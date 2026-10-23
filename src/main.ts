import maplibregl, { type GeoJSONSource, type LngLatBoundsLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { DISCLAIMER, ORIGIN, QUOTE_COLOR, QUOTE_LABEL, SUPPLEMENTS, SUPPLEMENTS_NOTE, TIERS } from './config';
import { LAST_KM, formatEuro, quote, tierLabel } from './pricing';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Place {
  label: string;
  context: string;
  lat: number;
  lon: number;
}

interface ApiResult {
  distance_km: number;
  duration_min: number;
  geometry: GeoJSON.LineString;
  error?: string;
}

// ---------------------------------------------------------------- panneau statique
$('title').textContent = `Tarifs selon la distance (à partir de ${ORIGIN.name})`;
$('origin-address').textContent = ORIGIN.address;
$('supplements-note').textContent = SUPPLEMENTS_NOTE;
$('disclaimer').textContent = DISCLAIMER;

const legend = $('legend');
const legendRows = [
  ...TIERS.map((t) => ({ label: tierLabel(t), price: formatEuro(t.prix), color: t.couleur })),
  { label: `> ${LAST_KM} km`, price: QUOTE_LABEL, color: QUOTE_COLOR },
];
legend.innerHTML = legendRows
  .map(
    (r) =>
      `<li><span class="swatch" style="background:${r.color}"></span><span>${r.label}</span><span class="price">${r.price}</span></li>`,
  )
  .join('');

const suppContainer = $('supplements');
for (const s of SUPPLEMENTS.filter((s) => s.enabled)) {
  const label = document.createElement('label');
  label.className = 'supp';
  label.innerHTML = `<input type="checkbox" value="${s.id}" ${s.defaultChecked ? 'checked' : ''} /><span>${s.label}</span><span class="price">+${formatEuro(s.prix)}</span>`;
  suppContainer.append(label);
}
suppContainer.addEventListener('change', () => last && renderQuote(last.place, last.data));

const selectedSupplements = () =>
  [...suppContainer.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);

// Bottom sheet (mobile)
const panel = $('panel');
const handle = $('sheet-handle');
const setSheet = (expanded: boolean) => {
  panel.dataset.state = expanded ? 'expanded' : 'peek';
  handle.setAttribute('aria-expanded', String(expanded));
};
handle.addEventListener('click', () => setSheet(panel.dataset.state !== 'expanded'));

// ---------------------------------------------------------------- carte
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [ORIGIN.lon, ORIGIN.lat],
  zoom: 7,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

const originEl = document.createElement('div');
originEl.className = 'origin-marker';
originEl.textContent = 'BM';
originEl.title = `${ORIGIN.name} — ${ORIGIN.address}`;
new maplibregl.Marker({ element: originEl })
  .setLngLat([ORIGIN.lon, ORIGIN.lat])
  .setPopup(new maplibregl.Popup({ offset: 20 }).setHTML(`<strong>${ORIGIN.name}</strong><br>${ORIGIN.address}`))
  .addTo(map);

const destMarker = new maplibregl.Marker({ color: '#0F1B2D' });
const emptyLine: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

map.on('load', async () => {
  const zones = (await fetch('/zones.geojson').then((r) => r.json())) as GeoJSON.FeatureCollection;
  // Les plus grandes zones d'abord pour que les petites restent visibles au survol.
  // Couleurs et prix relus depuis la config (pas besoin de régénérer les zones pour les changer).
  for (const f of zones.features) {
    const tier = TIERS.find((t) => t.max_km === f.properties!.max_km);
    if (tier) Object.assign(f.properties!, { couleur: tier.couleur, prix: tier.prix });
  }
  zones.features.sort((a, b) => (b.properties!.max_km as number) - (a.properties!.max_km as number));

  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addSource('zones', { type: 'geojson', data: zones });
  map.addLayer(
    {
      id: 'zones-fill',
      type: 'fill',
      source: 'zones',
      paint: { 'fill-color': ['get', 'couleur'], 'fill-opacity': 0.34 },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: 'zones-line',
      type: 'line',
      source: 'zones',
      paint: { 'line-color': ['get', 'couleur'], 'line-width': 1.2, 'line-opacity': 0.9 },
    },
    firstSymbol,
  );

  map.addSource('route', { type: 'geojson', data: emptyLine });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 7 },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#0F1B2D', 'line-width': 4 },
  });

  fitTo(bboxOf(zones.features.flatMap((f) => flatCoords(f.geometry))));

  map.getCanvas().style.cursor = 'crosshair';
  map.on('click', (e) => onMapClick(e.lngLat.lat, e.lngLat.lng));
});

