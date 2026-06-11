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
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/**
 * Apply the finalized model: Score = Recency × [ Σ wᵢ·signalᵢ ] × Diversity.
 * Pure and deterministic; the heart of the rating engine.
 */
export function computeScore(signals, multipliers, profile) {
    const w = profile.weights;
    const weightedCore = w.corroboration * signals.corroboration +
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
/** Confidence = wC·C + wTier·tierConf + wCohesion·cohesion + wAgreement·agreement. */
export function computeConfidence(parts, profile) {
    const w = profile.confidence.weights;
    const value = w.corroboration * parts.corroboration +
        w.tierConf * parts.tierConf +
        w.cohesion * parts.cohesion +
        w.agreement * parts.agreement;
    return clamp(value, 0, 1);
}
/** Map a confidence value onto the auto / flagged / hold editorial gate. */
export function confidenceStatus(confidence, profile) {
    if (confidence >= profile.confidence.autoThreshold)
        return 'auto';
    if (confidence >= profile.confidence.holdThreshold)
        return 'flagged';
    return 'hold';
}
/** Map a confidence value onto the shared `Confidence` enum (gate-aligned). */
export function toConfidenceLabel(confidence, profile) {
    const status = confidenceStatus(confidence, profile);
    return status === 'auto' ? 'high' : status === 'flagged' ? 'medium' : 'low';
}
/** A topic may enter the Top-10 only with ≥minIndependentOwners OR a Tier-1 primary. */
export function isEligibleForTop10(inputs, profile) {
    return (inputs.hasTier1Primary || inputs.independentOwners >= profile.promotion.minIndependentOwners);
}
// ---------------------------------------------------------------------------
// Provenance labels — derived from the cluster's tier histogram (deterministic).
// ---------------------------------------------------------------------------
function hasTier1(cluster, profile) {
    for (const [tier, count] of Object.entries(cluster.tierHistogram)) {
        if ((count ?? 0) > 0 && profile.sourceTier.rankByTaxonomy[tier] === 'T1') {
            return true;
        }
    }
    return false;
}
/** corroborated | multi-source | single trusted source | single source. */
export function deriveSourceQuality(cluster, profile) {
    const distinct = cluster.distinctDomains;
    const trusted = hasTier1(cluster, profile);
    if (distinct >= 2 && trusted)
        return 'corroborated';
    if (distinct >= 2)
        return 'multi-source';
    if (trusted)
        return 'single trusted source';
    return 'single source';
}
/** multi-source vs single-source. */
export function deriveVerification(cluster) {
    return cluster.distinctDomains >= 2 ? 'multi-source' : 'single-source';
}
/** Comparator for descending rank order with the §2.6 tie-break cascade. */
export function compareForRank(a, b, profile) {
    if (Math.abs(a.score - b.score) >= profile.tieBreakEpsilon)
        return b.score - a.score;
    if (a.independentOwners !== b.independentOwners)
        return b.independentOwners - a.independentOwners;
    if (a.maxTier !== b.maxTier)
        return b.maxTier - a.maxTier;
    if (a.technicalSignificance !== b.technicalSignificance) {
        return b.technicalSignificance - a.technicalSignificance;
    }
    if (a.freshestMs !== b.freshestMs)
        return b.freshestMs - a.freshestMs;
    return b.topicKeyHash - a.topicKeyHash;
}
// ---------------------------------------------------------------------------
// Mapping onto the shared contract (lossy by design — see CONTRACT NOTE above).
// ---------------------------------------------------------------------------
/**
 * Project a `RatingBreakdown` onto the shared `ScoreBreakdown`.
 * Rev 3: `technicalSignificance` is a typed field — the mapping is now lossless.
 */
export function toScoreBreakdown(rating) {
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
