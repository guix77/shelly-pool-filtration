# Audit du Projet Shelly Pool Filtration

**Date:** 2024  
**Version du code:** Stable version — Single timer loop — Shelly Plus 1 compatible  
**Fichier audité:** `shelly-pool-filtration.js` (485 lignes)

---

## Résumé Exécutif

Ce projet est un contrôleur de filtration de piscine pour appareil Shelly Plus 1, intégrant MQTT et Home Assistant. Le code est fonctionnel mais présente plusieurs problèmes de sécurité, de robustesse et de maintenabilité qui nécessitent des améliorations.

**Score global:** 6/10

**Points forts:**
- Code fonctionnel et structuré
- Intégration MQTT et Home Assistant bien implémentée
- Gestion de l'autodiscovery Home Assistant complète
- Logique de filtration intelligente avec protection anti-gel

**Points faibles:**
- Absence de validation d'entrée (sécurité)
- Gestion d'erreur incomplète
- Absence de documentation
- Risques de bugs en cas de valeurs nulles
- Pas de tests

---

## 1. Sécurité

### 🔴 Critique: Validation d'entrée MQTT manquante

**Problème:** Les messages MQTT ne sont pas validés avant traitement, permettant potentiellement des injections ou des valeurs invalides.

**Localisation:**
- Lignes 84-91: `registerNumberListener` accepte n'importe quel `parseFloat`
- Lignes 94-99: `controlMode` accepte n'importe quelle chaîne
- Ligne 101-107: `replan` ne vérifie que `=== "ON"`

**Risque:** Un attaquant pourrait envoyer des valeurs extrêmes via MQTT, causant un comportement inattendu ou une panne du système.

**Recommandation:**
```javascript
function registerNumberListener(topic, setter, kvsKey, validator) {
  MQTT.subscribe(topic, function (msg) {
    let v = parseFloat(msg);
    if (!isNaN(v) && validator && validator(v)) {
      setter(v);
      Shelly.call("KVS.Set", { key: kvsKey, value: String(v) });
      publishState();
    }
  });
}
```

### 🟡 Moyen: Token Home Assistant en clair

**Problème:** Le token Home Assistant est stocké en clair dans le KVS (Key-Value Store) de Shelly.

**Localisation:** Lignes 425, 430

**Risque:** Si l'accès physique ou logique au dispositif est compromis, le token peut être extrait.

**Recommandation:** Documenter que le token est stocké en clair et recommander de limiter les permissions du token dans Home Assistant.

### 🟡 Moyen: Pas de validation de l'IP Home Assistant

**Problème:** L'IP Home Assistant n'est pas validée (format, accessibilité).

**Localisation:** Ligne 66

**Risque:** Une IP invalide pourrait causer des erreurs ou des comportements inattendus.

**Recommandation:** Ajouter une validation de format IP et une vérification de connectivité au démarrage.

### 🟡 Moyen: Pas de validation des limites pour les paramètres configurables

**Problème:** Les valeurs configurées via MQTT ne sont pas validées contre des limites raisonnables.

**Localisation:** Lignes 109-131

**Risque:** Des valeurs extrêmes (ex: `minMinutes = 10000`) pourraient causer des bugs.

**Recommandation:** Ajouter des validations de limites cohérentes avec les valeurs min/max définies dans l'autodiscovery (lignes 212-217).

---

## 2. Robustesse et Gestion d'Erreurs

### 🔴 Critique: Appel de `readAir()` avec `homeAssistantAirTemperatureEntityId` null

**Problème:** `readAir()` est appelée même si `homeAssistantAirTemperatureEntityId` est null, générant une URL invalide.

**Localisation:** Lignes 292-302, 444

**Impact:** Erreur HTTP inutile et pollution des logs.

**Recommandation:**
```javascript
function readAir() {
  if (!homeAssistantAirTemperatureEntityId) {
    airTemperature = null;
    return;
  }
  haGET("states/" + homeAssistantAirTemperatureEntityId, function (body) {
    // ... reste du code
  });
}
```

### 🔴 Critique: Calcul de `filtrationDuration` avec valeur potentiellement null

**Problème:** `planFiltration()` calcule `filtrationDuration` en utilisant `maximumTemperatureYesterday` qui peut être null.

**Localisation:** Lignes 315-321

**Impact:** `Math.floor(null * 30 * filtrationCoeff)` = `NaN`, ce qui peut causer des problèmes dans les calculs suivants.

