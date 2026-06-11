/**
 * Hostile-input tests — verify that out-of-contract values are rejected or
 * normalized loudly, never silently emitting NaN / null into the pipeline.
 *
 * Covers QA issues:
 *   #7 — unknown tier enum in tierHistogram / member items must not produce NaN
 *   #8 — validateAggregationArtifact must reject malformed input with clear errors
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AggregatedItem, Cluster } from './contracts.ts';
import { SCHEMA_VERSION } from './contracts.ts';
import { BALANCED_V1 } from './weights.ts';
import { tierValue, sourceTierSignal, countIndependentOwners } from './signals.ts';
import { runRanking } from './index.ts';
import { validateAggregationArtifact } from './validate.ts';
import type { SourceTier } from './contracts.ts';

const P = BALANCED_V1;
const NOW = new Date('2026-06-11T12:00:00Z');

function makeItem(overrides: Partial<AggregatedItem> & Pick<AggregatedItem, 'id' | 'clusterId'>): AggregatedItem {
  return {
    topic: 'kubernetes',
    topicLabel: 'Kubernetes',
    title: 'Test article',
    source: 'Test Source',
    sourceDomain: 'test.example',
    sourceUrl: 'https://test.example',
    url: 'https://test.example/article',
    tier: 'technical-news',
    publishedAt: '2026-06-11T06:00:00Z',
    summaryHint: '',
    interaction: {
      feedRank: 0,
      shares: null,
      comments: null,
      reactions: null,
      crossSourceMentions: 1,
      velocity: 1.0,
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
    headline: 'Test headline',
    memberIds: [],
    sourceCount: 1,
    distinctDomains: 1,
    tierHistogram: { 'technical-news': 1 },
    earliestPublishedAt: '2026-06-11T06:00:00Z',
    latestPublishedAt: '2026-06-11T06:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Issue #7 — unknown tier enum must not produce NaN in score.total
// ---------------------------------------------------------------------------

test('#7 tierValue: unknown tier string clamps to T4 value, never NaN', () => {
  const unknownTier = 'super-special-tier' as SourceTier;
  const v = tierValue(unknownTier, P);
  assert.ok(Number.isFinite(v), `expected finite value, got ${v}`);
  assert.equal(v, P.sourceTier.values['T4']); // clamped to T4 = 0.15
});

test('#7 tierValue: empty string tier clamps to T4, never NaN', () => {
  const v = tierValue('' as SourceTier, P);
  assert.ok(Number.isFinite(v), `expected finite value, got ${v}`);
  assert.equal(v, P.sourceTier.values['T4']);
});

test('#7 sourceTierSignal: unknown tier in tierHistogram does not produce NaN', () => {
  // Use a cast via a typed variable — Node type-stripper disallows `as` in key position.
  const unknownTierKey = 'totally-unknown-tier' as unknown as SourceTier;
  const histogram = { [unknownTierKey]: 2, 'technical-news': 1 } as Cluster['tierHistogram'];
  const cluster = makeCluster({ clusterId: 'c-hostile-tier', tierHistogram: histogram });
  const s = sourceTierSignal({ cluster, members: [], now: NOW, profile: P });
  assert.ok(Number.isFinite(s), `expected finite signal, got ${s}`);
  assert.ok(s >= 0 && s <= 1, `signal out of [0,1]: ${s}`);
});

test('#7 sourceTierSignal: all-unknown tiers in histogram give finite T4-based signal', () => {
  const unknownTierKey = 'vendor-x-tier' as unknown as SourceTier;
  const histogram = { [unknownTierKey]: 5 } as Cluster['tierHistogram'];
  const cluster = makeCluster({ clusterId: 'c-all-unknown', tierHistogram: histogram });
  const s = sourceTierSignal({ cluster, members: [], now: NOW, profile: P });
  assert.ok(Number.isFinite(s), `expected finite signal, got ${s}`);
  // T4 = 0.15, sourceTierBlend(0.15, 0.15, P) = 0.7*0.15 + 0.3*0.15 = 0.15
  assert.ok(s >= 0 && s <= 1);
});

test('#7 countIndependentOwners: member with unknown tier uses T4 value (below T3 min → not counted)', () => {
  const cluster = makeCluster({ clusterId: 'c-hostile-owner', distinctDomains: 1 });
  const mysteryTier = 'mystery-tier' as unknown as SourceTier;
  const items: AggregatedItem[] = [
    makeItem({ id: 'x1', clusterId: 'c-hostile-owner', sourceDomain: 'mystery.io', tier: mysteryTier }),
  ];
  // T4 value (0.15) < T3 minimum (0.4) → not counted as independent owner
  const n = countIndependentOwners({ cluster, members: items, now: NOW, profile: P });
  assert.ok(typeof n === 'number' && Number.isFinite(n), `expected finite count, got ${n}`);
  assert.equal(n, 0); // below T3 min → excluded
});

test('#7 runRanking: cluster with unknown tier in tierHistogram emits finite score.total (no NaN)', () => {
  const unknownTierKey = 'unknown-vendor-tier' as unknown as SourceTier;
  const histogram = { [unknownTierKey]: 3 } as Cluster['tierHistogram'];
  const cluster = makeCluster({ clusterId: 'c-hostile-run', tierHistogram: histogram, memberIds: [] });
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation' as const,
    runId: 'agg-hostile-01',
    upstreamRunId: null,
    generatedAt: NOW.toISOString(),
    cycle: { id: '2026-06-11T12:00Z', windowStart: '2026-06-11T12:00:00Z', windowEnd: '2026-06-11T18:00:00Z' },
    topics: [],
    warnings: [],
    data: { clustersByTopic: { kubernetes: [cluster] }, itemsByTopic: {}, coverageByTopic: {} },
  };
  const result = runRanking(artifact, { now: NOW });
  const c = result.data.rankedByTopic['kubernetes']?.[0];
  assert.ok(c !== undefined, 'expected a ranked cluster in output');
  assert.ok(Number.isFinite(c.score.total), `score.total must be finite, got ${c.score.total}`);
  assert.ok(!Number.isNaN(c.score.total), 'score.total must not be NaN');
  assert.ok(c.score.total >= 0, `score.total must be non-negative, got ${c.score.total}`);
});

test('#7 runRanking: member item with unknown tier does not poison score.total', () => {
  const inventedTier = 'completely-invented-tier' as unknown as SourceTier;
  const histogram = { [inventedTier]: 1 } as Cluster['tierHistogram'];
  const item = makeItem({ id: 'hostile-item', clusterId: 'c-hostile-member', tier: inventedTier, sourceDomain: 'hostile.example' });
  const cluster = makeCluster({ clusterId: 'c-hostile-member', memberIds: ['hostile-item'], tierHistogram: histogram });
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation' as const,
    runId: 'agg-hostile-02',
    upstreamRunId: null,
    generatedAt: NOW.toISOString(),
    cycle: { id: '2026-06-11T12:00Z', windowStart: '2026-06-11T12:00:00Z', windowEnd: '2026-06-11T18:00:00Z' },
    topics: [],
    warnings: [],
    data: { clustersByTopic: { kubernetes: [cluster] }, itemsByTopic: { kubernetes: [item] }, coverageByTopic: {} },
  };
  const result = runRanking(artifact, { now: NOW });
  const c = result.data.rankedByTopic['kubernetes']?.[0];
  assert.ok(c !== undefined, 'expected a ranked cluster in output');
  assert.ok(!Number.isNaN(c.score.total), `score.total must not be NaN, got ${c.score.total}`);
  assert.ok(Number.isFinite(c.score.total), `score.total must be finite, got ${c.score.total}`);
});

// ---------------------------------------------------------------------------
// Issue #8 — validateAggregationArtifact must reject malformed inputs loudly
// ---------------------------------------------------------------------------

test('#8 validateAggregationArtifact: rejects null', () => {
  assert.throws(() => validateAggregationArtifact(null), /expected a JSON object/);
});

test('#8 validateAggregationArtifact: rejects a plain string (even if JSON-looking)', () => {
  assert.throws(
    () => validateAggregationArtifact('{"schemaVersion":"ardur-content-pipeline/v1"}'),
    /expected a JSON object/,
  );
});

test('#8 validateAggregationArtifact: rejects an array', () => {
  assert.throws(() => validateAggregationArtifact([]), /expected a JSON object/);
});

test('#8 validateAggregationArtifact: rejects a number', () => {
  assert.throws(() => validateAggregationArtifact(42), /expected a JSON object/);
});

test('#8 validateAggregationArtifact: rejects missing schemaVersion', () => {
  assert.throws(
    () =>
      validateAggregationArtifact({
        artifact: 'aggregation',
        data: { clustersByTopic: {}, itemsByTopic: {} },
        cycle: {},
      }),
    /schemaVersion mismatch/,
  );
});

test('#8 validateAggregationArtifact: rejects wrong schemaVersion', () => {
  assert.throws(
    () =>
      validateAggregationArtifact({
        schemaVersion: 'ardur-content-pipeline/v2',
        artifact: 'aggregation',
        data: { clustersByTopic: {}, itemsByTopic: {} },
        cycle: {},
      }),
    /schemaVersion mismatch/,
  );
});

test('#8 validateAggregationArtifact: rejects wrong artifact type', () => {
  assert.throws(
    () =>
      validateAggregationArtifact({
        schemaVersion: SCHEMA_VERSION,
        artifact: 'ranking',
        data: { clustersByTopic: {}, itemsByTopic: {} },
        cycle: {},
      }),
    /expected artifact="aggregation"/,
  );
});

test('#8 validateAggregationArtifact: rejects missing data field', () => {
  assert.throws(
    () =>
      validateAggregationArtifact({
        schemaVersion: SCHEMA_VERSION,
        artifact: 'aggregation',
        cycle: {},
      }),
    /missing or invalid "data"/,
  );
});

test('#8 validateAggregationArtifact: rejects data as array', () => {
  assert.throws(
    () =>
      validateAggregationArtifact({
        schemaVersion: SCHEMA_VERSION,
        artifact: 'aggregation',
        data: [],
        cycle: {},
      }),
    /missing or invalid "data"/,
  );
});

test('#8 validateAggregationArtifact: rejects missing data.clustersByTopic', () => {
  assert.throws(
    () =>
      validateAggregationArtifact({
        schemaVersion: SCHEMA_VERSION,
        artifact: 'aggregation',
        data: { itemsByTopic: {} },
        cycle: {},
      }),
    /clustersByTopic/,
  );
});

test('#8 validateAggregationArtifact: rejects missing data.itemsByTopic', () => {
  assert.throws(
    () =>
      validateAggregationArtifact({
        schemaVersion: SCHEMA_VERSION,
        artifact: 'aggregation',
        data: { clustersByTopic: {} },
        cycle: {},
      }),
    /itemsByTopic/,
  );
});

test('#8 validateAggregationArtifact: rejects missing cycle field', () => {
  assert.throws(
    () =>
      validateAggregationArtifact({
        schemaVersion: SCHEMA_VERSION,
        artifact: 'aggregation',
        data: { clustersByTopic: {}, itemsByTopic: {} },
      }),
    /cycle/,
  );
});

test('#8 validateAggregationArtifact: accepts a minimal well-formed artifact', () => {
  const minimal = {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId: 'test-agg-01',
    upstreamRunId: null,
    generatedAt: NOW.toISOString(),
    cycle: { id: 'test', windowStart: 'test', windowEnd: 'test' },
    topics: [],
    warnings: [],
    data: { clustersByTopic: {}, itemsByTopic: {}, coverageByTopic: {} },
  };
  assert.doesNotThrow(() => validateAggregationArtifact(minimal));
});
