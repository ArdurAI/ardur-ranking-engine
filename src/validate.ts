import type { AggregationArtifact } from '@ardurai/contracts';
import { assertCompatibleArtifact } from '@ardurai/contracts';

/**
 * Validate that `raw` is a structurally plausible AggregationArtifact.
 * Throws on any mismatch; returns the typed artifact otherwise.
 *
 * Gate layer: assertCompatibleArtifact (from @ardurai/contracts) enforces the
 * versioned envelope contract (schemaVersion, artifact type, non-null data).
 *
 * Engine layer: ranking-specific structural checks on data fields follow the gate.
 */
export function validateAggregationArtifact(raw: unknown): AggregationArtifact {
  const { envelope, warnings } = assertCompatibleArtifact(raw, 'aggregation');
  for (const w of warnings) {
    process.stderr.write(`ardur-ranking-engine: warning: ${w}\n`);
  }

  const env = raw as Record<string, unknown>;
  const d = env['data'] as Record<string, unknown>;

  if (d['clustersByTopic'] === null || typeof d['clustersByTopic'] !== 'object' || Array.isArray(d['clustersByTopic'])) {
    throw new Error('missing or invalid "data.clustersByTopic"');
  }
  if (d['itemsByTopic'] === null || typeof d['itemsByTopic'] !== 'object' || Array.isArray(d['itemsByTopic'])) {
    throw new Error('missing or invalid "data.itemsByTopic"');
  }
  if (env['cycle'] === null || typeof env['cycle'] !== 'object' || Array.isArray(env['cycle'])) {
    throw new Error('missing or invalid "cycle" field');
  }

  return envelope as AggregationArtifact;
}
