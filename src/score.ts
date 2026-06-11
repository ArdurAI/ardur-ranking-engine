/**
 * Scoring — combine raw signals + weights into a ScoreBreakdown, and derive the
 * qualitative provenance labels (sourceQuality, confidence, verification).
 *
 * SCAFFOLD ONLY. Port the label logic from build-news-digests.mjs:
 * `sourceQuality()`, `confidenceFromReferences()`, and the multi/single-source
 * verification rule.
 */

import type {
  Cluster,
  ScoreBreakdown,
  SourceQuality,
  Confidence,
  Verification,
} from './contracts.ts';
import type { WeightProfile } from './weights.ts';

export interface RawSignals {
  interaction: number;
  credibility: number;
  recency: number;
  diversity: number;
  corroboration: number;
}

/** Apply a weight profile to raw signals → a fully itemized ScoreBreakdown. */
export function computeScore(_signals: RawSignals, _profile: WeightProfile): ScoreBreakdown {
  throw new Error('not implemented: weighted sum + record weights used');
}

/** corroborated | multi-source | single trusted source | single source. */
export function deriveSourceQuality(_cluster: Cluster): SourceQuality {
  throw new Error('not implemented: port sourceQuality() from build-news-digests.mjs');
}

/** high (>=3 sources) | medium (>=2) | low (1). */
export function deriveConfidence(_cluster: Cluster): Confidence {
  throw new Error('not implemented: port confidenceFromReferences()');
}

/** multi-source vs single-source. */
export function deriveVerification(_cluster: Cluster): Verification {
  throw new Error('not implemented');
}
