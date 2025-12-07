/*****************************************************************************
 * Pool Filtration Controller — MQTT + Relay + Home Assistant
 * Stable version — Single timer loop — Shelly Plus 1 compatible
 * Version: 1.0.0
 *****************************************************************************/

// ───── System constants ─────
const VERSION            = "1.0.0";
const DEVICE_NAME        = "Pool filtration";
const MANUFACTURER       = "Shelly";
const ENTITY_PREFIX      = "pool_filtration";
const BASE_TOPIC         = "homeassistant";
const STATE_TOPIC        = "pool_filtration/state";
const CONTROL_MODE_TOPIC = "pool_filtration/control_mode/set";

// ───── Magic numbers as constants ─────
const MINUTES_PER_DAY                = 1440;
const TEMPERATURE_TO_MINUTES_FACTOR  = 30;
const WATER_READ_INTERVAL            = 5;      // minutes
const MAIN_LOOP_INTERVAL             = 60000; // milliseconds
const HTTP_TIMEOUT                    = 5;      // seconds
const MIN_MINUTES_LIMIT               = 30;     // minimum value for minMinutes/maxMinutes
const SENSOR_FAILURE_TIMEOUT          = 600000; // 10 minutes in milliseconds

// ───── Configurable parameters (can be changed via MQTT) ─────
let freezeOn        = 0.5;
let freezeOff       = 1.0;
let minMinutes      = 120;
let maxMinutes      = 960;
let noonMinutes     = 825;
let filtrationCoeff = 1.0;

// ───── Runtime state ─────
let homeAssistantIp                    = null;
let homeAssistantToken                 = null;
let homeAssistantAirTemperatureEntityId = null;
let waterSensorId                      = 0;
let airSensorId                        = 1;

let waterTemperature            = null;
let airTemperature              = null;
let maximumTemperatureYesterday = null;
let maximumWaterTemperatureToday = null;
let lastWaterTemperatureReadTime = null;

let filtrationStartTime = null;
let filtrationStopTime  = null;
let filtrationDuration  = null;
let lastPlanningTime    = null;

let filtrationState  = false;
let frostProtection  = false;
let controlMode      = "auto";
let filtrationReason = "off";
let lastError        = null;

// ───── Utility functions ─────
/**
 * Converts minutes (0-1439) to HH:MM format
 * @param {number|null} minutes - Minutes since midnight (0-1439) or null
 * @returns {string} Time in HH:MM format or "--:--" if null
 */
function minutesToHHMM(minutes) {
  if (minutes === null) return "--:--";
  let total = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  let h = Math.floor(total / 60);
  let m = total % 60;
  return ("0" + h).slice(-2) + ":" + ("0" + m).slice(-2);
}

/**
 * Converts minutes to hours with one decimal place
 * @param {number|null} minutes - Duration in minutes
 * @returns {number|null} Duration in hours (rounded to 1 decimal) or null
 */
function toHours(minutes) {
  return minutes !== null ? Math.round((minutes / 60) * 10) / 10 : null;
}

/**
 * Sanitizes MAC address by replacing colons with underscores
 * @param {string} mac - MAC address in format "XX:XX:XX:XX:XX:XX"
 * @returns {string} Sanitized MAC address
 */
function sanitizeMAC(mac) {
  return mac.split(":").join("_");
}

// ───── Home Assistant HTTP helper ─────
/**
 * Makes an HTTP GET request to Home Assistant API
 * @param {string} path - API path (e.g., "states/sun.sun")
 * @param {function} cb - Callback function receiving response body or null on error
 */
function haGET(path, cb) {
  if (!homeAssistantIp || !homeAssistantToken) {
    lastError = "Home Assistant not configured (missing IP or token)";
    cb(null);
    return;
  }

  Shelly.call("HTTP.Request", {
    method : "GET",
    url    : "http://" + homeAssistantIp + ":8123/api/" + path,
    headers: { Authorization: "Bearer " + homeAssistantToken },
    timeout: HTTP_TIMEOUT
  }, function (res, err) {
    if (err === 0) {
      lastError = null;
      cb(res.body);
    } else {
      // Error -1: Request cancelled (ignored, can happen during shutdown)
      // Error 408: Request timeout (ignored, network may be temporarily unavailable)
      if (err !== -1 && err !== 408) {
        lastError = "HA request error: " + path + " (code " + err + ", IP: " + 
                    (homeAssistantIp || "not set") + ")";
      }
      cb(null);
    }
  });
}

