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
import { CONTRACT_REVISION, SCHEMA_VERSION } from "./contracts.js";
import { DEFAULT_WEIGHT_PROFILE, getWeightProfile } from "./weights.js";
import { corroborationSignal, factCorroborationSignal, technicalSignificanceSignal, sourceTierSignal, engagementSignal, ownerDiversity, countIndependentOwners, recencyHalfLifeHours, recencyDecay, diversityMultiplier, ageHoursSince, hasTier1Primary, maxTierValue, } from "./signals.js";
import { computeScore, computeConfidence, confidenceStatus, toConfidenceLabel, isEligibleForTop10, deriveSourceQuality, deriveVerification, compareForRank, toScoreBreakdown, } from "./score.js";
import { buildAuditEntry, stableHashNumber } from "./audit.js";
export * from "./contracts.js";
// Weight profiles (tunable config — pure data).
export { DEFAULT_WEIGHT_PROFILE, BALANCED_V1, getWeightProfile, coreWeightsAreNormalized, } from "./weights.js";
// Signal transforms (the model's formulas) + extraction.
export { corroborationScore, sourceTierBlend, sourceTierSignal, recencyHalfLifeHours, recencyDecay, diversityMultiplier, engagementScore, ageHoursSince, tierValue, hasTier1Primary, maxTierValue, countIndependentOwners, normalizeOwnerDomain, technicalSignificanceSignal, ownerDiversity, platformVelocities, corroborationSignal, factCorroborationSignal, engagementSignal, } from "./signals.js";
// Scoring, confidence, gate, tie-breaks, contract mapping.
export { computeScore, computeConfidence, confidenceStatus, toConfidenceLabel, isEligibleForTop10, deriveSourceQuality, deriveVerification, compareForRank, toScoreBreakdown, } from "./score.js";
// Audit trail.
export { buildAuditEntry, explainRanking, auditIdFor, stableHashNumber } from "./audit.js";
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/** agreement = low when engagement is high but corroboration is near zero. */
function agreementScore(corroboration, engagement) {
    return 1 - Math.max(0, engagement - corroboration);
}
/**
 * Cohesion — mean intra-cluster similarity to the cluster headline.
 *
 * Tokenizes each member's title + summaryHint and measures what fraction of
 * the headline's tokens appear in the member text (Jaccard-lite overlap).
 * Singletons always return 1.0 (by definition a single source is internally
 * consistent).  Deterministic; no external dependencies.
 */
