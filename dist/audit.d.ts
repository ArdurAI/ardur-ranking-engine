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
import type { RatingBreakdown, ConfidenceInputs, GateStatus } from './score.ts';
export interface AuditInput {
    clusterId: string;
    topic: string;
    /** The full, lossless model output for the topic. */
    rating: RatingBreakdown;
    /** Confidence value (§2.7) and the editorial gate it falls into. */
    confidence: number;
    /**
     * ENGINE-007 (#5): the four inputs that produced `confidence`.
     * Recorded so calibration can be validated offline: check whether clusters
     * that scored 'high' actually held up multi-source over time.
     *
     * Static calibration (balanced@v1): wC=0.35, wTier=0.30, wCohesion=0.20, wAgreement=0.15.
     * Dynamic recalibration (future): compare realized corroboration against predicted
     * confidence buckets once a rolling history is available.
     */
    confidenceInputs: ConfidenceInputs;
    gate: GateStatus;
    /** Inputs to the recency multiplier, for full reproducibility. */
    independentOwners: number;
    halfLifeHours: number;
    ageHours: number;
    /** Rev 3: fact-level corroboration signal (0 when no facts available). */
    factCorroboration: number;
    weightProfile: string;
    rankedAt: Date;
}
/** Deterministic 32-bit FNV-1a hash → unsigned int (stable across runs/machines). */
export declare function stableHashNumber(input: string): number;
/** Stable hex audit id derived only from the entry's identifying inputs. */
export declare function auditIdFor(input: AuditInput): string;
/** Build one immutable, fully-reproducible audit entry. */
export declare function buildAuditEntry(input: AuditInput): AuditEntry;
/** Human-readable one-line rationale. Deterministic given the input. */
export declare function explainRanking(input: AuditInput): string;
