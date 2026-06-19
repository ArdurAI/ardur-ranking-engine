/**
 * Scoring — combine the model's signals into a rating, derive confidence + the
 * editorial gate, map onto the shared `ScoreBreakdown`, and order ties.
 *
 * Finalized model (news-rating-system.md §2.1, §2.6, §2.7):
 *
 *   Score = Recency(t) × [ wC·C + wT·T + wS·S + wE·E ] × Diversity
 *   Confidence = 0.35·C + 0.30·tierConf + 0.20·cohesion + 0.15·agreement
 *   gate: ≥0.66 auto · 0.40–0.66 flagged · <0.40 hold
 *
 * The combination math, confidence, gate, tie-breaks, and the contract mapping
 * are PURE and implemented here. Provenance labels are derived from the
 * cluster's tier histogram. (Cohesion/agreement extraction lives upstream.)
 *
 * Rev 3: `ScoreBreakdown.technicalSignificance` is now a typed field; `toScoreBreakdown()`
 * is fully lossless — no CONTRACT NOTE workaround needed.
 */
import type { Cluster, ScoreBreakdown, SourceQuality, Confidence, Verification } from './contracts.ts';
import type { WeightProfile, CoreWeights } from './weights.ts';
/** The four normalized [0,1] core signals (pre-weighting). */
export interface RawSignals {
    corroboration: number;
    technicalSignificance: number;
    sourceTier: number;
    engagement: number;
}
/** The two multipliers wrapping the weighted core. */
export interface Multipliers {
    recency: number;
    diversity: number;
}
/** A complete, lossless record of one topic's score. */
export interface RatingBreakdown {
    signals: RawSignals;
    weights: CoreWeights;
    weightedCore: number;
    recency: number;
    diversity: number;
    total: number;
}
/**
 * Apply the finalized model: Score = Recency × [ Σ wᵢ·signalᵢ ] × Diversity.
 * Pure and deterministic; the heart of the rating engine.
 */
export declare function computeScore(signals: RawSignals, multipliers: Multipliers, profile: WeightProfile): RatingBreakdown;
export interface ConfidenceInputs {
    corroboration: number;
    tierConf: number;
    cohesion: number;
    agreement: number;
}
export type GateStatus = 'auto' | 'flagged' | 'hold';
/** Confidence = wC·C + wTier·tierConf + wCohesion·cohesion + wAgreement·agreement. */
export declare function computeConfidence(parts: ConfidenceInputs, profile: WeightProfile): number;
/** Map a confidence value onto the auto / flagged / hold editorial gate. */
export declare function confidenceStatus(confidence: number, profile: WeightProfile): GateStatus;
/** Map a confidence value onto the shared `Confidence` enum (gate-aligned). */
export declare function toConfidenceLabel(confidence: number, profile: WeightProfile): Confidence;
export interface EligibilityInputs {
    independentOwners: number;
    hasTier1Primary: boolean;
}
/** A topic may enter the Top-10 only with ≥minIndependentOwners OR a Tier-1 primary. */
export declare function isEligibleForTop10(inputs: EligibilityInputs, profile: WeightProfile): boolean;
/** corroborated | multi-source | single trusted source | single source. */
export declare function deriveSourceQuality(cluster: Cluster, profile: WeightProfile): SourceQuality;
/** multi-source vs single-source. */
export declare function deriveVerification(cluster: Cluster): Verification;
export interface TieBreakKeys {
    score: number;
    independentOwners: number;
    maxTier: number;
    technicalSignificance: number;
    freshestMs: number;
    topicKeyHash: number;
}
/** Comparator for descending rank order with the §2.6 tie-break cascade. */
export declare function compareForRank(a: TieBreakKeys, b: TieBreakKeys, profile: WeightProfile): number;
/**
 * Project a `RatingBreakdown` onto the shared `ScoreBreakdown`.
 * Rev 3: `technicalSignificance` is a typed field — the mapping is now lossless.
 */
export declare function toScoreBreakdown(rating: RatingBreakdown): ScoreBreakdown;
