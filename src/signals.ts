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

import type { Cluster, AggregatedItem, SourceTier } from './contracts.ts';
import type { WeightProfile, CredibilityTier } from './weights.ts';

export interface SignalInputs {
  cluster: Cluster;
  members: AggregatedItem[]; // resolved cluster members
  now: Date;
  profile: WeightProfile;
}

// ---------------------------------------------------------------------------
// Pure transforms — the finalized model's formulas (deterministic, tested).
// ---------------------------------------------------------------------------

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** C — corroboration from independent-owner count: min(1, ln(1+n)/ln(1+C_sat)). */
export function corroborationScore(ownerCount: number, profile: WeightProfile): number {
  const n = Math.max(0, ownerCount);
  if (n <= 0) return 0;
  return Math.min(1, Math.log(1 + n) / Math.log(1 + profile.corroborationSaturation));
}

/** Credibility value of one source tier (maps aggregator taxonomy → model tier). */
export function tierValue(tier: SourceTier, profile: WeightProfile): number {
  const credibility: CredibilityTier = profile.sourceTier.rankByTaxonomy[tier];
  return profile.sourceTier.values[credibility];
}

/** S — source tier: maxWeight·maxTier + meanWeight·meanTier over the cluster. */
export function sourceTierBlend(maxTier: number, meanTier: number, profile: WeightProfile): number {
  const { maxWeight, meanWeight } = profile.sourceTier;
  return clamp(maxWeight * maxTier + meanWeight * meanTier, 0, 1);
}

/** Significance-scaled recency half-life in hours: H(T) = hMin + hSpan·T. */
export function recencyHalfLifeHours(technicalSignificance: number, profile: WeightProfile): number {
  const t = clamp(technicalSignificance, 0, 1);
  return profile.recency.hMinHours + profile.recency.hSpanHours * t;
}

/** Recency(t) = 0.5^(t / H). t and H in hours; returns (0, 1]. */
export function recencyDecay(ageHours: number, halfLifeHours: number): number {
  const t = Math.max(0, ageHours);
  if (halfLifeHours <= 0) return t === 0 ? 1 : 0;
  return Math.pow(0.5, t / halfLifeHours);
}

/** Diversity multiplier from a normalized owner/type-entropy term in [0,1]. */
export function diversityMultiplier(normalizedDiversity: number, profile: WeightProfile): number {
  const { floor, ceil, slope } = profile.diversity;
  return clamp(floor + slope * clamp(normalizedDiversity, 0, 1), floor, ceil);
}

/** E — engagement: capped per-platform velocities, averaged, clamped to [0,1]. */
export function engagementScore(
  velocityByPlatform: Record<string, number>,
  profile: WeightProfile,
): number {
  const entries = Object.entries(velocityByPlatform);
  if (entries.length === 0) return 0; // no data → other signals carry the topic
  let sum = 0;
  let count = 0;
  for (const [platform, velocity] of entries) {
    const cap = profile.engagement.platformCaps[platform] ?? 1;
    sum += Math.min(cap, Math.max(0, velocity));
    count += 1;
  }
  return count === 0 ? 0 : Math.min(1, sum / count);
}

/** Hours between a timestamp and `now` (never negative). */
export function ageHoursSince(isoTimestamp: string, now: Date): number {
  const then = new Date(isoTimestamp).valueOf();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, (now.valueOf() - then) / 3_600_000);
}

// ---------------------------------------------------------------------------
// Extraction from contract data (implemented where the data is available).
// ---------------------------------------------------------------------------

/**
 * S — source tier signal, computed from the cluster's `tierHistogram`
 * (distinct-source counts per tier). Real, deterministic, no registry needed.
 */
export function sourceTierSignal(input: SignalInputs): number {
  const { cluster, profile } = input;
  let maxTier = 0;
  let weightedSum = 0;
  let total = 0;
  for (const [tier, rawCount] of Object.entries(cluster.tierHistogram)) {
    const count = rawCount ?? 0;
    if (count <= 0) continue;
    const value = tierValue(tier as SourceTier, profile);
    maxTier = Math.max(maxTier, value);
    weightedSum += value * count;
    total += count;
  }
  if (total === 0) return 0;
  return sourceTierBlend(maxTier, weightedSum / total, profile);
}

// ---------------------------------------------------------------------------
// Extraction requiring registries / heuristics — tracked as issues (stubs).
// ---------------------------------------------------------------------------

/**
 * n — count of distinct independent OWNERS (registrable domain + ownership map),
 * tier ≥ `corroborationMinTier`. Syndicated copies / self-citation collapse to
 * one owner. Needs the source-ownership registry.
 */
export function countIndependentOwners(_input: SignalInputs): number {
  throw new Error('not implemented: dedup members by registrable domain + ownership map');
}

/**
 * T — technical significance from extracted metadata: CVE severity (KEV/CVSS/EPSS),
 * semver/release type, standard/spec change, press release, +0.1 AI/platform lean.
 * Take the max matched rule, add bonuses, clamp [0,1].
 */
export function technicalSignificanceSignal(_input: SignalInputs): number {
  throw new Error('not implemented: CVE/semver/release rules over extracted metadata');
}

/** Normalized owner/type entropy feeding the diversity multiplier. */
export function ownerDiversity(_input: SignalInputs): number {
  throw new Error('not implemented: normalized entropy of owner distribution × #source-types');
}

/** Per-platform velocity (delta over window ÷ rolling baseline) for engagement. */
export function platformVelocities(_input: SignalInputs): Record<string, number> {
  throw new Error('not implemented: needs rolling per-platform baselines (HN/GitHub/Reddit)');
}

/** C — corroboration signal (composes owner count + the pure curve). */
export function corroborationSignal(input: SignalInputs): number {
  return corroborationScore(countIndependentOwners(input), input.profile);
}

/** E — engagement signal (composes velocities + caps). */
export function engagementSignal(input: SignalInputs): number {
  return engagementScore(platformVelocities(input), input.profile);
}