function flatCoords(g: GeoJSON.Geometry): number[][] {
  if (g.type === 'Polygon') return g.coordinates.flat();
  if (g.type === 'MultiPolygon') return g.coordinates.flat(2);
  if (g.type === 'LineString') return g.coordinates;
  return [];
}

function bboxOf(coords: number[][]): LngLatBoundsLike {
  const b = new maplibregl.LngLatBounds();
  for (const c of coords) b.extend(c as [number, number]);
  return b;
}

function fitTo(bounds: LngLatBoundsLike) {
  // Mobile : la bottom sheet recouvre le bas de la carte, on en tient compte.
  const overlap = Math.max(0, map.getContainer().getBoundingClientRect().bottom - panel.getBoundingClientRect().top);
  const pad = isMobile()
    ? { top: 30, bottom: 30 + overlap, left: 20, right: 20 }
    : { top: 50, bottom: 50, left: 50, right: 60 };
  map.fitBounds(bounds, { padding: pad, duration: 700, maxZoom: 13 });
}

// ---------------------------------------------------------------- calcul
const resultEl = $('result');
let last: { place: Place; data: ApiResult } | null = null;
let requestSeq = 0;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function computeFor(place: Place) {
  const seq = ++requestSeq;
  resultEl.hidden = false;
  resultEl.innerHTML = `<p class="dest">${esc(place.label)}</p><p class="loading">Calcul de l’itinéraire…</p>`;
  destMarker.setLngLat([place.lon, place.lat]).addTo(map);
  highlightLegend(-1);

  try {
    const res = await fetch(`/api/distance?lat=${place.lat}&lon=${place.lon}`);
    const data = (await res.json()) as ApiResult;
    if (seq !== requestSeq) return;
    if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
    last = { place, data };
    renderQuote(place, data);
    (map.getSource('route') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: data.geometry });
    fitTo(bboxOf(data.geometry.coordinates));
  } catch (err) {
    if (seq !== requestSeq) return;
    last = null;
    (map.getSource('route') as GeoJSONSource | undefined)?.setData(emptyLine);
    resultEl.innerHTML = `<p class="dest">${esc(place.label)}</p><p class="error">${esc((err as Error).message)}</p>`;
  }
}

function renderQuote(place: Place, data: ApiResult) {
  const q = quote(data.distance_km, selectedSupplements());
  const km = q.distance_km.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const lines = q.sur_devis
    ? `<li class="total"><span>Prix</span><span>${QUOTE_LABEL}</span></li>`
    : [
        `<li><span>Prix de base (${q.tier_label})</span><span>${formatEuro(q.base!)}</span></li>`,
        ...q.supplements.map((s) => `<li><span>${esc(s.label)}</span><span>+${formatEuro(s.prix)}</span></li>`),
        `<li class="total"><span>Total</span><span>${formatEuro(q.total!)}</span></li>`,
      ].join('');
  resultEl.innerHTML = `
    <p class="dest">${esc(place.label)}${place.context ? ` · ${esc(place.context)}` : ''}</p>
    <div class="big">
      <span class="km">${km} km <small>par la route · ~${formatDuration(data.duration_min)}</small></span>
      <span class="badge"><i style="background:${q.couleur}"></i>${q.tier_label}</span>
    </div>
    <ul class="lines">${lines}</ul>`;
  highlightLegend(q.tier ? TIERS.indexOf(q.tier) : TIERS.length);
}

function formatDuration(min: number) {
  // espaces insécables : la durée ne doit pas être coupée en fin de ligne
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

function highlightLegend(index: number) {
  legend.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === index));
}

