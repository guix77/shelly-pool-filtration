/*****************************************************************************
 * Pool Filtration Controller — MQTT + Relay + Home Assistant
 * Stable version — Single timer loop — Shelly Plus 1 compatible
 *****************************************************************************/

// ───── System constants ─────
const DEVICE_NAME        = "Pool filtration";
const MANUFACTURER       = "Shelly";
const ENTITY_PREFIX      = "pool_filtration";
const BASE_TOPIC         = "homeassistant";
const STATE_TOPIC        = "pool_filtration/state";
const CONTROL_MODE_TOPIC = "pool_filtration/control_mode/set";

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
function minutesToHHMM(minutes) {
  if (minutes === null) return "--:--";
  let total = ((minutes % 1440) + 1440) % 1440;
  let h = Math.floor(total / 60);
  let m = total % 60;
  return ("0" + h).slice(-2) + ":" + ("0" + m).slice(-2);
}

function toHours(minutes) {
  return minutes !== null ? Math.round((minutes / 60) * 10) / 10 : null;
}

function sanitizeMAC(mac) {
  return mac.split(":").join("_");
}

// ───── Home Assistant HTTP helper ─────
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
    timeout: 5
  }, function (res, err) {
    if (err === 0) {
      lastError = null;
      cb(res.body);
    } else {
      // Error -1: Request cancelled (ignored, can happen during shutdown)
      // Error 408: Request timeout (ignored, network may be temporarily unavailable)
      if (err !== -1 && err !== 408) {
        lastError = "HA request error: " + path + " (code " + err + ")";
      }
      cb(null);
    }
  });
}

// ───── MQTT input handlers ─────
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
  return v >= 30 && v <= 1440 && v <= maxMinutes;
});

registerNumberListener("pool_filtration/max_minutes/set", function (v) {
  maxMinutes = v;
}, "maxMinutes", function (v) {
  return v >= 30 && v <= 1440 && v >= minMinutes;
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
  enqueueNumber("min_minutes", "Min minutes", 30, 1440, 10, "mdi:timer-sand", "{{ value_json.minMinutes }}", "pool_filtration/min_minutes/set");
  enqueueNumber("max_minutes", "Max minutes", 30, 1440, 10, "mdi:timer-sand-full", "{{ value_json.maxMinutes }}", "pool_filtration/max_minutes/set");
  enqueueNumber("noon_minutes", "Noon fallback", 0, 1439, 1, "mdi:clock", "{{ value_json.noonMinutes }}", "pool_filtration/noon_minutes/set");
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
function readWater() {
  let res = Shelly.getComponentStatus("temperature", waterSensorId);
  waterTemperature = (res && typeof res.tC === "number") ? res.tC : null;

  if (waterTemperature !== null) {
    if (maximumWaterTemperatureToday === null || waterTemperature > maximumWaterTemperatureToday) {
      maximumWaterTemperatureToday = waterTemperature;
    }
  }
}

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
      lastError = "Air temperature read error: " + err.message;
    }
  });
}

// ───── Filtration planning ─────
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
        Math.floor(tempForCalculation * 30 * filtrationCoeff)
      )
    );

    if (isNaN(filtrationDuration) || filtrationDuration < 0) {
      lastError = "Invalid filtration duration calculated";
      filtrationDuration = minMinutes;
    }

    filtrationStartTime = (localNoon - Math.floor(filtrationDuration / 2) + 1440) % 1440;
    filtrationStopTime  = (filtrationStartTime + filtrationDuration) % 1440;

    if (isNaN(filtrationStartTime) || isNaN(filtrationStopTime)) {
      lastError = "Invalid filtration times calculated";
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
function updateFiltrationState() {
  let now = new Date();
  let minutesNow = now.getHours() * 60 + now.getMinutes();

  if (filtrationStartTime === null || filtrationStopTime === null) {
    lastError = "Missing schedule";
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
    if (!frostProtection && waterTemperature !== null && waterTemperature <= freezeOn) frostProtection = true;
    if (frostProtection && waterTemperature !== null && waterTemperature >= freezeOff) frostProtection = false;

    if (frostProtection) {
      filtrationState = true;
      filtrationReason = "frost";
    } else if (minutesNow >= filtrationStartTime && minutesNow < filtrationStopTime) {
      filtrationState = true;
      filtrationReason = "schedule";
    } else {
      filtrationState = false;
      filtrationReason = "off";
    }
  }

  Shelly.call("Switch.Set", { id: 0, on: filtrationState });
  publishState();
}

// ───── MQTT state publication ─────
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
function mqttConnected() {
  let st = Shelly.getComponentStatus("mqtt");
  return st && st.connected;
}

function runAutodiscoveryWhenReady() {
  if (mqttConnected()) {
    autodiscovery();
  } else {
    Timer.set(2000, false, runAutodiscoveryWhenReady);
  }
}

// ───── Load configuration from KVS ─────
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

Timer.set(60000, true, function () {
  let now = new Date();
  loopCount++;

  // Every 5 minutes
  if (loopCount % 5 === 0) {
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
    }
    maximumWaterTemperatureToday = waterTemperature !== null ? waterTemperature : maximumWaterTemperatureToday;
    planFiltration();
  }
});