// ───── MQTT input handlers ─────
/**
 * Registers an MQTT listener for numeric values with validation
 * @param {string} topic - MQTT topic to subscribe to
 * @param {function} setter - Function to call with validated value
 * @param {string} kvsKey - KVS key to persist the value
 * @param {function|null} validator - Optional validation function returning boolean
 */
function registerNumberListener(topic, setter, kvsKey, validator) {
  MQTT.subscribe(topic, function (msg) {
    let v = parseFloat(msg);
    if (!isNaN(v) && (!validator || validator(v))) {
      setter(v);
      Shelly.call("KVS.Set", { key: kvsKey, value: String(v) });
      publishState();
    }
  });
}

MQTT.subscribe(CONTROL_MODE_TOPIC, function (msg) {
  if (typeof msg === "string" && (msg === "auto" || msg === "manual_on" || msg === "manual_off")) {
    controlMode = msg;
    publishState();
  }
});

MQTT.subscribe("pool_filtration/replan/set", function (msg) {
  if (msg === "ON") {
    lastError = "Manual re-planning requested";
    planFiltration();
    MQTT.publish("pool_filtration/replan/set", "", 0, true);
  }
});

registerNumberListener("pool_filtration/freeze_on/set", function (v) {
  if (v < freezeOff) freezeOn = v;
}, "freezeOn", function (v) {
  return v >= -10 && v <= 10 && v < freezeOff;
});

registerNumberListener("pool_filtration/freeze_off/set", function (v) {
  if (v > freezeOn) freezeOff = v;
}, "freezeOff", function (v) {
  return v >= -10 && v <= 10 && v > freezeOn;
});

registerNumberListener("pool_filtration/min_minutes/set", function (v) {
  minMinutes = v;
}, "minMinutes", function (v) {
  return v >= MIN_MINUTES_LIMIT && v <= MINUTES_PER_DAY && v <= maxMinutes;
});

registerNumberListener("pool_filtration/max_minutes/set", function (v) {
  maxMinutes = v;
}, "maxMinutes", function (v) {
  return v >= MIN_MINUTES_LIMIT && v <= MINUTES_PER_DAY && v >= minMinutes;
});

registerNumberListener("pool_filtration/noon_minutes/set", function (v) {
  noonMinutes = v;
}, "noonMinutes", function (v) {
  return v >= 0 && v <= 1439;
});

registerNumberListener("pool_filtration/coeff/set", function (v) {
  filtrationCoeff = v;
}, "filtrationCoeff", function (v) {
  return v >= 0.5 && v <= 2;
});

// ───── Autodiscovery for Home Assistant ─────
/**
 * Publishes Home Assistant autodiscovery configuration for all entities
 * Creates sensors, binary sensors, numbers, select, and button entities
 * Publishes one entity per second to avoid MQTT overload
 */
