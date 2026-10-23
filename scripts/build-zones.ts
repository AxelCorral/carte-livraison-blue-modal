/**
 * Pré-calcul des zones d'isodistance ROUTIÈRE autour de chaque départ → public/zones-<id>.geojson
 *
 *   npm run zones                 (profil 'auto' par défaut, cf. src/config.ts)
 *   npm run zones -- --truck      (profil poids lourd)
 *   npm run zones -- --origin bellocq   (un seul départ ; par défaut : tous ceux de src/config.ts)
 *
 * Méthode :
 *  1. Isochrones Valhalla en distance pour toutes les bornes ≤ 100 km (4 contours max / requête,
 *     le serveur public refuse > 100 km). Fallback OpenRouteService si ORS_API_KEY est défini.
 *  2. Pour les bornes > 100 km (150 km) : on échantillonne la frontière du polygone 100 km,
 *     on mesure la distance route réelle d de chaque point, puis on calcule depuis ce point une
 *     isochrone de (borne − d) km. L'union de ces isochrones + du polygone 100 km donne la zone.
 *     Tout point atteint ainsi est à ≤ borne km de l'origine : la zone ne peut pas être surestimée.
 *  3. Anneaux : zone N = polygone N − polygone N−1 (@turf/difference).
 */
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { difference } from '@turf/difference';
import { union } from '@turf/union';
import { simplify } from '@turf/simplify';
import { featureCollection, multiPolygon } from '@turf/helpers';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { ORIGINS, ROUTING, TIERS, getOrigin, type Origin } from '../src/config.js';
import { valhallaRoute, type LatLon } from '../src/routing.js';

type Poly = Feature<Polygon | MultiPolygon>;

// --- paramètres -----------------------------------------------------------------------------
const COSTING: 'auto' | 'truck' = process.argv.includes('--truck') ? 'truck' : ROUTING.costing;
const VALHALLA_MAX_KM = 100; // limite isochrone du serveur public valhalla1.openstreetmap.de
const VALHALLA_MAX_CONTOURS = 4;
const ORS_MAX_KM = 120; // limite range_type=distance de l'API publique ORS
const DELAY_MS = 1300; // délai entre appels (fair use des serveurs publics)
const FRONTIER_STEP_KM = 7; // espacement des points échantillonnés sur la frontière
const DENOISE = 0.1;
const GENERALIZE_M = 150;
const SIMPLIFY_TOLERANCE = 0.0015; // degrés (~150 m)

const originArg = process.argv.indexOf('--origin');
const SELECTED: Origin[] =
  originArg > -1
    ? [getOrigin(process.argv[originArg + 1]) ?? fail(`départ inconnu : ${process.argv[originArg + 1]}`)]
    : ORIGINS;
/** Départ en cours de calcul (seuls lat/lon sont envoyés aux API et utilisés comme clé de cache). */
let ORIGIN: LatLon = { lat: 0, lon: 0 };

function fail(msg: string): never {
  throw new Error(msg);
}

const CONTROL_POINTS: (LatLon & { name: string })[] = [
  { name: 'Bayonne', lat: 43.4929, lon: -1.4748 },
  { name: 'Dax', lat: 43.7102, lon: -1.0538 },
  { name: 'Pau', lat: 43.2951, lon: -0.3708 },
  { name: 'Mont-de-Marsan', lat: 43.8902, lon: -0.4995 },
  { name: 'Saint-Jean-Pied-de-Port', lat: 43.1636, lon: -1.2364 },
];

// --- utilitaires ----------------------------------------------------------------------------
loadDotEnv();
const ORS_API_KEY = process.env.ORS_API_KEY;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function throttled<T>(fn: () => Promise<T>, retries = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || (err as any)?.fatal) throw err;
      const backoff = 2000 * 2 ** attempt;
      console.warn(`  ↻ ${(err as Error).message} — nouvel essai dans ${backoff / 1000}s`);
      await sleep(backoff);
    }
  }
}

