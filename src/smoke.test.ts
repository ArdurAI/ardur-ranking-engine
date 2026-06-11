import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from './contracts.ts';
import { DEFAULT_WEIGHT_PROFILE } from './weights.ts';
import { runRanking } from './index.ts';
import type { AggregationArtifact } from './contracts.ts';

const MINIMAL_ARTIFACT: AggregationArtifact = {
  schemaVersion: SCHEMA_VERSION,
  artifact: 'aggregation',
  runId: 'agg-smoke-0001',
  upstreamRunId: null,
  generatedAt: '2026-06-11T12:00:00Z',
  cycle: {
    id: '2026-06-11T12:00Z',
    windowStart: '2026-06-11T12:00:00Z',
    windowEnd: '2026-06-11T18:00:00Z',
  },
  topics: [{ id: 'test', label: 'Test', description: 'Smoke test topic' }],
  warnings: [],
  data: { clustersByTopic: {}, itemsByTopic: {}, coverageByTopic: {} },
};

test('schema version is pinned', () => {
  assert.equal(SCHEMA_VERSION, 'ardur-content-pipeline/v1');
});

test('default weight profile is versioned', () => {
  assert.match(DEFAULT_WEIGHT_PROFILE, /@v\d+$/);
});

test('runRanking returns a valid RankingArtifact envelope', () => {
  const result = runRanking(MINIMAL_ARTIFACT, { now: new Date('2026-06-11T12:00:00Z') });
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.artifact, 'ranking');
  assert.equal(result.upstreamRunId, 'agg-smoke-0001');
  assert.equal(result.data.weightProfile, DEFAULT_WEIGHT_PROFILE);
  assert.deepEqual(result.data.rankedByTopic, {});
  assert.deepEqual(result.data.audit, []);
});
