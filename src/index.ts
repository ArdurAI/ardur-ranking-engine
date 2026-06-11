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

import type {
  AggregatedItem,
  AggregationArtifact,
  AuditEntry,
  Cluster,
  ExtractedFact,
  RankedCluster,
  RankingArtifact,
  RankingData,
  ScoreBreakdown,
  SourceDocument,
  SourceRef,
} from './contracts.ts';
import { CONTRACT_REVISION, SCHEMA_VERSION } from './contracts.ts';
import { DEFAULT_WEIGHT_PROFILE, getWeightProfile } from './weights.ts';
import type { WeightProfile } from './weights.ts';
import {
  corroborationSignal,
  factCorroborationSignal,
  technicalSignificanceSignal,
  sourceTierSignal,
  engagementSignal,
  ownerDiversity,
  countIndependentOwners,
  recencyHalfLifeHours,
  recencyDecay,
  diversityMultiplier,
  ageHoursSince,
  hasTier1Primary,
  maxTierValue,
} from './signals.ts';
import type { SignalInputs } from './signals.ts';
import {
  computeScore,
  computeConfidence,
  confidenceStatus,
  toConfidenceLabel,
  deriveSourceQuality,
  deriveVerification,
  compareForRank,
  toScoreBreakdown,
} from './score.ts';
import type { RawSignals, Multipliers, TieBreakKeys } from './score.ts';
import { buildAuditEntry, stableHashNumber } from './audit.ts';

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
  hasTier1Primary,
  maxTierValue,
  countIndependentOwners,
  technicalSignificanceSignal,
  ownerDiversity,
  platformVelocities,
  corroborationSignal,
  factCorroborationSignal,
  engagementSignal,
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
  /** Override the wall clock (testing/replay). Drives generatedAt and runId. */
  now?: Date;
  /** Override the generated runId (agent idempotency key). */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** agreement = low when engagement is high but corroboration is near zero. */
function agreementScore(corroboration: number, engagement: number): number {
  return 1 - Math.max(0, engagement - corroboration);
}

/** Deterministic run ID for a ranking stage execution. */
function generateRunId(cycleId: string, now: Date): string {
  const h = stableHashNumber(`ranking|${cycleId}|${now.toISOString()}`);
  return `rank-${h.toString(16).padStart(8, '0')}`;
}

interface ScoredEntry {
  rankedCluster: RankedCluster;
  tieKeys: TieBreakKeys;
  auditEntry: AuditEntry;
}

