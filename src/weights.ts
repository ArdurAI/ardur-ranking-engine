/**
 * Weight profiles — named, versioned weighting for the five ranking signals.
 *
 * SCAFFOLD ONLY. Seed `balanced@v1` from the de-facto weights already in use on
 * ardur.ai/main: `scoreItem()` in refresh-news.mjs (recency vs term/position)
 * and `scoreWeights` in refresh-article-intelligence.mjs (interaction emphasis).
 * Profiles are pure data so ranking stays fully reproducible and auditable.
 */

export interface WeightProfile {
  id: string; // e.g. "balanced@v1"
  weights: {
    interaction: number;
    credibility: number;
    recency: number;
    diversity: number;
    corroboration: number;
  };
  /** Recency half-life in hours (older items decay below this). */
  recencyWindowHours: number;
}

/** Default profile id used when none is requested. */
export const DEFAULT_WEIGHT_PROFILE = 'balanced@v1';

/** Registry of available profiles. Implementations resolve by id. */
export function getWeightProfile(_id: string = DEFAULT_WEIGHT_PROFILE): WeightProfile {
  throw new Error('not implemented: define balanced@v1 from existing scoreWeights');
}
