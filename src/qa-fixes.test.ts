/**
 * QA-fix regression tests — one focused test block per issue (#13–#18).
 *
 * Structure: reproduce → fix → prove.  Each block names the issue number in
 * the test description so failures are self-identifying.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AggregatedItem, AggregationArtifact, Cluster, CycleMeta, ExtractedFact, TopicMeta } from './contracts.ts';
import { SCHEMA_VERSION } from './contracts.ts';
import { BALANCED_V1 } from './weights.ts';
import {
  NEUTRAL_AGE_HOURS,
  ageHoursSince,
  corroborationScore,
  factCorroborationSignal,
  corroborationSignal,
  countIndependentOwners,
  normalizeOwnerDomain,
  ownerDiversity,
} from './signals.ts';
import { isEligibleForTop10 } from './score.ts';
import { runRanking } from './index.ts';
import { validateAggregationArtifact } from './validate.ts';

const P = BALANCED_V1;
const NOW = new Date('2026-06-11T12:00:00Z');

const CYCLE: CycleMeta = {
  id: '2026-06-11T12:00Z',
  windowStart: '2026-06-11T12:00:00Z',
  windowEnd: '2026-06-11T18:00:00Z',
};
const TOPICS: TopicMeta[] = [
  { id: 'kubernetes', label: 'Kubernetes', description: 'k8s' },
];

const approx = (a: number, b: number, eps = 0.005): void =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);

function makeItem(overrides: Partial<AggregatedItem> & Pick<AggregatedItem, 'id' | 'clusterId'>): AggregatedItem {
  return {
    topic: 'kubernetes',
    topicLabel: 'Kubernetes',
    title: 'Kubernetes patch release',
    source: 'K8s Docs',
    sourceDomain: 'kubernetes.io',
    sourceUrl: 'https://kubernetes.io',
    url: 'https://kubernetes.io/article',
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
      provenance: 'rss',
    },
    fingerprint: overrides.id,
    ...overrides,
  };
}

function makeCluster(overrides: Partial<Cluster> & Pick<Cluster, 'clusterId'>): Cluster {
  return {
    topic: 'kubernetes',
    topicLabel: 'Kubernetes',
    headline: 'Kubernetes patch release available',
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
    artifact: 'aggregation' as const,
    runId: 'agg-qa-01',
    upstreamRunId: null,
    generatedAt: NOW.toISOString(),
    cycle: CYCLE,
    topics: TOPICS,
    warnings: [],
    data: { clustersByTopic, itemsByTopic, coverageByTopic: {} },
  };
}

function makeFact(overrides: Partial<ExtractedFact> & Pick<ExtractedFact, 'id' | 'clusterId'>): ExtractedFact {
  return {
    topic: 'kubernetes',
    statement: 'Test fact statement',
    entities: [],
    provenance: [{ sourceDocId: 'doc-1', sourceDomain: 'kubernetes.io', url: 'https://kubernetes.io' }],
    corroboration: 1,
    confidence: 'medium',
    extractedBy: { provider: 'deterministic', model: 'rule-based', status: 'generated', generatedAt: NOW.toISOString() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// #13 — validate fact.corroboration: NaN / Infinity / negative must never
//       reach the scorer and cause score.total to serialize as null.
// ---------------------------------------------------------------------------

test('#13 factCorroborationSignal: NaN corroboration is sanitized to 0, not NaN', () => {
  const facts = [makeFact({ id: 'f-nan', clusterId: 'c-1', corroboration: NaN as unknown as number })];
  const signal = factCorroborationSignal(facts, P);
  assert.ok(Number.isFinite(signal), `NaN corroboration must produce finite signal, got ${signal}`);
  assert.equal(signal, 0, 'NaN corroboration sanitized to 0 → corroborationScore(0, P) = 0');
});

test('#13 factCorroborationSignal: Infinity corroboration is sanitized, not Infinity', () => {
  const facts = [makeFact({ id: 'f-inf', clusterId: 'c-1', corroboration: Infinity as unknown as number })];
  const signal = factCorroborationSignal(facts, P);
  assert.ok(Number.isFinite(signal), `Infinity corroboration must produce finite signal, got ${signal}`);
});

test('#13 factCorroborationSignal: negative corroboration is sanitized to 0', () => {
  const facts = [makeFact({ id: 'f-neg', clusterId: 'c-1', corroboration: -5 as unknown as number })];
  const signal = factCorroborationSignal(facts, P);
  assert.ok(Number.isFinite(signal) && signal >= 0, `negative corroboration must give ≥ 0, got ${signal}`);
});

test('#13 runRanking: cluster with NaN fact.corroboration is rejected at validation (not silently scored)', () => {
  // Since #26 wired validateAggregationArtifact into runRanking, invalid facts now
  // throw before scoring rather than producing NaN-poisoned output.  The old
  // assertion (emits finite score.total) is superseded: rejection is the stricter fix.
  const cluster = makeCluster({ clusterId: 'c-nan', memberIds: [] });
  const artifact = makeArtifact({ kubernetes: [cluster] });
  artifact.data.factsByCluster = {
    'c-nan': [makeFact({ id: 'bad', clusterId: 'c-nan', corroboration: NaN as unknown as number })],
  };
  assert.throws(() => runRanking(artifact, { now: NOW }), /factsByCluster/,
    '#13+#26: NaN corroboration must be caught by input validation before scoring');
});

test('#13 validateAggregationArtifact (Zod tier): rejects fact with corroboration=NaN', () => {
  const minimal = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId: 'test-01',
    upstreamRunId: null,
    generatedAt: NOW.toISOString(),
    cycle: CYCLE,
    topics: [],
    warnings: [],
    data: {
      clustersByTopic: {},
      itemsByTopic: {},
      coverageByTopic: {},
      factsByCluster: {
        'c-1': [makeFact({ id: 'bad', clusterId: 'c-1', corroboration: NaN as unknown as number })],
      },
    },
  };
  assert.throws(() => validateAggregationArtifact(minimal), /factsByCluster/);
});

test('#13 validateAggregationArtifact (Zod tier): rejects fact with corroboration=0', () => {
  const minimal = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId: 'test-02',
    upstreamRunId: null,
    generatedAt: NOW.toISOString(),
    cycle: CYCLE,
    topics: [],
    warnings: [],
    data: {
      clustersByTopic: {},
      itemsByTopic: {},
      coverageByTopic: {},
      factsByCluster: {
        'c-1': [makeFact({ id: 'zero', clusterId: 'c-1', corroboration: 0 as unknown as number })],
      },
    },
  };
  assert.throws(() => validateAggregationArtifact(minimal), /factsByCluster/);
});

test('#13 validateAggregationArtifact (Zod tier): accepts well-formed facts with corroboration ≥ 1', () => {
  const minimal = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId: 'test-03',
    upstreamRunId: null,
    generatedAt: NOW.toISOString(),
    cycle: CYCLE,
    topics: [],
    warnings: [],
    data: {
      clustersByTopic: {},
      itemsByTopic: {},
      coverageByTopic: {},
      factsByCluster: {
        'c-1': [makeFact({ id: 'good', clusterId: 'c-1', corroboration: 2 })],
      },
    },
  };
  assert.doesNotThrow(() => validateAggregationArtifact(minimal));
});

// ---------------------------------------------------------------------------
// #14 — isEligibleForTop10 (§2.8 anti-gaming gate) must be enforced.
// ---------------------------------------------------------------------------

test('#14 isEligibleForTop10: gate is dead code no more — it is called and enforced', () => {
  // Single low-tier source → NOT eligible (no T1, owners=1 < min=2)
  assert.equal(isEligibleForTop10({ independentOwners: 1, hasTier1Primary: false }, P), false);
  // Two owners → eligible
  assert.equal(isEligibleForTop10({ independentOwners: 2, hasTier1Primary: false }, P), true);
  // Single T1 primary → eligible
  assert.equal(isEligibleForTop10({ independentOwners: 1, hasTier1Primary: true }, P), true);
});

test('#14 runRanking: single low-tier source is held by anti-gaming gate (gateStatus=hold)', () => {
  const item = makeItem({ id: 'e1', clusterId: 'c-elig', tier: 'technical-news', sourceDomain: 'singleblog.io',
    interaction: { feedRank: 0, shares: null, comments: null, reactions: null,
      crossSourceMentions: 100, velocity: 500.0, capturedAt: NOW.toISOString(), provenance: 'rss' },
  });
  const cluster = makeCluster({
    clusterId: 'c-elig',
    memberIds: ['e1'],
    distinctDomains: 1,
    tierHistogram: { 'technical-news': 1 },
  });
  const result = runRanking(makeArtifact({ kubernetes: [cluster] }, { kubernetes: [item] }), { now: NOW });
  const c = result.data.rankedByTopic['kubernetes']?.[0]!;
  // High engagement alone must NOT promote a single low-tier source.
  assert.equal(c.gateStatus, 'hold', '#14: single low-tier source must be held regardless of engagement');
});

test('#14 runRanking: T1 primary source is eligible (not held by anti-gaming gate)', () => {
  const item = makeItem({
    id: 'e2', clusterId: 'c-elig2', tier: 'primary', sourceDomain: 'kubernetes.io',
    title: 'Kubernetes patch release available',
  });
  const cluster = makeCluster({
    clusterId: 'c-elig2',
    memberIds: ['e2'],
    distinctDomains: 1,
    tierHistogram: { primary: 1 },
    headline: 'Kubernetes patch release available',
  });
  const result = runRanking(makeArtifact({ kubernetes: [cluster] }, { kubernetes: [item] }), { now: NOW });
  const c = result.data.rankedByTopic['kubernetes']?.[0]!;
  assert.notEqual(c.gateStatus, 'hold', '#14: T1 primary is eligible — must not be held by anti-gaming gate');
});

test('#14 runRanking: 2-independent-owner low-tier cluster is eligible (meets minIndependentOwners)', () => {
  const i1 = makeItem({ id: 'eo1', clusterId: 'c-elig3', tier: 'technical-news', sourceDomain: 'site-a.io' });
  const i2 = makeItem({ id: 'eo2', clusterId: 'c-elig3', tier: 'technical-news', sourceDomain: 'site-b.io' });
  const cluster = makeCluster({
    clusterId: 'c-elig3',
    memberIds: ['eo1', 'eo2'],
    distinctDomains: 2,
    tierHistogram: { 'technical-news': 2 },
  });
  const result = runRanking(makeArtifact({ kubernetes: [cluster] }, { kubernetes: [i1, i2] }), { now: NOW });
  const c = result.data.rankedByTopic['kubernetes']?.[0]!;
  assert.notEqual(c.gateStatus, 'hold', '#14: 2 independent owners meets the threshold — must not be held');
});

// ---------------------------------------------------------------------------
// #15 — fact-level corroboration must apply owner-dedup (log-saturation).
//        A single owner (corroboration=1) must NOT reach C=1.0.
// ---------------------------------------------------------------------------

test('#15 factCorroborationSignal: single-owner facts (corroboration=1) must not reach C=1.0', () => {
  const facts = Array.from({ length: 10 }, (_, i) =>
    makeFact({ id: `sf${i}`, clusterId: 'c-single', corroboration: 1 }),
  );
  const signal = factCorroborationSignal(facts, P);
  assert.ok(signal < 1.0, `single-owner corroboration must be < 1.0, got ${signal}`);
  // corroborationScore(1, P) = ln(2)/ln(9) ≈ 0.315
  approx(signal, corroborationScore(1, P), 0.001);
});

test('#15 factCorroborationSignal: applies log-saturation curve per fact (not raw integer passthrough)', () => {
  // n=8 saturates the curve → signal ≈ 1.0 (the only correct way to reach 1.0)
  const saturatedFacts = [makeFact({ id: 'sat', clusterId: 'c-sat', corroboration: 8 })];
  approx(factCorroborationSignal(saturatedFacts, P), 1.0);

  // n=1 → ~0.315 (far below 1.0)
  const oneFacts = [makeFact({ id: 'one', clusterId: 'c-one', corroboration: 1 })];
  approx(factCorroborationSignal(oneFacts, P), corroborationScore(1, P));

  // n=3 → ln(4)/ln(9) ≈ 0.631 (graded between 1 and 8)
  const threeFacts = [makeFact({ id: 'three', clusterId: 'c-three', corroboration: 3 })];
  approx(factCorroborationSignal(threeFacts, P), corroborationScore(3, P));
});

test('#15 corroborationSignal: single-owner cluster cannot reach C=1.0 via fact path', () => {
  const cluster = makeCluster({ clusterId: 'c-s1', distinctDomains: 1 });
  const members = [makeItem({ id: 'sm1', clusterId: 'c-s1', sourceDomain: 'one-owner.io', tier: 'technical-news' })];
  // Even with many facts, all from a single owner (corroboration=1), C must stay below 1.0
  const facts = Array.from({ length: 5 }, (_, i) =>
    makeFact({ id: `cf${i}`, clusterId: 'c-s1', corroboration: 1 }),
  );
  const c = corroborationSignal({ cluster, members, now: NOW, profile: P, facts });
  assert.ok(c < 1.0, `single-owner cluster C must be < 1.0, got ${c}`);
});

// ---------------------------------------------------------------------------
// #16 — owner/domain dedup must strip userinfo / port / www (CWE-20).
// ---------------------------------------------------------------------------

test('#16 normalizeOwnerDomain: strips www. prefix', () => {
  assert.equal(normalizeOwnerDomain('www.example.com'), 'example.com');
  assert.equal(normalizeOwnerDomain('WWW.Example.COM'), 'example.com');
});

test('#16 normalizeOwnerDomain: strips port', () => {
  assert.equal(normalizeOwnerDomain('example.com:8080'), 'example.com');
  assert.equal(normalizeOwnerDomain('example.com:443'), 'example.com');
});

test('#16 normalizeOwnerDomain: strips userinfo', () => {
  assert.equal(normalizeOwnerDomain('cdn@example.com'), 'example.com');
  assert.equal(normalizeOwnerDomain('user@www.example.com'), 'example.com');
});

test('#16 normalizeOwnerDomain: lowercases and reduces subdomains to eTLD+1', () => {
  assert.equal(normalizeOwnerDomain('Example.com'), 'example.com');
  // #22: subdomains now collapse to registrable domain (eTLD+1)
  assert.equal(normalizeOwnerDomain('sub.example.com'), 'example.com');
});

test('#16 countIndependentOwners: www.example.com and example.com are the same owner', () => {
  const cluster = makeCluster({ clusterId: 'c-norm', distinctDomains: 2 });
  const items: AggregatedItem[] = [
    makeItem({ id: 'n1', clusterId: 'c-norm', sourceDomain: 'www.thenewstack.io', tier: 'technical-news' }),
    makeItem({ id: 'n2', clusterId: 'c-norm', sourceDomain: 'thenewstack.io', tier: 'technical-news' }),
    makeItem({ id: 'n3', clusterId: 'c-norm', sourceDomain: 'kubernetes.io', tier: 'primary' }),
  ];
  // www.thenewstack.io + thenewstack.io → same owner; plus kubernetes.io → 2 total
  const n = countIndependentOwners({ cluster, members: items, now: NOW, profile: P });
  assert.equal(n, 2, '#16: www.thenewstack.io and thenewstack.io collapse to one owner');
});

test('#16 countIndependentOwners: example.com:8080 and example.com are the same owner', () => {
  const cluster = makeCluster({ clusterId: 'c-port', distinctDomains: 2 });
  const items: AggregatedItem[] = [
    makeItem({ id: 'p1', clusterId: 'c-port', sourceDomain: 'docs.example.com:8080', tier: 'technical-news' }),
    makeItem({ id: 'p2', clusterId: 'c-port', sourceDomain: 'docs.example.com', tier: 'technical-news' }),
  ];
  const n = countIndependentOwners({ cluster, members: items, now: NOW, profile: P });
  assert.equal(n, 1, '#16: same domain with and without port collapses to one owner');
});

test('#16 ownerDiversity: www.example.com and example.com do not inflate domain count', () => {
  const cluster = makeCluster({ clusterId: 'c-div-norm' });
  const items: AggregatedItem[] = [
    makeItem({ id: 'dv1', clusterId: 'c-div-norm', sourceDomain: 'www.example.com', tier: 'technical-news' }),
    makeItem({ id: 'dv2', clusterId: 'c-div-norm', sourceDomain: 'example.com', tier: 'technical-news' }),
  ];
  // Both normalize to example.com → single domain → diversity = 0
  const div = ownerDiversity({ cluster, members: items, now: NOW, profile: P });
  assert.equal(div, 0, '#16: www and non-www of same domain should give diversity=0');
});

// ---------------------------------------------------------------------------
// #17 — cohesion must be computed (not hardcoded to 1.0).
// ---------------------------------------------------------------------------

test('#17 runRanking: cohesion is non-trivially computed — audit reflects non-1.0 value for multi-member clusters', () => {
  // Two members with titles unrelated to the headline → low cohesion
  const i1 = makeItem({ id: 'ch1', clusterId: 'c-coh', sourceDomain: 'a.io', tier: 'technical-news',
    title: 'Completely unrelated sports story' });
  const i2 = makeItem({ id: 'ch2', clusterId: 'c-coh', sourceDomain: 'b.io', tier: 'technical-news',
    title: 'Finance news nothing shared' });
  const cluster = makeCluster({
    clusterId: 'c-coh',
    headline: 'Kubernetes security patch release',
    memberIds: ['ch1', 'ch2'],
    distinctDomains: 2,
    tierHistogram: { 'technical-news': 2 },
  });
  const result = runRanking(makeArtifact({ kubernetes: [cluster] }, { kubernetes: [i1, i2] }), { now: NOW });
  const entry = result.data.audit[0]!;
  const cohesion = entry.inputs['conf_cohesion'] ?? -1;
  assert.ok(cohesion < 1.0, `#17: multi-member cluster with unrelated titles should have cohesion < 1.0, got ${cohesion}`);
});

test('#17 runRanking: singleton cluster has cohesion = 1.0 (by definition)', () => {
  const item = makeItem({ id: 'coh-s', clusterId: 'c-coh-s', sourceDomain: 'k8s.io', tier: 'primary',
    title: 'Kubernetes patch release available' });
  const cluster = makeCluster({
    clusterId: 'c-coh-s',
    headline: 'Kubernetes patch release available',
    memberIds: ['coh-s'],
    distinctDomains: 1,
    tierHistogram: { primary: 1 },
  });
  const result = runRanking(makeArtifact({ kubernetes: [cluster] }, { kubernetes: [item] }), { now: NOW });
  const entry = result.data.audit[0]!;
  const cohesion = entry.inputs['conf_cohesion'] ?? -1;
  assert.equal(cohesion, 1.0, '#17: singleton cluster must have cohesion = 1.0');
});

test('#17 runRanking: matching member titles raise cohesion vs mismatched titles', () => {
  // Cluster A: titles closely match headline
  const ha1 = makeItem({ id: 'ha1', clusterId: 'c-match', sourceDomain: 'a.io', tier: 'technical-news',
    title: 'Kubernetes patch release notes available' });
  const ha2 = makeItem({ id: 'ha2', clusterId: 'c-match', sourceDomain: 'b.io', tier: 'technical-news',
    title: 'Kubernetes release patch notes' });
  const clusterMatch = makeCluster({
    clusterId: 'c-match',
    headline: 'Kubernetes patch release available',
    memberIds: ['ha1', 'ha2'],
    distinctDomains: 2,
    tierHistogram: { 'technical-news': 2 },
  });

  // Cluster B: titles are unrelated
  const hb1 = makeItem({ id: 'hb1', clusterId: 'c-miss', sourceDomain: 'c.io', tier: 'technical-news',
    title: 'Stock market quarterly results' });
  const hb2 = makeItem({ id: 'hb2', clusterId: 'c-miss', sourceDomain: 'd.io', tier: 'technical-news',
    title: 'Celebrity news entertainment gossip' });
  const clusterMiss = makeCluster({
    clusterId: 'c-miss',
    headline: 'Kubernetes patch release available',
    memberIds: ['hb1', 'hb2'],
    distinctDomains: 2,
    tierHistogram: { 'technical-news': 2 },
  });

  const resultMatch = runRanking(
    makeArtifact({ kubernetes: [clusterMatch] }, { kubernetes: [ha1, ha2] }), { now: NOW });
  const resultMiss = runRanking(
    makeArtifact({ kubernetes: [clusterMiss] }, { kubernetes: [hb1, hb2] }), { now: NOW });

  const cohMatch = resultMatch.data.audit[0]?.inputs['conf_cohesion'] ?? -1;
  const cohMiss = resultMiss.data.audit[0]?.inputs['conf_cohesion'] ?? -1;
  assert.ok(cohMatch > cohMiss, `#17: matching titles (${cohMatch}) should have higher cohesion than mismatched (${cohMiss})`);
});

// ---------------------------------------------------------------------------
// #18 — factCorroborationSignal must not equalize C at 1.0, so T-signal
//        ordering for security clusters is preserved.
// ---------------------------------------------------------------------------

test('#18 factCorroborationSignal does not saturate to 1.0 for typical aggregator output', () => {
  // The aggregator typically emits corroboration=1 (single-owner) for most facts.
  // Before fix: mean(1)/1 = 1.0 → C = 1.0 for all clusters with any facts.
  // After fix: corroborationScore(1, P) ≈ 0.315 — far below 1.0.
  const typicalFacts = Array.from({ length: 5 }, (_, i) =>
    makeFact({ id: `tf${i}`, clusterId: 'c-typical', corroboration: 1 }),
  );
  const signal = factCorroborationSignal(typicalFacts, P);
  assert.ok(signal < 0.4, `typical single-owner facts must not approach 1.0 (got ${signal})`);
});

test('#18 T-signal ordering preserved: high-T security cluster beats low-T cluster despite both having single-owner facts', () => {
  // Reproduce the pre-fix failure: both clusters have corroboration=1 facts.
  // Pre-fix: both C=1.0 → T-ordering could be washed out by other signals.
  // Post-fix: C is graded → T-ordering preserved.

  const secItems = [
    makeItem({ id: 's1', clusterId: 'c-sec', sourceDomain: 'nvd.nist.gov', tier: 'primary',
      title: 'CVE-2026-9999 exploited in the wild CVSS 9.8 RCE critical' }),
  ];
  const secCluster = makeCluster({
    clusterId: 'c-sec',
    headline: 'CVE-2026-9999 exploited in the wild — CVSS 9.8 RCE critical vulnerability',
    memberIds: ['s1'],
    distinctDomains: 1,
    tierHistogram: { primary: 1 },
  });

  const blogItems = [
    makeItem({ id: 'b1', clusterId: 'c-blog', sourceDomain: 'myblog.io', tier: 'technical-news',
      title: 'Conference recap blog post press release' }),
  ];
  const blogCluster = makeCluster({
    clusterId: 'c-blog',
    headline: 'Conference recap blog post press release',
    memberIds: ['b1'],
    distinctDomains: 1,
    tierHistogram: { 'technical-news': 1 },
  });

  const artifact = makeArtifact(
    { kubernetes: [blogCluster, secCluster] },
    { kubernetes: [...secItems, ...blogItems] },
  );
  // Both clusters get single-owner facts (corroboration=1)
  artifact.data.factsByCluster = {
    'c-sec':  [makeFact({ id: 'sec-f1', clusterId: 'c-sec',  corroboration: 1 })],
    'c-blog': [makeFact({ id: 'blg-f1', clusterId: 'c-blog', corroboration: 1 })],
  };

  const result = runRanking(artifact, { now: NOW });
  const ranked = result.data.rankedByTopic['kubernetes']!;
  assert.equal(ranked.length, 2);
  // Security cluster (T≈0.95) must rank above blog (T≈0.25) even though both have C≈0.315
  assert.equal(ranked[0]!.clusterId, 'c-sec',
    `#18: security cluster (high-T) must outrank blog post (low-T) even with equal single-owner corroboration`);
  assert.ok(ranked[0]!.score.total > ranked[1]!.score.total,
    `#18: security cluster score ${ranked[0]!.score.total} must exceed blog ${ranked[1]!.score.total}`);
});

// ---------------------------------------------------------------------------
// #21 — runRanking produces identical rankedByTopic regardless of input order.
//        Tests that sort() is stable across permutations (relies on the
//        quantized-bucket comparator being a valid strict weak ordering).
// ---------------------------------------------------------------------------

test('#21 runRanking: rankedByTopic order is identical regardless of clustersByTopic input order', () => {
  // Three clusters with scores that span a single ε-bucket boundary:
  //   - c-hi: high technical-significance, T1 primary → highest score
  //   - c-mid: medium tech-sig, 2 owners → middle score
  //   - c-lo: low tech-sig, 1 owner, news tier → lowest score
  const NOW_21 = new Date('2026-06-15T12:00:00Z');

  const iHi = makeItem({ id: 'i-hi', clusterId: 'c-hi', tier: 'primary', sourceDomain: 'kubernetes.io',
    title: 'CVE-2026-1234 critical RCE vulnerability exploited in the wild CVSS 9.8' });
  const clusterHi = makeCluster({ clusterId: 'c-hi', memberIds: ['i-hi'],
    headline: 'CVE-2026-1234 critical RCE vulnerability exploited in the wild',
    distinctDomains: 1, tierHistogram: { primary: 1 } });

  const iMid1 = makeItem({ id: 'i-mid1', clusterId: 'c-mid', tier: 'technical-news', sourceDomain: 'devblog-a.io',
    title: 'Kubernetes v1.30 patch release notes' });
  const iMid2 = makeItem({ id: 'i-mid2', clusterId: 'c-mid', tier: 'technical-news', sourceDomain: 'devblog-b.io',
    title: 'Kubernetes v1.30 release patch' });
  const clusterMid = makeCluster({ clusterId: 'c-mid', memberIds: ['i-mid1', 'i-mid2'],
    headline: 'Kubernetes v1.30 patch release', distinctDomains: 2,
    tierHistogram: { 'technical-news': 2 } });

  const iLo = makeItem({ id: 'i-lo', clusterId: 'c-lo', tier: 'technical-news', sourceDomain: 'generic-blog.io',
    title: 'Some conference recap recap blog post press release announcement' });
  const clusterLo = makeCluster({ clusterId: 'c-lo', memberIds: ['i-lo'],
    headline: 'Conference recap blog post', distinctDomains: 1,
    tierHistogram: { 'technical-news': 1 } });

  const items = { kubernetes: [iHi, iMid1, iMid2, iLo] };

  // Run with clusters in original order [hi, mid, lo]
  const resultABC = runRanking(
    makeArtifact({ kubernetes: [clusterHi, clusterMid, clusterLo] }, items),
    { now: NOW_21 },
  );
  // Run with clusters in reversed order [lo, mid, hi]
  const resultCBA = runRanking(
    makeArtifact({ kubernetes: [clusterLo, clusterMid, clusterHi] }, items),
    { now: NOW_21 },
  );
  // Run with clusters in a different permutation [mid, lo, hi]
  const resultBCA = runRanking(
    makeArtifact({ kubernetes: [clusterMid, clusterLo, clusterHi] }, items),
    { now: NOW_21 },
  );

  const rankedABC = resultABC.data.rankedByTopic['kubernetes']!.map((c) => c.clusterId);
  const rankedCBA = resultCBA.data.rankedByTopic['kubernetes']!.map((c) => c.clusterId);
  const rankedBCA = resultBCA.data.rankedByTopic['kubernetes']!.map((c) => c.clusterId);

  assert.deepEqual(rankedCBA, rankedABC,
    `#21: reversed input order must produce same rank order. Got ${rankedCBA.join(',')} vs ${rankedABC.join(',')}`);
  assert.deepEqual(rankedBCA, rankedABC,
    `#21: permuted input order must produce same rank order. Got ${rankedBCA.join(',')} vs ${rankedABC.join(',')}`);

  // Sanity: the highest cluster (c-hi, T1 primary) should rank first.
  assert.equal(rankedABC[0], 'c-hi', '#21: T1 primary high-T cluster must rank first');
});

test('#18 T-signal ordering: graded corroboration values produce graded C scores (not flat 1.0)', () => {
  // Verify that the saturation curve produces graded signals across typical owner counts.
  const c1 = factCorroborationSignal([makeFact({ id: 'g1', clusterId: 'c', corroboration: 1 })], P);
  const c2 = factCorroborationSignal([makeFact({ id: 'g2', clusterId: 'c', corroboration: 2 })], P);
  const c4 = factCorroborationSignal([makeFact({ id: 'g4', clusterId: 'c', corroboration: 4 })], P);
  const c8 = factCorroborationSignal([makeFact({ id: 'g8', clusterId: 'c', corroboration: 8 })], P);

  assert.ok(c1 < c2, `C(n=1)=${c1} < C(n=2)=${c2}`);
  assert.ok(c2 < c4, `C(n=2)=${c2} < C(n=4)=${c4}`);
  assert.ok(c4 < c8, `C(n=4)=${c4} < C(n=8)=${c8}`);
  approx(c8, 1.0); // saturation at C_sat=8
  assert.ok(c1 < 0.4, `C(n=1)=${c1} must be well below 1.0 (was 1.0 before fix)`);
});

// ---------------------------------------------------------------------------
// #22 — eTLD+1 corroboration dedup: subdomains of the same publisher must
//        collapse to a single owner key.
// ---------------------------------------------------------------------------

test('#22 normalizeOwnerDomain: subdomains collapse to eTLD+1 (example.com)', () => {
  assert.equal(normalizeOwnerDomain('news.example.com'), 'example.com');
  assert.equal(normalizeOwnerDomain('blog.example.com'), 'example.com');
  assert.equal(normalizeOwnerDomain('example.com'), 'example.com');
});

test('#22 normalizeOwnerDomain: two-part TLD preserved (bbc.co.uk)', () => {
  assert.equal(normalizeOwnerDomain('bbc.co.uk'), 'bbc.co.uk');
  assert.equal(normalizeOwnerDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(normalizeOwnerDomain('www.bbc.co.uk'), 'bbc.co.uk');
});

test('#22 countIndependentOwners: news.example.com and blog.example.com count as one owner', () => {
  const cluster = makeCluster({ clusterId: 'c-etld', distinctDomains: 2 });
  const items: AggregatedItem[] = [
    makeItem({ id: 'etld1', clusterId: 'c-etld', sourceDomain: 'news.example.com', tier: 'technical-news' }),
    makeItem({ id: 'etld2', clusterId: 'c-etld', sourceDomain: 'blog.example.com', tier: 'technical-news' }),
    makeItem({ id: 'etld3', clusterId: 'c-etld', sourceDomain: 'other-site.io', tier: 'technical-news' }),
  ];
  const n = countIndependentOwners({ cluster, members: items, now: NOW, profile: P });
  assert.equal(n, 2, '#22: news.example.com + blog.example.com collapse to one owner; other-site.io is another');
});

// ---------------------------------------------------------------------------
// #23 — Invalid/missing latestPublishedAt yields NEUTRAL_AGE_HOURS, not 0.
//        Prevents articles with missing timestamps from receiving max recency.
// ---------------------------------------------------------------------------

test('#23 NEUTRAL_AGE_HOURS is exported and equals 24', () => {
  assert.equal(NEUTRAL_AGE_HOURS, 24);
});

test('#23 ageHoursSince: undefined timestamp returns NEUTRAL_AGE_HOURS, not 0', () => {
  assert.equal(ageHoursSince(undefined, NOW), NEUTRAL_AGE_HOURS);
});

test('#23 ageHoursSince: null timestamp returns NEUTRAL_AGE_HOURS, not 0', () => {
  assert.equal(ageHoursSince(null, NOW), NEUTRAL_AGE_HOURS);
});

test('#23 ageHoursSince: invalid ISO string returns NEUTRAL_AGE_HOURS, not 0', () => {
  assert.equal(ageHoursSince('not-a-date', NOW), NEUTRAL_AGE_HOURS);
  assert.equal(ageHoursSince('', NOW), NEUTRAL_AGE_HOURS);
});

test('#23 ageHoursSince: valid timestamp still works correctly', () => {
  const sixHoursAgo = new Date(NOW.valueOf() - 6 * 3_600_000).toISOString();
  approx(ageHoursSince(sixHoursAgo, NOW), 6, 0.01);
});

test('#23 runRanking: cluster with missing latestPublishedAt does not receive max recency (1.0)', () => {
  // Cluster with an empty/invalid latestPublishedAt — before fix this would give age=0 → recency=1.0
  const cluster = makeCluster({
    clusterId: 'c-nodate',
    latestPublishedAt: '',
    memberIds: [],
    tierHistogram: { primary: 1 },
    distinctDomains: 1,
  });
  const artifact = makeArtifact({ kubernetes: [cluster] });
  const result = runRanking(artifact, { now: NOW });
  const c = result.data.rankedByTopic['kubernetes']?.[0]!;
  // With neutral floor (24h) recency should be well below 1.0 (H≈12–36h)
  assert.ok(c.score.recency < 1.0, `#23: missing timestamp must not give max recency, got ${c.score.recency}`);
  assert.ok(Number.isFinite(c.score.total), '#23: score.total must be finite even with missing timestamp');
});

// ---------------------------------------------------------------------------
// #26 — runRanking() validates input via validateAggregationArtifact.
//        Invalid artifacts must throw rather than produce NaN-poisoned output.
// ---------------------------------------------------------------------------

test('#26 runRanking: throws on missing clustersByTopic', () => {
  const invalid = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId: 'bad-01',
    upstreamRunId: null,
    generatedAt: NOW.toISOString(),
    cycle: CYCLE,
    topics: [],
    warnings: [],
    data: {
      itemsByTopic: {},
      coverageByTopic: {},
      // clustersByTopic intentionally omitted
    },
  };
  assert.throws(() => runRanking(invalid as unknown as AggregationArtifact, { now: NOW }),
    /clustersByTopic/,
    '#26: missing clustersByTopic must throw a clear validation error');
});

test('#26 runRanking: accepts a well-formed artifact without throwing', () => {
  const artifact = makeArtifact({ kubernetes: [] });
  assert.doesNotThrow(() => runRanking(artifact, { now: NOW }),
    '#26: valid artifact must not throw during validation');
});
