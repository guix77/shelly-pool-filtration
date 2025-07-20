/*****************************************************************************
 * Pool Filtration Controller — MQTT + Relay + Home Assistant
 * Stable version — All config exposed — Shelly Plus 1 compatible
 *****************************************************************************/

// ───── System constants ─────
const DEVICE_NAME      = "Pool filtration";
const MANUFACTURER     = "Shelly";
const ENTITY_PREFIX    = "pool_filtration";
const BASE_TOPIC       = "homeassistant";
const STATE_TOPIC      = "pool_filtration/state";
const CONTROL_MODE_TOPIC = "pool_filtration/control_mode/set";

// ───── Configurable parameters (modifiable depuis HA) ─────
let freezeOn    = 0.5;
let freezeOff   = 1.0;
let minMinutes  = 120;
let maxMinutes  = 960;
let noonMinutes = 825;
let filtrationCoeff = 1.0;                    // ⇦ NOUVEAU

// ───── Runtime state ─────
let homeAssistantIp                       = null;
let homeAssistantToken                    = null;
let homeAssistantAirTemperatureEntityId  = null;
let waterSensorId                         = 0;
let airSensorId                           = 1;

let waterTemperature            = null;
let airTemperature              = null;
let maximumTemperatureYesterday = 10;

let filtrationStartTime         = null;
let filtrationStopTime          = null;
let filtrationDuration          = null;
let lastPlanningTime            = null;

let filtrationState  = false;
let frostProtection  = false;
let controlMode      = "auto";
let filtrationReason = "off";
let lastError        = null;

// ───── Helpers ─────
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
function sanitizeMAC(mac) { return mac.split(":").join("_"); }

// ───── HTTP helper ─────
function haGET(path, cb) {
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
      if (err !== -1 && err !== 408) {
        lastError = "HA request error: " + path + " (code " + err + ")";
      }
      cb(null);
    }
  });
}

// ───── Generic numeric setter over MQTT ─────
function registerNumberListener(topic, setter, kvsKey) {
  MQTT.subscribe(topic, function (msg) {
    let v = parseFloat(msg);
    if (!isNaN(v)) {
      setter(v);
      Shelly.call("KVS.Set", { key: kvsKey, value: String(v) });
      publishState();
    }
  });
}

// ───── MQTT listeners ─────
MQTT.subscribe(CONTROL_MODE_TOPIC, function (msg) {
  if (msg === "auto" || msg === "manual_on" || msg === "manual_off") {
    controlMode = msg;
    publishState();
  }
});
MQTT.subscribe("pool_filtration/replan/set", function (msg) {
  if (msg === "ON") {
    lastError = "Replanification manuelle demandée";
    planFiltration();
    MQTT.publish("pool_filtration/replan/set", "", 0, true);
  }
});

registerNumberListener("pool_filtration/freeze_on/set", function (v) {
  if (v < freezeOff) freezeOn = v;
}, "freezeOn");
registerNumberListener("pool_filtration/freeze_off/set", function (v) {
  if (v > freezeOn) freezeOff = v;
}, "freezeOff");
registerNumberListener("pool_filtration/min_minutes/set",  function (v) { minMinutes  = v; }, "minMinutes");
registerNumberListener("pool_filtration/max_minutes/set",  function (v) { maxMinutes  = v; }, "maxMinutes");
registerNumberListener("pool_filtration/noon_minutes/set", function (v) { noonMinutes = v; }, "noonMinutes");
registerNumberListener("pool_filtration/coeff/set",        function (v) { filtrationCoeff = v; }, "filtrationCoeff");  // ⇦ NOUVEAU