async function onMapClick(lat: number, lon: number) {
  const fallback = `Point ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const place: Place = { label: fallback, context: '', lat, lon };
  input.value = '';
  computeFor(place);
  const rev = await reverseGeocode(lat, lon).catch(() => null);
  if (rev && last?.place === place) {
    place.label = rev.label;
    place.context = rev.context;
    renderQuote(place, last.data);
  } else if (rev) {
    place.label = rev.label;
    place.context = rev.context;
  }
}

// ---------------------------------------------------------------- géocodage
async function searchBan(q: string, signal: AbortSignal): Promise<Place[]> {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=5&lat=${ORIGIN.lat}&lon=${ORIGIN.lon}`;
  const data = await fetch(url, { signal }).then((r) => r.json());
  return (data.features ?? []).map((f: any) => ({
    label: f.properties.label,
    context: f.properties.context ?? '',
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
}

function photonPlace(f: any): Place {
  const p = f.properties;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const main = p.name ?? (street || p.city);
  const ctx = [p.name && street ? street : null, p.postcode, p.city !== main ? p.city : null, p.country]
    .filter(Boolean)
    .join(', ');
  return { label: main, context: ctx, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
}

async function searchPhoton(q: string, signal: AbortSignal): Promise<(Place & { cc: string })[]> {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=fr&lat=${ORIGIN.lat}&lon=${ORIGIN.lon}&bbox=-10,35.5,4.5,46.5`;
  const data = await fetch(url, { signal }).then((r) => r.json());
  return (data.features ?? []).map((f: any) => ({ ...photonPlace(f), cc: f.properties.countrycode ?? '' }));
}

/** API Adresse pour la France, Photon en complément (Espagne, ou si la BAN ne trouve rien). */
async function geocode(q: string, signal: AbortSignal): Promise<Place[]> {
  const [ban, photon] = await Promise.allSettled([searchBan(q, signal), searchPhoton(q, signal)]);
  const fr = ban.status === 'fulfilled' ? ban.value : [];
  const ph = photon.status === 'fulfilled' ? photon.value : [];
  const foreign = ph.filter((p) => p.cc && p.cc !== 'FR');
  const extra = fr.length ? foreign : ph;
  return [...fr, ...extra.slice(0, 4)];
}

async function reverseGeocode(lat: number, lon: number): Promise<Place | null> {
  const ban = await fetch(`https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lon}&limit=1`)
    .then((r) => r.json())
    .catch(() => null);
  const f = ban?.features?.[0];
  if (f && f.properties.distance < 1000) {
    return { label: f.properties.label, context: f.properties.context ?? '', lat, lon };
  }
  const ph = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=fr`).then((r) => r.json());
  return ph?.features?.[0] ? { ...photonPlace(ph.features[0]), lat, lon } : null;
}

// ---------------------------------------------------------------- autocomplétion
const input = $<HTMLInputElement>('address');
const list = $<HTMLUListElement>('suggestions');
let suggestions: Place[] = [];
let active = -1;
let debounce: number | undefined;
let controller: AbortController | null = null;

function closeList() {
  list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  active = -1;
}

function renderList() {
  if (!suggestions.length) return closeList();
  list.innerHTML = suggestions
    .map(
      (s, i) =>
        `<li role="option" id="sugg-${i}" aria-selected="${i === active}" data-i="${i}">${esc(s.label)}${s.context ? `<small>${esc(s.context)}</small>` : ''}</li>`,
    )
    .join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (active >= 0) input.setAttribute('aria-activedescendant', `sugg-${active}`);
  else input.removeAttribute('aria-activedescendant');
}

function choose(i: number) {
  const place = suggestions[i];
  if (!place) return;
  input.value = place.label;
  closeList();
  input.blur();
  setSheet(false); // mobile : on replie le panneau pour montrer l'itinéraire
  computeFor(place);
}

input.addEventListener('input', () => {
  clearTimeout(debounce);
  const q = input.value.trim();
  if (q.length < 3) {
    suggestions = [];
    return closeList();
  }
  debounce = window.setTimeout(async () => {
    controller?.abort();
    controller = new AbortController();
    try {
      suggestions = await geocode(q, controller.signal);
      active = -1;
      renderList();
    } catch {
      /* requête annulée */
    }
  }, 250);
});

input.addEventListener('keydown', (e) => {
  if (list.hidden) {
    if (e.key === 'Enter' && suggestions.length) choose(0);
    return;
  }
  if (e.key === 'ArrowDown') active = Math.min(active + 1, suggestions.length - 1);
  else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0);
  else if (e.key === 'Enter') return choose(active >= 0 ? active : 0);
  else if (e.key === 'Escape') return closeList();
  else return;
  e.preventDefault();
  renderList();
});

input.addEventListener('focus', () => {
  if (isMobile()) setSheet(true);
  if (suggestions.length && input.value.trim().length >= 3) renderList();
});

list.addEventListener('mousedown', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li) return;
  e.preventDefault();
  choose(Number(li.dataset.i));
});

document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.search')) closeList();
});