function autodiscovery() {
  let mac = sanitizeMAC(Shelly.getDeviceInfo().mac);
  let queue = [];

  function buildObjectId(id) {
    return ENTITY_PREFIX + "_" + id;
  }

  function enqueueSensor(id, name, unit, dclass, icon, tpl, diagnostic) {
    let o = {
      name: name,
      uniq_id: buildObjectId(id),
      stat_t: STATE_TOPIC,
      val_tpl: tpl,
      dev: { ids: ["shelly_pool_" + mac], name: DEVICE_NAME, mf: MANUFACTURER }
    };
    if (unit) o.unit_of_measurement = unit;
    if (dclass) o.device_class = dclass;
    if (icon) o.icon = icon;
    if (diagnostic) o.entity_category = "diagnostic";
    queue.push({ path: BASE_TOPIC + "/sensor/" + buildObjectId(id) + "/config", payload: JSON.stringify(o) });
  }

  function enqueueBinarySensor(id, name, dclass, icon, tpl, diagnostic) {
    let o = {
      name: name,
      uniq_id: buildObjectId(id),
      stat_t: STATE_TOPIC,
      val_tpl: tpl,
      payload_on: "ON",
      payload_off: "OFF",
      dev: { ids: ["shelly_pool_" + mac], name: DEVICE_NAME, mf: MANUFACTURER }
    };
    if (dclass) o.device_class = dclass;
    if (icon) o.icon = icon;
    if (diagnostic) o.entity_category = "diagnostic";
    queue.push({ path: BASE_TOPIC + "/binary_sensor/" + buildObjectId(id) + "/config", payload: JSON.stringify(o) });
  }

  function enqueueNumber(id, name, min, max, step, icon, tpl, cmd) {
    let o = {
      name: name,
      uniq_id: buildObjectId(id),
      stat_t: STATE_TOPIC,
      val_tpl: tpl,
      cmd_t: cmd,
      min: min,
      max: max,
      step: step,
      dev: { ids: ["shelly_pool_" + mac], name: DEVICE_NAME, mf: MANUFACTURER },
      entity_category: "config"
    };
    if (icon) o.icon = icon;
    queue.push({ path: BASE_TOPIC + "/number/" + buildObjectId(id) + "/config", payload: JSON.stringify(o) });
  }

  function enqueueMisc(path, obj) {
    queue.push({ path: path, payload: JSON.stringify(obj) });
  }

  // Sensors
  enqueueSensor("water_temperature", "Water temperature", "°C", "temperature", "mdi:waves", "{{ value_json.waterTemperature }}");
  enqueueSensor("air_temperature", "Air temperature", "°C", "temperature", "mdi:weather-sunny", "{{ value_json.airTemperature }}");
  enqueueSensor("maximum_water_temperature_today", "Max temp today", "°C", "temperature", "mdi:calendar-today", "{{ value_json.maximumWaterTemperatureToday }}");
  enqueueSensor("maximum_temperature_yesterday", "Max temp yesterday", "°C", "temperature", "mdi:calendar-clock", "{{ value_json.maximumTemperatureYesterday }}");
  enqueueSensor("filtration_start_time", "Start time", null, null, "mdi:clock-start", "{{ value_json.filtrationStartTime }}");
  enqueueSensor("filtration_stop_time", "Stop time", null, null, "mdi:clock-end", "{{ value_json.filtrationStopTime }}");
  enqueueSensor("last_planning_time", "Last planning", null, "timestamp", "mdi:calendar-range", "{{ value_json.lastPlanningTime }}", true);
  enqueueSensor("filtration_duration", "Duration", "h", "duration", "mdi:timer", "{{ value_json.filtrationDuration }}");
  enqueueSensor("filtration_reason", "Reason", null, null, "mdi:comment-question-outline", "{{ value_json.filtrationReason }}", true);
  enqueueSensor("last_error", "Last error", null, null, "mdi:alert", "{{ value_json.lastError }}", true);
  enqueueSensor("heartbeat", "Heartbeat", null, "timestamp", "mdi:heart-pulse", "{{ value_json.heartbeat }}", true);

  // Binary sensors
  enqueueBinarySensor("filtration_state", "Filtration state", "running", "mdi:pump", "{{ value_json.filtrationState }}");
  enqueueBinarySensor("frost_protection", "Frost protection", "cold", "mdi:snowflake", "{{ value_json.frostProtection }}");

  // Number inputs
  enqueueNumber("freeze_on", "Freeze ON", -10, 10, 0.1, "mdi:snowflake-alert", "{{ value_json.freezeOn }}", "pool_filtration/freeze_on/set");
  enqueueNumber("freeze_off", "Freeze OFF", -10, 10, 0.1, "mdi:snowflake-off", "{{ value_json.freezeOff }}", "pool_filtration/freeze_off/set");
  enqueueNumber("min_minutes", "Min minutes", MIN_MINUTES_LIMIT, MINUTES_PER_DAY, 10, "mdi:timer-sand", "{{ value_json.minMinutes }}", "pool_filtration/min_minutes/set");
  enqueueNumber("max_minutes", "Max minutes", MIN_MINUTES_LIMIT, MINUTES_PER_DAY, 10, "mdi:timer-sand-full", "{{ value_json.maxMinutes }}", "pool_filtration/max_minutes/set");
  enqueueNumber("noon_minutes", "Noon fallback", 0, MINUTES_PER_DAY - 1, 1, "mdi:clock", "{{ value_json.noonMinutes }}", "pool_filtration/noon_minutes/set");
  enqueueNumber("coeff", "Filtration coeff", 0.5, 2, 0.1, "mdi:lambda", "{{ value_json.filtrationCoeff }}", "pool_filtration/coeff/set");

  // Control mode selector
  enqueueMisc(BASE_TOPIC + "/select/" + buildObjectId("control_mode") + "/config", {
    name: "Control mode",
    unique_id: buildObjectId("control_mode"),
    state_topic: STATE_TOPIC,
    value_template: "{{ value_json.controlMode }}",
    command_topic: CONTROL_MODE_TOPIC,
    options: ["auto", "manual_on", "manual_off"],
    icon: "mdi:account-switch",
    device: {
      identifiers: ["shelly_pool_" + mac],
      name: DEVICE_NAME,
      manufacturer: MANUFACTURER
    }
  });

  // Replan button
  enqueueMisc(BASE_TOPIC + "/button/" + buildObjectId("replan") + "/config", {
    name: "Replan",
    unique_id: buildObjectId("replan"),
    command_topic: "pool_filtration/replan/set",
    payload_press: "ON",
    icon: "mdi:refresh",
    device: {
      identifiers: ["shelly_pool_" + mac],
      name: DEVICE_NAME,
      manufacturer: MANUFACTURER
    }
  });

  queue.push({
    path: BASE_TOPIC + "/binary_sensor/" + ENTITY_PREFIX + "_alive/config",
    payload: JSON.stringify({
      name: "Alive",
      unique_id: ENTITY_PREFIX + "_alive",
      state_topic: "pool_filtration/alive",
      payload_on: "ON",
      payload_off: "OFF",
      device_class: "connectivity",
      expire_after: 300,
      entity_category: "diagnostic",
      device: {
        identifiers: ["shelly_pool_" + sanitizeMAC(Shelly.getDeviceInfo().mac)],
        name: DEVICE_NAME,
        manufacturer: MANUFACTURER
      }
    })
  });

  // Publish all entities (1 per second)
  let i = 0;
  let timerId = Timer.set(1000, true, function () {
    if (i < queue.length) {
      MQTT.publish(queue[i].path, queue[i].payload, 1, true);
      i++;
    } else {
      Timer.clear(timerId);
    }
  });
}

