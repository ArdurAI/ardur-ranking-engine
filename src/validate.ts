/**
 * CLI input validation — structural + schemaVersion guard for AggregationArtifacts
 * consumed by the ranking engine.
 *
 * Intentionally local to this engine; a unified cross-engine validation approach
 * is tracked separately and will supersede this guard once finalized.
 */

import type { AggregationArtifact } from './contracts.ts';
import { SCHEMA_VERSION } from './contracts.ts';

/**
 * Validate that `raw` is a structurally plausible AggregationArtifact.
 * Throws a descriptive Error on any mismatch; returns the typed artifact otherwise.
 *
 * Checks (ordered cheapest → most specific):
 *   1. Must be a non-null, non-array object.
 *   2. schemaVersion must equal the local SCHEMA_VERSION constant.
 *   3. artifact must equal "aggregation".
 *   4. data must be a non-null, non-array object.
 *   5. data.clustersByTopic must be a non-null object.
 *   6. data.itemsByTopic must be a non-null object.
 *   7. cycle must be a non-null object.
 */
export function validateAggregationArtifact(raw: unknown): AggregationArtifact {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    const got = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    throw new Error(`expected a JSON object, got ${got}`);
  }
  const obj = raw as Record<string, unknown>;

  if (obj['schemaVersion'] !== SCHEMA_VERSION) {
    throw new Error(
      `schemaVersion mismatch: expected "${SCHEMA_VERSION}", got ${JSON.stringify(obj['schemaVersion'])}`,
    );
  }
  if (obj['artifact'] !== 'aggregation') {
    throw new Error(`expected artifact="aggregation", got ${JSON.stringify(obj['artifact'])}`);
  }

  const data = obj['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('missing or invalid "data" field');
  }
  const d = data as Record<string, unknown>;

  if (d['clustersByTopic'] === null || typeof d['clustersByTopic'] !== 'object' || Array.isArray(d['clustersByTopic'])) {
    throw new Error('missing or invalid "data.clustersByTopic"');
  }
  if (d['itemsByTopic'] === null || typeof d['itemsByTopic'] !== 'object' || Array.isArray(d['itemsByTopic'])) {
    throw new Error('missing or invalid "data.itemsByTopic"');
  }
  if (obj['cycle'] === null || typeof obj['cycle'] !== 'object' || Array.isArray(obj['cycle'])) {
    throw new Error('missing or invalid "cycle" field');
  }

  return raw as AggregationArtifact;
}
