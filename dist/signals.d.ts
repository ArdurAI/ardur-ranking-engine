/**
 * Signal extraction — turn a cluster into the finalized model's signals.
 *
 * Two layers:
 *   1. PURE TRANSFORMS (implemented) — the exact formulas from the design spec.
 *      Deterministic, dependency-free, unit-tested. This is the model's math.
 *   2. EXTRACTION (some implemented from contract data, some stubbed) — turning a
 *      `Cluster` + members into the raw inputs the transforms consume. The parts
 *      that need the source-ownership registry, CVE/semver parsing, or rolling
 *      engagement baselines remain `not implemented` and are tracked as issues.
 *
 * Model (news-rating-system.md §2.2–§2.3):
 *   C = min(1, ln(1+n)/ln(1+C_sat)),  n = independent owners (tier ≥ T3)
 *   T = max matched CVE/semver/release rule (+0.1 AI/platform lean), clamp[0,1]
 *   S = 0.7·maxTier + 0.3·meanTier
 *   E = min(1, mean_p min(cap_p, velocity_p / baseline_p))   (counts only)
 *   Recency(t) = 0.5^(t/H),  H = 12 + 24·T   (t = age of freshest corroboration)
 *   Diversity  = clamp(0.8 + 0.35·div, 0.8, 1.15)
 */
import type { Cluster, AggregatedItem, ExtractedFact, SourceTier } from './contracts.ts';
import type { WeightProfile } from './weights.ts';
export interface SignalInputs {
    cluster: Cluster;
    members: AggregatedItem[];
    /** Rev 3: facts extracted by the aggregator for this cluster. */
    facts?: ExtractedFact[];
    now: Date;
    profile: WeightProfile;
}
/** C — corroboration from independent-owner count: min(1, ln(1+n)/ln(1+C_sat)). */
export declare function corroborationScore(ownerCount: number, profile: WeightProfile): number;
/** Credibility value of one source tier (maps aggregator taxonomy → model tier). */
export declare function tierValue(tier: SourceTier, profile: WeightProfile): number;
/** S — source tier: maxWeight·maxTier + meanWeight·meanTier over the cluster. */
export declare function sourceTierBlend(maxTier: number, meanTier: number, profile: WeightProfile): number;
/** Significance-scaled recency half-life in hours: H(T) = hMin + hSpan·T. */
export declare function recencyHalfLifeHours(technicalSignificance: number, profile: WeightProfile): number;
/** Recency(t) = 0.5^(t / H). t and H in hours; returns (0, 1]. */
export declare function recencyDecay(ageHours: number, halfLifeHours: number): number;
/** Diversity multiplier from a normalized owner/type-entropy term in [0,1]. */
export declare function diversityMultiplier(normalizedDiversity: number, profile: WeightProfile): number;
/** E — engagement: capped per-platform velocities, averaged, clamped to [0,1]. */
export declare function engagementScore(velocityByPlatform: Record<string, number>, profile: WeightProfile): number;
/** Hours between a timestamp and `now` (never negative). */
export declare function ageHoursSince(isoTimestamp: string, now: Date): number;
/**
 * S — source tier signal, computed from the cluster's `tierHistogram`
 * (distinct-source counts per tier). Real, deterministic, no registry needed.
 */
export declare function sourceTierSignal(input: SignalInputs): number;
/** True if the cluster has at least one Tier-1 primary source. */
export declare function hasTier1Primary(cluster: Cluster, profile: WeightProfile): boolean;
/** Highest credibility value present in the cluster's tier histogram. */
export declare function maxTierValue(cluster: Cluster, profile: WeightProfile): number;
/**
 * Normalize a raw sourceDomain string for owner-dedup (CWE-20 defence).
 *
 * Strips userinfo (`user@`), port (`:8080`), and the `www.` prefix, then
 * lowercases.  Two URLs that differ only in these inert components (e.g.
 * "WWW.Example.com", "example.com:443", "cdn@example.com") collapse to the
 * same key so they aren't counted as separate independent owners.
 */
export declare function normalizeOwnerDomain(domain: string): string;
/**
 * n — count of distinct independent OWNERS for a cluster.
 *
 * Deduplicates members by normalized `sourceDomain` (strip userinfo/port/www,
 * then lowercase — CWE-20), counting only those at credibility tier ≥
 * `profile.corroborationMinTier` (default T3).  This is a domain-level proxy
 * for the full ownership registry; syndicated copies of the same publisher
 * collapse to one domain entry.
 *
 * Falls back to `cluster.distinctDomains` when no members are available.
 */
export declare function countIndependentOwners(input: SignalInputs): number;
/**
 * T — technical significance from rule matching over member title/summaryHint
 * text (§4 table T).  Take the max matched rule value, add the AI/platform lean
 * bonus from the weight profile, clamp to [0, 1].
 *
 * Default noise floor is 0.20 (unclassified content that still carries some
 * signal due to source-tier and corroboration filtering upstream).
 */
export declare function technicalSignificanceSignal(input: SignalInputs): number;
/**
 * Normalized owner/type entropy for the diversity multiplier (§4, Diversity).
 *
 * Computes Shannon entropy of the domain distribution (how evenly articles are
 * spread across owners), then scales by the fraction of distinct source
 * categories present (official / press / academic → up to 3).
 *
 * Returns a value in [0, 1]:
 *   0   → single domain / single type (echo penalty when fed into diversityMultiplier)
 *   1   → maximally spread across many domains and all three categories
 */
export declare function ownerDiversity(input: SignalInputs): number;
/**
 * Per-platform velocity (normalized by a documented baseline) for engagement.
 *
 * Sums `interaction.velocity` across cluster members and divides by the
 * velocity baseline (5 mentions/hour = "moderately active").  Returns the
 * result under the key `"feed"` so `engagementScore` can apply the cap.
 *
 * Falls back to `crossSourceMentions` (mention count) if velocity is absent.
 * Returns an empty record when no interaction data is available, which causes
 * `engagementScore` to return 0 (documented neutral floor).
 */
export declare function platformVelocities(input: SignalInputs): Record<string, number>;
/**
 * Rev 3: fact-level corroboration signal.
 *
 * `ExtractedFact.corroboration` is an INTEGER COUNT of distinct source owners
 * that agree on the fact (set by the aggregator, min 1 = single owner).  This
 * function applies the same log-saturation curve as `corroborationScore` to
 * each fact, then returns the mean — so a single owner NEVER saturates to 1.0
 * (#15/#18), and NaN/Infinity/negative values are sanitized to 0 (#13).
 *
 * Without profile-aware saturation, a cluster where every fact has
 * corroboration=1 (one-owner) would produce factLevel=1.0, collapsing all
 * such clusters to C=1.0 and erasing T-signal ordering for security topics.
 */
export declare function factCorroborationSignal(facts: ExtractedFact[], profile: WeightProfile): number;
/**
 * C — corroboration signal.
 *
 * When Rev 3 facts are available, blends the domain-based estimate with the
 * fact-level signal: `max(domainBased, factLevel)`.  This guarantees a cluster
 * with corroborated facts always ranks ≥ an equal-domain cluster with no
 * agreeing facts — satisfying the R1 acceptance criterion — without ever
 * penalising a cluster that lacks extracted facts.
 */
export declare function corroborationSignal(input: SignalInputs): number;
/** E — engagement signal (composes velocities + caps). */
export declare function engagementSignal(input: SignalInputs): number;
