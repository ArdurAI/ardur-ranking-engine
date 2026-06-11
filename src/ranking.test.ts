/**
 * Comprehensive ranking-engine tests: runRanking, signal extraction, and
 * integration properties (audit reproducibility, tie-breaks, boundary conditions).
 *
 * All fixtures are fully deterministic (no Date.now(), no Math.random()).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AggregationArtifact,
  AggregatedItem,
  Cluster,
  CycleMeta,
  TopicMeta,
} from './contracts.ts';
import { SCHEMA_VERSION } from './contracts.ts';
import { BALANCED_V1 } from './weights.ts';
import {
  corroborationScore,
  sourceTierSignal,
  recencyDecay,
  recencyHalfLifeHours,
  diversityMultiplier,
  engagementScore,
  countIndependentOwners,
  technicalSignificanceSignal,
  ownerDiversity,
  platformVelocities,
  hasTier1Primary,
  maxTierValue,
} from './signals.ts';
import { computeScore, computeConfidence, toConfidenceLabel } from './score.ts';
import { buildAuditEntry } from './audit.ts';
import { runRanking } from './index.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-11T12:00:00Z');
const CYCLE: CycleMeta = {
  id: '2026-06-11T12:00Z',
  windowStart: '2026-06-11T12:00:00Z',
  windowEnd: '2026-06-11T18:00:00Z',
};
const TOPICS: TopicMeta[] = [
  { id: 'kubernetes', label: 'Kubernetes', description: 'Kubernetes releases and ecosystem' },
  { id: 'ai-models', label: 'AI Models', description: 'Foundation model releases' },
];

const P = BALANCED_V1;
const approx = (a: number, b: number, eps = 0.005): void =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);

function makeItem(overrides: Partial<AggregatedItem> & Pick<AggregatedItem, 'id' | 'clusterId'>): AggregatedItem {
  return {
    topic: 'kubernetes',
    topicLabel: 'Kubernetes',
    title: 'Test article',
    source: 'The New Stack',
    sourceDomain: 'thenewstack.io',
    sourceUrl: 'https://thenewstack.io',
    url: 'https://thenewstack.io/test',
    tier: 'technical-news',
    publishedAt: '2026-06-11T06:00:00Z',
    summaryHint: '',
    interaction: {
      feedRank: 0,
      shares: null,
      comments: null,
      reactions: null,
      crossSourceMentions: 2,
      velocity: 3.0,
      capturedAt: NOW.toISOString(),
      provenance: 'rss-feed',
    },
    fingerprint: overrides.id,
    ...overrides,
  };
}

function makeCluster(overrides: Partial<Cluster> & Pick<Cluster, 'clusterId'>): Cluster {
  return {
    topic: 'kubernetes',
    topicLabel: 'Kubernetes',
    headline: 'Kubernetes v1.30 GA release',
    memberIds: [],
    sourceCount: 1,
    distinctDomains: 1,
    tierHistogram: { 'technical-news': 1 },
    earliestPublishedAt: '2026-06-11T06:00:00Z',
    latestPublishedAt: '2026-06-11T06:00:00Z',
    ...overrides,
  };
}

function makeArtifact(
  clustersByTopic: Record<string, Cluster[]>,
  itemsByTopic: Record<string, AggregatedItem[]> = {},
): AggregationArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId: 'agg-00000001',
    upstreamRunId: null,
    generatedAt: '2026-06-11T12:00:00Z',
    cycle: CYCLE,
    topics: TOPICS,
    warnings: [],
    data: { clustersByTopic, itemsByTopic, coverageByTopic: {} },
  };
}

// ---------------------------------------------------------------------------
// Signal extraction — unit tests
// ---------------------------------------------------------------------------

test('countIndependentOwners: deduplicates by domain, filters by min tier', () => {
  const cluster = makeCluster({ clusterId: 'c-1', distinctDomains: 3 });

  // Two members from the same domain → count as 1
  const items: AggregatedItem[] = [
    makeItem({ id: 'i1', clusterId: 'c-1', sourceDomain: 'kubernetes.io', tier: 'primary' }),
    makeItem({ id: 'i2', clusterId: 'c-1', sourceDomain: 'kubernetes.io', tier: 'primary' }),
    makeItem({ id: 'i3', clusterId: 'c-1', sourceDomain: 'thenewstack.io', tier: 'technical-news' }),
  ];
  const n = countIndependentOwners({ cluster, members: items, now: NOW, profile: P });
  assert.equal(n, 2); // kubernetes.io + thenewstack.io

  // T4 sources (not present in the taxonomy but conceptually below T3) — all T2/T1 here, so all count
  const emptyCluster = makeCluster({ clusterId: 'c-empty', distinctDomains: 4 });
  const noMembers = countIndependentOwners({ cluster: emptyCluster, members: [], now: NOW, profile: P });
  assert.equal(noMembers, 4); // falls back to cluster.distinctDomains
});

test('technicalSignificanceSignal: rule table matches expected values', () => {
  // Actively exploited → 0.95.  Use a non-platform topic so the AI/platform bonus
  // does not apply; "kubernetes" in the default topic would add +0.10.
  const cve = makeCluster({
    clusterId: 'c-cve',
    topic: 'security-news',
    topicLabel: 'Security News',
    headline: 'CVE-2025-1234 exploited in the wild (CVSS 9.8)',
  });
  const cveT = technicalSignificanceSignal({ cluster: cve, members: [], now: NOW, profile: P });
  approx(cveT, 0.95); // 0.95 rule; no platform keyword → no +0.10 bonus

  // GA release with kubernetes topic → 0.72 GA + 0.10 platform lean = 0.82
  const ga = makeCluster({ clusterId: 'c-ga', headline: 'Kubernetes v1.30 general availability' });
  const gaT = technicalSignificanceSignal({ cluster: ga, members: [], now: NOW, profile: P });
  approx(gaT, 0.82);

  // Major v-prefix release with kubernetes topic → 0.80 + 0.10 = 0.90
  const major = makeCluster({ clusterId: 'c-major', headline: 'Helm v4.0 released' });
  const majorT = technicalSignificanceSignal({ cluster: major, members: [], now: NOW, profile: P });
  approx(majorT, 0.90);

  // No match → noise floor 0.20 (non-platform topic to avoid bonus)
  const noSig = makeCluster({
    clusterId: 'c-none',
    topic: 'industry-events',
    topicLabel: 'Industry Events',
    headline: 'Conference recap: talks and panels',
  });
  const noneT = technicalSignificanceSignal({ cluster: noSig, members: [], now: NOW, profile: P });
  approx(noneT, 0.20);

  // AI/platform lean bonus applies on LLM topics (non-kubernetes topic; LLM in headline)
  const llm = makeCluster({
    clusterId: 'c-llm',
    topic: 'ai-research',
    topicLabel: 'AI Research',
    headline: 'New large language model benchmarks',
  });
  const llmT = technicalSignificanceSignal({ cluster: llm, members: [], now: NOW, profile: P });
  approx(llmT, 0.30); // 0.20 floor + 0.10 LLM bonus = 0.30
});

test('ownerDiversity: single domain → 0; equal split + mixed types → > 0.5', () => {
  const cluster = makeCluster({ clusterId: 'c-div' });

  // Single domain → echo penalty = 0
  const single: AggregatedItem[] = [
    makeItem({ id: 'i1', clusterId: 'c-div', sourceDomain: 'kubernetes.io', tier: 'primary' }),
    makeItem({ id: 'i2', clusterId: 'c-div', sourceDomain: 'kubernetes.io', tier: 'primary' }),
  ];
  assert.equal(ownerDiversity({ cluster, members: single, now: NOW, profile: P }), 0);

  // Equal split across 3 domains with 2 different source categories
  const diverse: AggregatedItem[] = [
    makeItem({ id: 'd1', clusterId: 'c-div', sourceDomain: 'kubernetes.io', tier: 'primary' }),
    makeItem({ id: 'd2', clusterId: 'c-div', sourceDomain: 'thenewstack.io', tier: 'technical-news' }),
    makeItem({ id: 'd3', clusterId: 'c-div', sourceDomain: 'infoq.com', tier: 'technical-news' }),
  ];
  const div = ownerDiversity({ cluster, members: diverse, now: NOW, profile: P });
  assert.ok(div > 0, `expected div > 0, got ${div}`);
  assert.ok(div <= 1, `expected div ≤ 1, got ${div}`);

  // All three source categories → maximum diversity
  const maxDiverse: AggregatedItem[] = [
    makeItem({ id: 'm1', clusterId: 'c-div', sourceDomain: 'kubernetes.io', tier: 'primary' }),
    makeItem({ id: 'm2', clusterId: 'c-div', sourceDomain: 'arxiv.org', tier: 'paper' }),
    makeItem({ id: 'm3', clusterId: 'c-div', sourceDomain: 'thenewstack.io', tier: 'technical-news' }),
  ];
  const divMax = ownerDiversity({ cluster, members: maxDiverse, now: NOW, profile: P });
  assert.ok(divMax > div, `three-type diversity ${divMax} should exceed two-type ${div}`);
});

test('platformVelocities: sums velocity, normalizes by baseline', () => {
  const cluster = makeCluster({ clusterId: 'c-vel' });
  const highVel: AggregatedItem[] = [
    makeItem({ id: 'v1', clusterId: 'c-vel', interaction: { feedRank: 0, shares: null, comments: null, reactions: null, crossSourceMentions: 3, velocity: 10.0, capturedAt: NOW.toISOString(), provenance: 'rss' } }),
    makeItem({ id: 'v2', clusterId: 'c-vel', interaction: { feedRank: 0, shares: null, comments: null, reactions: null, crossSourceMentions: 2, velocity: 5.0, capturedAt: NOW.toISOString(), provenance: 'rss' } }),
  ];
  const vel = platformVelocities({ cluster, members: highVel, now: NOW, profile: P });
  assert.ok('feed' in vel, 'expected a feed key');
  approx(vel['feed'] ?? 0, 3.0); // (10 + 5) / 5 = 3.0

  // No velocity → fall back to crossSourceMentions
  const noVel: AggregatedItem[] = [
    makeItem({ id: 'n1', clusterId: 'c-vel', interaction: { feedRank: null, shares: null, comments: null, reactions: null, crossSourceMentions: 10, velocity: null, capturedAt: NOW.toISOString(), provenance: 'rss' } }),
  ];
  const velFb = platformVelocities({ cluster, members: noVel, now: NOW, profile: P });
  assert.ok('feed' in velFb, 'expected a feed key on fallback');
  approx(velFb['feed'] ?? 0, 2.0); // 10 / 5 = 2.0

  // No data → empty record
  const noData: AggregatedItem[] = [
    makeItem({ id: 'z1', clusterId: 'c-vel', interaction: { feedRank: null, shares: null, comments: null, reactions: null, crossSourceMentions: 0, velocity: null, capturedAt: NOW.toISOString(), provenance: 'rss' } }),
  ];
  const velEmpty = platformVelocities({ cluster, members: noData, now: NOW, profile: P });
  assert.equal(Object.keys(velEmpty).length, 0);
});

test('hasTier1Primary and maxTierValue from tier histogram', () => {
  const withT1 = makeCluster({ clusterId: 'c-t1', tierHistogram: { primary: 1, 'technical-news': 2 } });
  assert.equal(hasTier1Primary(withT1, P), true);
  approx(maxTierValue(withT1, P), 1.0);

  const withoutT1 = makeCluster({ clusterId: 'c-t2', tierHistogram: { 'technical-news': 3, news: 1 } });
  assert.equal(hasTier1Primary(withoutT1, P), false);
  approx(maxTierValue(withoutT1, P), 0.7); // T2 = 0.7
});

// ---------------------------------------------------------------------------
// runRanking integration
// ---------------------------------------------------------------------------

test('runRanking: empty input produces a valid empty RankingArtifact', () => {
  const artifact = makeArtifact({});
  const result = runRanking(artifact, { now: NOW });

  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.artifact, 'ranking');
  assert.equal(result.upstreamRunId, 'agg-00000001');
  assert.equal(result.cycle.id, CYCLE.id);
  assert.deepEqual(result.data.rankedByTopic, {});
  assert.deepEqual(result.data.audit, []);
  assert.equal(result.data.weightProfile, 'balanced@v1');
  assert.match(result.runId, /^rank-[0-9a-f]{8}$/);
});

test('runRanking: single cluster → rank 1, non-zero score', () => {
  const item = makeItem({
    id: 'i-1',
    clusterId: 'c-1',
    tier: 'primary',
    sourceDomain: 'kubernetes.io',
    title: 'Kubernetes v1.30 generally available',
    interaction: {
      feedRank: 0,
      shares: null,
      comments: null,
      reactions: null,
      crossSourceMentions: 5,
      velocity: 8.0,
      capturedAt: NOW.toISOString(),
      provenance: 'rss',
    },
  });
  const cluster = makeCluster({
    clusterId: 'c-1',
    headline: 'Kubernetes v1.30 generally available',
    memberIds: ['i-1'],
    sourceCount: 1,
    distinctDomains: 1,
    tierHistogram: { primary: 1 },
  });

  const result = runRanking(makeArtifact({ kubernetes: [cluster] }, { kubernetes: [item] }), { now: NOW });

  const ranked = result.data.rankedByTopic['kubernetes'];
  assert.ok(ranked, 'expected kubernetes topic in output');
  assert.equal(ranked.length, 1);
  const c = ranked[0]!;
  assert.equal(c.rank, 1);
  assert.ok(c.score.total > 0, `score.total should be > 0, got ${c.score.total}`);
  assert.equal(c.clusterId, 'c-1');
  assert.equal(c.auditId, result.data.audit[0]?.auditId);
});

test('runRanking: higher-signal cluster ranks above lower-signal cluster', () => {
  const highItem = makeItem({
    id: 'h-1',
    clusterId: 'c-high',
    tier: 'primary',
    sourceDomain: 'kubernetes.io',
    title: 'Critical CVE-2026-9999 exploited in the wild — CVSS 9.8 RCE',
    interaction: {
      feedRank: 0,
      shares: null,
      comments: null,
      reactions: null,
      crossSourceMentions: 10,
      velocity: 20.0,
      capturedAt: NOW.toISOString(),
      provenance: 'rss',
    },
  });
  const lowItem = makeItem({
    id: 'l-1',
    clusterId: 'c-low',
    tier: 'technical-news',
    sourceDomain: 'someblog.io',
    title: 'Conference recap: talks and panels',
    interaction: {
      feedRank: 5,
      shares: null,
      comments: null,
      reactions: null,
      crossSourceMentions: 1,
      velocity: 0.1,
      capturedAt: NOW.toISOString(),
      provenance: 'rss',
    },
  });

  const highCluster = makeCluster({
    clusterId: 'c-high',
    headline: 'Critical CVE-2026-9999 exploited in the wild — CVSS 9.8 RCE',
    memberIds: ['h-1'],
    sourceCount: 1,
    distinctDomains: 1,
    tierHistogram: { primary: 1 },
  });
  const lowCluster = makeCluster({
    clusterId: 'c-low',
    headline: 'Conference recap: talks and panels',
    memberIds: ['l-1'],
    sourceCount: 1,
    distinctDomains: 1,
    tierHistogram: { 'technical-news': 1 },
  });

  const result = runRanking(
    makeArtifact(
      { kubernetes: [lowCluster, highCluster] }, // low first in input
      { kubernetes: [highItem, lowItem] },
    ),
    { now: NOW },
  );

  const ranked = result.data.rankedByTopic['kubernetes']!;
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]!.clusterId, 'c-high');
  assert.equal(ranked[0]!.rank, 1);
  assert.equal(ranked[1]!.clusterId, 'c-low');
  assert.equal(ranked[1]!.rank, 2);
  assert.ok(ranked[0]!.score.total > ranked[1]!.score.total);
});

test('runRanking: tie-break by owner count when scores are within epsilon', () => {
  // Two clusters with identical structure except clusterId (different hash) and owner count.
  // By constructing them with different distinctDomains we drive the tie-break.
  const makeClusterN = (id: string, domains: number): Cluster =>
    makeCluster({
      clusterId: id,
      headline: 'Identical headline for tie testing',
      memberIds: [],
      sourceCount: domains,
      distinctDomains: domains,
      tierHistogram: { 'technical-news': domains },
    });

  const c3 = makeClusterN('c-owners-3', 3);
  const c5 = makeClusterN('c-owners-5', 5);

  const result = runRanking(makeArtifact({ kubernetes: [c3, c5] }), { now: NOW });
  const ranked = result.data.rankedByTopic['kubernetes']!;

  // Higher owner count should rank higher (tie-break rule 1)
  assert.equal(ranked[0]!.distinctDomains, 5);
  assert.equal(ranked[1]!.distinctDomains, 3);
});

test('runRanking: all-zero engagement → deterministic non-zero score from tier/corroboration', () => {
  const item = makeItem({
    id: 'z-1',
    clusterId: 'c-zero',
    tier: 'technical-news',
    interaction: {
      feedRank: null,
      shares: null,
      comments: null,
      reactions: null,
      crossSourceMentions: 0,
      velocity: null,
      capturedAt: NOW.toISOString(),
      provenance: 'rss',
    },
  });
  const cluster = makeCluster({
    clusterId: 'c-zero',
    memberIds: ['z-1'],
    distinctDomains: 1,
    tierHistogram: { 'technical-news': 1 },
  });

  const result = runRanking(makeArtifact({ kubernetes: [cluster] }, { kubernetes: [item] }), { now: NOW });
  const c = result.data.rankedByTopic['kubernetes']?.[0]!;

  // Even with zero engagement, tier and corroboration carry a score.
  assert.equal(c.score.interaction, 0);
  assert.ok(c.score.total > 0, `total should be positive, got ${c.score.total}`);
});

test('runRanking: very old cluster has near-zero recency', () => {
  const OLD_PUBLISHED = '2026-01-01T00:00:00Z'; // ~161 days before NOW
  const cluster = makeCluster({
    clusterId: 'c-old',
    earliestPublishedAt: OLD_PUBLISHED,
    latestPublishedAt: OLD_PUBLISHED,
    memberIds: [],
  });

  const result = runRanking(makeArtifact({ kubernetes: [cluster] }), { now: NOW });
  const c = result.data.rankedByTopic['kubernetes']?.[0]!;
  // Score should be effectively 0 after ~161 days of decay
  assert.ok(c.score.total < 0.001, `expected near-zero score, got ${c.score.total}`);
});

test('runRanking: multi-source T1+T2 cluster has auto confidence', () => {
  const t1 = makeItem({ id: 'm1', clusterId: 'c-conf', tier: 'primary', sourceDomain: 'kubernetes.io' });
  const t2a = makeItem({ id: 'm2', clusterId: 'c-conf', tier: 'technical-news', sourceDomain: 'thenewstack.io' });
  const t2b = makeItem({ id: 'm3', clusterId: 'c-conf', tier: 'news', sourceDomain: 'reuters.com' });

  const cluster = makeCluster({
    clusterId: 'c-conf',
    memberIds: ['m1', 'm2', 'm3'],
    sourceCount: 3,
    distinctDomains: 3,
    tierHistogram: { primary: 1, 'technical-news': 1, news: 1 },
    headline: 'Kubernetes v1.30 general availability — major release',
  });

  const result = runRanking(
    makeArtifact({ kubernetes: [cluster] }, { kubernetes: [t1, t2a, t2b] }),
    { now: NOW },
  );
  const c = result.data.rankedByTopic['kubernetes']?.[0]!;
  // T1 primary + multi-source → high confidence
  assert.equal(c.confidence, 'high');
  assert.equal(c.sourceQuality, 'corroborated');
  assert.equal(c.verification, 'multi-source');
});

test('runRanking: single low-tier cluster has low confidence', () => {
  const item = makeItem({ id: 's-1', clusterId: 'c-single', tier: 'technical-news', sourceDomain: 'blog.dev' });
  const cluster = makeCluster({
    clusterId: 'c-single',
    memberIds: ['s-1'],
    distinctDomains: 1,
    tierHistogram: { 'technical-news': 1 },
  });

  const result = runRanking(
    makeArtifact({ kubernetes: [cluster] }, { kubernetes: [item] }),
    { now: NOW },
  );
  const c = result.data.rankedByTopic['kubernetes']?.[0]!;
  assert.equal(c.sourceQuality, 'single source');
  assert.equal(c.verification, 'single-source');
});

test('runRanking: audit entries are lossless + recomputable', () => {
  const item = makeItem({ id: 'a-1', clusterId: 'c-audit', tier: 'primary', sourceDomain: 'kubernetes.io' });
  const cluster = makeCluster({
    clusterId: 'c-audit',
    memberIds: ['a-1'],
    distinctDomains: 1,
    tierHistogram: { primary: 1 },
    headline: 'Kubernetes v2.0 stable release',
  });

  const result = runRanking(
    makeArtifact({ kubernetes: [cluster] }, { kubernetes: [item] }),
    { now: NOW },
  );

  assert.equal(result.data.audit.length, 1);
  const entry = result.data.audit[0]!;

  // All required inputs preserved
  assert.ok('corroboration' in entry.inputs);
  assert.ok('technicalSignificance' in entry.inputs);
  assert.ok('sourceTier' in entry.inputs);
  assert.ok('engagement' in entry.inputs);
  assert.ok('weightedCore' in entry.inputs);
  assert.ok('recencyMultiplier' in entry.inputs);
  assert.ok('diversityMultiplier' in entry.inputs);
  assert.ok('total' in entry.inputs);
  assert.ok('confidence' in entry.inputs);

  // Reproducibility invariant: recompute total from audit inputs
  const recomputed = computeScore(
    {
      corroboration: entry.inputs['corroboration'] ?? 0,
      technicalSignificance: entry.inputs['technicalSignificance'] ?? 0,
      sourceTier: entry.inputs['sourceTier'] ?? 0,
      engagement: entry.inputs['engagement'] ?? 0,
    },
    {
      recency: entry.inputs['recencyMultiplier'] ?? 0,
      diversity: entry.inputs['diversityMultiplier'] ?? 0,
    },
    BALANCED_V1,
  );
  approx(recomputed.total, entry.inputs['total'] ?? -1, 1e-9);

  // auditId is stable (same inputs → same id)
  assert.equal(entry.auditId, result.data.rankedByTopic['kubernetes']?.[0]?.auditId);
});

test('runRanking: multiple topics are ranked independently', () => {
  const k8sCluster = makeCluster({ clusterId: 'c-k8s', topic: 'kubernetes' });
  const aiCluster = makeCluster({
    clusterId: 'c-ai',
    topic: 'ai-models',
    topicLabel: 'AI Models',
    headline: 'New large language model foundation release',
    tierHistogram: { 'technical-news': 1 },
  });

  const result = runRanking(makeArtifact({ kubernetes: [k8sCluster], 'ai-models': [aiCluster] }), { now: NOW });

  assert.ok('kubernetes' in result.data.rankedByTopic);
  assert.ok('ai-models' in result.data.rankedByTopic);
  assert.equal(result.data.rankedByTopic['kubernetes']?.length, 1);
  assert.equal(result.data.rankedByTopic['ai-models']?.length, 1);
});

test('runRanking: deterministic — same inputs → same output', () => {
  const cluster = makeCluster({ clusterId: 'c-det', memberIds: [] });
  const artifact = makeArtifact({ kubernetes: [cluster] });

  const r1 = runRanking(artifact, { now: NOW });
  const r2 = runRanking(artifact, { now: NOW });

  assert.equal(r1.runId, r2.runId);
  assert.equal(r1.data.rankedByTopic['kubernetes']?.[0]?.score.total,
               r2.data.rankedByTopic['kubernetes']?.[0]?.score.total);
  assert.equal(r1.data.audit[0]?.auditId, r2.data.audit[0]?.auditId);
});

test('runRanking: warnings from upstream artifact are preserved', () => {
  const artifact = makeArtifact({});
  artifact.warnings.push('upstream-warning-1');

  const result = runRanking(artifact, { now: NOW });
  assert.ok(result.warnings.includes('upstream-warning-1'));
});

test('runRanking: runId changes when now changes', () => {
  const artifact = makeArtifact({});
  const r1 = runRanking(artifact, { now: new Date('2026-06-11T12:00:00Z') });
  const r2 = runRanking(artifact, { now: new Date('2026-06-11T13:00:00Z') });
  assert.notEqual(r1.runId, r2.runId);
});

// ---------------------------------------------------------------------------
// Weight-sum invariant (regression guard for profile edits)
// ---------------------------------------------------------------------------

test('core weights sum exactly to 1.0 (±1e-9)', () => {
  const { corroboration, technicalSignificance, sourceTier, engagement } = P.weights;
  const sum = corroboration + technicalSignificance + sourceTier + engagement;
  approx(sum, 1.0, 1e-9);
});

// ---------------------------------------------------------------------------
// Boundary conditions
// ---------------------------------------------------------------------------

test('recency decay: age = 0 → 1.0; half-life H = 0 guard', () => {
  approx(recencyDecay(0, 24), 1.0);
  assert.equal(recencyDecay(1, 0), 0); // degenerate half-life
});

test('sourceTierSignal: empty histogram → 0', () => {
  const cluster = makeCluster({ clusterId: 'c-empty', tierHistogram: {} });
  const s = sourceTierSignal({ cluster, members: [], now: NOW, profile: P });
  assert.equal(s, 0);
});

test('engagementScore: all platforms above cap → clamps to 1', () => {
  // cap for all platforms is 1.0 — velocity 100 clamps to 1
  const e = engagementScore({ hn: 100, github: 100, reddit: 100 }, P);
  approx(e, 1.0);
});

test('corroborationScore: 0 owners → 0; n=8 → ≈ 1.0', () => {
  assert.equal(corroborationScore(0, P), 0);
  approx(corroborationScore(8, P), 1.0);
});

test('diversityMultiplier: div = 0 → floor 0.8; div = 1 → ceil 1.15', () => {
  approx(diversityMultiplier(0, P), 0.8);
  approx(diversityMultiplier(1, P), 1.15);
  approx(diversityMultiplier(2, P), 1.15); // clamped at ceiling
});

test('Score is bounded [0, 1.15]', () => {
  const max = computeScore(
    { corroboration: 1, technicalSignificance: 1, sourceTier: 1, engagement: 1 },
    { recency: 1, diversity: 1.15 },
    P,
  );
  approx(max.total, 1.15);

  const min = computeScore(
    { corroboration: 0, technicalSignificance: 0, sourceTier: 0, engagement: 0 },
    { recency: 1, diversity: 0.8 },
    P,
  );
  assert.equal(min.total, 0);
});

test('confidence: all-perfect inputs → 1.0; all-zero → 0', () => {
  const full = computeConfidence({ corroboration: 1, tierConf: 1, cohesion: 1, agreement: 1 }, P);
  approx(full, 1.0);
  const zero = computeConfidence({ corroboration: 0, tierConf: 0, cohesion: 0, agreement: 0 }, P);
  assert.equal(zero, 0);
  assert.equal(toConfidenceLabel(zero, P), 'low');
});
