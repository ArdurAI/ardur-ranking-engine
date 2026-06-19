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
export * from './contracts.ts';
export { DEFAULT_WEIGHT_PROFILE, BALANCED_V1, getWeightProfile, coreWeightsAreNormalized, } from './weights.ts';
export type { WeightProfile, CoreWeights, CredibilityTier } from './weights.ts';
export { corroborationScore, sourceTierBlend, sourceTierSignal, recencyHalfLifeHours, recencyDecay, diversityMultiplier, engagementScore, ageHoursSince, tierValue, hasTier1Primary, maxTierValue, countIndependentOwners, normalizeOwnerDomain, technicalSignificanceSignal, ownerDiversity, platformVelocities, corroborationSignal, factCorroborationSignal, engagementSignal, } from './signals.ts';
export type { SignalInputs } from './signals.ts';
export { computeScore, computeConfidence, confidenceStatus, toConfidenceLabel, isEligibleForTop10, deriveSourceQuality, deriveVerification, compareForRank, toScoreBreakdown, } from './score.ts';
export type { RawSignals, Multipliers, RatingBreakdown, ConfidenceInputs, GateStatus, EligibilityInputs, TieBreakKeys, } from './score.ts';
export { buildAuditEntry, explainRanking, auditIdFor, stableHashNumber } from './audit.ts';
export type { AuditInput } from './audit.ts';
export interface RankingOptions {
    /** Named weight profile to apply. Defaults to `balanced@v1`. */
    weightProfile?: string;
    /** Override the wall clock (testing/replay). Drives generatedAt and runId. */
    now?: Date;
    /** Override the generated runId (agent idempotency key). */
    runId?: string;
}
/**
 * Rank a full `AggregationArtifact`.
 *
 * For each topic: extracts the four core signals per cluster, applies the
 * recency and diversity multipliers, computes the confidence gate, sorts by
 * score with the §2.6 tie-break cascade, and emits a lossless audit entry.
 * The cycle / runId provenance chain is preserved from the upstream artifact.
 *
 * Deterministic: same artifact + same profile + same `now` ⇒ same output.
 * Total function: a cluster that errors during scoring is recorded as score=0
 * with a warning rather than throwing mid-run.
 */
export declare function runRanking(aggregation: AggregationArtifact, options?: RankingOptions): RankingArtifact;
