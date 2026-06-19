import type { AggregationArtifact } from '@ardurai/contracts';
/**
 * Validate that `raw` is a structurally plausible AggregationArtifact.
 * Throws on any mismatch; returns the typed artifact otherwise.
 *
 * Gate layer (Tier 1): assertCompatibleArtifact enforces the versioned envelope
 * contract (schemaVersion, artifact type, non-null data).
 *
 * Engine layer: ranking-specific structural checks on data fields follow.
 *
 * Zod layer (Tier 2, #13): validates every ExtractedFact in factsByCluster
 * using ExtractedFactSchema so invalid corroboration values (NaN, Infinity,
 * negative, zero) are rejected before they can poison score.total.
 */
export declare function validateAggregationArtifact(raw: unknown): AggregationArtifact;
