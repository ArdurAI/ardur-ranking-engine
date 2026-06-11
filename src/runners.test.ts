/**
 * Tests for the agent-ready runners.ts CLI entrypoint.
 *
 * Covers: --describe, --now determinism, --run-id override, --out file,
 * JSON error envelopes, contractRevision stamping, backward-compat positional arg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCHEMA_VERSION, CONTRACT_REVISION } from './contracts.ts';
import type { AggregationArtifact, RankingArtifact } from './contracts.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUNNER = join(import.meta.dirname!, 'runners.ts');
const NODE = process.execPath;
const NODE_FLAGS = ['--experimental-strip-types'];

function run(
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(NODE, [...NODE_FLAGS, RUNNER, ...args], {
    input: input ?? '',
    encoding: 'utf8',
    env: { ...process.env, ARDUR_AI_PROVIDER: 'deterministic' },
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function tmpFile(name: string, content: string): string {
  const p = join(tmpdir(), `ranking-test-${process.pid}-${name}`);
  writeFileSync(p, content, 'utf8');
  return p;
}

function cleanUp(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

const NOW = '2026-06-11T12:00:00.000Z';

const MINIMAL_ARTIFACT: AggregationArtifact = {
  schemaVersion: SCHEMA_VERSION,
  artifact: 'aggregation',
  runId: 'agg-test-0001',
  upstreamRunId: null,
  generatedAt: NOW,
  cycle: { id: '2026-06-11T12:00:00.000Z', windowStart: NOW, windowEnd: '2026-06-11T18:00:00.000Z' },
  topics: [{ id: 'ai', label: 'AI', description: 'Artificial intelligence' }],
  warnings: [],
  data: { clustersByTopic: {}, itemsByTopic: {}, coverageByTopic: {} },
};

const MINIMAL_JSON = JSON.stringify(MINIMAL_ARTIFACT);

// ---------------------------------------------------------------------------
// --describe
// ---------------------------------------------------------------------------

test('--describe exits 0 and emits valid JSON', () => {
  const { status, stdout } = run(['--describe']);
  assert.equal(status, 0, 'should exit 0');
  const desc = JSON.parse(stdout);
  assert.equal(desc.name, '@ardurai/ranking-engine');
  assert.equal(desc.stage, 'ranking');
  assert.equal(desc.contract.schemaVersion, SCHEMA_VERSION);
  assert.equal(desc.contract.contractRevision, CONTRACT_REVISION);
});

test('--describe emits input and output JSON-Schema objects', () => {
  const { stdout } = run(['--describe']);
  const desc = JSON.parse(stdout);
  assert.ok(typeof desc.input === 'object', 'input schema present');
  assert.ok(typeof desc.output === 'object', 'output schema present');
  assert.equal(desc.input.title, 'AggregationArtifact');
  assert.equal(desc.output.title, 'RankingArtifact');
  assert.ok(Array.isArray(desc.input.required), 'input.required is array');
  assert.ok(Array.isArray(desc.output.required), 'output.required is array');
});

test('--describe emits flags array', () => {
  const { stdout } = run(['--describe']);
  const desc = JSON.parse(stdout);
  assert.ok(Array.isArray(desc.flags), 'flags array present');
  const names = desc.flags.map((f: { name: string }) => f.name);
  for (const expected of ['--in', '--out', '--provider', '--now', '--run-id', '--describe']) {
    assert.ok(names.includes(expected), `flag ${expected} present`);
  }
});

test('--describe input schema has const schemaVersion', () => {
  const { stdout } = run(['--describe']);
  const desc = JSON.parse(stdout);
  assert.equal(desc.input.properties.schemaVersion.const, SCHEMA_VERSION);
  assert.equal(desc.input.properties.artifact.const, 'aggregation');
});

test('--describe output schema has const contractRevision', () => {
  const { stdout } = run(['--describe']);
  const desc = JSON.parse(stdout);
  assert.equal(desc.output.properties.contractRevision.const, CONTRACT_REVISION);
  assert.equal(desc.output.properties.artifact.const, 'ranking');
});

// ---------------------------------------------------------------------------
// Determinism — --now
// ---------------------------------------------------------------------------

test('--now produces deterministic generatedAt', () => {
  const { status, stdout } = run(['--now', NOW], MINIMAL_JSON);
  assert.equal(status, 0);
  const artifact: RankingArtifact = JSON.parse(stdout);
  assert.equal(artifact.generatedAt, NOW);
});

test('same --now + same input produces byte-identical output', () => {
  const r1 = run(['--now', NOW], MINIMAL_JSON);
  const r2 = run(['--now', NOW], MINIMAL_JSON);
  assert.equal(r1.status, 0);
  assert.equal(r2.status, 0);
  assert.equal(r1.stdout, r2.stdout, 'output must be byte-identical');
});

test('different --now produces different generatedAt and runId', () => {
  const now2 = '2026-06-11T18:00:00.000Z';
  const r1 = run(['--now', NOW], MINIMAL_JSON);
  const r2 = run(['--now', now2], MINIMAL_JSON);
  const a1: RankingArtifact = JSON.parse(r1.stdout);
  const a2: RankingArtifact = JSON.parse(r2.stdout);
  assert.notEqual(a1.generatedAt, a2.generatedAt);
  assert.notEqual(a1.runId, a2.runId);
});

// ---------------------------------------------------------------------------
// --run-id override
// ---------------------------------------------------------------------------

test('--run-id overrides the generated run ID', () => {
  const customId = 'rank-custom-abc123';
  const { status, stdout } = run(['--now', NOW, '--run-id', customId], MINIMAL_JSON);
  assert.equal(status, 0);
  const artifact: RankingArtifact = JSON.parse(stdout);
  assert.equal(artifact.runId, customId);
});

test('--run-id + --now produces idempotent output', () => {
  const customId = 'rank-idempotent-001';
  const r1 = run(['--now', NOW, '--run-id', customId], MINIMAL_JSON);
  const r2 = run(['--now', NOW, '--run-id', customId], MINIMAL_JSON);
  assert.equal(r1.stdout, r2.stdout, 'idempotent: must be byte-identical');
});

// ---------------------------------------------------------------------------
// contractRevision stamping
// ---------------------------------------------------------------------------

test('output always stamps contractRevision', () => {
  const { status, stdout } = run(['--now', NOW], MINIMAL_JSON);
  assert.equal(status, 0);
  const artifact: RankingArtifact = JSON.parse(stdout);
  assert.equal(artifact.contractRevision, CONTRACT_REVISION);
});

test('output artifact field is "ranking"', () => {
  const { status, stdout } = run(['--now', NOW], MINIMAL_JSON);
  assert.equal(status, 0);
  const artifact: RankingArtifact = JSON.parse(stdout);
  assert.equal(artifact.artifact, 'ranking');
  assert.equal(artifact.schemaVersion, SCHEMA_VERSION);
});

// ---------------------------------------------------------------------------
// --in / --out flags
// ---------------------------------------------------------------------------

test('--in reads from file', () => {
  const inputPath = tmpFile('input.json', MINIMAL_JSON);
  try {
    const { status, stdout } = run(['--in', inputPath, '--now', NOW]);
    assert.equal(status, 0);
    const artifact: RankingArtifact = JSON.parse(stdout);
    assert.equal(artifact.artifact, 'ranking');
  } finally {
    cleanUp(inputPath);
  }
});

test('--out writes to file', () => {
  const outputPath = join(tmpdir(), `ranking-test-${process.pid}-out.json`);
  try {
    const { status } = run(['--now', NOW, '--out', outputPath], MINIMAL_JSON);
    assert.equal(status, 0);
    const raw = readFileSync(outputPath, 'utf8');
    const artifact: RankingArtifact = JSON.parse(raw);
    assert.equal(artifact.artifact, 'ranking');
    assert.equal(artifact.contractRevision, CONTRACT_REVISION);
  } finally {
    cleanUp(outputPath);
  }
});

test('--in file and --out file round-trip', () => {
  const inputPath = tmpFile('in.json', MINIMAL_JSON);
  const outputPath = join(tmpdir(), `ranking-test-${process.pid}-roundtrip.json`);
  try {
    const { status } = run(['--in', inputPath, '--out', outputPath, '--now', NOW]);
    assert.equal(status, 0);
    const raw = readFileSync(outputPath, 'utf8');
    const artifact: RankingArtifact = JSON.parse(raw);
    assert.equal(artifact.generatedAt, NOW);
    assert.equal(artifact.contractRevision, CONTRACT_REVISION);
  } finally {
    cleanUp(inputPath);
    cleanUp(outputPath);
  }
});

// ---------------------------------------------------------------------------
// --provider flag
// ---------------------------------------------------------------------------

test('--provider deterministic is accepted silently', () => {
  const { status, stderr } = run(['--provider', 'deterministic', '--now', NOW], MINIMAL_JSON);
  assert.equal(status, 0);
  assert.ok(!stderr.includes('ardur-ranking-engine: warning'), 'no engine warning for deterministic');
});

test('--provider unknown emits a warning but still succeeds', () => {
  const { status, stderr } = run(['--provider', 'openai', '--now', NOW], MINIMAL_JSON);
  assert.equal(status, 0, 'should still succeed');
  assert.ok(stderr.includes('warning'), 'should emit a warning');
});

// ---------------------------------------------------------------------------
// Backward compat — positional arg as --in
// ---------------------------------------------------------------------------

test('positional arg is accepted as --in (backward compat)', () => {
  const inputPath = tmpFile('positional.json', MINIMAL_JSON);
  try {
    const { status, stdout } = run([inputPath, '--now', NOW]);
    assert.equal(status, 0);
    const artifact: RankingArtifact = JSON.parse(stdout);
    assert.equal(artifact.artifact, 'ranking');
  } finally {
    cleanUp(inputPath);
  }
});

// ---------------------------------------------------------------------------
// JSON error envelopes
// ---------------------------------------------------------------------------

test('invalid JSON input emits structured error and exits non-zero', () => {
  const { status, stdout } = run(['--now', NOW], 'not-json{{{');
  assert.notEqual(status, 0, 'should exit non-zero');
  const err = JSON.parse(stdout);
  assert.ok('error' in err, 'error key present');
  assert.equal(err.error.stage, 'ranking');
  assert.equal(err.error.code, 'INPUT_PARSE');
  assert.ok(typeof err.error.message === 'string');
});

test('invalid artifact emits INPUT_INVALID error envelope', () => {
  const bad = JSON.stringify({ schemaVersion: 'ardur-content-pipeline/v1', artifact: 'aggregation' });
  const { status, stdout } = run(['--now', NOW], bad);
  assert.notEqual(status, 0);
  const err = JSON.parse(stdout);
  assert.equal(err.error.code, 'INPUT_INVALID');
  assert.equal(err.error.stage, 'ranking');
});

test('wrong schemaVersion emits INPUT_INVALID error envelope', () => {
  const bad = JSON.stringify({ ...MINIMAL_ARTIFACT, schemaVersion: 'wrong/v0' });
  const { status, stdout } = run(['--now', NOW], bad);
  assert.notEqual(status, 0);
  const err = JSON.parse(stdout);
  assert.equal(err.error.code, 'INPUT_INVALID');
});

test('unknown flag emits INVALID_FLAG error envelope', () => {
  const { status, stdout } = run(['--bogus-flag', '--now', NOW], MINIMAL_JSON);
  assert.notEqual(status, 0);
  const err = JSON.parse(stdout);
  assert.equal(err.error.code, 'INVALID_FLAG');
  assert.equal(err.error.stage, 'ranking');
});

test('missing --in value emits MISSING_FLAG_VALUE error envelope', () => {
  const { status, stdout } = run(['--in']);
  assert.notEqual(status, 0);
  const err = JSON.parse(stdout);
  assert.equal(err.error.code, 'MISSING_FLAG_VALUE');
});

test('nonexistent --in file emits IO_READ error envelope', () => {
  const { status, stdout } = run(['--in', '/no/such/file.json', '--now', NOW]);
  assert.notEqual(status, 0);
  const err = JSON.parse(stdout);
  assert.equal(err.error.code, 'IO_READ');
  assert.equal(err.error.stage, 'ranking');
});

test('invalid --now value emits INVALID_FLAG error', () => {
  const { status, stdout } = run(['--now', 'not-a-date'], MINIMAL_JSON);
  assert.notEqual(status, 0);
  const err = JSON.parse(stdout);
  assert.equal(err.error.code, 'INVALID_FLAG');
});

test('error envelope has required fields', () => {
  const { status, stdout } = run(['--now', NOW], 'garbage');
  assert.notEqual(status, 0);
  const err = JSON.parse(stdout);
  assert.ok('error' in err);
  const e = err.error;
  assert.ok('code' in e, 'code present');
  assert.ok('message' in e, 'message present');
  assert.ok('stage' in e, 'stage present');
});

// ---------------------------------------------------------------------------
// Upstream runId passthrough
// ---------------------------------------------------------------------------

test('upstreamRunId matches input artifact runId', () => {
  const { status, stdout } = run(['--now', NOW], MINIMAL_JSON);
  assert.equal(status, 0);
  const artifact: RankingArtifact = JSON.parse(stdout);
  assert.equal(artifact.upstreamRunId, MINIMAL_ARTIFACT.runId);
});
