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
const FILTRATION_STRATEGY_TOPIC = "pool_filtration/filtration_strategy/set";
const REPLAN_TOPIC       = "pool_filtration/replan/set";

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
let filtrationStrategy = "temperature_linear"; // temperature_linear | winter_circulation
let winterMinutes = 120;
let winterCenterMinutes = 420; // 07:00

// ───── Runtime state ─────
let homeAssistantIp                    = null;
let homeAssistantToken                 = null;
let homeAssistantAirTemperatureEntityId = null;
let waterSensorId                      = 0;
let airSensorId                        = 1;

let waterTemperature            = null;
let airTemperature              = null;
let airTemperatureSensor        = null;
let airTemperatureMin           = null;
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
// NOTE: Shelly scripts have a low limit on MQTT subscriptions.
// We keep a single wildcard subscription and dispatch by topic.

let topicHandlers = {};

function registerNumberTopic(topic, setter, kvsKey, validator, onAfterSet) {
  topicHandlers[topic] = function (raw) {
    let v = parseFloat(raw);
    if (!isNaN(v) && (!validator || validator(v))) {
      setter(v);
      if (kvsKey) Shelly.call("KVS.Set", { key: kvsKey, value: String(v) });
      if (onAfterSet) onAfterSet(v);
      publishState();
    }
  };
}

function registerStringTopic(topic, setter, kvsKey, validator, onAfterSet) {
  topicHandlers[topic] = function (raw) {
    if (typeof raw !== "string") return;
    if (validator && !validator(raw)) return;
    setter(raw);
    if (kvsKey) Shelly.call("KVS.Set", { key: kvsKey, value: String(raw) });
    if (onAfterSet) onAfterSet(raw);
    publishState();
  };
}

registerStringTopic(CONTROL_MODE_TOPIC, function (v) { controlMode = v; }, null, function (v) {
  return v === "auto" || v === "manual_on" || v === "manual_off";
}, function () {
  updateFiltrationState();
});

registerStringTopic(FILTRATION_STRATEGY_TOPIC, function (v) { filtrationStrategy = v; }, "filtrationStrategy", function (v) {
  return v === "temperature_linear" || v === "winter_circulation";
}, function () {
  planFiltration();
});

topicHandlers[REPLAN_TOPIC] = function (raw) {
  if (raw === "ON") {
    lastError = "Manual re-planning requested";
    planFiltration();
    // Clear retained command
    MQTT.publish(REPLAN_TOPIC, "", 0, true);
  }
};

registerNumberTopic("pool_filtration/freeze_on/set", function (v) { if (v < freezeOff) freezeOn = v; }, "freezeOn", function (v) {
  return v >= -10 && v <= 10 && v < freezeOff;
});

registerNumberTopic("pool_filtration/freeze_off/set", function (v) { if (v > freezeOn) freezeOff = v; }, "freezeOff", function (v) {
  return v >= -10 && v <= 10 && v > freezeOn;
});

registerNumberTopic("pool_filtration/min_minutes/set", function (v) { minMinutes = v; }, "minMinutes", function (v) {
  return v >= MIN_MINUTES_LIMIT && v <= MINUTES_PER_DAY && v <= maxMinutes;
});

registerNumberTopic("pool_filtration/max_minutes/set", function (v) { maxMinutes = v; }, "maxMinutes", function (v) {
  return v >= MIN_MINUTES_LIMIT && v <= MINUTES_PER_DAY && v >= minMinutes;
});

registerNumberTopic("pool_filtration/noon_minutes/set", function (v) { noonMinutes = v; }, "noonMinutes", function (v) {
  return v >= 0 && v <= 1439;
});

registerNumberTopic("pool_filtration/coeff/set", function (v) { filtrationCoeff = v; }, "filtrationCoeff", function (v) {
  return v >= 0.5 && v <= 2;
});