function loadDotEnv() {
  const p = resolve('.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function toMulti(f: Poly): Feature<MultiPolygon> {
  const g = f.geometry;
  return multiPolygon(g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
}

/** Union par paires (arbre) : bien moins gourmand en mémoire qu'une union globale de N polygones. */
function unionAll(polys: Poly[]): Poly {
  let level = polys;
  while (level.length > 1) {
    const next: Poly[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const u = i + 1 < level.length ? union(featureCollection([level[i], level[i + 1]])) : level[i];
      if (u) next.push(u);
    }
    level = next;
  }
  if (!level[0]) throw new Error('union vide');
  return level[0];
}

/** Cache disque des réponses (scripts/.cache, ignoré par git) : une relance ne refait pas les appels. */
const CACHE_DIR = resolve('scripts/.cache');
async function cached<T>(key: unknown, fn: () => Promise<T>): Promise<T> {
  const file = resolve(CACHE_DIR, `${createHash('sha1').update(JSON.stringify(key)).digest('hex')}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T;
  const value = await fn();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return value;
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Points espacés d'environ stepKm le long des anneaux extérieurs. */
function sampleOuterRings(f: Poly, stepKm: number): [number, number][] {
  const out: [number, number][] = [];
  for (const poly of toMulti(f).geometry.coordinates) {
    const ring = poly[0] as [number, number][];
    let acc = stepKm; // force un point au départ
    for (let i = 1; i < ring.length; i++) {
      acc += haversineKm(ring[i - 1], ring[i]);
      if (acc >= stepKm) {
        out.push(ring[i]);
        acc = 0;
      }
    }
  }
  return out;
}

// --- isochrones -----------------------------------------------------------------------------
async function valhallaIsochrone(loc: LatLon, contoursKm: number[]): Promise<Poly[]> {
  const res = await fetch(`${ROUTING.valhallaUrl}/isochrone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: [loc],
      costing: COSTING,
      contours: contoursKm.map((distance) => ({ distance })),
      polygons: true,
      denoise: DENOISE,
      generalize: GENERALIZE_M,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const err = new Error(`Valhalla isochrone HTTP ${res.status}: ${data?.error ?? ''}`);
    (err as any).fatal = res.status === 400;
    throw err;
  }
  for (const f of data.features as Poly[]) f.properties = { km: Number((f.properties as any).contour) };
  return data.features;
}

async function orsIsochrone(loc: LatLon, contoursKm: number[]): Promise<Poly[]> {
  if (!ORS_API_KEY) throw new Error('ORS_API_KEY absent');
  const profile = COSTING === 'truck' ? 'driving-hgv' : ROUTING.orsProfile;
  const res = await fetch(`${ROUTING.orsUrl}/v2/isochrones/${profile}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ORS_API_KEY },
    body: JSON.stringify({
      locations: [[loc.lon, loc.lat]],
      range_type: 'distance',
      range: contoursKm.map((km) => km * 1000),
      smoothing: 10,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`ORS isochrone HTTP ${res.status}: ${data?.error?.message ?? ''}`);
  for (const f of data.features as Poly[]) f.properties = { km: Number((f.properties as any).value) / 1000 };
  return data.features;
}

/** Appel throttlé + mis en cache disque. */
const isochrone = (provider: 'valhalla' | 'ors', loc: LatLon, contoursKm: number[], retries = 4) =>
  cached([provider, 'iso', COSTING, loc, contoursKm, DENOISE, GENERALIZE_M], () =>
    throttled(() => (provider === 'valhalla' ? valhallaIsochrone : orsIsochrone)(loc, contoursKm), retries),
  );
const routeKm = (to: LatLon, retries = 4) =>
  cached(['valhalla', 'route', COSTING, ORIGIN, to], () =>
    throttled(async () => {
      const r = await valhallaRoute(ORIGIN, to, COSTING);
      return { km: r.distance_km, min: Math.round(r.duration_s / 60) };
    }, retries),
  );

/** Contours ≤ 100 km : Valhalla par paquets de 4, ORS en secours (≤ 120 km). */
async function directContours(contoursKm: number[]): Promise<Map<number, Poly>> {
  const result = new Map<number, Poly>();
  for (let i = 0; i < contoursKm.length; i += VALHALLA_MAX_CONTOURS) {
    const batch = contoursKm.slice(i, i + VALHALLA_MAX_CONTOURS);
    console.log(`→ Isochrone Valhalla (${COSTING}) : ${batch.join(' / ')} km`);
    try {
      for (const f of await isochrone('valhalla', ORIGIN, batch)) result.set((f.properties as any).km, f);
    } catch (err) {
      console.warn(`  ✗ Valhalla : ${(err as Error).message}`);
      if (!ORS_API_KEY) throw err;
      if (Math.max(...batch) > ORS_MAX_KM) throw new Error(`ORS limité à ${ORS_MAX_KM} km`);
      console.log(`→ Fallback OpenRouteService : ${batch.join(' / ')} km`);
      // ORS : 10 contours max mais quota bas → un seul appel par paquet
      for (const f of await isochrone('ors', ORIGIN, batch)) result.set((f.properties as any).km, f);
    }
  }
  return result;
}

/** Contour > 100 km via les isochrones lancées depuis la frontière de base. */
async function extendedContour(limitKm: number, base: Poly, baseKm: number): Promise<Poly> {
  const samples = sampleOuterRings(base, FRONTIER_STEP_KM);
  console.log(`→ Contour ${limitKm} km : ${samples.length} points échantillonnés sur la frontière ${baseKm} km`);
  const pieces: Poly[] = [base];
  let done = 0;
  for (const [lon, lat] of samples) {
    done++;
    let d: number;
    try {
      d = (await routeKm({ lat, lon }, 2)).km;
    } catch {
      continue; // point non routable (mer, zone sans route)
    }
    // Points de frontière bien en deçà de baseKm (côte, culs-de-sac) : déjà couverts.
    if (d < baseKm - 15 || d >= limitKm) continue;
    const remaining = Math.min(VALHALLA_MAX_KM, limitKm - d);
    try {
      const [f] = await isochrone('valhalla', { lat, lon }, [Math.round(remaining * 10) / 10], 2);
      // Simplification avant union : limite fortement la mémoire et le temps de calcul.
      if (f) pieces.push(simplify(toMulti(f), { tolerance: SIMPLIFY_TOLERANCE }));
      process.stdout.write(`\r  ${done}/${samples.length} points — d=${d.toFixed(1)} km, +${remaining.toFixed(1)} km   `);
    } catch (err) {
      console.warn(`\n  ✗ isochrone depuis (${lat.toFixed(4)}, ${lon.toFixed(4)}) : ${(err as Error).message}`);
    }
  }
  process.stdout.write('\n');
  return unionAll(pieces);
}

/** Arrondi à 1 m puis nettoyage : un anneau GeoJSON valide a ≥ 4 positions (sinon : éclat dégénéré). */
function roundCoords(f: Feature<MultiPolygon>): Feature<MultiPolygon> {
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  const clean = (ring: number[][]) =>
    ring.map(([x, y]) => [r(x), r(y)]).filter((c, i, a) => i === 0 || c[0] !== a[i - 1][0] || c[1] !== a[i - 1][1]);
  f.geometry.coordinates = f.geometry.coordinates
    .map((p) => p.map(clean))
    // anneau extérieur dégénéré → tout le polygone saute ; trou dégénéré → seul le trou saute
    .filter((p) => p[0].length >= 4)
    .map((p) => p.filter((ring) => ring.length >= 4));
  return f;
}

// --- main -----------------------------------------------------------------------------------
async function main() {
  for (const origin of SELECTED) await buildFor(origin);
}

async function buildFor(origin: Origin) {
  ORIGIN = { lat: origin.lat, lon: origin.lon };
  console.log(`\n=== Départ ${origin.label} : ${origin.address} (${origin.lat}, ${origin.lon}) — profil ${COSTING}\n`);
  const bounds = TIERS.map((t) => t.max_km);
  const direct = bounds.filter((km) => km <= VALHALLA_MAX_KM);
  const extended = bounds.filter((km) => km > VALHALLA_MAX_KM);

  const polys = await directContours(direct);
  for (const km of extended) {
    const baseKm = Math.max(...polys.keys());
    polys.set(km, await extendedContour(km, polys.get(baseKm)!, baseKm));
  }

  // Imbrication stricte (polygone N ⊇ polygone N−1), puis anneaux.
  const nested: Poly[] = [];
  for (const km of bounds) {
    const p = polys.get(km);
    if (!p) throw new Error(`contour ${km} km manquant`);
    nested.push(nested.length ? unionAll([p, nested[nested.length - 1]]) : p);
  }
  const features = TIERS.map((t, i) => {
    const ring = i === 0 ? nested[0] : difference(featureCollection([nested[i], nested[i - 1]]));
    if (!ring) throw new Error(`anneau ${t.min_km}-${t.max_km} vide`);
    const simplified = simplify(toMulti(ring), { tolerance: SIMPLIFY_TOLERANCE, highQuality: true });
    const f = roundCoords(toMulti(simplified));
    f.properties = { min_km: t.min_km, max_km: t.max_km, prix: t.prix, couleur: t.couleur };
    return f;
  });

  const fc = {
    type: 'FeatureCollection',
    metadata: {
      generated_at: new Date().toISOString(),
      origin,
      costing: COSTING,
      source: 'Valhalla (valhalla1.openstreetmap.de) — données © OpenStreetMap contributors',
    },
    features,
  };
  const out = resolve(`public/zones-${origin.id}.geojson`);
  writeFileSync(out, JSON.stringify(fc));
  console.log(`\n✓ ${out} écrit (${(JSON.stringify(fc).length / 1024).toFixed(0)} Ko)\n`);

  console.log(`Contrôle — distances route depuis ${origin.label} :`);
  for (const c of CONTROL_POINTS) {
    try {
      const r = await routeKm(c);
      console.log(`  ${c.name.padEnd(26)} ${r.km.toFixed(1).padStart(6)} km  (${r.min} min)`);
    } catch (err) {
      console.log(`  ${c.name.padEnd(26)} erreur : ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
