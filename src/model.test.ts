/**
 * Model conformance tests — assert the implemented pure formulas match the
 * finalized design spec's worked values (news-rating-system.md §2.2, §2.3, §2.7).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BALANCED_V1,
  coreWeightsAreNormalized,
  getWeightProfile,
} from './weights.ts';
import {
  corroborationScore,
  sourceTierBlend,
  recencyHalfLifeHours,
  recencyDecay,
  diversityMultiplier,
  engagementScore,
} from './signals.ts';
import {
  computeScore,
  computeConfidence,
  confidenceStatus,
  toConfidenceLabel,
  isEligibleForTop10,
  compareForRank,
  type RawSignals,
  type TieBreakKeys,
} from './score.ts';
import { buildAuditEntry, auditIdFor, type AuditInput } from './audit.ts';

const P = BALANCED_V1;
const approx = (a: number, b: number, eps = 0.01): void =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);

test('balanced@v1 core weights sum to 1.0 and resolve from the registry', () => {
  assert.ok(coreWeightsAreNormalized(P));
  assert.equal(getWeightProfile(), P);
  assert.throws(() => getWeightProfile('nope@v9'), /unknown weight profile/);
});

test('corroboration log-saturation matches spec (n=1→.32, 3→.63, 8→1.0)', () => {
  approx(corroborationScore(1, P), 0.32);
  approx(corroborationScore(3, P), 0.63);
  approx(corroborationScore(8, P), 1.0);
  assert.equal(corroborationScore(0, P), 0);
});

test('recency half-life scales with significance: 12h → 24h → 36h', () => {
  approx(recencyHalfLifeHours(0, P), 12);
  approx(recencyHalfLifeHours(0.5, P), 24);
  approx(recencyHalfLifeHours(1, P), 36);
});

test('recency decay matches the worked table', () => {
  // Base (H=24): 6h→.84, 24h→.50, 48h→.25
  approx(recencyDecay(6, 24), 0.84);
  approx(recencyDecay(24, 24), 0.5);
  approx(recencyDecay(48, 24), 0.25);
  // Trivial (H=12): 12h→.50 ; Critical (H=36): 24h→.63
  approx(recencyDecay(12, 12), 0.5);
  approx(recencyDecay(24, 36), 0.63);
});

test('diversity multiplier clamps to [0.8, 1.15]', () => {
  approx(diversityMultiplier(0, P), 0.8);
  approx(diversityMultiplier(1, P), 1.15);
  approx(diversityMultiplier(0.714, P), 1.05);
});

test('source-tier blend = 0.7·max + 0.3·mean', () => {
  approx(sourceTierBlend(1.0, 1.0, P), 1.0);
  approx(sourceTierBlend(1.0, 0.7, P), 0.91);
});

test('engagement averages capped velocities; no data → 0', () => {
  assert.equal(engagementScore({}, P), 0);
  approx(engagementScore({ hn: 2.0, github: 0.4 }, P), 0.7); // cap 1.0 then mean(1,0.4)
});

test('computeScore = recency × weightedCore × diversity, bounded [0, 1.15]', () => {
  const signals: RawSignals = {
    corroboration: 0.63,
    technicalSignificance: 0.9,
    sourceTier: 0.85,
    engagement: 0.4,
  };
  const r = computeScore(signals, { recency: 0.84, diversity: 1.05 }, P);
  approx(r.weightedCore, 0.708);
  approx(r.total, 0.84 * 0.708 * 1.05);
  // Upper bound: all signals 1, recency 1, diversity ceiling.
  const max = computeScore(
    { corroboration: 1, technicalSignificance: 1, sourceTier: 1, engagement: 1 },
    { recency: 1, diversity: 1.15 },
    P,
  );
  approx(max.total, 1.15);
});

test('confidence + gate thresholds (≥.66 auto, .40–.66 flagged, <.40 hold)', () => {
  const full = computeConfidence(
    { corroboration: 1, tierConf: 1, cohesion: 1, agreement: 1 },
    P,
  );
  approx(full, 1.0);
  assert.equal(confidenceStatus(0.66, P), 'auto');
  assert.equal(confidenceStatus(0.659, P), 'flagged');
  assert.equal(confidenceStatus(0.4, P), 'flagged');
  assert.equal(confidenceStatus(0.399, P), 'hold');
  assert.equal(toConfidenceLabel(0.7, P), 'high');
  assert.equal(toConfidenceLabel(0.5, P), 'medium');
  assert.equal(toConfidenceLabel(0.2, P), 'low');
});

test('promotion gate: ≥2 owners OR a Tier-1 primary', () => {
  assert.equal(isEligibleForTop10({ independentOwners: 1, hasTier1Primary: false }, P), false);
  assert.equal(isEligibleForTop10({ independentOwners: 2, hasTier1Primary: false }, P), true);
  assert.equal(isEligibleForTop10({ independentOwners: 1, hasTier1Primary: true }, P), true);
});

test('tie-break cascade: within ε, more owners wins; else score', () => {
  const base: TieBreakKeys = {
    score: 0.5,
    independentOwners: 2,
    maxTier: 0.7,
    technicalSignificance: 0.5,
    freshestMs: 1000,
    topicKeyHash: 1,
  };
  const moreOwners: TieBreakKeys = { ...base, score: 0.502, independentOwners: 5 };
  assert.ok(compareForRank(moreOwners, base, P) < 0); // moreOwners ranks first
  const higherScore: TieBreakKeys = { ...base, score: 0.9 };
  assert.ok(compareForRank(base, higherScore, P) > 0); // higher score ranks first
});

test('audit entry is lossless + reproducible + deterministically identified', () => {
  const rating = computeScore(
    { corroboration: 0.63, technicalSignificance: 0.9, sourceTier: 0.85, engagement: 0.4 },
    { recency: 0.84, diversity: 1.05 },
    P,
  );
  const input: AuditInput = {
    clusterId: 'c-1',
    topic: 'kubernetes',
    rating,
    confidence: 0.82,
    gate: 'auto',
    independentOwners: 4,
    halfLifeHours: recencyHalfLifeHours(0.9, P),
    ageHours: 6,
    weightProfile: P.id,
    rankedAt: new Date('2026-06-11T00:00:00Z'),
  };
  const entry = buildAuditEntry(input);
  // T is preserved losslessly in inputs (it has no slot in ScoreBreakdown).
  approx(entry.inputs.technicalSignificance ?? -1, 0.9);
  // Recompute the score from the audit inputs → matches.
  const recomputed = computeScore(
    {
      corroboration: entry.inputs.corroboration ?? 0,
      technicalSignificance: entry.inputs.technicalSignificance ?? 0,
      sourceTier: entry.inputs.sourceTier ?? 0,
      engagement: entry.inputs.engagement ?? 0,
    },
    { recency: entry.inputs.recencyMultiplier ?? 0, diversity: entry.inputs.diversityMultiplier ?? 0 },
    P,
  );
  approx(recomputed.total, entry.inputs.total ?? -1, 1e-9);
  // Stable id.
  assert.equal(entry.auditId, auditIdFor(input));
});