// ───── Sensor reading ─────
/**
 * Reads water temperature from the Shelly temperature sensor
 * Updates waterTemperature and tracks maximumWaterTemperatureToday
 */
function readWater() {
  let res = Shelly.getComponentStatus("temperature", waterSensorId);
  waterTemperature = (res && typeof res.tC === "number") ? res.tC : null;

  if (waterTemperature !== null) {
    lastWaterTemperatureReadTime = Date.now();
    if (maximumWaterTemperatureToday === null || waterTemperature > maximumWaterTemperatureToday) {
      maximumWaterTemperatureToday = waterTemperature;
    }
  }
}

/**
 * Reads air temperature from Home Assistant
 * Returns early if homeAssistantAirTemperatureEntityId is not configured
 * Updates airTemperature global variable
 */
function readAir() {
  if (!homeAssistantAirTemperatureEntityId) {
    airTemperature = null;
    return;
  }
  haGET("states/" + homeAssistantAirTemperatureEntityId, function (body) {
    try {
      let t = parseFloat(JSON.parse(body).state);
      airTemperature = !isNaN(t) ? t : null;
    } catch (err) {
      airTemperature = null;
      lastError = "Air temperature read error: " + err.message + 
                  " (entity: " + (homeAssistantAirTemperatureEntityId || "not set") + ")";
    }
  });
}

// ───── Filtration planning ─────
/**
 * Calculates and sets the daily filtration schedule
 * Uses maximumTemperatureYesterday (or fallback) to determine duration
 * Centers the schedule around solar noon
 * Updates filtrationStartTime, filtrationStopTime, and filtrationDuration
 */
