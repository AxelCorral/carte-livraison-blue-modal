// Calcul d'itinéraire (Valhalla public, fallback OpenRouteService si une clé est fournie).
// Utilisé par l'API serverless et par le script de génération des zones — jamais par le front.
import { ROUTING } from './config.js';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RouteResult {
  distance_km: number;
  duration_s: number;
  /** [lon, lat][] */
  coordinates: [number, number][];
  provider: 'valhalla' | 'ors';
}

/** Décode une polyline encodée (précision 6 pour Valhalla). */
export function decodePolyline(str: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    coords.push([lon / factor, lat / factor]);
  }
  return coords;
}

export class RoutingError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

export async function valhallaRoute(from: LatLon, to: LatLon, costing = ROUTING.costing): Promise<RouteResult> {
  const res = await fetch(`${ROUTING.valhallaUrl}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: [from, to],
      costing,
      units: 'kilometers',
      directions_type: 'none',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data.trip) {
    // 442 = aucun itinéraire, 171 = point non routable : erreur "client", pas de fallback utile.
    const code = data?.error_code;
    const noRoute = res.status === 400 && [170, 171, 442, 443].includes(code);
    throw new RoutingError(data?.error ?? `Valhalla HTTP ${res.status}`, noRoute ? 422 : 502);
  }
  const leg = data.trip.legs[0];
  return {
    distance_km: data.trip.summary.length,
    duration_s: data.trip.summary.time,
    coordinates: decodePolyline(leg.shape, 6),
    provider: 'valhalla',
  };
}

export async function orsRoute(from: LatLon, to: LatLon, apiKey: string): Promise<RouteResult> {
  const res = await fetch(`${ROUTING.orsUrl}/v2/directions/${ROUTING.orsProfile}/geojson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({
      coordinates: [
        [from.lon, from.lat],
        [to.lon, to.lat],
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  const feature = data?.features?.[0];
  if (!res.ok || !feature) throw new RoutingError(data?.error?.message ?? `ORS HTTP ${res.status}`);
  return {
    distance_km: feature.properties.summary.distance / 1000,
    duration_s: feature.properties.summary.duration,
    coordinates: feature.geometry.coordinates,
    provider: 'ors',
  };
}

/** Valhalla d'abord ; ORS si Valhalla est indisponible et qu'une clé est configurée. */
export async function route(from: LatLon, to: LatLon, orsKey?: string): Promise<RouteResult> {
  try {
    return await valhallaRoute(from, to);
  } catch (err) {
    if (!orsKey || (err instanceof RoutingError && err.status === 422)) throw err;
    return orsRoute(from, to, orsKey);
  }
}
