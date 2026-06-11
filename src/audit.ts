/**
 * Audit trail — a fully reproducible record of every ranking decision.
 *
 * SCAFFOLD ONLY. The audit entry must contain enough to RECOMPUTE the score
 * offline: raw inputs, the weight profile, the computed breakdown, and a short
 * human-readable rationale. This is the engine's transparency contract.
 */

import type { AuditEntry, ScoreBreakdown } from './contracts.ts';
import type { RawSignals } from './score.ts';

export interface AuditInput {
  clusterId: string;
  topic: string;
  signals: RawSignals;
  weightProfile: string;
  weights: Record<string, number>;
  computed: ScoreBreakdown;
  rankedAt: Date;
}

/** Build one immutable audit entry. Must be deterministic given its input. */
export function buildAuditEntry(_input: AuditInput): AuditEntry {
  throw new Error('not implemented');
}

/** Human-readable one-line rationale, e.g. "corroborated by 4 sources, fresh (2h)". */
export function explainRanking(_input: AuditInput): string {
  throw new Error('not implemented');
}
