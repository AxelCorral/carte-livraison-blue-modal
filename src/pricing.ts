import { QUOTE_COLOR, QUOTE_LABEL, SUPPLEMENTS, TIERS, type Tier } from './config.js';

export interface Quote {
  distance_km: number;
  tier: Tier | null;
  /** Libellé de tranche, ex. "15 – 30 km" ou "> 150 km". */
  tier_label: string;
  couleur: string;
  /** Prix de base, null si "Sur devis". */
  base: number | null;
  supplements: { id: string; label: string; prix: number }[];
  /** Total, null si "Sur devis". */
  total: number | null;
  sur_devis: boolean;
  label_prix: string;
}

export function tierLabel(t: Tier): string {
  return `${t.min_km} – ${t.max_km} km`;
}

export const LAST_KM = TIERS[TIERS.length - 1].max_km;

/** Tranche pour une distance route (borne haute incluse). */
export function findTier(distanceKm: number): Tier | null {
  return TIERS.find((t) => distanceKm <= t.max_km) ?? null;
}

export function formatEuro(n: number): string {
  return `${n.toLocaleString('fr-FR')} €`;
}

export function quote(distanceKm: number, supplementIds: string[] = []): Quote {
  const tier = findTier(distanceKm);
  const supplements = SUPPLEMENTS.filter((s) => s.enabled && supplementIds.includes(s.id)).map(
    ({ id, label, prix }) => ({ id, label, prix }),
  );
  const base = tier ? tier.prix : null;
  const total = base === null ? null : base + supplements.reduce((sum, s) => sum + s.prix, 0);
  return {
    distance_km: distanceKm,
    tier,
    tier_label: tier ? tierLabel(tier) : `> ${LAST_KM} km`,
    couleur: tier ? tier.couleur : QUOTE_COLOR,
    base,
    supplements,
    total,
    sur_devis: tier === null,
    label_prix: tier ? formatEuro(tier.prix) : QUOTE_LABEL,
  };
}
