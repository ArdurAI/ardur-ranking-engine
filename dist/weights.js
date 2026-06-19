/**
 * Weight profiles — the tunable configuration for the finalized Ardur
 * topic-rating model. Everything here is PURE DATA so ranking stays fully
 * reproducible and auditable; tuning is a reviewed data change, never a code
 * change to the scoring math.
 *
 * Model (see ~/Documents/Ardur-AI-Website/news-rating-system.md and docs/spec.md):
 *
 *   Score = Recency(t) × [ 0.30·C + 0.28·T + 0.22·S + 0.20·E ] × Diversity
 *
 * where the bracket is the weighted core over four normalized [0,1] signals
 * (Corroboration, Technical significance, Source tier, Engagement) and Recency
 * and Diversity are multipliers.
 */
/** Default profile id used when none is requested. */
export const DEFAULT_WEIGHT_PROFILE = 'balanced@v1';
/**
 * The approved finalized profile. Values are taken verbatim from the design
 * spec (news-rating-system.md §2.1, §2.2, §2.3, §2.7, §2.11).
 */
export const BALANCED_V1 = {
    id: 'balanced@v1',
    weights: {
        corroboration: 0.3,
        technicalSignificance: 0.28,
        sourceTier: 0.22,
        engagement: 0.2,
    },
    corroborationSaturation: 8,
    corroborationMinTier: 'T3',
    recency: { hMinHours: 12, hSpanHours: 24 },
    diversity: { floor: 0.8, ceil: 1.15, slope: 0.35 },
    sourceTier: {
        maxWeight: 0.7,
        meanWeight: 0.3,
        values: { T1: 1.0, T2: 0.7, T3: 0.4, T4: 0.15 },
        // Map the aggregator taxonomy onto model tiers. Configurable; refined as the
        // source registry grows (community-aggregator / unknown tiers land here too).
        rankByTaxonomy: {
            primary: 'T1',
            paper: 'T2',
            news: 'T2',
            'technical-news': 'T2',
            'security-news': 'T2',
        },
    },
    engagement: {
        platformCaps: { hn: 1.0, github: 1.0, reddit: 1.0, lobsters: 1.0 },
    },
    aiPlatformSignificanceBonus: 0.1,
    clustering: { similarityThreshold: 0.6, timeWindowHours: 48 },
    confidence: {
        weights: { corroboration: 0.35, tierConf: 0.3, cohesion: 0.2, agreement: 0.15 },
        autoThreshold: 0.66,
        holdThreshold: 0.4,
    },
    promotion: { minIndependentOwners: 2 },
    tieBreakEpsilon: 0.01,
};
const PROFILES = {
    [BALANCED_V1.id]: BALANCED_V1,
};
/** Resolve a named, versioned weight profile. Unknown id → error. */
export function getWeightProfile(id = DEFAULT_WEIGHT_PROFILE) {
    const profile = PROFILES[id];
    if (!profile) {
        throw new Error(`unknown weight profile: ${id} (known: ${Object.keys(PROFILES).join(', ')})`);
    }
    return profile;
}
/** True if the four core weights sum to 1.0 (within float tolerance). */
export function coreWeightsAreNormalized(profile, tolerance = 1e-9) {
    const { corroboration, technicalSignificance, sourceTier, engagement } = profile.weights;
    return Math.abs(corroboration + technicalSignificance + sourceTier + engagement - 1) <= tolerance;
}
