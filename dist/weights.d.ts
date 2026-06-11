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
import type { SourceTier } from './contracts.ts';
/** Model credibility tiers (distinct from the aggregator's source taxonomy). */
export type CredibilityTier = 'T1' | 'T2' | 'T3' | 'T4';
/** Weights for the four core signals. Must sum to 1.0. */
export interface CoreWeights {
    corroboration: number;
    technicalSignificance: number;
    sourceTier: number;
    engagement: number;
}
export interface WeightProfile {
    id: string;
    /** Weighted core signal mix (sums to 1.0). */
    weights: CoreWeights;
    /** Corroboration saturation: C = min(1, ln(1+n)/ln(1+cSat)). */
    corroborationSaturation: number;
    /** Minimum independent owner tier counted toward corroboration. */
    corroborationMinTier: CredibilityTier;
    /**
     * Significance-scaled recency half-life, in hours: H(T) = hMinHours + hSpanHours·T.
     * Defaults give 12h (trivial) → 24h (base, T=0.5) → 36h (critical, T=1).
     */
    recency: {
        hMinHours: number;
        hSpanHours: number;
    };
    /** Diversity multiplier = clamp(floor + slope·div, floor, ceil). */
    diversity: {
        floor: number;
        ceil: number;
        slope: number;
    };
    /** Source tier score: S = maxWeight·maxTier + meanWeight·meanTier. */
    sourceTier: {
        maxWeight: number;
        meanWeight: number;
        /** Credibility value per model tier (T1 highest → T4 unknown). */
        values: Record<CredibilityTier, number>;
        /** Map the aggregator's source taxonomy onto a model credibility tier. */
        rankByTaxonomy: Record<SourceTier, CredibilityTier>;
    };
    /** Engagement: per-platform velocity caps; counts only, baseline-normalized. */
    engagement: {
        platformCaps: Record<string, number>;
    };
    /** +bonus to T for the AI / platform-engineering lean (never a hard filter). */
    aiPlatformSignificanceBonus: number;
    /** Deterministic clustering knobs (consumed upstream / for cohesion). */
    clustering: {
        similarityThreshold: number;
        timeWindowHours: number;
    };
    /** Confidence = wC·C + wTier·tierConf + wCohesion·cohesion + wAgreement·agreement. */
    confidence: {
        weights: {
            corroboration: number;
            tierConf: number;
            cohesion: number;
            agreement: number;
        };
        /** Editorial gate thresholds: ≥auto → auto; ≥hold → flagged; else hold. */
        autoThreshold: number;
        holdThreshold: number;
    };
    /** Anti-gaming: a topic needs ≥minIndependentOwners OR a Tier-1 primary. */
    promotion: {
        minIndependentOwners: number;
    };
    /** Tie-break tolerance: |ΔScore| < epsilon → ordered by the §2.6 tie-breaks. */
    tieBreakEpsilon: number;
}
/** Default profile id used when none is requested. */
export declare const DEFAULT_WEIGHT_PROFILE = "balanced@v1";
/**
 * The approved finalized profile. Values are taken verbatim from the design
 * spec (news-rating-system.md §2.1, §2.2, §2.3, §2.7, §2.11).
 */
export declare const BALANCED_V1: WeightProfile;
/** Resolve a named, versioned weight profile. Unknown id → error. */
export declare function getWeightProfile(id?: string): WeightProfile;
/** True if the four core weights sum to 1.0 (within float tolerance). */
export declare function coreWeightsAreNormalized(profile: WeightProfile, tolerance?: number): boolean;
