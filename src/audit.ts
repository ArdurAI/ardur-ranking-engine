/**
 * Audit trail — a fully reproducible record of every rating decision.
 *
 * The audit entry is the engine's transparency contract: it captures enough to
 * RECOMPUTE the score offline. Because the shared `ScoreBreakdown` cannot carry
 * the Technical-significance component value, the audit `inputs` (a free-form
 * `Record<string, number>`) is the LOSSLESS record of the model — every signal,
 * multiplier, weight input, and confidence value lands here.
 *
 * Reproducibility invariant:
 *   computeScore(signalsFrom(entry.inputs), multipliersFrom(entry.inputs),
 *                getWeightProfile(entry.weightProfile)).total === entry.inputs.total
 */

import type { AuditEntry } from './contracts.ts';
import type { RatingBreakdown, GateStatus } from './score.ts';
import { toScoreBreakdown } from './score.ts';

export interface AuditInput {
  clusterId: string;
  topic: string;
  /** The full, lossless model output for the topic. */
  rating: RatingBreakdown;
  /** Confidence value (§2.7) and the editorial gate it falls into. */
  confidence: number;
  gate: GateStatus;
  /** Inputs to the recency multiplier, for full reproducibility. */
  independentOwners: number;
  halfLifeHours: number;
  ageHours: number;
  weightProfile: string;
  rankedAt: Date;
}

/** Deterministic 32-bit FNV-1a hash → unsigned int (stable across runs/machines). */
export function stableHashNumber(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable hex audit id derived only from the entry's identifying inputs. */
export function auditIdFor(input: AuditInput): string {
  const key = `${input.weightProfile}|${input.clusterId}|${input.rating.total.toFixed(6)}`;
  return stableHashNumber(key).toString(16).padStart(8, '0');
}

/** Build one immutable, fully-reproducible audit entry. */
export function buildAuditEntry(input: AuditInput): AuditEntry {
  const { rating } = input;
  const inputs: Record<string, number> = {
    // Core signals (C, T, S, E) — the lossless model record, incl. T.
    corroboration: rating.signals.corroboration,
    technicalSignificance: rating.signals.technicalSignificance,
    sourceTier: rating.signals.sourceTier,
    engagement: rating.signals.engagement,
    // Combination.
    weightedCore: rating.weightedCore,
    recencyMultiplier: rating.recency,
    diversityMultiplier: rating.diversity,
    total: rating.total,
    // Recency provenance.
    independentOwners: input.independentOwners,
    halfLifeHours: input.halfLifeHours,
    ageHours: input.ageHours,
    // Confidence.
    confidence: input.confidence,
  };
  return {
    auditId: auditIdFor(input),
    clusterId: input.clusterId,
    topic: input.topic,
    inputs,
    weights: { ...rating.weights },
    computed: toScoreBreakdown(rating),
    rationale: explainRanking(input),
    weightProfile: input.weightProfile,
    rankedAt: input.rankedAt.toISOString(),
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Human-readable one-line rationale. Deterministic given the input. */
export function explainRanking(input: AuditInput): string {
  const s = input.rating.signals;
  return (
    `${input.gate} (confidence ${pct(input.confidence)}): ` +
    `corroboration ${pct(s.corroboration)} from ${input.independentOwners} owner(s), ` +
    `significance ${pct(s.technicalSignificance)}, tier ${pct(s.sourceTier)}, ` +
    `engagement ${pct(s.engagement)}; ` +
    `recency ×${input.rating.recency.toFixed(2)} (age ${Math.round(input.ageHours)}h, ` +
    `half-life ${Math.round(input.halfLifeHours)}h), ` +
    `diversity ×${input.rating.diversity.toFixed(2)} ⇒ score ${input.rating.total.toFixed(3)}`
  );
}
