# Carte des zones de livraison — Blue Modal (Mouguerre)

Site public qui affiche les **zones tarifaires de livraison calculées en distance routière** (pas à vol
d'oiseau) autour de Blue Modal, Centre Européen de Fret, Mouguerre (64990), avec un **calculateur de prix
par adresse**.

- Carte : Vite + TypeScript + MapLibre GL, fond OpenFreeMap (sans clé)
- Zones : pré-calculées avec l'API isochrone Valhalla → `public/zones.geojson`
- Prix : fonction serverless Vercel `api/distance.ts` qui calcule l'itinéraire **exact** (Valhalla `/route`,
  fallback OpenRouteService) et applique la grille tarifaire côté serveur
- Adresses : API Adresse (BAN) pour la France, Photon (Komoot) pour l'Espagne

> Le prix est calculé sur l'itinéraire exact ; les zones sont une visualisation approximative.

## Grille tarifaire

| Distance route depuis Blue Modal | Prix |
| --- | --- |
| 0 – 15 km | 300 € |
| ]15 – 30] km | 350 € |
| ]30 – 60] km | 450 € |
| ]60 – 100] km | 500 € |
| ]100 – 150] km | 550 € |
| > 150 km | Sur devis |

Bornes hautes incluses. La distance utilisée est arrondie au dixième de km.

Suppléments (cases à cocher) : City pour la livraison +50 €, Chariot embarqué +100 €, Passage chez Blue
Modal +50 € (désactivé par défaut).

## Structure

```
src/config.ts         ← TOUTE la configuration métier (origine, tranches, couleurs, suppléments, textes, routage)
src/pricing.ts        ← calcul tranche / prix / total (partagé front + API)
src/routing.ts        ← appels Valhalla / ORS (API + script uniquement)
src/main.ts           ← carte, panneau, autocomplétion, calculateur
api/distance.ts       ← fonction serverless Vercel : GET /api/distance?lat=..&lon=..[&options=city,chariot]
scripts/build-zones.ts← génération de public/zones.geojson
public/zones.geojson  ← zones pré-calculées (commité)
```

## Développement local

```bash
npm install
npm run dev        # http://localhost:5173 (l'API /api/distance est servie par Vite en dev)
npm run build      # typecheck + build de production dans dist/
```

Sous Windows / PowerShell, les mêmes commandes fonctionnent telles quelles.

## Changer les tarifs, les couleurs ou les suppléments

Tout est dans `src/config.ts` :

- `TIERS` : bornes (`min_km`, `max_km`), `prix`, `couleur` ;
- `SUPPLEMENTS` : `label`, `prix`, `enabled` (afficher ou non), `defaultChecked` ;
- `QUOTE_LABEL`, `SUPPLEMENTS_NOTE`, `DISCLAIMER` : textes affichés.

**Changer uniquement un prix, une couleur ou un supplément** → commit + push, Vercel redéploie. Pas besoin de
régénérer les zones (la couleur et le prix sont relus depuis la config par le front).

**Changer une borne de distance ou l'origine** → il faut régénérer les zones (ci-dessous).

## Changer l'origine

Dans `src/config.ts`, modifier `ORIGIN` (`lat`, `lon`, `address`), puis régénérer les zones.

## Régénérer les zones

```bash
npm run zones              # profil voiture (costing "auto")
npm run zones -- --truck   # profil poids lourd (costing "truck")
git add public/zones.geojson && git commit -m "Régénère les zones" && git push
```

Durée : environ 10 à 15 minutes (le script respecte un délai de 1,3 s entre appels aux serveurs publics).

### Méthode

1. **Contours ≤ 100 km** (15 / 30 / 60 / 100) : une requête isochrone Valhalla en `distance`
   (4 contours max par requête, `polygons: true`, `denoise`, `generalize`).
2. **Contour 150 km** : le serveur Valhalla public refuse les isochrones au-delà de **100 km**
   (`error 166 : Exceeded max distance: 100`) et l'API publique ORS est limitée à **120 km** en
   `range_type=distance`. Le script échantillonne donc la frontière du polygone 100 km (un point tous les
   ~7 km), mesure la distance route réelle `d` de chaque point par `/route`, puis lance depuis ce point une
   isochrone de `150 − d` km. L'union de ces isochrones et du polygone 100 km donne la zone 150 km. Tout point
   ainsi couvert est à ≤ 150 km par la route : la zone ne peut pas être surestimée (au pire légèrement
   sous-estimée entre deux échantillons).
3. **Anneaux** : zone N = polygone N − polygone N−1 (`@turf/difference`), simplification ~150 m.

Fallback : si Valhalla est indisponible et que `ORS_API_KEY` est défini dans `.env`, les contours ≤ 100 km
sont demandés à OpenRouteService (limite 120 km vérifiée par le script).

En fin d'exécution, le script affiche les distances route de contrôle vers Bayonne, Dax, Pau,
Mont-de-Marsan et Saint-Jean-Pied-de-Port.

## Variables d'environnement

Voir `.env.example`. Une seule variable, **optionnelle** :

- `ORS_API_KEY` : clé OpenRouteService pour le fallback (script en local via `.env`, API via les
  *Environment Variables* du projet Vercel). Ne jamais la commiter.

## Déploiement

Le repo est relié à Vercel : chaque push sur `main` redéploie le site. Vercel détecte Vite (`vercel.json`)
et publie `api/distance.ts` comme fonction serverless.

## Crédits

Itinéraires et isochrones : [Valhalla](https://github.com/valhalla/valhalla) (serveur public FOSSGIS
valhalla1.openstreetmap.de). Fond de carte : [OpenFreeMap](https://openfreemap.org). Données ©
[contributeurs OpenStreetMap](https://www.openstreetmap.org/copyright). Géocodage :
[API Adresse](https://adresse.data.gouv.fr) et [Photon](https://photon.komoot.io).