**Recommandation:**
```javascript
filtrationDuration = Math.max(
  minMinutes,
  Math.min(
    maxMinutes,
    Math.floor((maximumTemperatureYesterday || 0) * 30 * filtrationCoeff)
  )
);
```

### 🟡 Moyen: Pas de vérification de `homeAssistantIp` et `homeAssistantToken` avant les appels HTTP

**Problème:** `haGET()` est appelée sans vérifier que `homeAssistantIp` et `homeAssistantToken` sont définis.

**Localisation:** Lignes 63-80, 307, 293

**Impact:** Erreurs HTTP inutiles si la configuration n'est pas complète.

**Recommandation:** Ajouter des vérifications au début de `haGET()`.

### 🟡 Moyen: Gestion d'erreur partielle dans `haGET()`

**Problème:** Certains codes d'erreur sont ignorés (`-1`, `408`) sans log explicite.

**Localisation:** Lignes 74-76

**Impact:** Difficulté à diagnostiquer certains problèmes de connectivité.

**Recommandation:** Documenter pourquoi ces codes sont ignorés ou les logger différemment.

### 🟡 Moyen: Timer d'autodiscovery peut créer une fuite mémoire

**Problème:** Si MQTT ne se connecte jamais, le timer dans `runAutodiscoveryWhenReady()` continue indéfiniment.

**Localisation:** Lignes 403-409

**Impact:** Consommation mémoire et CPU inutile.

**Recommandation:** Ajouter un compteur de tentatives maximum ou un mécanisme de backoff exponentiel.

### 🟡 Moyen: Pas de validation que `freezeOn < freezeOff` après modification

**Problème:** Les fonctions `registerNumberListener` pour `freezeOn` et `freezeOff` vérifient la relation, mais seulement dans un sens.

**Localisation:** Lignes 109-115

**Impact:** Si `freezeOff` est modifié en premier avec une valeur < `freezeOn`, la validation échoue.

**Recommandation:** Valider la relation dans les deux sens ou utiliser une fonction de validation centralisée.

---

## 3. Qualité du Code

### 🟡 Moyen: Variables globales nombreuses

**Problème:** Le code utilise de nombreuses variables globales, rendant le code difficile à tester et à maintenir.

**Localisation:** Lignes 15-43

**Impact:** Risque de collisions, difficulté de test unitaire, maintenance complexe.

**Recommandation:** Encapsuler dans un objet ou utiliser un pattern module.

### 🟡 Moyen: Absence de documentation

**Problème:** Aucun commentaire JSDoc, pas de README, pas de documentation des paramètres.

**Impact:** Difficulté pour les nouveaux développeurs de comprendre le code.

**Recommandation:** 
- Ajouter des commentaires JSDoc pour les fonctions principales
- Créer un README.md avec instructions d'installation et configuration
- Documenter les topics MQTT et leur format

### 🟢 Mineur: Code monolithique

**Note:** Tout le code est dans un seul fichier, ce qui est une **contrainte de la plateforme Shelly**. Les scripts Shelly fonctionnent avec un seul fichier monolithique et ne supportent pas la séparation en modules multiples.

**Impact:** Fichier long (485 lignes), mais c'est la structure attendue et appropriée pour l'environnement Shelly. La structure actuelle est donc correcte et ne nécessite pas de modification.

### 🟢 Mineur: Magic numbers

**Problème:** Plusieurs valeurs magiques dans le code (ex: `1440`, `30`, `5`, `60000`).

**Localisation:** Lignes 48, 319, 466, 461

**Recommandation:** Définir des constantes nommées:
```javascript
const MINUTES_PER_DAY = 1440;
const TEMPERATURE_TO_MINUTES_FACTOR = 30;
const WATER_READ_INTERVAL = 5; // minutes
const MAIN_LOOP_INTERVAL = 60000; // ms
```

---

## 4. Bugs Potentiels

### 🔴 Critique: Réinitialisation de `maximumWaterTemperatureToday` à minuit

**Problème:** À 01:00, `maximumWaterTemperatureToday` est réinitialisé à `waterTemperature` actuel, mais si `waterTemperature` est null, il devient null.

**Localisation:** Lignes 478-482

**Impact:** Perte de la température maximale du jour si la lecture échoue à ce moment précis.

**Recommandation:** Conserver la valeur précédente si `waterTemperature` est null:
```javascript
maximumWaterTemperatureToday = waterTemperature !== null ? waterTemperature : maximumWaterTemperatureToday;
```

### 🟡 Moyen: Condition de replan quotidien trop restrictive

**Problème:** Le replan quotidien ne se déclenche que si `maximumWaterTemperatureToday !== null` à 01:00.