function scoreCluster(
  cluster: Cluster,
  itemsById: Map<string, AggregatedItem>,
  profile: WeightProfile,
  now: Date,
  clusterFacts?: ExtractedFact[],
  clusterDocuments?: SourceDocument[],
): ScoredEntry {
  const members = cluster.memberIds
    .map((id) => itemsById.get(id))
    .filter((item): item is AggregatedItem => item !== undefined);

  const signalInput: SignalInputs = {
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
  const signals: RawSignals = { corroboration, technicalSignificance, sourceTier, engagement };

  // -- Recency multiplier --
  const halfLifeHours = recencyHalfLifeHours(technicalSignificance, profile);
  const ageHours = ageHoursSince(cluster.latestPublishedAt, now);
  const recency = recencyDecay(ageHours, halfLifeHours);

  // -- Diversity multiplier --
  const div = ownerDiversity(signalInput);
  const diversity = diversityMultiplier(div, profile);

  const multipliers: Multipliers = { recency, diversity };
  const rating = computeScore(signals, multipliers, profile);

  // -- Confidence + editorial gate --
  const hasTier1 = hasTier1Primary(cluster, profile);
  const tierConf = hasTier1 ? 1.0 : maxTierValue(cluster, profile);
  const independentOwners = countIndependentOwners(signalInput);
  const agreement = agreementScore(corroboration, engagement);

  const confidenceInputs = {
    corroboration,
    tierConf,
    cohesion: 1.0, // stub: singleton → 1.0 (cohesion estimation tracked separately)
    agreement,
  };
  const confidence = computeConfidence(confidenceInputs, profile);
  const gate = confidenceStatus(confidence, profile);

  // -- Fact-level corroboration (Rev 3) --
  const factCorroboration = clusterFacts ? factCorroborationSignal(clusterFacts) : 0;

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
  const tieKeys: TieBreakKeys = {
    score: rating.total,
    independentOwners,
    maxTier: maxTierValue(cluster, profile),
    technicalSignificance,
    freshestMs: new Date(cluster.latestPublishedAt).valueOf() || 0,
    topicKeyHash: stableHashNumber(cluster.clusterId),
  };

  const rankedCluster: RankedCluster = {
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
function buildReferences(members: AggregatedItem[]): SourceRef[] {
  return members.map((m): SourceRef => ({
    source: m.source,
    sourceDomain: m.sourceDomain,
    tier: m.tier,
    url: m.url,
    title: m.title,
    publishedAt: m.publishedAt,
  }));
}

/** Collect SourceDocument IDs that cover this cluster's member domains. */
function buildSourceDocIds(documents: SourceDocument[], memberDomains: Set<string>): string[] {
  return documents
    .filter((d) => memberDomains.has(d.sourceDomain.toLowerCase()))
    .map((d) => d.id);
}

/** Zero-score ranked cluster emitted when scoring fails (total-function guarantee). */
function zeroRankedCluster(
  cluster: Cluster,
  profile: WeightProfile,
): { rankedCluster: RankedCluster; tieKeys: TieBreakKeys } {
  const zeroScore: ScoreBreakdown = {
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
export function runRanking(
  aggregation: AggregationArtifact,
  options: RankingOptions = {},
): RankingArtifact {
  const profile = getWeightProfile(options.weightProfile ?? DEFAULT_WEIGHT_PROFILE);
  const now = options.now ?? new Date();
  const warnings: string[] = [...aggregation.warnings];

  // Rev 3: passthrough collections (may be absent on older aggregator output).
  const factsByCluster = aggregation.data.factsByCluster;
  const documentsByTopic = aggregation.data.documentsByTopic;

  const rankedByTopic: Record<string, RankedCluster[]> = {};
  const audit: AuditEntry[] = [];

  for (const [topicKey, clusters] of Object.entries(
    aggregation.data.clustersByTopic ?? {},
  )) {
    const items = aggregation.data.itemsByTopic?.[topicKey] ?? [];
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const topicDocuments = documentsByTopic?.[topicKey];

    const scored: Array<{ rankedCluster: RankedCluster; tieKeys: TieBreakKeys; auditEntry: AuditEntry | null }> = [];

    for (const cluster of clusters) {
      try {
        const clusterFacts = factsByCluster?.[cluster.clusterId];
        const entry = scoreCluster(cluster, itemsById, profile, now, clusterFacts, topicDocuments);
        scored.push({ ...entry, auditEntry: entry.auditEntry });
      } catch (err) {
        warnings.push(
          `Scoring failed for cluster ${cluster.clusterId} (topic: ${topicKey}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        const zero = zeroRankedCluster(cluster, profile);
        scored.push({ ...zero, auditEntry: null });
      }
    }

    // Sort descending by score with the §2.6 tie-break cascade.
    scored.sort((a, b) => compareForRank(a.tieKeys, b.tieKeys, profile));

    // Assign 1-based ranks and collect audit entries.
    const topicRanked: RankedCluster[] = [];
    for (let i = 0; i < scored.length; i++) {
      const entry = scored[i];
      if (entry === undefined) continue;
      entry.rankedCluster.rank = i + 1;
      topicRanked.push(entry.rankedCluster);
      if (entry.auditEntry !== null) audit.push(entry.auditEntry);
    }

    rankedByTopic[topicKey] = topicRanked;
  }

  // Rev 3: carry factsByCluster + documentsByTopic through so downstream
  // stages (top-10, synthesizer) can access them without re-reading the
  // full aggregation artifact.
  const data: RankingData & {
    factsByCluster?: typeof factsByCluster;
    documentsByTopic?: typeof documentsByTopic;
  } = {
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
    data: data as RankingData,
  };
}
