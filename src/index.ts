/**
 * ardur-ranking-engine — public entrypoint.
 *
 * Stage 2 of the Ardur content pipeline. Implements the finalized topic-rating
 * model (see docs/spec.md and ~/Documents/Ardur-AI-Website/news-rating-system.md):
 *
 *   Score = Recency(t) × [ 0.30·C + 0.28·T + 0.22·S + 0.20·E ] × Diversity
 *
 *   C  Corroboration         — independent source OWNERS, log-saturating
 *   T  Technical significance — CVE/semver/release rules (+0.1 AI/platform lean)
 *   S  Source tier            — 0.7·maxTier + 0.3·meanTier
 *   E  Engagement             — capped, baseline-normalized velocity (counts only)
 *   Recency(t) = 0.5^(t/H), H = 12 + 24·T   ·   Diversity ∈ [0.8, 1.15]
 *
 * The model's math (combination, recency decay, corroboration curve, diversity,
 * confidence + the auto/flagged/hold gate, tie-breaks) is implemented and
 * deterministic with no paid-API dependency. The data-extraction layer
 * (owner-independence dedup, CVE/semver parsing, engagement baselines, cohesion/
 * agreement) and the per-artifact orchestration (`runRanking`) remain scaffold
 * stubs, tracked as issues. An LLM is optional enrichment only — never required.
 */

import type { AggregationArtifact, RankingArtifact } from './contracts.ts';
import { DEFAULT_WEIGHT_PROFILE } from './weights.ts';

export * from './contracts.ts';

// Weight profiles (tunable config — pure data).
export {
  DEFAULT_WEIGHT_PROFILE,
  BALANCED_V1,
  getWeightProfile,
  coreWeightsAreNormalized,
} from './weights.ts';
export type { WeightProfile, CoreWeights, CredibilityTier } from './weights.ts';

// Signal transforms (the model's formulas) + extraction.
export {
  corroborationScore,
  sourceTierBlend,
  sourceTierSignal,
  recencyHalfLifeHours,
  recencyDecay,
  diversityMultiplier,
  engagementScore,
  ageHoursSince,
  tierValue,
} from './signals.ts';
export type { SignalInputs } from './signals.ts';

// Scoring, confidence, gate, tie-breaks, contract mapping.
export {
  computeScore,
  computeConfidence,
  confidenceStatus,
  toConfidenceLabel,
  isEligibleForTop10,
  deriveSourceQuality,
  deriveVerification,
  compareForRank,
  toScoreBreakdown,
} from './score.ts';
export type {
  RawSignals,
  Multipliers,
  RatingBreakdown,
  ConfidenceInputs,
  GateStatus,
  EligibilityInputs,
  TieBreakKeys,
} from './score.ts';

// Audit trail.
export { buildAuditEntry, explainRanking, auditIdFor, stableHashNumber } from './audit.ts';
export type { AuditInput } from './audit.ts';

export interface RankingOptions {
  /** Named weight profile to apply. Defaults to `balanced@v1`. */
  weightProfile?: string;
  /** Override the wall clock (testing/replay). */
  now?: Date;
}

/**
 * Rank a full `AggregationArtifact`. Returns a `RankingArtifact` whose
 * `rankedByTopic` is sorted by score and whose `audit` is the lossless,
 * recomputable record of every topic's rating. The cycle/runId chain is
 * preserved from the upstream artifact.
 *
 * SCAFFOLD: orchestration is wired but unimplemented — it composes the
 * implemented model math with the still-stubbed extraction layer.
 */
export function runRanking(
  _aggregation: AggregationArtifact,
  _options: RankingOptions = {},
): RankingArtifact {
  void DEFAULT_WEIGHT_PROFILE;
  throw new Error(
    'not implemented: extract signals -> computeScore -> confidence/gate -> rank -> audit',
  );
}