// ───── Home Assistant Autodiscovery ─────
function autodiscovery() {
  var mac = sanitizeMAC(Shelly.getDeviceInfo().mac);
  function publish(path,obj){ MQTT.publish(path,JSON.stringify(obj),1,true); }

  function publishSensor(id,name,unit,dclass,icon,tpl){
    var o={name:name,uniq_id:ENTITY_PREFIX+id,stat_t:STATE_TOPIC,val_tpl:tpl,
      dev:{ids:["shelly_pool_"+mac],name:DEVICE_NAME,mf:MANUFACTURER}};
    if(unit)  o.unit_of_measurement=unit;
    if(dclass)o.device_class=dclass;
    if(icon)  o.icon=icon;
    if(id==="maximum_temperature_yesterday"||id==="last_planning_time"||
       id==="next_filtration_start_time"   ||id==="last_error"||
       id==="filtration_reason")
       o.entity_category="diagnostic";
    publish(BASE_TOPIC+"/sensor/"+ENTITY_PREFIX+id+"/config",o);
  }

  function publishBinarySensor(id,name,dclass,icon,tpl){
    var o={name:name,uniq_id:ENTITY_PREFIX+id,stat_t:STATE_TOPIC,val_tpl:tpl,
      payload_on:"ON",payload_off:"OFF",
      dev:{ids:["shelly_pool_"+mac],name:DEVICE_NAME,mf:MANUFACTURER}};
    if(dclass)o.device_class=dclass;
    if(icon)o.icon=icon;
    publish(BASE_TOPIC+"/binary_sensor/"+ENTITY_PREFIX+id+"/config",o);
  }

  function publishNumber(id,name,min,max,step,icon,tpl,cmd){
    var o={name:name,uniq_id:ENTITY_PREFIX+id,stat_t:STATE_TOPIC,val_tpl:tpl,
      cmd_t:cmd,min:min,max:max,step:step,
      dev:{ids:["shelly_pool_"+mac],name:DEVICE_NAME,mf:MANUFACTURER}};
    if(icon)o.icon=icon;
    if(id==="freeze_on"||id==="freeze_off"||id==="min_minutes"||
       id==="max_minutes"||id==="noon_minutes"||id==="coeff")   // ⇦ AJOUT
       o.entity_category="config";
    publish(BASE_TOPIC+"/number/"+ENTITY_PREFIX+id+"/config",o);
  }

  publishSensor("water_temperature","Water temperature","°C","temperature","mdi:waves","{{ value_json.waterTemperature }}");
  publishSensor("air_temperature","Air temperature","°C","temperature","mdi:weather-sunny","{{ value_json.airTemperature }}");
  publishSensor("maximum_temperature_yesterday","Max temp yesterday","°C","temperature","mdi:calendar-clock","{{ value_json.maximumTemperatureYesterday }}");
  publishSensor("filtration_start_time","Start time",null,null,"mdi:clock-start","{{ value_json.filtrationStartTime }}");
  publishSensor("filtration_stop_time","Stop time",null,null,"mdi:clock-end","{{ value_json.filtrationStopTime }}");
  publishSensor("last_planning_time","Last planning",null,"timestamp","mdi:calendar-range","{{ value_json.lastPlanningTime }}");
  publishSensor("filtration_duration","Duration","h","duration","mdi:timer","{{ value_json.filtrationDuration }}");
  publishSensor("filtration_reason","Reason",null,null,"mdi:comment-question-outline","{{ value_json.filtrationReason }}");
  publishSensor("last_error","Last error",null,null,"mdi:alert","{{ value_json.lastError }}");

  publishBinarySensor("filtration_state","Filtration state","running","mdi:pump","{{ value_json.filtrationState }}");
  publishBinarySensor("frost_protection","Frost protection","cold","mdi:snowflake","{{ value_json.frostProtection }}");

  publishNumber("freeze_on","Freeze ON",-10,10,0.1,"mdi:snowflake-alert","{{ value_json.freezeOn }}","pool_filtration/freeze_on/set");
  publishNumber("freeze_off","Freeze OFF",-10,10,0.1,"mdi:snowflake-off","{{ value_json.freezeOff }}","pool_filtration/freeze_off/set");
  publishNumber("min_minutes","Min minutes",30,1440,10,"mdi:timer-sand","{{ value_json.minMinutes }}","pool_filtration/min_minutes/set");
  publishNumber("max_minutes","Max minutes",30,1440,10,"mdi:timer-sand-full","{{ value_json.maxMinutes }}","pool_filtration/max_minutes/set");
  publishNumber("noon_minutes","Noon fallback",0,1439,1,"mdi:clock","{{ value_json.noonMinutes }}","pool_filtration/noon_minutes/set");
  publishNumber("coeff","Filtration coeff",0.5,2,0.1,"mdi:lambda","{{ value_json.filtrationCoeff }}","pool_filtration/coeff/set"); // ⇦ NOUVEAU

  publish(BASE_TOPIC+"/select/"+ENTITY_PREFIX+"control_mode/config", {
    name: "Control mode",
    unique_id: ENTITY_PREFIX + "control_mode",
    state_topic: STATE_TOPIC,
    value_template: "{{ value_json.controlMode }}",
    command_topic: CONTROL_MODE_TOPIC,
    options: ["auto", "manual_on", "manual_off"],
    icon: "mdi:account-switch",
    device: {
      identifiers: ["shelly_pool_" + mac],
      name: DEVICE_NAME,
      manufacturer: MANUFACTURER
    },
  });

  publish(BASE_TOPIC+"/switch/"+ENTITY_PREFIX+"replan/config", {
    name: "Replanifier",
    unique_id: ENTITY_PREFIX + "replan",
    command_topic: "pool_filtration/replan/set",
    payload_on: "ON",
    payload_off: "OFF",
    icon: "mdi:refresh",
    device: {
      identifiers: ["shelly_pool_" + mac],
      name: DEVICE_NAME,
      manufacturer: MANUFACTURER
    }
  });
}