**Localisation:** Ligne 478

**Impact:** Si la température n'a jamais été lue avec succès dans la journée, le replan ne se fait pas.

**Recommandation:** Utiliser `maximumTemperatureYesterday` comme fallback ou permettre le replan même sans température.

### 🟡 Moyen: Pas de gestion du cas où `filtrationStartTime` ou `filtrationStopTime` sont invalides après calcul

**Problème:** Si le calcul de `filtrationDuration` produit `NaN`, les temps de début/fin seront invalides.

**Localisation:** Lignes 323-324

**Impact:** La logique de filtration pourrait ne pas fonctionner correctement.

**Recommandation:** Valider les valeurs calculées avant de les assigner.

---

## 5. Performance

### 🟢 Mineur: Publication MQTT fréquente

**Problème:** `publishState()` est appelée à chaque changement, ce qui peut être fréquent.

**Impact:** Trafic MQTT élevé, mais acceptable pour un système de contrôle.

**Recommandation:** Considérer un throttling si nécessaire, mais probablement pas critique.

### 🟢 Mineur: Timer d'autodiscovery publie toutes les entités séquentiellement

**Problème:** L'autodiscovery publie une entité par seconde (ligne 270).

**Impact:** Délai d'initialisation de ~20 secondes, mais acceptable pour un démarrage unique.

**Recommandation:** Aucune, le comportement est intentionnel pour éviter la surcharge MQTT.

---

## 6. Maintenabilité

### 🔴 Critique: Absence de README

**Problème:** Aucun fichier README.md pour documenter le projet.

**Impact:** Difficulté pour les utilisateurs de comprendre comment installer, configurer et utiliser le projet.

**Recommandation:** Créer un README.md avec:
- Description du projet
- Prérequis (Shelly Plus 1, Home Assistant, MQTT)
- Instructions d'installation
- Configuration requise (KVS keys)
- Documentation des topics MQTT
- Exemples d'utilisation

### 🟡 Moyen: Pas de gestion de version

**Problème:** Aucun système de versioning visible (pas de package.json, pas de tag git).

**Impact:** Difficulté à suivre les versions et les changements.

**Recommandation:** Ajouter un numéro de version dans le fichier et utiliser des tags git.

### 🟡 Moyen: Pas de tests

**Problème:** Aucun test unitaire ou d'intégration.

**Impact:** Risque de régression lors de modifications.

**Recommandation:** Pour un projet embarqué, considérer au moins des tests manuels documentés ou des tests de simulation.

---

## 7. Conformité et Bonnes Pratiques

### 🟡 Moyen: Pas de linting visible

**Problème:** Aucun fichier de configuration ESLint ou similaire.

**Impact:** Incohérences de style et erreurs potentielles non détectées.

**Recommandation:** Ajouter un fichier `.eslintrc` ou similaire pour maintenir la cohérence du code.

### 🟢 Mineur: Formatage cohérent

**Point positif:** Le code est bien formaté et lisible, avec des sections clairement délimitées.

---

## Recommandations Prioritaires

### Priorité 1 (Critique - À corriger immédiatement)
1. ✅ Valider `homeAssistantAirTemperatureEntityId` avant `readAir()`
2. ✅ Gérer le cas `maximumTemperatureYesterday === null` dans `planFiltration()`
3. ✅ Corriger la réinitialisation de `maximumWaterTemperatureToday` à minuit
4. ✅ Ajouter une validation d'entrée pour les messages MQTT

### Priorité 2 (Important - À corriger prochainement)
1. ✅ Ajouter un README.md complet
2. ✅ Valider les limites des paramètres configurables
3. ✅ Améliorer la gestion d'erreur dans `haGET()`
4. ✅ Ajouter des constantes pour les magic numbers

### Priorité 3 (Souhaitable - Améliorations futures)
1. ✅ Ajouter des commentaires JSDoc
2. ✅ Encapsuler les variables globales
3. ✅ Ajouter un système de versioning
4. ✅ Considérer des tests unitaires

---

## Conclusion

Le code est fonctionnel et bien structuré pour un script embarqué, mais présente plusieurs problèmes de sécurité et de robustesse qui doivent être corrigés. Les principales préoccupations concernent la validation d'entrée, la gestion des valeurs nulles, et l'absence de documentation.

Avec les corrections recommandées, ce projet pourrait atteindre un score de 8-9/10.

---

**Audit réalisé par:** Assistant IA  
**Méthodologie:** Analyse statique du code, recherche de patterns problématiques, évaluation des bonnes pratiques

