/**
 * Weight profiles — the tunable configuration for the finalized Ardur
 * topic-rating model. Everything here is PURE DATA so ranking stays fully
 * reproducible and auditable; tuning is a reviewed data change, never a code
 * change to the scoring math.
 *
 * Model (see ~/Documents/Ardur-AI-Website/news-rating-system.md and docs/spec.md):
 *
 *   Score = Recency(t) × [ 0.30·C + 0.28·T + 0.22·S + 0.20·E ] × Diversity
 *
 * where the bracket is the weighted core over four normalized [0,1] signals
 * (Corroboration, Technical significance, Source tier, Engagement) and Recency
 * and Diversity are multipliers.
 */

import type { SourceTier } from './contracts.ts';

/** Model credibility tiers (distinct from the aggregator's source taxonomy). */
export type CredibilityTier = 'T1' | 'T2' | 'T3' | 'T4';

/** Weights for the four core signals. Must sum to 1.0. */
export interface CoreWeights {
  corroboration: number; // C — independent owners covering the topic
  technicalSignificance: number; // T — does it matter to a builder
  sourceTier: number; // S — credibility of the sources
  engagement: number; // E — capped, baseline-normalized public velocity
}

export interface WeightProfile {
  id: string; // e.g. "balanced@v1"

  /** Weighted core signal mix (sums to 1.0). */
  weights: CoreWeights;

  /** Corroboration saturation: C = min(1, ln(1+n)/ln(1+cSat)). */
  corroborationSaturation: number; // C_sat (default 8)
  /** Minimum independent owner tier counted toward corroboration. */
  corroborationMinTier: CredibilityTier; // default 'T3'

  /**
   * Significance-scaled recency half-life, in hours: H(T) = hMinHours + hSpanHours·T.
   * Defaults give 12h (trivial) → 24h (base, T=0.5) → 36h (critical, T=1).
   */
  recency: {
    hMinHours: number; // 12
    hSpanHours: number; // 24
  };

  /** Diversity multiplier = clamp(floor + slope·div, floor, ceil). */
  diversity: {
    floor: number; // 0.8
    ceil: number; // 1.15
    slope: number; // 0.35
  };

  /** Source tier score: S = maxWeight·maxTier + meanWeight·meanTier. */
  sourceTier: {
    maxWeight: number; // 0.7
    meanWeight: number; // 0.3
    /** Credibility value per model tier (T1 highest → T4 unknown). */
    values: Record<CredibilityTier, number>;
    /** Map the aggregator's source taxonomy onto a model credibility tier. */
    rankByTaxonomy: Record<SourceTier, CredibilityTier>;
  };

  /** Engagement: per-platform velocity caps; counts only, baseline-normalized. */
  engagement: {
    platformCaps: Record<string, number>; // cap_p per platform id
  };

  /** +bonus to T for the AI / platform-engineering lean (never a hard filter). */
  aiPlatformSignificanceBonus: number; // 0.1

  /** Deterministic clustering knobs (consumed upstream / for cohesion). */
  clustering: {
    similarityThreshold: number; // θ = 0.6
    timeWindowHours: number; // W = 48
  };

  /** Confidence = wC·C + wTier·tierConf + wCohesion·cohesion + wAgreement·agreement. */
  confidence: {
    weights: {
      corroboration: number; // 0.35
      tierConf: number; // 0.30
      cohesion: number; // 0.20
      agreement: number; // 0.15
    };
    /** Editorial gate thresholds: ≥auto → auto; ≥hold → flagged; else hold. */
    autoThreshold: number; // 0.66
    holdThreshold: number; // 0.40
  };

  /** Anti-gaming: a topic needs ≥minIndependentOwners OR a Tier-1 primary. */
  promotion: {
    minIndependentOwners: number; // 2
  };

  /** Tie-break tolerance: |ΔScore| < epsilon → ordered by the §2.6 tie-breaks. */
  tieBreakEpsilon: number; // 0.01
}

/** Default profile id used when none is requested. */
export const DEFAULT_WEIGHT_PROFILE = 'balanced@v1';

/**
 * The approved finalized profile. Values are taken verbatim from the design
 * spec (news-rating-system.md §2.1, §2.2, §2.3, §2.7, §2.11).
 */
export const BALANCED_V1: WeightProfile = {
  id: 'balanced@v1',
  weights: {
    corroboration: 0.3,
    technicalSignificance: 0.28,
    sourceTier: 0.22,
    engagement: 0.2,
  },
  corroborationSaturation: 8,
  corroborationMinTier: 'T3',
  recency: { hMinHours: 12, hSpanHours: 24 },
  diversity: { floor: 0.8, ceil: 1.15, slope: 0.35 },
  sourceTier: {
    maxWeight: 0.7,
    meanWeight: 0.3,
    values: { T1: 1.0, T2: 0.7, T3: 0.4, T4: 0.15 },
    // Map the aggregator taxonomy onto model tiers. Configurable; refined as the
    // source registry grows (community-aggregator / unknown tiers land here too).
    rankByTaxonomy: {
      primary: 'T1',
      paper: 'T2',
      news: 'T2',
      'technical-news': 'T2',
      'security-news': 'T2',
    },
  },
  engagement: {
    platformCaps: { hn: 1.0, github: 1.0, reddit: 1.0, lobsters: 1.0 },
  },
  aiPlatformSignificanceBonus: 0.1,
  clustering: { similarityThreshold: 0.6, timeWindowHours: 48 },
  confidence: {
    weights: { corroboration: 0.35, tierConf: 0.3, cohesion: 0.2, agreement: 0.15 },
    autoThreshold: 0.66,
    holdThreshold: 0.4,
  },
  promotion: { minIndependentOwners: 2 },
  tieBreakEpsilon: 0.01,
};

const PROFILES: Record<string, WeightProfile> = {
  [BALANCED_V1.id]: BALANCED_V1,
};

/** Resolve a named, versioned weight profile. Unknown id → error. */
export function getWeightProfile(id: string = DEFAULT_WEIGHT_PROFILE): WeightProfile {
  const profile = PROFILES[id];
  if (!profile) {
    throw new Error(`unknown weight profile: ${id} (known: ${Object.keys(PROFILES).join(', ')})`);
  }
  return profile;
}

/** True if the four core weights sum to 1.0 (within float tolerance). */
export function coreWeightsAreNormalized(profile: WeightProfile, tolerance = 1e-9): boolean {
  const { corroboration, technicalSignificance, sourceTier, engagement } = profile.weights;
  return Math.abs(corroboration + technicalSignificance + sourceTier + engagement - 1) <= tolerance;
}
