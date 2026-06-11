/**
 * ardur-ranking-engine — public entrypoint.
 *
 * Stage 2 of the Ardur content pipeline: score every cluster from the
 * aggregator on five signals (interaction, credibility, recency, diversity,
 * corroboration), rank within each topic, and emit a `RankingArtifact` with a
 * complete audit trail for `ardur-top10-engine`.
 *
 * SCAFFOLD ONLY — wiring/signatures are final; module bodies are stubs.
 */

import type { AggregationArtifact, RankingArtifact } from './contracts.ts';
import { DEFAULT_WEIGHT_PROFILE } from './weights.ts';

export * from './contracts.ts';
export type { WeightProfile } from './weights.ts';
export type { RawSignals } from './score.ts';

export interface RankingOptions {
  /** Named weight profile to apply. Defaults to `balanced@v1`. */
  weightProfile?: string;
  /** Override the wall clock (testing/replay). */
  now?: Date;
}

/**
 * Rank a full `AggregationArtifact`. Returns a `RankingArtifact` whose
 * `rankedByTopic` is sorted by total score and whose `audit` recomputes every
 * score. The cycle/runId chain is preserved from the upstream artifact.
 */
export function runRanking(
  _aggregation: AggregationArtifact,
  _options: RankingOptions = {},
): RankingArtifact {
  void DEFAULT_WEIGHT_PROFILE;
  throw new Error('not implemented: signals -> score -> rank -> audit');
}
