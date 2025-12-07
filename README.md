# Pool Filtration Controller for Shelly Plus 1

Intelligent pool filtration controller using MQTT and Home Assistant, designed to run on a Shelly Plus 1 device. The system automatically manages filtration based on water temperature, with integrated frost protection and automatic adaptation for active winterization.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Pool Management Operation](#pool-management-operation)
  - [Active Winterization and Frost Protection](#active-winterization-and-frost-protection)
- [MQTT Topics](#mqtt-topics)
- [Home Assistant Entities](#home-assistant-entities)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Shelly Plus 1 device** with firmware supporting scripts
- **MQTT broker** configured and accessible
- **Home Assistant** with REST API enabled
- **Temperature sensor** connected to the Shelly Plus 1 (for water temperature)
- **Air temperature entity** in Home Assistant (optional but recommended)

---

## Installation

1. **Configure MQTT on Shelly Plus 1**
   - Access the Shelly web interface
   - Go to **Settings → MQTT**
   - Configure your MQTT broker with appropriate credentials

2. **Configure Home Assistant**
   - Ensure the REST API is enabled
   - Create a long-lived access token in Home Assistant
   - Note the IP address of your Home Assistant instance

3. **Upload the script**
   - Copy the contents of `shelly-pool-filtration.js`
   - In the Shelly web interface, go to **Scripts**
   - Create a new script and paste the code
   - Enable the script

4. **Initial configuration via KVS**
   - Use the Shelly API or web interface to configure the following KVS keys:
     - `homeAssistantIp` : Home Assistant IP address
     - `homeAssistantToken` : Home Assistant access token
     - `homeAssistantAirTemperatureEntityId` : Air temperature entity ID (e.g., `sensor.temperature_exterieure`)
     - `waterSensorId` : Water temperature sensor ID (default: 0)
     - `airSensorId` : Air temperature sensor ID (default: 1)

---

## Configuration

### Configurable parameters via MQTT

All parameters can be modified via MQTT and are persisted in KVS:

| Parameter | MQTT Topic | Default | Description |
|-----------|------------|---------|-------------|
| `freezeOn` | `pool_filtration/freeze_on/set` | 0.5°C | Frost protection activation threshold |
| `freezeOff` | `pool_filtration/freeze_off/set` | 1.0°C | Frost protection deactivation threshold |
| `minMinutes` | `pool_filtration/min_minutes/set` | 120 min | Minimum daily filtration duration |
| `maxMinutes` | `pool_filtration/max_minutes/set` | 960 min | Maximum daily filtration duration |
| `noonMinutes` | `pool_filtration/noon_minutes/set` | 825 min | Fallback noon time (13:45) |
| `filtrationCoeff` | `pool_filtration/coeff/set` | 1.0 | Filtration duration multiplier coefficient |

### Control mode

The control mode can be changed via the `pool_filtration/control_mode/set` topic:
- `auto` : Automatic mode (scheduling + frost protection)
- `manual_on` : Forced filtration ON
- `manual_off` : Forced filtration OFF

---

## Pool Management Operation

The script manages pool filtration intelligently and automatically by combining several mechanisms:

### 1. Automatic temperature-based scheduling

The system calculates the optimal daily filtration duration based on **yesterday's maximum water temperature**. The formula used is:

```
Duration (minutes) = max(minMinutes, min(maxMinutes, MaxTempYesterday × 30 × filtrationCoeff))
```

**Example:** If yesterday's maximum temperature was 25°C with a coefficient of 1.0:
- Calculation: 25 × 30 × 1.0 = 750 minutes (12h30)
- If minMinutes = 120 and maxMinutes = 960, the duration will be 750 minutes

### 2. Centering around solar noon

The filtration period is **centered around solar noon** (calculated automatically via Home Assistant or uses the configured fallback time). This ensures that filtration occurs during the warmest hours of the day, optimizing water treatment efficiency.

**Example:** If solar noon is at 1:00 PM and the calculated duration is 6 hours:
- Start: 1:00 PM - 3h = 10:00 AM
- End: 1:00 PM + 3h = 4:00 PM

### 3. Daily update

Every day at **01:00**, the system:
1. Records yesterday's maximum temperature
2. Resets the day's maximum temperature counter
3. Recalculates the filtration schedule for the new day

### 4. Temperature readings

- **Water temperature** : Read every 5 minutes from the sensor connected to the Shelly
- **Air temperature** : Read every 5 minutes from Home Assistant (for information only)
- **Maximum tracking** : The system automatically tracks the daily maximum temperature

### 5. Control priorities

The system applies the following priorities (from most to least priority):

1. **Manual mode** : If `controlMode` is `manual_on` or `manual_off`, manual mode has absolute priority
2. **Frost protection** : If activated, it overrides normal scheduling
3. **Automatic scheduling** : Filtration according to calculated schedule

### 6. Manual replanning

It is possible to force a schedule recalculation at any time by sending `ON` to the `pool_filtration/replan/set` topic. This is useful after changing parameters or to test the configuration.

---

## Active Winterization and Frost Protection

### Active winterization principle

In **active winterization**, the pool remains filled and functional, but with reduced equipment:
- ✅ **Filtration** : Maintained (managed by this script)
- ❌ **Electrolysis** : Disabled
- ❌ **Automatic pH control** : Disabled
- ✅ **Chemical treatment** : Slow-release chlorine tablets in skimmers

The script **automatically** adapts to this configuration without requiring parameter changes.

### Frost protection operation

Frost protection is a **priority** mechanism that protects the pool against freezing by keeping water circulating when temperature approaches the freezing point.

#### Temperature thresholds

The system uses two thresholds with **hysteresis** to avoid frequent toggling:

- **`freezeOn`** (default: 0.5°C) : Frost protection **activation** threshold
  - When water temperature drops to 0.5°C or below, frost protection activates
  - Filtration is **forced ON** immediately, regardless of schedule

- **`freezeOff`** (default: 1.0°C) : Frost protection **deactivation** threshold
  - When temperature rises to 1.0°C or above, frost protection deactivates
  - Filtration resumes normal operation according to schedule

#### Why hysteresis?

The 0.5°C gap between `freezeOn` and `freezeOff` prevents the pump from constantly turning on and off when temperature oscillates around 0°C. This also protects equipment against excessive cycling.

#### Behavior during active winterization

During active winterization, several phenomena occur simultaneously:

1. **Lower temperatures** : Daily maximum temperature is generally lower (e.g., 8-15°C instead of 25-30°C)

2. **Automatically reduced filtration duration** :
   - Example with max temperature of 10°C: 10 × 30 × 1.0 = 300 minutes (5h)
   - The system naturally reduces filtration duration without intervention

3. **Frequent frost protection activation** :
   - Cold nights can trigger frost protection
   - The pump runs continuously until temperature rises
   - This protects pipes and equipment against freezing

4. **Schedule always active** :
   - Even in winter, the schedule continues to function
   - Filtration occurs during the warmest hours (around noon)
   - Frost protection takes over at night if necessary

#### Concrete example during active winterization

**Scenario:** Yesterday's maximum temperature = 12°C, night at -2°C

**Typical day:**
- **01:00** : Schedule recalculation → Duration = 12 × 30 = 360 minutes (6h)
- **02:00** : Water temperature = 0.3°C → **Frost protection activated** → Filtration ON
- **08:00** : Water temperature = 1.2°C → Frost protection deactivated → Return to schedule
- **10:00** : Schedule start (centered on noon) → Filtration ON
- **16:00** : Schedule end → Filtration OFF
- **23:00** : Water temperature = 0.4°C → **Frost protection activated** → Filtration ON

**Result:** The pool is protected against freezing at night, and daily filtration continues to function to keep water clean.

### Parameter adjustment for winterization

Although the system adapts automatically, you can adjust parameters to optimize winterization:

- **Reduce `minMinutes`** : If you want less filtration in winter (e.g., 60-90 minutes)
- **Adjust `freezeOn` and `freezeOff`** : According to your local climate
  - Mild climate: `freezeOn = 1.0°C`, `freezeOff = 2.0°C`
  - Cold climate: `freezeOn = 0.0°C`, `freezeOff = 1.0°C`
- **Reduce `filtrationCoeff`** : To decrease filtration duration (e.g., 0.7-0.8)

---

## MQTT Topics

### Publication (state)

- **`pool_filtration/state`** : Complete system state (JSON)
  ```json
  {
    "waterTemperature": 25.5,
    "airTemperature": 22.0,
    "maximumWaterTemperatureToday": 26.0,
    "maximumTemperatureYesterday": 25.8,
    "filtrationStartTime": "10:00",
    "filtrationStopTime": "16:00",
    "lastPlanningTime": "2024-01-15T01:00:00.000Z",
    "filtrationDuration": 6.0,
    "filtrationState": "ON",
    "frostProtection": "OFF",
    "controlMode": "auto",
    "filtrationReason": "schedule",
    "lastError": null,
    "freezeOn": 0.5,
    "freezeOff": 1.0,
    "minMinutes": 120,
    "maxMinutes": 960,
    "noonMinutes": 825,
    "filtrationCoeff": 1.0,
    "heartbeat": "2024-01-15T14:30:00.000Z"
  }
  ```

- **`pool_filtration/alive`** : Heartbeat signal (ON/OFF, expires after 5 minutes)

### Subscription (commands)

- **`pool_filtration/control_mode/set`** : Change mode (`auto`, `manual_on`, `manual_off`)
- **`pool_filtration/freeze_on/set`** : Set frost protection activation threshold (number)
- **`pool_filtration/freeze_off/set`** : Set frost protection deactivation threshold (number)
- **`pool_filtration/min_minutes/set`** : Minimum filtration duration (number)
- **`pool_filtration/max_minutes/set`** : Maximum filtration duration (number)
- **`pool_filtration/noon_minutes/set`** : Fallback noon time in minutes (0-1439)
- **`pool_filtration/coeff/set`** : Filtration coefficient (number)
- **`pool_filtration/replan/set`** : Force schedule recalculation (send `ON`)

---

## Home Assistant Entities

The script automatically publishes Home Assistant autodiscovery configuration. All entities are grouped under the same "Pool filtration" device.

### Sensors

- `pool_filtration_water_temperature` : Water temperature (°C)
- `pool_filtration_air_temperature` : Air temperature (°C)
- `pool_filtration_maximum_water_temperature_today` : Today's max temperature (°C)
- `pool_filtration_maximum_temperature_yesterday` : Yesterday's max temperature (°C)
- `pool_filtration_filtration_start_time` : Start time (HH:MM)
- `pool_filtration_filtration_stop_time` : Stop time (HH:MM)
- `pool_filtration_filtration_duration` : Filtration duration (hours)
- `pool_filtration_filtration_reason` : Filtration reason (schedule/frost/manual/off)
- `pool_filtration_last_planning_time` : Last planning (timestamp)
- `pool_filtration_last_error` : Last error (if applicable)
- `pool_filtration_heartbeat` : Heartbeat signal (timestamp)

### Binary sensors

- `pool_filtration_filtration_state` : Filtration state (ON/OFF)
- `pool_filtration_frost_protection` : Frost protection active (ON/OFF)
- `pool_filtration_alive` : Device online (ON/OFF, expires after 5 min)

### Controls

- `pool_filtration_control_mode` : Mode selector (auto/manual_on/manual_off)
- `pool_filtration_freeze_on` : Frost activation threshold setting
- `pool_filtration_freeze_off` : Frost deactivation threshold setting
- `pool_filtration_min_minutes` : Minimum duration setting
- `pool_filtration_max_minutes` : Maximum duration setting
- `pool_filtration_noon_minutes` : Noon time setting
- `pool_filtration_coeff` : Filtration coefficient setting
- `pool_filtration_replan` : Replanning button

---

## Troubleshooting

### Filtration does not start

1. Check that control mode is not set to `manual_off`
2. Check that MQTT is connected (`pool_filtration_alive` entity must be ON)
3. Check script logs in the Shelly interface
4. Check that `filtrationStartTime` and `filtrationStopTime` are defined

### Frost protection does not activate

1. Check that water temperature is being read (`waterTemperature` not null)
2. Check `freezeOn` and `freezeOff` thresholds
3. Check that mode is not set to `manual_off`

### Schedule does not recalculate

1. Check that Home Assistant is accessible
2. Check that `homeAssistantIp` and `homeAssistantToken` are correct
3. Check that the `sun.sun` entity exists in Home Assistant
4. Use the `replan` button to force a recalculation

### Home Assistant errors

1. Check that the REST API is enabled
2. Check that the token has necessary permissions
3. Check that the IP is correct and accessible from the Shelly
4. Check `last_error` in MQTT state for more details

### Temperature not read

1. Check that the temperature sensor is properly connected
2. Check that `waterSensorId` corresponds to the correct sensor
3. Check sensor connection in the Shelly interface

---

## Technical Notes

- The script uses a single main timer that runs every minute
- Temperatures are read every 5 minutes
- The schedule is recalculated every day at 01:00
- All parameters are persisted in the Shelly KVS
- Home Assistant autodiscovery is published automatically on startup

---

## License

This project is provided as-is, without warranty. Use at your own risk.

