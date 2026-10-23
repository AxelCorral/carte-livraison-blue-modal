// Configuration métier unique : origine, tranches tarifaires, suppléments, routage.
// Toute modification de tarif ou d'origine se fait ICI (puis `npm run zones` si l'origine
// ou les bornes de distance changent).

export interface Origin {
  /** Identifiant court (URL ?depart=, nom du fichier de zones). */
  id: string;
  /** Libellé du sélecteur de départ. */
  label: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
}

export interface Tier {
  /** Borne basse exclue (km) — 0 pour la première tranche (incluse). */
  min_km: number;
  /** Borne haute incluse (km). */
  max_km: number;
  /** Prix de base en euros. */
  prix: number;
  couleur: string;
}

export interface Supplement {
  id: string;
  label: string;
  prix: number;
  /** false = supplément masqué / non proposé. */
  enabled: boolean;
  /** Case cochée par défaut. */
  defaultChecked: boolean;
}

/** Départs possibles. Ajouter un départ = une entrée ici + `npm run zones -- --origin <id>`. */
export const ORIGINS: Origin[] = [
  {
    id: 'bellocq',
    label: 'Bellocq',
    name: 'Blue Modal',
    address: 'Chemin de Lesperance, 64270 Bellocq',
    // Coordonnées confirmées (API Adresse, milieu du chemin de Lesperance).
    lat: 43.508612,
    lon: -0.9187,
  },
  {
    id: 'mouguerre',
    label: 'Mouguerre',
    name: 'Blue Modal',
    address: "Centre Européen de Fret, 5 Av. d'Alegera, 64990 Mouguerre",
    // Coordonnées confirmées (géocodage API Adresse du 5 Rue Alegera).
    lat: 43.485135,
    lon: -1.426763,
  },
];

/** Départ par défaut (page principale). */
export const DEFAULT_ORIGIN_ID = 'bellocq';

export function getOrigin(id: string | null | undefined): Origin | undefined {
  return ORIGINS.find((o) => o.id === id);
}

export const DEFAULT_ORIGIN = getOrigin(DEFAULT_ORIGIN_ID)!;

export const TIERS: Tier[] = [
  { min_km: 0, max_km: 15, prix: 300, couleur: '#E8616F' },
  { min_km: 15, max_km: 30, prix: 350, couleur: '#EE9440' },
  { min_km: 30, max_km: 60, prix: 450, couleur: '#E5C13A' },
  { min_km: 60, max_km: 100, prix: 500, couleur: '#5A9E4B' },
  { min_km: 100, max_km: 150, prix: 550, couleur: '#3B82D6' },
];

/** Libellé affiché au-delà de la dernière tranche. */
export const QUOTE_LABEL = 'Sur devis';
export const QUOTE_COLOR = '#8A94A6';

export const SUPPLEMENTS: Supplement[] = [
  { id: 'passage', label: 'Passage chez Blue Modal', prix: 50, enabled: false, defaultChecked: false },
  { id: 'city', label: 'City pour la livraison', prix: 100, enabled: true, defaultChecked: false },
  { id: 'chariot', label: 'Chariot embarqué', prix: 150, enabled: true, defaultChecked: false },
];

export const SUPPLEMENTS_NOTE =
  'Ces frais supplémentaires peuvent s’appliquer selon la destination et les conditions de livraison.';

export const DISCLAIMER =
  'Le prix est calculé sur l’itinéraire exact ; les zones sont une visualisation approximative.';

export const ROUTING = {
  /** Profil Valhalla : 'auto' ou 'truck'. */
  costing: 'auto' as 'auto' | 'truck',
  valhallaUrl: 'https://valhalla1.openstreetmap.de',
  /** Profil OpenRouteService correspondant (fallback). */
  orsProfile: 'driving-car' as 'driving-car' | 'driving-hgv',
  orsUrl: 'https://api.openrouteservice.org',
};