// ───── Lecture capteurs ─────
function readWater() {
  let res = Shelly.getComponentStatus("temperature", waterSensorId);
  waterTemperature = (res && typeof res.tC === "number") ? res.tC : null;
}
function readAir() {
  haGET("states/" + homeAssistantAirTemperatureEntityId, function (body) {
    try {
      let t = parseFloat(JSON.parse(body).state);
      airTemperature = !isNaN(t) ? t : null;
    } catch (err) {
      airTemperature = null;
      lastError = "Erreur lecture température air : " + err.message;
    }
  });
}

// ───── Planification ─────
function planFiltration() {
  var localNoon = noonMinutes;
  haGET("states/sun.sun", function (body) {
    try {
      var d = new Date(JSON.parse(body).attributes.next_noon);
      if (!isNaN(d.getTime())) {
        localNoon = d.getHours() * 60 + d.getMinutes();
      } else {
        lastError = "HA sun.sun invalide, fallback noonMinutes";
      }
    } catch (_) {
      lastError = "Erreur parsing HA sun.sun, fallback noonMinutes";
    }

    // Durée = Tmax × 30 min × coeff (bornée)
    filtrationDuration = Math.max(
      minMinutes,
      Math.min(
        maxMinutes,
        Math.floor(maximumTemperatureYesterday * 30 * filtrationCoeff)   // ⇦ AJOUT coeff
      )
    );

    filtrationStartTime = (localNoon - Math.floor(filtrationDuration / 2) + 1440) % 1440;
    filtrationStopTime  = (filtrationStartTime + filtrationDuration) % 1440;
    lastPlanningTime = new Date().toISOString();

    publishState();
    updateFiltrationState();
  });
}

// ───── Logique relais ─────
function updateFiltrationState() {
  let now = new Date();
  let minutesNow = now.getHours() * 60 + now.getMinutes();

  if (filtrationStartTime === null || filtrationStopTime === null) {
    lastError = "Planning manquant — recalcul forcé";
    planFiltration();
    return;
  }

  if (controlMode === "manual_on") {
    filtrationState = true;  filtrationReason = "manual"; frostProtection = false;
  } else if (controlMode === "manual_off") {
    filtrationState = false; filtrationReason = "manual"; frostProtection = false;
  } else {
    if (!frostProtection && waterTemperature!==null && waterTemperature<=freezeOn) frostProtection = true;
    if (frostProtection && waterTemperature!==null && waterTemperature>=freezeOff) frostProtection = false;

    if (frostProtection) {
      filtrationState = true; filtrationReason = "frost";
    } else if (
      minutesNow >= filtrationStartTime &&
      minutesNow < filtrationStopTime
    ) {
      filtrationState = true; filtrationReason = "schedule";
    } else {
      filtrationState = false; filtrationReason = "off";
    }
  }

  Shelly.call("Switch.Set", { id: 0, on: filtrationState });
  publishState();
}