function planFiltration() {
  let localNoon = noonMinutes;
  haGET("states/sun.sun", function (body) {
    try {
      let d = new Date(JSON.parse(body).attributes.next_noon);
      if (!isNaN(d.getTime())) {
        localNoon = d.getHours() * 60 + d.getMinutes();
      }
    } catch (_) {}

    let tempForCalculation = maximumTemperatureYesterday;
    if (tempForCalculation === null) {
      tempForCalculation = maximumWaterTemperatureToday !== null ? maximumWaterTemperatureToday : 15;
    }

    filtrationDuration = Math.max(
      minMinutes,
      Math.min(
        maxMinutes,
        Math.floor(tempForCalculation * TEMPERATURE_TO_MINUTES_FACTOR * filtrationCoeff)
      )
    );

    if (isNaN(filtrationDuration) || filtrationDuration < 0) {
      lastError = "Invalid filtration duration calculated (temp: " + tempForCalculation + 
                  "°C, coeff: " + filtrationCoeff + ", result: " + filtrationDuration + ")";
      filtrationDuration = minMinutes;
    }

    filtrationStartTime = (localNoon - Math.floor(filtrationDuration / 2) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    filtrationStopTime  = (filtrationStartTime + filtrationDuration) % MINUTES_PER_DAY;

    if (isNaN(filtrationStartTime) || isNaN(filtrationStopTime)) {
      lastError = "Invalid filtration times calculated (start: " + filtrationStartTime + 
                  ", stop: " + filtrationStopTime + ", duration: " + filtrationDuration + 
                  ", noon: " + localNoon + ")";
      filtrationStartTime = null;
      filtrationStopTime = null;
      return;
    }
    lastPlanningTime    = new Date().toISOString();

    publishState();
    updateFiltrationState();
  });
}

// ───── Filtration logic ─────
/**
 * Updates filtration state based on control mode, frost protection, and schedule
 * Priority: manual mode > frost protection > schedule
 * Controls the relay switch and publishes state
 */
function updateFiltrationState() {
  let now = new Date();
  let minutesNow = now.getHours() * 60 + now.getMinutes();

  if (filtrationStartTime === null || filtrationStopTime === null) {
    lastError = "Missing schedule (start: " + (filtrationStartTime === null ? "null" : minutesToHHMM(filtrationStartTime)) + 
                ", stop: " + (filtrationStopTime === null ? "null" : minutesToHHMM(filtrationStopTime)) + ")";
    planFiltration();
    return;
  }

  if (controlMode === "manual_on") {
    filtrationState = true;
    filtrationReason = "manual";
    frostProtection = false;
  } else if (controlMode === "manual_off") {
    filtrationState = false;
    filtrationReason = "manual";
    frostProtection = false;
  } else {
    // Check for sensor failure (no reading for more than 10 minutes)
    let sensorFailed = lastWaterTemperatureReadTime !== null && 
                       (Date.now() - lastWaterTemperatureReadTime) > SENSOR_FAILURE_TIMEOUT;

    // Degraded mode: if sensor failed and air temperature is low, activate frost protection as precaution
    if (sensorFailed && airTemperature !== null && airTemperature < freezeOn) {
      frostProtection = true;
      lastError = "Sensor failure detected: frost protection activated as precaution (air temp: " + airTemperature + "°C)";
    }

    // Normal frost protection logic (only if sensor is working)
    if (!sensorFailed) {
      if (!frostProtection && waterTemperature !== null && waterTemperature <= freezeOn) frostProtection = true;
      if (frostProtection && waterTemperature !== null && waterTemperature >= freezeOff) frostProtection = false;
    }

    if (frostProtection) {
      filtrationState = true;
      filtrationReason = "frost";
    } else {
      // Check if we're in the scheduled time window
      // Handle case where schedule crosses midnight (startTime > stopTime)
      let inSchedule = false;
      if (filtrationStartTime < filtrationStopTime) {
        // Normal case: no midnight crossing
        inSchedule = minutesNow >= filtrationStartTime && minutesNow < filtrationStopTime;
      } else {
        // Midnight crossing: startTime > stopTime (e.g., 23:00 to 02:00)
        inSchedule = minutesNow >= filtrationStartTime || minutesNow < filtrationStopTime;
      }

      if (inSchedule) {
        filtrationState = true;
        filtrationReason = "schedule";
      } else {
        filtrationState = false;
        filtrationReason = "off";
      }
    }
  }

  Shelly.call("Switch.Set", { id: 0, on: filtrationState });
  publishState();
}

// ───── MQTT state publication ─────
/**
 * Publishes current system state to MQTT
 * Includes all temperatures, schedule, filtration state, and configuration
 */
function publishState() {
  MQTT.publish(STATE_TOPIC, JSON.stringify({
    waterTemperature: waterTemperature,
    airTemperature: airTemperature,
    maximumWaterTemperatureToday: maximumWaterTemperatureToday,
    maximumTemperatureYesterday: maximumTemperatureYesterday,
    filtrationStartTime: minutesToHHMM(filtrationStartTime),
    filtrationStopTime: minutesToHHMM(filtrationStopTime),
    lastPlanningTime: lastPlanningTime,
    filtrationDuration: toHours(filtrationDuration),
    filtrationState: filtrationState ? "ON" : "OFF",
    frostProtection: frostProtection ? "ON" : "OFF",
    controlMode: controlMode,
    filtrationReason: filtrationReason,
    lastError: lastError,
    freezeOn: freezeOn,
    freezeOff: freezeOff,
    minMinutes: minMinutes,
    maxMinutes: maxMinutes,
    noonMinutes: noonMinutes,
    filtrationCoeff: filtrationCoeff,
    heartbeat: (new Date()).toISOString()
  }), 1, true);
}

// ───── MQTT connection check ─────
/**
 * Checks if MQTT is connected
 * @returns {boolean} True if MQTT is connected, false otherwise
 */
function mqttConnected() {
  let st = Shelly.getComponentStatus("mqtt");
  return st && st.connected;
}

/**
 * Runs Home Assistant autodiscovery when MQTT is ready
 * Retries up to 30 times (1 minute total) if MQTT is not connected
 * @param {number} attemptCount - Current attempt number (default: 0)
 */
function runAutodiscoveryWhenReady(attemptCount) {
  if (attemptCount === undefined) attemptCount = 0;
  
  if (mqttConnected()) {
    autodiscovery();
  } else {
    if (attemptCount < 30) {
      Timer.set(2000, false, function () {
        runAutodiscoveryWhenReady(attemptCount + 1);
      });
    } else {
      lastError = "MQTT autodiscovery failed: MQTT not connected after 30 attempts";
    }
  }
}

// ───── Load configuration from KVS ─────
/**
 * Loads multiple keys from KVS asynchronously
 * @param {string[]} keys - Array of KVS keys to load
 * @param {function} cb - Callback function receiving object with key-value pairs
 */
function loadKVS(keys, cb) {
  let res = {}, idx = 0;
  (function next() {
    if (idx >= keys.length) { cb(res); return; }
    Shelly.call("KVS.Get", { key: keys[idx] }, function (r) {
      if (r && r.value !== undefined && r.value !== null) res[keys[idx]] = r.value;
      idx++; next();
    });
  })();
}

// ───── Parameter validation ─────
/**
 * Validates and auto-corrects parameter inconsistencies
 * Swaps minMinutes/maxMinutes if inverted, adjusts freezeOff if <= freezeOn
 * Sets lastError if corrections were made
 */
function validateParameters() {
  let errors = [];
  
  if (minMinutes > maxMinutes) {
    let temp = minMinutes;
    minMinutes = maxMinutes;
    maxMinutes = temp;
    errors.push("minMinutes > maxMinutes: values swapped");
    Shelly.call("KVS.Set", { key: "minMinutes", value: String(minMinutes) });
    Shelly.call("KVS.Set", { key: "maxMinutes", value: String(maxMinutes) });
  }
  
  if (freezeOn >= freezeOff) {
    freezeOff = freezeOn + 0.5;
    errors.push("freezeOn >= freezeOff: freezeOff adjusted to " + freezeOff);
    Shelly.call("KVS.Set", { key: "freezeOff", value: String(freezeOff) });
  }
  
  if (errors.length > 0) {
    lastError = "Parameter validation error: " + errors.join(", ");
  }
}

// ───── Initialization ─────
loadKVS([
  "homeAssistantIp", "homeAssistantToken", "homeAssistantAirTemperatureEntityId",
  "waterSensorId", "airSensorId", "maximumTemperatureYesterday",
  "freezeOn", "freezeOff", "minMinutes", "maxMinutes", "noonMinutes", "filtrationCoeff"
], function (v) {
  if (v.homeAssistantIp) homeAssistantIp = v.homeAssistantIp;
  if (v.homeAssistantToken) homeAssistantToken = v.homeAssistantToken;
  if (v.homeAssistantAirTemperatureEntityId) homeAssistantAirTemperatureEntityId = v.homeAssistantAirTemperatureEntityId;
  if (v.waterSensorId) waterSensorId = parseInt(v.waterSensorId, 10);
  if (v.airSensorId) airSensorId = parseInt(v.airSensorId, 10);
  if (v.maximumTemperatureYesterday) maximumTemperatureYesterday = parseFloat(v.maximumTemperatureYesterday);
  if (v.freezeOn) freezeOn = parseFloat(v.freezeOn);
  if (v.freezeOff) freezeOff = parseFloat(v.freezeOff);
  if (v.minMinutes) minMinutes = parseInt(v.minMinutes, 10);
  if (v.maxMinutes) maxMinutes = parseInt(v.maxMinutes, 10);
  if (v.noonMinutes) noonMinutes = parseInt(v.noonMinutes, 10);
  if (v.filtrationCoeff) filtrationCoeff = parseFloat(v.filtrationCoeff);

  // Validate and auto-correct parameters
  validateParameters();

  runAutodiscoveryWhenReady();
  readWater();
  readAir();

  if (maximumTemperatureYesterday === null && waterTemperature !== null) {
    maximumTemperatureYesterday = waterTemperature;
    Shelly.call("KVS.Set", { key: "maximumTemperatureYesterday", value: String(waterTemperature) });
  }

  if (waterTemperature !== null) {
    maximumWaterTemperatureToday = waterTemperature;
  }

  planFiltration();
});

// ───── Main loop (1-minute interval, only one active timer) ─────
let loopCount = 0;

Timer.set(MAIN_LOOP_INTERVAL, true, function () {
  let now = new Date();
  loopCount++;

  // Every WATER_READ_INTERVAL minutes
  if (loopCount % WATER_READ_INTERVAL === 0) {
    readWater();
    readAir();
  }

  // Filtration logic
  updateFiltrationState();

  // Alive.
  MQTT.publish("pool_filtration/alive", "ON", 1, true);

  // Daily replan at 01:00
  if (now.getHours() === 1 && now.getMinutes() === 0) {
    if (maximumWaterTemperatureToday !== null) {
      maximumTemperatureYesterday = maximumWaterTemperatureToday;
      Shelly.call("KVS.Set", { key: "maximumTemperatureYesterday", value: String(maximumWaterTemperatureToday) });
    } else if (maximumTemperatureYesterday === null) {
      // Fallback: use current water temperature or default to 15°C
      let fallbackTemp = waterTemperature !== null ? waterTemperature : 15;
      maximumTemperatureYesterday = fallbackTemp;
      Shelly.call("KVS.Set", { key: "maximumTemperatureYesterday", value: String(fallbackTemp) });
    }
    maximumWaterTemperatureToday = waterTemperature !== null ? waterTemperature : maximumWaterTemperatureToday;
    planFiltration();
    
    // Verify replan succeeded after a short delay (planFiltration is async)
    Timer.set(5000, false, function () {
      if (filtrationStartTime === null || filtrationStopTime === null) {
        lastError = "Daily replan failed: schedule not set, retrying with defaults";
        // Retry with default temperature if available
        if (maximumTemperatureYesterday === null) {
          maximumTemperatureYesterday = waterTemperature !== null ? waterTemperature : 15;
        }
        planFiltration();
      }
    });
  }
});
