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

import type {
  Cluster,
  ScoreBreakdown,
  SourceQuality,
  Confidence,
  Verification,
  SourceTier,
} from './contracts.ts';
import type { WeightProfile, CoreWeights } from './weights.ts';

/** The four normalized [0,1] core signals (pre-weighting). */
export interface RawSignals {
  corroboration: number; // C
  technicalSignificance: number; // T
  sourceTier: number; // S
  engagement: number; // E
}

/** The two multipliers wrapping the weighted core. */
export interface Multipliers {
  recency: number; // Recency(t) ∈ (0, 1]
  diversity: number; // Diversity ∈ [0.8, 1.15]
}

/** A complete, lossless record of one topic's score. */
export interface RatingBreakdown {
  signals: RawSignals;
  weights: CoreWeights;
  weightedCore: number; // Σ wᵢ·signalᵢ
  recency: number; // multiplier
  diversity: number; // multiplier
  total: number; // recency × weightedCore × diversity
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * Apply the finalized model: Score = Recency × [ Σ wᵢ·signalᵢ ] × Diversity.
 * Pure and deterministic; the heart of the rating engine.
 */
export function computeScore(
  signals: RawSignals,
  multipliers: Multipliers,
  profile: WeightProfile,
): RatingBreakdown {
  const w = profile.weights;
  const weightedCore =
    w.corroboration * signals.corroboration +
    w.technicalSignificance * signals.technicalSignificance +
    w.sourceTier * signals.sourceTier +
    w.engagement * signals.engagement;
  const total = multipliers.recency * weightedCore * multipliers.diversity;
  return {
    signals,
    weights: { ...w },
    weightedCore,
    recency: multipliers.recency,
    diversity: multipliers.diversity,
    total,
  };
}

// ---------------------------------------------------------------------------
// Confidence + editorial gate (§2.7)
// ---------------------------------------------------------------------------

export interface ConfidenceInputs {
  corroboration: number; // C (reused from the score signals)
  tierConf: number; // 1.0 if a Tier-1 primary present, else maxTier value
  cohesion: number; // mean intra-cluster similarity (singleton → 1.0)
  agreement: number; // low when engagement is high but corroboration ~0
}

export type GateStatus = 'auto' | 'flagged' | 'hold';

/** Confidence = wC·C + wTier·tierConf + wCohesion·cohesion + wAgreement·agreement. */
export function computeConfidence(parts: ConfidenceInputs, profile: WeightProfile): number {
  const w = profile.confidence.weights;
  const value =
    w.corroboration * parts.corroboration +
    w.tierConf * parts.tierConf +
    w.cohesion * parts.cohesion +
    w.agreement * parts.agreement;
  return clamp(value, 0, 1);
}

/** Map a confidence value onto the auto / flagged / hold editorial gate. */
export function confidenceStatus(confidence: number, profile: WeightProfile): GateStatus {
  if (confidence >= profile.confidence.autoThreshold) return 'auto';
  if (confidence >= profile.confidence.holdThreshold) return 'flagged';
  return 'hold';
}

/** Map a confidence value onto the shared `Confidence` enum (gate-aligned). */
export function toConfidenceLabel(confidence: number, profile: WeightProfile): Confidence {
  const status = confidenceStatus(confidence, profile);
  return status === 'auto' ? 'high' : status === 'flagged' ? 'medium' : 'low';
}

// ---------------------------------------------------------------------------
// Anti-gaming promotion gate (§2.8): engagement is necessary-not-sufficient.
// ---------------------------------------------------------------------------

export interface EligibilityInputs {
  independentOwners: number;
  hasTier1Primary: boolean;
}

/** A topic may enter the Top-10 only with ≥minIndependentOwners OR a Tier-1 primary. */
export function isEligibleForTop10(inputs: EligibilityInputs, profile: WeightProfile): boolean {
  return (
    inputs.hasTier1Primary || inputs.independentOwners >= profile.promotion.minIndependentOwners
  );
}

// ---------------------------------------------------------------------------
// Provenance labels — derived from the cluster's tier histogram (deterministic).
// ---------------------------------------------------------------------------

function hasTier1(cluster: Cluster, profile: WeightProfile): boolean {
  for (const [tier, count] of Object.entries(cluster.tierHistogram)) {
    if ((count ?? 0) > 0 && profile.sourceTier.rankByTaxonomy[tier as SourceTier] === 'T1') {
      return true;
    }
  }
  return false;
}

/** corroborated | multi-source | single trusted source | single source. */
export function deriveSourceQuality(cluster: Cluster, profile: WeightProfile): SourceQuality {
  const distinct = cluster.distinctDomains;
  const trusted = hasTier1(cluster, profile);
  if (distinct >= 2 && trusted) return 'corroborated';
  if (distinct >= 2) return 'multi-source';
  if (trusted) return 'single trusted source';
  return 'single source';
}

/** multi-source vs single-source. */
export function deriveVerification(cluster: Cluster): Verification {
  return cluster.distinctDomains >= 2 ? 'multi-source' : 'single-source';
}

// ---------------------------------------------------------------------------
// Tie-breaking (§2.6): when |ΔScore| < ε, order by the documented keys.
// ---------------------------------------------------------------------------

export interface TieBreakKeys {
  score: number;
  independentOwners: number; // 1. more independent owners wins
  maxTier: number; // 2. primary anchor present
  technicalSignificance: number; // 3. significance
  freshestMs: number; // 4. freshest corroboration timestamp
  topicKeyHash: number; // 5. stable deterministic hash (anti-flapping)
}

/** Comparator for descending rank order with the §2.6 tie-break cascade. */
export function compareForRank(a: TieBreakKeys, b: TieBreakKeys, profile: WeightProfile): number {
  // Quantize to ε-wide buckets first — this makes the primary key transitive.
  // The old |Δscore| < ε check was not transitive: A≈B and B≈C does not imply
  // A≈C, which could cause sort() to cycle (violating strict weak ordering).
  const bucketA = Math.round(a.score / profile.tieBreakEpsilon);
  const bucketB = Math.round(b.score / profile.tieBreakEpsilon);
  if (bucketA !== bucketB) return bucketB - bucketA;
  // Within the same bucket, apply the §2.6 cascade:
  if (a.independentOwners !== b.independentOwners) return b.independentOwners - a.independentOwners;
  if (a.maxTier !== b.maxTier) return b.maxTier - a.maxTier;
  if (a.technicalSignificance !== b.technicalSignificance) {
    return b.technicalSignificance - a.technicalSignificance;
  }
  if (a.freshestMs !== b.freshestMs) return b.freshestMs - a.freshestMs;
  return b.topicKeyHash - a.topicKeyHash;
}

// ---------------------------------------------------------------------------
// Mapping onto the shared contract (lossy by design — see CONTRACT NOTE above).
// ---------------------------------------------------------------------------

/**
 * Project a `RatingBreakdown` onto the shared `ScoreBreakdown`.
 * Rev 3: `technicalSignificance` is a typed field — the mapping is now lossless.
 */
export function toScoreBreakdown(rating: RatingBreakdown): ScoreBreakdown {
  return {
    corroboration: rating.signals.corroboration,
    credibility: rating.signals.sourceTier, // S = source-tier credibility
    interaction: rating.signals.engagement, // E = engagement / attention
    technicalSignificance: rating.signals.technicalSignificance, // Rev 3: typed slot
    recency: rating.recency,
    diversity: rating.diversity,
    total: rating.total,
    weights: { ...rating.weights },
  };
}