registerNumberTopic("pool_filtration/winter_minutes/set", function (v) { winterMinutes = v; }, "winterMinutes", function (v) {
  return v >= MIN_MINUTES_LIMIT && v <= MINUTES_PER_DAY;
}, function () {
  if (filtrationStrategy === "winter_circulation") planFiltration();
});

registerNumberTopic("pool_filtration/winter_center_minutes/set", function (v) { winterCenterMinutes = v; }, "winterCenterMinutes", function (v) {
  return v >= 0 && v <= (MINUTES_PER_DAY - 1);
}, function () {
  if (filtrationStrategy === "winter_circulation") planFiltration();
});

MQTT.subscribe("pool_filtration/+/set", function (a, b) {
  let topic = null;
  let payload = null;

  // Shelly firmware variants may pass (topic, msg) or (msg, topic)
  if (typeof a === "string" && a.indexOf("/") !== -1 && b !== undefined) {
    topic = a;
    payload = b;
  } else if (typeof b === "string" && b.indexOf("/") !== -1) {
    topic = b;
    payload = a;
  } else if (a && typeof a === "object") {
    // Fallback: try object fields
    topic = a.topic || a.t || null;
    payload = a.payload || a.msg || a.message || null;
  }

  if (typeof topic !== "string") return;
  if (topicHandlers[topic]) topicHandlers[topic](payload);
});

// ───── Autodiscovery for Home Assistant ─────
/**
 * Publishes Home Assistant autodiscovery configuration for all entities
 * Creates sensors, binary sensors, numbers, select, and button entities
 * Publishes one entity per second to avoid MQTT overload
 */
