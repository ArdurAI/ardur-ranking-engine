/**
 * Signal extraction — turn a cluster into the five raw ranking signals.
 *
 * SCAFFOLD ONLY. Each function returns a NORMALIZED 0..1 raw signal; weighting
 * happens in score.ts. Keeping extraction separate from weighting is what makes
 * the audit trail reproducible.
 */

import type { Cluster, AggregatedItem, SourceTier } from './contracts.ts';

/** Credibility weight per source tier (higher = more trusted). */
export type TierCredibility = Record<SourceTier, number>;

export interface SignalInputs {
  cluster: Cluster;
  members: AggregatedItem[]; // resolved cluster members (for interaction signals)
  now: Date;
  recencyWindowHours: number;
  tierCredibility: TierCredibility;
}

/** Aggregate interaction signal (feed rank, mentions, velocity), normalized 0..1. */
export function interactionSignal(_input: SignalInputs): number {
  throw new Error('not implemented');
}

/** Source credibility: tier-weighted blend over distinct member sources, 0..1. */
export function credibilitySignal(_input: SignalInputs): number {
  throw new Error('not implemented');
}

/** Recency: decay from latestPublishedAt over recencyWindowHours, 0..1. */
export function recencySignal(_input: SignalInputs): number {
  throw new Error('not implemented: port decay from refresh-news.mjs scoreItem');
}

/** Source diversity: distinct domains / tier spread, 0..1. */
export function diversitySignal(_input: SignalInputs): number {
  throw new Error('not implemented');
}

/** Corroboration: how many distinct sources independently report the story, 0..1. */
export function corroborationSignal(_input: SignalInputs): number {
  throw new Error('not implemented');
}

/** All five raw signals for one cluster (pre-weighting). */
export function extractSignals(_input: SignalInputs): {
  interaction: number;
  credibility: number;
  recency: number;
  diversity: number;
  corroboration: number;
} {
  throw new Error('not implemented');
}
