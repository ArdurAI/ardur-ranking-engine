import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from './contracts.ts';
import { DEFAULT_WEIGHT_PROFILE } from './weights.ts';
import { runRanking } from './index.ts';

test('schema version is pinned', () => {
  assert.equal(SCHEMA_VERSION, 'ardur-content-pipeline/v1');
});

test('default weight profile is versioned', () => {
  assert.match(DEFAULT_WEIGHT_PROFILE, /@v\d+$/);
});

test('runRanking is wired but not yet implemented', () => {
  // @ts-expect-error intentionally passing an empty artifact to a stub
  assert.throws(() => runRanking({}), /not implemented/);
});