function computeCohesion(cluster, members) {
    if (members.length <= 1)
        return 1.0;
    const headlineWords = new Set(tokenizeText(cluster.headline));
    if (headlineWords.size === 0)
        return 1.0;
    let sumSim = 0;
    for (const m of members) {
        const memberWords = new Set(tokenizeText(`${m.title} ${m.summaryHint ?? ''}`));
        let overlap = 0;
        for (const w of headlineWords) {
            if (memberWords.has(w))
                overlap++;
        }
        sumSim += overlap / headlineWords.size;
    }
    return Math.min(1, sumSim / members.length);
}
function tokenizeText(text) {
    return text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
}
/** Deterministic run ID for a ranking stage execution. */
function generateRunId(cycleId, now) {
    const h = stableHashNumber(`ranking|${cycleId}|${now.toISOString()}`);
    return `rank-${h.toString(16).padStart(8, '0')}`;
}
function scoreCluster(cluster, itemsById, profile, now, clusterFacts, clusterDocuments) {
    const members = cluster.memberIds
        .map((id) => itemsById.get(id))
        .filter((item) => item !== undefined);
    const signalInput = {
        cluster,
        members,
        now,
        profile,
        ...(clusterFacts !== undefined && { facts: clusterFacts }),
    };
    // -- Core signals --
    const corroboration = corroborationSignal(signalInput);
    const technicalSignificance = technicalSignificanceSignal(signalInput);
    const sourceTier = sourceTierSignal(signalInput);
    const engagement = engagementSignal(signalInput);
    const signals = { corroboration, technicalSignificance, sourceTier, engagement };
    // -- Recency multiplier --
    const halfLifeHours = recencyHalfLifeHours(technicalSignificance, profile);
    const ageHours = ageHoursSince(cluster.latestPublishedAt, now);
    const recency = recencyDecay(ageHours, halfLifeHours);
    // -- Diversity multiplier --
    const div = ownerDiversity(signalInput);
    const diversity = diversityMultiplier(div, profile);
    const multipliers = { recency, diversity };
    const rating = computeScore(signals, multipliers, profile);
    // -- Confidence + editorial gate --
    const hasTier1 = hasTier1Primary(cluster, profile);
    const tierConf = hasTier1 ? 1.0 : maxTierValue(cluster, profile);
    const independentOwners = countIndependentOwners(signalInput);
    const agreement = agreementScore(corroboration, engagement);
    // #17: compute real cohesion — mean headline-token overlap across cluster members.
    const cohesion = computeCohesion(cluster, members);
    const confidenceInputs = {
        corroboration,
        tierConf,
        cohesion,
        agreement,
    };
    const confidence = computeConfidence(confidenceInputs, profile);
    let gate = confidenceStatus(confidence, profile);
    // #14: anti-gaming gate §2.8 — enforce isEligibleForTop10.
    // A cluster that lacks a T1 primary AND has fewer than minIndependentOwners must
    // be held regardless of confidence, preventing pure-engagement promotion.
    if (!isEligibleForTop10({ independentOwners, hasTier1Primary: hasTier1 }, profile)) {
        gate = 'hold';
    }
    // -- Fact-level corroboration (Rev 3) --
    const factCorroboration = clusterFacts ? factCorroborationSignal(clusterFacts, profile) : 0;
    // -- Rev 3: build references + sourceDocIds for downstream stages --
    const references = buildReferences(members);
    const memberDomains = new Set(members.map((m) => m.sourceDomain.toLowerCase()));
    const sourceDocIds = clusterDocuments ? buildSourceDocIds(clusterDocuments, memberDomains) : undefined;
    // -- Audit --
    const auditEntry = buildAuditEntry({
        clusterId: cluster.clusterId,
        topic: cluster.topic,
        rating,
        confidence,
        confidenceInputs,
        gate,
        independentOwners,
        halfLifeHours,
        ageHours,
        factCorroboration,
        weightProfile: profile.id,
        rankedAt: now,
    });
    // -- Tie-break keys (computed once, used for sort) --
    const tieKeys = {
        score: rating.total,
        independentOwners,
        maxTier: maxTierValue(cluster, profile),
        technicalSignificance,
        freshestMs: new Date(cluster.latestPublishedAt).valueOf() || 0,
        topicKeyHash: stableHashNumber(cluster.clusterId),
    };
    const rankedCluster = {
        clusterId: cluster.clusterId,
        topic: cluster.topic,
        topicLabel: cluster.topicLabel,
        headline: cluster.headline,
        rank: 0, // assigned after sort
        score: toScoreBreakdown(rating),
        sourceQuality: deriveSourceQuality(cluster, profile),
        confidence: toConfidenceLabel(confidence, profile),
        verification: deriveVerification(cluster),
        sourceCount: cluster.sourceCount,
        distinctDomains: cluster.distinctDomains,
        tierHistogram: { ...cluster.tierHistogram },
        memberIds: [...cluster.memberIds],
        earliestPublishedAt: cluster.earliestPublishedAt,
        latestPublishedAt: cluster.latestPublishedAt,
        auditId: auditEntry.auditId,
        // Rev 3 fields
        gateStatus: gate,
        ...(references.length > 0 && { references }),
        ...(sourceDocIds && sourceDocIds.length > 0 && { sourceDocIds }),
    };
    return { rankedCluster, tieKeys, auditEntry };
}
/** Build uncapped SourceRef list from cluster members (Rev 3 §6.1b). */
function buildReferences(members) {
    return members.map((m) => ({
        source: m.source,
        sourceDomain: m.sourceDomain,
        tier: m.tier,
        url: m.url,
        title: m.title,
        publishedAt: m.publishedAt,
    }));
}
/** Collect SourceDocument IDs that cover this cluster's member domains. */
function buildSourceDocIds(documents, memberDomains) {
    return documents
        .filter((d) => memberDomains.has(d.sourceDomain.toLowerCase()))
        .map((d) => d.id);
}
/** Zero-score ranked cluster emitted when scoring fails (total-function guarantee). */
function zeroRankedCluster(cluster, profile) {
    const zeroScore = {
        corroboration: 0,
        credibility: 0,
        interaction: 0,
        recency: 0,
        diversity: 0,
        total: 0,
        weights: { ...profile.weights },
    };
    return {
        rankedCluster: {
            clusterId: cluster.clusterId,
            topic: cluster.topic,
            topicLabel: cluster.topicLabel,
            headline: cluster.headline,
            rank: 0,
            score: zeroScore,
            sourceQuality: 'single source',
            confidence: 'low',
            verification: deriveVerification(cluster),
            sourceCount: cluster.sourceCount,
            distinctDomains: cluster.distinctDomains,
            tierHistogram: { ...cluster.tierHistogram },
            memberIds: [...cluster.memberIds],
            earliestPublishedAt: cluster.earliestPublishedAt,
            latestPublishedAt: cluster.latestPublishedAt,
            auditId: 'error',
        },
        tieKeys: {
            score: 0,
            independentOwners: 0,
            maxTier: 0,
            technicalSignificance: 0,
            freshestMs: 0,
            topicKeyHash: stableHashNumber(cluster.clusterId),
        },
    };
}
// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------
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
export function runRanking(aggregation, options = {}) {
    const profile = getWeightProfile(options.weightProfile ?? DEFAULT_WEIGHT_PROFILE);
    const now = options.now ?? new Date();
    const warnings = [...aggregation.warnings];
    // Rev 3: passthrough collections (may be absent on older aggregator output).
    const factsByCluster = aggregation.data.factsByCluster;
    const documentsByTopic = aggregation.data.documentsByTopic;
    const rankedByTopic = {};
    const audit = [];
    for (const [topicKey, clusters] of Object.entries(aggregation.data.clustersByTopic ?? {})) {
        const items = aggregation.data.itemsByTopic?.[topicKey] ?? [];
        const itemsById = new Map(items.map((item) => [item.id, item]));
        const topicDocuments = documentsByTopic?.[topicKey];
        const scored = [];
        for (const cluster of clusters) {
            try {
                const clusterFacts = factsByCluster?.[cluster.clusterId];
                const entry = scoreCluster(cluster, itemsById, profile, now, clusterFacts, topicDocuments);
                scored.push({ ...entry, auditEntry: entry.auditEntry });
            }
            catch (err) {
                warnings.push(`Scoring failed for cluster ${cluster.clusterId} (topic: ${topicKey}): ${err instanceof Error ? err.message : String(err)}`);
                const zero = zeroRankedCluster(cluster, profile);
                scored.push({ ...zero, auditEntry: null });
            }
        }
        // Sort descending by score with the §2.6 tie-break cascade.
        scored.sort((a, b) => compareForRank(a.tieKeys, b.tieKeys, profile));
        // Assign 1-based ranks and collect audit entries.
        const topicRanked = [];
        for (let i = 0; i < scored.length; i++) {
            const entry = scored[i];
            if (entry === undefined)
                continue;
            entry.rankedCluster.rank = i + 1;
            topicRanked.push(entry.rankedCluster);
            if (entry.auditEntry !== null)
                audit.push(entry.auditEntry);
        }
        rankedByTopic[topicKey] = topicRanked;
    }
    // Rev 3: carry factsByCluster + documentsByTopic through so downstream
    // stages (top-10, synthesizer) can access them without re-reading the
    // full aggregation artifact.
    const data = {
        rankedByTopic,
        audit,
        weightProfile: profile.id,
        ...(factsByCluster !== undefined && { factsByCluster }),
        ...(documentsByTopic !== undefined && { documentsByTopic }),
    };
    return {
        schemaVersion: SCHEMA_VERSION,
        contractRevision: CONTRACT_REVISION,
        artifact: 'ranking',
        runId: options.runId ?? generateRunId(aggregation.cycle.id, now),
        upstreamRunId: aggregation.runId,
        generatedAt: now.toISOString(),
        cycle: aggregation.cycle,
        topics: aggregation.topics,
        warnings,
        data: data,
    };
}
