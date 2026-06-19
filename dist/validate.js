import { assertCompatibleArtifact } from '@ardurai/contracts';
import { ExtractedFactSchema } from '@ardurai/contracts/zod';
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
export function validateAggregationArtifact(raw) {
    const { envelope, warnings } = assertCompatibleArtifact(raw, 'aggregation');
    for (const w of warnings) {
        process.stderr.write(`ardur-ranking-engine: warning: ${w}\n`);
    }
    const env = raw;
    const d = env['data'];
    if (d['clustersByTopic'] === null || typeof d['clustersByTopic'] !== 'object' || Array.isArray(d['clustersByTopic'])) {
        throw new Error('missing or invalid "data.clustersByTopic"');
    }
    if (d['itemsByTopic'] === null || typeof d['itemsByTopic'] !== 'object' || Array.isArray(d['itemsByTopic'])) {
        throw new Error('missing or invalid "data.itemsByTopic"');
    }
    if (env['cycle'] === null || typeof env['cycle'] !== 'object' || Array.isArray(env['cycle'])) {
        throw new Error('missing or invalid "cycle" field');
    }
    // Tier-2 (Zod): validate all ExtractedFacts — rejects corroboration=NaN/Infinity/negative/0 (#13).
    const factsByCluster = d['factsByCluster'];
    if (factsByCluster !== null && factsByCluster !== undefined && typeof factsByCluster === 'object' && !Array.isArray(factsByCluster)) {
        for (const [clusterId, facts] of Object.entries(factsByCluster)) {
            if (!Array.isArray(facts))
                continue;
            for (let i = 0; i < facts.length; i++) {
                const result = ExtractedFactSchema.safeParse(facts[i]);
                if (!result.success) {
                    throw new Error(`Invalid ExtractedFact at factsByCluster["${clusterId}"][${i}]: ${result.error.message}`);
                }
            }
        }
    }
    return envelope;
}
