// GET /api/distance?lat=43.49&lon=-1.47&options=city,chariot
// → distance route exacte depuis l'origine, tranche, prix et géométrie de l'itinéraire.
import { ORIGIN } from '../src/config.js';
import { quote } from '../src/pricing.js';
import { route, RoutingError, type RouteResult } from '../src/routing.js';

const CACHE_MAX = 500;
const CACHE_TTL_MS = 24 * 3600 * 1000;
const cache = new Map<string, { at: number; value: RouteResult }>();
/** Distance max entre le point demandé et la route la plus proche (sinon : mer / zone sans route). */
const MAX_SNAP_KM = 3;

function haversineKm([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

async function cachedRoute(lat: number, lon: number): Promise<{ result: RouteResult; cached: boolean }> {
  // ~1 m de précision : deux clics au même endroit partagent le résultat.
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { result: hit.value, cached: true };
  const result = await route(ORIGIN, { lat, lon }, process.env.ORS_API_KEY);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value: result });
  return { result, cached: false };
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  // Zone de service raisonnable (France + Espagne + Portugal) pour éviter les abus.
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 35 || lat > 52 || lon < -10 || lon > 10) {
    return json({ error: 'Paramètres lat/lon invalides ou hors zone (France / Espagne).' }, 400);
  }
  const options = (params.get('options') ?? '').split(',').filter(Boolean);

  try {
    const { result, cached } = await cachedRoute(lat, lon);
    const end = result.coordinates[result.coordinates.length - 1];
    if (end && haversineKm(end, [lon, lat]) > MAX_SNAP_KM) {
      return json({ error: `Aucune route à moins de ${MAX_SNAP_KM} km de ce point (mer, montagne ?).` }, 422);
    }
    const q =quote(Math.round(result.distance_km * 10) / 10, options);
    return json(
      {
        origin: ORIGIN,
        destination: { lat, lon },
        distance_km: q.distance_km,
        duration_min: Math.round(result.duration_s / 60),
        tranche: q.tier_label,
        couleur: q.couleur,
        prix_base: q.base,
        supplements: q.supplements,
        total: q.total,
        sur_devis: q.sur_devis,
        provider: result.provider,
        cached,
        geometry: { type: 'LineString', coordinates: result.coordinates },
      },
      200,
      { 'Cache-Control': 'public, max-age=0, s-maxage=86400' },
    );
  } catch (err) {
    const status = err instanceof RoutingError ? err.status : 502;
    const message =
      status === 422
        ? 'Aucun itinéraire routier trouvé vers ce point (mer, zone sans route ?).'
        : 'Service d’itinéraire momentanément indisponible, réessayez dans un instant.';
    return json({ error: message, detail: (err as Error).message }, status);
  }
}