// ───── Publication état JSON ─────
function publishState() {
  MQTT.publish(STATE_TOPIC, JSON.stringify({
    waterTemperature: waterTemperature,
    airTemperature: airTemperature,
    maximumTemperatureYesterday: maximumTemperatureYesterday,
    filtrationStartTime: minutesToHHMM(filtrationStartTime),
    filtrationStopTime : minutesToHHMM(filtrationStopTime),
    lastPlanningTime: lastPlanningTime,
    filtrationDuration: toHours(filtrationDuration),
    filtrationState: filtrationState ? "ON" : "OFF",
    frostProtection: frostProtection ? "ON" : "OFF",
    controlMode: controlMode,
    filtrationReason: filtrationReason,
    lastError: lastError,
    freezeOn: freezeOn, freezeOff: freezeOff,
    minMinutes: minMinutes, maxMinutes: maxMinutes, noonMinutes: noonMinutes,
    filtrationCoeff: filtrationCoeff                           // ⇦ NOUVEAU
  }), 1, true);
}

// ───── Chargement KVS ─────
function loadKVS(keys, cb){
  let res={}, idx=0;
  function next(){ if(idx>=keys.length){cb(res);return;}
    Shelly.call("KVS.Get",{key:keys[idx]},function(r){
      if(r && r.value!==undefined && r.value!==null) res[keys[idx]]=r.value;
      idx++; next();
    });
  } next();
}

// ───── Init ─────
loadKVS([
  "homeAssistantIp","homeAssistantToken","homeAssistantAirTemperatureEntityId",
  "waterSensorId","airSensorId","maximumTemperatureYesterday",
  "freezeOn","freezeOff","minMinutes","maxMinutes","noonMinutes","filtrationCoeff"  // ⇦ AJOUT
], function(v){
  if(v.homeAssistantIp)                      homeAssistantIp=v.homeAssistantIp;
  if(v.homeAssistantToken)                   homeAssistantToken=v.homeAssistantToken;
  if(v.homeAssistantAirTemperatureEntityId)  homeAssistantAirTemperatureEntityId=v.homeAssistantAirTemperatureEntityId;
  if(v.waterSensorId)                        waterSensorId=parseInt(v.waterSensorId,10);
  if(v.airSensorId)                          airSensorId=parseInt(v.airSensorId,10);
  if(v.maximumTemperatureYesterday)          maximumTemperatureYesterday=parseFloat(v.maximumTemperatureYesterday);
  if(v.freezeOn)                             freezeOn=parseFloat(v.freezeOn);
  if(v.freezeOff)                            freezeOff=parseFloat(v.freezeOff);
  if(v.minMinutes)                           minMinutes=parseInt(v.minMinutes,10);
  if(v.maxMinutes)                           maxMinutes=parseInt(v.maxMinutes,10);
  if(v.noonMinutes)                          noonMinutes=parseInt(v.noonMinutes,10);
  if(v.filtrationCoeff)                      filtrationCoeff=parseFloat(v.filtrationCoeff);   // ⇦ AJOUT

  autodiscovery(); readWater(); readAir(); planFiltration();
});

// ───── Timers ─────
Timer.set(300000,true,function(){ readWater(); readAir(); },null);
Timer.set(60000,true,function(){ updateFiltrationState(); },null);
Timer.set(60000,true,function(){
  let now=new Date();
  if(now.getHours()===1 && now.getMinutes()===0 && waterTemperature!==null){
    maximumTemperatureYesterday=waterTemperature;
    Shelly.call("KVS.Set",{key:"maximumTemperatureYesterday",value:String(waterTemperature)});
    planFiltration();
  }
},null);
Timer.set(60000,true,function(){
  MQTT.publish("pool_filtration/availability", "online", 1, true);
},null);
