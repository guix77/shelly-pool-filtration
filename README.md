# Contrôleur de Filtration de Piscine pour Shelly Plus 1

Contrôleur intelligent de filtration de piscine utilisant MQTT et Home Assistant, conçu pour fonctionner sur un appareil Shelly Plus 1. Le système gère automatiquement la filtration en fonction de la température de l'eau, avec protection antigel intégrée et adaptation automatique pour l'hivernage actif.

## Table des matières

- [Prérequis](#prérequis)
- [Installation](#installation)
- [Configuration](#configuration)
- [Fonctionnement de la gestion de la piscine](#fonctionnement-de-la-gestion-de-la-piscine)
  - [Hivernage actif et protection antigel](#hivernage-actif-et-protection-antigel)
- [Topics MQTT](#topics-mqtt)
- [Entités Home Assistant](#entités-home-assistant)
- [Dépannage](#dépannage)

---

## Prérequis

- **Appareil Shelly Plus 1** avec firmware supportant les scripts
- **Broker MQTT** configuré et accessible
- **Home Assistant** avec API REST activée
- **Capteur de température** connecté au Shelly Plus 1 (pour la température de l'eau)
- **Entité de température d'air** dans Home Assistant (optionnelle mais recommandée)

---

## Installation

1. **Configurer MQTT sur le Shelly Plus 1**
   - Accédez à l'interface web du Shelly
   - Allez dans **Settings → MQTT**
   - Configurez votre broker MQTT avec les identifiants appropriés

2. **Configurer Home Assistant**
   - Assurez-vous que l'API REST est activée
   - Créez un token d'accès long terme dans Home Assistant
   - Notez l'adresse IP de votre instance Home Assistant

3. **Uploader le script**
   - Copiez le contenu de `shelly-pool-filtration.js`
   - Dans l'interface web du Shelly, allez dans **Scripts**
   - Créez un nouveau script et collez le code
   - Activez le script

4. **Configuration initiale via KVS**
   - Utilisez l'API Shelly ou l'interface web pour configurer les clés KVS suivantes :
     - `homeAssistantIp` : Adresse IP de Home Assistant
     - `homeAssistantToken` : Token d'accès Home Assistant
     - `homeAssistantAirTemperatureEntityId` : ID de l'entité de température d'air (ex: `sensor.temperature_exterieure`)
     - `waterSensorId` : ID du capteur de température d'eau (défaut: 0)
     - `airSensorId` : ID du capteur de température d'air (défaut: 1)

---

## Configuration

### Paramètres configurables via MQTT

Tous les paramètres peuvent être modifiés via MQTT et sont persistés dans le KVS :

| Paramètre | Topic MQTT | Défaut | Description |
|-----------|------------|--------|-------------|
| `freezeOn` | `pool_filtration/freeze_on/set` | 0.5°C | Température d'activation de l'antigel |
| `freezeOff` | `pool_filtration/freeze_off/set` | 1.0°C | Température de désactivation de l'antigel |
| `minMinutes` | `pool_filtration/min_minutes/set` | 120 min | Durée minimale de filtration quotidienne |
| `maxMinutes` | `pool_filtration/max_minutes/set` | 960 min | Durée maximale de filtration quotidienne |
| `noonMinutes` | `pool_filtration/noon_minutes/set` | 825 min | Heure de midi de repli (13h45) |
| `filtrationCoeff` | `pool_filtration/coeff/set` | 1.0 | Coefficient multiplicateur de la durée de filtration |

### Mode de contrôle

Le mode de contrôle peut être changé via le topic `pool_filtration/control_mode/set` :
- `auto` : Mode automatique (planning + antigel)
- `manual_on` : Filtration forcée ON
- `manual_off` : Filtration forcée OFF

---

## Fonctionnement de la gestion de la piscine

Le script gère la filtration de la piscine de manière intelligente et automatique en combinant plusieurs mécanismes :

### 1. Planification automatique basée sur la température

Le système calcule chaque jour la durée optimale de filtration en fonction de la **température maximale de l'eau de la veille**. La formule utilisée est :

```
Durée (minutes) = max(minMinutes, min(maxMinutes, TempératureMaxHier × 30 × filtrationCoeff))
```

**Exemple :** Si la température maximale d'hier était de 25°C avec un coefficient de 1.0 :
- Calcul : 25 × 30 × 1.0 = 750 minutes (12h30)
- Si minMinutes = 120 et maxMinutes = 960, la durée sera de 750 minutes

### 2. Centrage autour du midi solaire

La période de filtration est **centrée autour du midi solaire** (calculé automatiquement via Home Assistant ou utilise l'heure configurée en repli). Cela garantit que la filtration se produit pendant les heures les plus chaudes de la journée, optimisant l'efficacité du traitement de l'eau.

**Exemple :** Si le midi solaire est à 13h00 et que la durée calculée est de 6 heures :
- Début : 13h00 - 3h = 10h00
- Fin : 13h00 + 3h = 16h00

### 3. Mise à jour quotidienne

Chaque jour à **01h00**, le système :
1. Enregistre la température maximale de la veille
2. Réinitialise le compteur de température maximale du jour
3. Recalcule le planning de filtration pour la nouvelle journée

### 4. Lecture des températures

- **Température de l'eau** : Lue toutes les 5 minutes depuis le capteur connecté au Shelly
- **Température de l'air** : Lue toutes les 5 minutes depuis Home Assistant (pour information uniquement)
- **Suivi des maximums** : Le système suit automatiquement la température maximale quotidienne

### 5. Priorités de contrôle

Le système applique les priorités suivantes (du plus prioritaire au moins prioritaire) :

1. **Mode manuel** : Si `controlMode` est `manual_on` ou `manual_off`, le mode manuel a la priorité absolue
2. **Protection antigel** : Si activée, elle prend le dessus sur le planning normal
3. **Planning automatique** : Filtration selon le planning calculé

### 6. Replanification manuelle

Il est possible de forcer un recalcul du planning à tout moment en envoyant `ON` au topic `pool_filtration/replan/set`. Cela est utile après un changement de paramètres ou pour tester la configuration.

---

## Hivernage actif et protection antigel

### Principe de l'hivernage actif

En **hivernage actif**, la piscine reste remplie et fonctionnelle, mais avec des équipements réduits :
- ✅ **Filtration** : Maintenue (gérée par ce script)
- ❌ **Électrolyse** : Coupée
- ❌ **Contrôle de pH automatique** : Coupé
- ✅ **Traitement chimique** : Galets de chlore lent dans les skimmers

Le script s'adapte **automatiquement** à cette configuration sans nécessiter de changement de paramètres.

### Fonctionnement de la protection antigel

La protection antigel est un mécanisme **prioritaire** qui protège la piscine contre le gel en maintenant l'eau en circulation lorsque la température approche du point de congélation.

#### Seuils de température

Le système utilise deux seuils avec **hystérésis** pour éviter les basculements fréquents :

- **`freezeOn`** (défaut : 0.5°C) : Seuil d'**activation** de l'antigel
  - Quand la température de l'eau descend à 0.5°C ou en dessous, l'antigel s'active
  - La filtration est **forcée ON** immédiatement, indépendamment du planning

- **`freezeOff`** (défaut : 1.0°C) : Seuil de **désactivation** de l'antigel
  - Quand la température remonte à 1.0°C ou au-dessus, l'antigel se désactive
  - La filtration reprend son fonctionnement normal selon le planning

#### Pourquoi une hystérésis ?

L'écart de 0.5°C entre `freezeOn` et `freezeOff` évite que la pompe ne s'allume et s'éteigne en permanence lorsque la température oscille autour de 0°C. Cela protège également l'équipement contre les cycles trop fréquents.

#### Comportement en hivernage actif

Pendant l'hivernage actif, plusieurs phénomènes se produisent simultanément :

1. **Températures plus basses** : La température maximale quotidienne est généralement plus basse (ex: 8-15°C au lieu de 25-30°C)

2. **Durée de filtration réduite automatiquement** :
   - Exemple avec température max de 10°C : 10 × 30 × 1.0 = 300 minutes (5h)
   - Le système réduit naturellement la durée de filtration sans intervention

3. **Activation fréquente de l'antigel** :
   - Les nuits froides peuvent déclencher l'antigel
   - La pompe tourne en continu jusqu'à ce que la température remonte
   - Cela protège les canalisations et l'équipement contre le gel

4. **Planning toujours actif** :
   - Même en hiver, le planning continue de fonctionner
   - La filtration se fait pendant les heures les plus chaudes (autour du midi)
   - L'antigel prend le relais la nuit si nécessaire

#### Exemple concret en hivernage actif

**Scénario :** Température maximale d'hier = 12°C, nuit à -2°C

**Journée type :**
- **01h00** : Recalcul du planning → Durée = 12 × 30 = 360 minutes (6h)
- **02h00** : Température eau = 0.3°C → **Antigel activé** → Filtration ON
- **08h00** : Température eau = 1.2°C → Antigel désactivé → Retour au planning
- **10h00** : Début du planning (centré sur midi) → Filtration ON
- **16h00** : Fin du planning → Filtration OFF
- **23h00** : Température eau = 0.4°C → **Antigel activé** → Filtration ON

**Résultat :** La piscine est protégée contre le gel la nuit, et la filtration quotidienne continue de fonctionner pour maintenir l'eau propre.

### Ajustement des paramètres pour l'hivernage

Bien que le système s'adapte automatiquement, vous pouvez ajuster les paramètres pour optimiser l'hivernage :

- **Réduire `minMinutes`** : Si vous voulez moins de filtration en hiver (ex: 60-90 minutes)
- **Ajuster `freezeOn` et `freezeOff`** : Selon votre climat local
  - Climat doux : `freezeOn = 1.0°C`, `freezeOff = 2.0°C`
  - Climat froid : `freezeOn = 0.0°C`, `freezeOff = 1.0°C`
- **Réduire `filtrationCoeff`** : Pour diminuer la durée de filtration (ex: 0.7-0.8)

---

## Topics MQTT

### Publication (état)

- **`pool_filtration/state`** : État complet du système (JSON)
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

- **`pool_filtration/alive`** : Signal de vie (ON/OFF, expire après 5 minutes)

### Souscription (commandes)

- **`pool_filtration/control_mode/set`** : Changer le mode (`auto`, `manual_on`, `manual_off`)
- **`pool_filtration/freeze_on/set`** : Définir le seuil d'activation antigel (nombre)
- **`pool_filtration/freeze_off/set`** : Définir le seuil de désactivation antigel (nombre)
- **`pool_filtration/min_minutes/set`** : Durée minimale de filtration (nombre)
- **`pool_filtration/max_minutes/set`** : Durée maximale de filtration (nombre)
- **`pool_filtration/noon_minutes/set`** : Heure de midi de repli en minutes (0-1439)
- **`pool_filtration/coeff/set`** : Coefficient de filtration (nombre)
- **`pool_filtration/replan/set`** : Forcer un recalcul du planning (envoyer `ON`)

---

## Entités Home Assistant

Le script publie automatiquement la configuration d'autodiscovery Home Assistant. Toutes les entités sont regroupées sous le même appareil "Pool filtration".

### Capteurs

- `pool_filtration_water_temperature` : Température de l'eau (°C)
- `pool_filtration_air_temperature` : Température de l'air (°C)
- `pool_filtration_maximum_water_temperature_today` : Température max du jour (°C)
- `pool_filtration_maximum_temperature_yesterday` : Température max d'hier (°C)
- `pool_filtration_filtration_start_time` : Heure de début (HH:MM)
- `pool_filtration_filtration_stop_time` : Heure de fin (HH:MM)
- `pool_filtration_filtration_duration` : Durée de filtration (heures)
- `pool_filtration_filtration_reason` : Raison de la filtration (schedule/frost/manual/off)
- `pool_filtration_last_planning_time` : Dernière planification (timestamp)
- `pool_filtration_last_error` : Dernière erreur (si applicable)
- `pool_filtration_heartbeat` : Signal de vie (timestamp)

### Capteurs binaires

- `pool_filtration_filtration_state` : État de la filtration (ON/OFF)
- `pool_filtration_frost_protection` : Protection antigel active (ON/OFF)
- `pool_filtration_alive` : Appareil en ligne (ON/OFF, expire après 5 min)

### Contrôles

- `pool_filtration_control_mode` : Sélecteur de mode (auto/manual_on/manual_off)
- `pool_filtration_freeze_on` : Réglage seuil activation antigel
- `pool_filtration_freeze_off` : Réglage seuil désactivation antigel
- `pool_filtration_min_minutes` : Réglage durée minimale
- `pool_filtration_max_minutes` : Réglage durée maximale
- `pool_filtration_noon_minutes` : Réglage heure de midi
- `pool_filtration_coeff` : Réglage coefficient de filtration
- `pool_filtration_replan` : Bouton de replanification

---

## Dépannage

### La filtration ne démarre pas

1. Vérifiez que le mode de contrôle n'est pas sur `manual_off`
2. Vérifiez que MQTT est connecté (entité `pool_filtration_alive` doit être ON)
3. Vérifiez les logs du script dans l'interface Shelly
4. Vérifiez que `filtrationStartTime` et `filtrationStopTime` sont définis

### L'antigel ne s'active pas

1. Vérifiez que la température de l'eau est bien lue (`waterTemperature` non null)
2. Vérifiez les seuils `freezeOn` et `freezeOff`
3. Vérifiez que le mode n'est pas sur `manual_off`

### Le planning ne se recalcule pas

1. Vérifiez que Home Assistant est accessible
2. Vérifiez que `homeAssistantIp` et `homeAssistantToken` sont corrects
3. Vérifiez que l'entité `sun.sun` existe dans Home Assistant
4. Utilisez le bouton `replan` pour forcer un recalcul

### Erreurs Home Assistant

1. Vérifiez que l'API REST est activée
2. Vérifiez que le token a les permissions nécessaires
3. Vérifiez que l'IP est correcte et accessible depuis le Shelly
4. Consultez `last_error` dans l'état MQTT pour plus de détails

### Température non lue

1. Vérifiez que le capteur de température est bien connecté
2. Vérifiez que `waterSensorId` correspond au bon capteur
3. Vérifiez la connexion du capteur dans l'interface Shelly

---

## Notes techniques

- Le script utilise un seul timer principal qui s'exécute toutes les minutes
- Les températures sont lues toutes les 5 minutes
- Le planning est recalculé chaque jour à 01h00
- Tous les paramètres sont persistés dans le KVS du Shelly
- L'autodiscovery Home Assistant est publiée automatiquement au démarrage

---

## Licence

Ce projet est fourni tel quel, sans garantie. Utilisez à vos propres risques.