function autodiscovery() {
  let mac = sanitizeMAC(Shelly.getDeviceInfo().mac);

  function buildObjectId(id) {
    return ENTITY_PREFIX + "_" + id;
  }

  function buildSensor(id, name, unit, dclass, icon, tpl, diagnostic) {
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
    return { path: BASE_TOPIC + "/sensor/" + buildObjectId(id) + "/config", payload: JSON.stringify(o) };
  }

  function buildBinarySensor(id, name, dclass, icon, tpl, diagnostic) {
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
    return { path: BASE_TOPIC + "/binary_sensor/" + buildObjectId(id) + "/config", payload: JSON.stringify(o) };
  }

  function buildNumber(id, name, min, max, step, icon, tpl, cmdTopic) {
    let o = {
      name: name,
      uniq_id: buildObjectId(id),
      stat_t: STATE_TOPIC,
      val_tpl: tpl,
      cmd_t: cmdTopic,
      min: min,
      max: max,
      step: step,
      dev: { ids: ["shelly_pool_" + mac], name: DEVICE_NAME, mf: MANUFACTURER },
      entity_category: "config"
    };
    if (icon) o.icon = icon;
    return { path: BASE_TOPIC + "/number/" + buildObjectId(id) + "/config", payload: JSON.stringify(o) };
  }

  function buildMisc(path, obj) {
    return { path: path, payload: JSON.stringify(obj) };
  }

  function itemAt(i) {
    switch (i) {
      // Sensors
      case 0:  return buildSensor("water_temperature", "Water temperature", "°C", "temperature", "mdi:waves", "{{ value_json.waterTemperature }}");
      case 1:  return buildSensor("air_temperature", "Air temperature", "°C", "temperature", "mdi:weather-sunny", "{{ value_json.airTemperature }}");
      case 2:  return buildSensor("air_temperature_sensor", "Air temperature (Shelly sensor)", "°C", "temperature", "mdi:thermometer", "{{ value_json.airTemperatureSensor }}", true);
      case 3:  return buildSensor("air_temperature_min", "Air temperature (freeze min)", "°C", "temperature", "mdi:snowflake-thermometer", "{{ value_json.airTemperatureMin }}", true);
      case 4:  return buildSensor("maximum_water_temperature_today", "Max temp today", "°C", "temperature", "mdi:calendar-today", "{{ value_json.maximumWaterTemperatureToday }}");
      case 5:  return buildSensor("maximum_temperature_yesterday", "Max temp yesterday", "°C", "temperature", "mdi:calendar-clock", "{{ value_json.maximumTemperatureYesterday }}");
      case 6:  return buildSensor("filtration_start_time", "Start time", null, null, "mdi:clock-start", "{{ value_json.filtrationStartTime }}");
      case 7:  return buildSensor("filtration_stop_time", "Stop time", null, null, "mdi:clock-end", "{{ value_json.filtrationStopTime }}");
      case 8:  return buildSensor("last_planning_time", "Last planning", null, "timestamp", "mdi:calendar-range", "{{ value_json.lastPlanningTime }}", true);
      case 9:  return buildSensor("filtration_duration", "Duration", "h", "duration", "mdi:timer", "{{ value_json.filtrationDuration }}");
      case 10: return buildSensor("filtration_reason", "Reason", null, null, "mdi:comment-question-outline", "{{ value_json.filtrationReason }}", true);
      case 11: return buildSensor("last_error", "Last error", null, null, "mdi:alert", "{{ value_json.lastError }}", true);
      case 12: return buildSensor("heartbeat", "Heartbeat", null, "timestamp", "mdi:heart-pulse", "{{ value_json.heartbeat }}", true);

      // Binary sensors
      case 13: return buildBinarySensor("filtration_state", "Filtration state", "running", "mdi:pump", "{{ value_json.filtrationState }}");
      case 14: return buildBinarySensor("frost_protection", "Frost protection", "cold", "mdi:snowflake", "{{ value_json.frostProtection }}");

      // Number inputs
      case 15: return buildNumber("freeze_on", "Freeze ON", -10, 10, 0.1, "mdi:snowflake-alert", "{{ value_json.freezeOn }}", "pool_filtration/freeze_on/set");
      case 16: return buildNumber("freeze_off", "Freeze OFF", -10, 10, 0.1, "mdi:snowflake-off", "{{ value_json.freezeOff }}", "pool_filtration/freeze_off/set");
      case 17: return buildNumber("min_minutes", "Min minutes", MIN_MINUTES_LIMIT, MINUTES_PER_DAY, 10, "mdi:timer-sand", "{{ value_json.minMinutes }}", "pool_filtration/min_minutes/set");
      case 18: return buildNumber("max_minutes", "Max minutes", MIN_MINUTES_LIMIT, MINUTES_PER_DAY, 10, "mdi:timer-sand-full", "{{ value_json.maxMinutes }}", "pool_filtration/max_minutes/set");
      case 19: return buildNumber("noon_minutes", "Noon fallback", 0, MINUTES_PER_DAY - 1, 1, "mdi:clock", "{{ value_json.noonMinutes }}", "pool_filtration/noon_minutes/set");
      case 20: return buildNumber("coeff", "Filtration coeff", 0.5, 2, 0.1, "mdi:lambda", "{{ value_json.filtrationCoeff }}", "pool_filtration/coeff/set");
      case 21: return buildNumber("winter_minutes", "Winter minutes", MIN_MINUTES_LIMIT, MINUTES_PER_DAY, 10, "mdi:timer-outline", "{{ value_json.winterMinutes }}", "pool_filtration/winter_minutes/set");
      case 22: return buildNumber("winter_center_minutes", "Winter center (minutes)", 0, MINUTES_PER_DAY - 1, 1, "mdi:clock-outline", "{{ value_json.winterCenterMinutes }}", "pool_filtration/winter_center_minutes/set");

      // Control mode selector
      case 23: return buildMisc(BASE_TOPIC + "/select/" + buildObjectId("control_mode") + "/config", {
        name: "Control mode",
        unique_id: buildObjectId("control_mode"),
        state_topic: STATE_TOPIC,
        value_template: "{{ value_json.controlMode }}",
        command_topic: CONTROL_MODE_TOPIC,
        options: ["auto", "manual_on", "manual_off"],
        icon: "mdi:account-switch",
        device: { identifiers: ["shelly_pool_" + mac], name: DEVICE_NAME, manufacturer: MANUFACTURER }
      });

      // Filtration strategy selector
      case 24: return buildMisc(BASE_TOPIC + "/select/" + buildObjectId("filtration_strategy") + "/config", {
        name: "Filtration strategy",
        unique_id: buildObjectId("filtration_strategy"),
        state_topic: STATE_TOPIC,
        value_template: "{{ value_json.filtrationStrategy }}",
        command_topic: FILTRATION_STRATEGY_TOPIC,
        options: ["temperature_linear", "winter_circulation"],
        icon: "mdi:chart-timeline-variant",
        device: { identifiers: ["shelly_pool_" + mac], name: DEVICE_NAME, manufacturer: MANUFACTURER },
        entity_category: "config"
      });

      // Replan button
      case 25: return buildMisc(BASE_TOPIC + "/button/" + buildObjectId("replan") + "/config", {
        name: "Replan",
        unique_id: buildObjectId("replan"),
        command_topic: REPLAN_TOPIC,
        payload_press: "ON",
        icon: "mdi:refresh",
        device: { identifiers: ["shelly_pool_" + mac], name: DEVICE_NAME, manufacturer: MANUFACTURER }
      });

      // Alive (connectivity)
      case 26: return buildMisc(BASE_TOPIC + "/binary_sensor/" + ENTITY_PREFIX + "_alive/config", {
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
      });
    }
    return null;
  }

  // Publish all entities (1 per second) without storing payload strings (saves RAM)
  let i = 0;
  let timerId = Timer.set(1000, true, function () {
    let item = itemAt(i);
    if (item) {
      MQTT.publish(item.path, item.payload, 1, true);
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
 * Reads air temperature from the Shelly temperature sensor (airSensorId)
 * Updates airTemperatureSensor global variable
 */
function readAirSensor() {
  let res = Shelly.getComponentStatus("temperature", airSensorId);
  airTemperatureSensor = (res && typeof res.tC === "number") ? res.tC : null;
  computeAirTemperatureMin();
}

/**
 * Computes the air temperature used for frost protection:
 * minimum of Shelly air sensor and Home Assistant air temperature when available.
 */
function computeAirTemperatureMin() {
  let a = airTemperatureSensor;
  let b = airTemperature;
  if (a !== null && b !== null) airTemperatureMin = Math.min(a, b);
  else if (a !== null) airTemperatureMin = a;
  else if (b !== null) airTemperatureMin = b;
  else airTemperatureMin = null;
}

/**
 * Reads air temperature from Home Assistant
 * Returns early if homeAssistantAirTemperatureEntityId is not configured
 * Updates airTemperature global variable
 */
function readAir() {
  if (!homeAssistantAirTemperatureEntityId) {
    airTemperature = null;
    computeAirTemperatureMin();
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
    computeAirTemperatureMin();
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

    let centerMinutes = localNoon;

    if (filtrationStrategy === "winter_circulation") {
      filtrationDuration = Math.max(
        MIN_MINUTES_LIMIT,
        Math.min(MINUTES_PER_DAY, Math.floor(winterMinutes))
      );
      centerMinutes = (typeof winterCenterMinutes === "number" && !isNaN(winterCenterMinutes))
        ? ((winterCenterMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
        : 420;
    } else {
      // Default strategy: temperature_linear
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
      centerMinutes = localNoon;
    }

    if (isNaN(filtrationDuration) || filtrationDuration < 0) {
      lastError = "Invalid filtration duration calculated (strategy: " + filtrationStrategy + ", result: " + filtrationDuration + ")";
      filtrationDuration = minMinutes;
    }

    filtrationStartTime = (centerMinutes - Math.floor(filtrationDuration / 2) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    filtrationStopTime  = (filtrationStartTime + filtrationDuration) % MINUTES_PER_DAY;

    if (isNaN(filtrationStartTime) || isNaN(filtrationStopTime)) {
      lastError = "Invalid filtration times calculated (start: " + filtrationStartTime + 
                  ", stop: " + filtrationStopTime + ", duration: " + filtrationDuration + 
                  ", center: " + centerMinutes + ")";
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
    // Frost protection is governed by the lowest available air temperature (Shelly sensor vs HA entity)
    if (airTemperatureMin === null) {
      // Do not toggle frostProtection without any air temperature data
      if (!lastError) {
        lastError = "No air temperature available: frost protection unchanged (need Shelly air sensor and/or HA air entity)";
      }
    } else {
      if (!frostProtection && airTemperatureMin <= freezeOn) frostProtection = true;
      if (frostProtection && airTemperatureMin >= freezeOff) frostProtection = false;
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
    airTemperatureSensor: airTemperatureSensor,
    airTemperatureMin: airTemperatureMin,
    maximumWaterTemperatureToday: maximumWaterTemperatureToday,
    maximumTemperatureYesterday: maximumTemperatureYesterday,
    filtrationStartTime: minutesToHHMM(filtrationStartTime),
    filtrationStopTime: minutesToHHMM(filtrationStopTime),
    lastPlanningTime: lastPlanningTime,
    filtrationDuration: toHours(filtrationDuration),
    filtrationState: filtrationState ? "ON" : "OFF",
    frostProtection: frostProtection ? "ON" : "OFF",
    controlMode: controlMode,
    filtrationStrategy: filtrationStrategy,
    filtrationReason: filtrationReason,
    lastError: lastError,
    freezeOn: freezeOn,
    freezeOff: freezeOff,
    minMinutes: minMinutes,
    maxMinutes: maxMinutes,
    noonMinutes: noonMinutes,
    filtrationCoeff: filtrationCoeff,
    winterMinutes: winterMinutes,
    winterCenterMinutes: winterCenterMinutes,
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

  if (filtrationStrategy !== "temperature_linear" && filtrationStrategy !== "winter_circulation") {
    filtrationStrategy = "temperature_linear";
    errors.push("Invalid filtrationStrategy: reset to temperature_linear");
    Shelly.call("KVS.Set", { key: "filtrationStrategy", value: String(filtrationStrategy) });
  }

  if (isNaN(winterMinutes) || winterMinutes < MIN_MINUTES_LIMIT || winterMinutes > MINUTES_PER_DAY) {
    winterMinutes = 120;
    errors.push("Invalid winterMinutes: reset to 120");
    Shelly.call("KVS.Set", { key: "winterMinutes", value: String(winterMinutes) });
  }

  if (isNaN(winterCenterMinutes) || winterCenterMinutes < 0 || winterCenterMinutes > (MINUTES_PER_DAY - 1)) {
    winterCenterMinutes = 420;
    errors.push("Invalid winterCenterMinutes: reset to 420");
    Shelly.call("KVS.Set", { key: "winterCenterMinutes", value: String(winterCenterMinutes) });
  }
  
  if (errors.length > 0) {
    lastError = "Parameter validation error: " + errors.join(", ");
  }
}

// ───── Initialization ─────
loadKVS([
  "homeAssistantIp", "homeAssistantToken", "homeAssistantAirTemperatureEntityId",
  "waterSensorId", "airSensorId", "maximumTemperatureYesterday",
  "freezeOn", "freezeOff", "minMinutes", "maxMinutes", "noonMinutes", "filtrationCoeff",
  "filtrationStrategy", "winterMinutes", "winterCenterMinutes"
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
  if (v.filtrationStrategy) filtrationStrategy = String(v.filtrationStrategy);
  if (v.winterMinutes) winterMinutes = parseInt(v.winterMinutes, 10);
  if (v.winterCenterMinutes) winterCenterMinutes = parseInt(v.winterCenterMinutes, 10);

  // Validate and auto-correct parameters
  validateParameters();

  runAutodiscoveryWhenReady();
  readWater();
  readAirSensor();
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
    readAirSensor();
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
