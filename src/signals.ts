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
import type { WeightProfile, CredibilityTier } from './weights.ts';

export interface SignalInputs {
  cluster: Cluster;
  members: AggregatedItem[]; // resolved cluster members
  /** Rev 3: facts extracted by the aggregator for this cluster. */
  facts?: ExtractedFact[];
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
  // Cast to allow partial-record lookup: upstream JSON may carry unknown tier strings.
  // Unknown tiers clamp to T4 (lowest credibility) rather than silently emitting NaN.
  const rankMap = profile.sourceTier.rankByTaxonomy as Partial<Record<string, CredibilityTier>>;
  const credibility = rankMap[tier] ?? 'T4';
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

/**
 * Neutral floor age used when a timestamp is absent or invalid.
 * Returning 0 would give recencyDecay(0, H) = 1.0 (max), which is misleading
 * for a cluster whose publication time is unknown.  24 h is a documented
 * conservative midpoint that does not unfairly penalise or boost such clusters.
 */
export const NEUTRAL_AGE_HOURS = 24;

/** Hours between a timestamp and `now` (never negative).
 *
 * Returns NEUTRAL_AGE_HOURS when the timestamp is absent or invalid so that
 * missing/bad timestamps do not receive the maximum recency score (1.0).
 */
export function ageHoursSince(isoTimestamp: string | undefined | null, now: Date): number {
  if (!isoTimestamp) return NEUTRAL_AGE_HOURS;
  const then = new Date(isoTimestamp).valueOf();
  if (!Number.isFinite(then)) return NEUTRAL_AGE_HOURS;
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
// Tier helpers — needed by extraction and by the orchestration layer.
// ---------------------------------------------------------------------------

/** True if the cluster has at least one Tier-1 primary source. */
export function hasTier1Primary(cluster: Cluster, profile: WeightProfile): boolean {
  for (const [tier, count] of Object.entries(cluster.tierHistogram)) {
    if ((count ?? 0) > 0 && profile.sourceTier.rankByTaxonomy[tier as SourceTier] === 'T1') {
      return true;
    }
  }
  return false;
}

/** Highest credibility value present in the cluster's tier histogram. */
export function maxTierValue(cluster: Cluster, profile: WeightProfile): number {
  let max = 0;
  for (const [tier, count] of Object.entries(cluster.tierHistogram)) {
    if ((count ?? 0) > 0) {
      max = Math.max(max, tierValue(tier as SourceTier, profile));
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Technical significance — rule table over title/summaryHint text (§4, Table T).
//
// Noise floor is 0.20 (unclassified content).  Rules are applied to a
// concatenated corpus of the cluster headline + all member titles/summaryHints.
// The highest matched rule wins; an AI/platform-engineering lean adds +0.1.
// ---------------------------------------------------------------------------

interface SignificanceRule {
  readonly pattern: RegExp;
  readonly value: number;
}

const SIGNIFICANCE_RULES: readonly SignificanceRule[] = [
  // Actively exploited / CISA KEV — highest urgency
  { pattern: /\b(exploited[\s-]+in[\s-]+the[\s-]+wild|zero[\s-]?day|0day|cisa[\s-]+kev|actively[\s-]+exploited)\b/i, value: 0.95 },
  // Critical severity CVE or RCE
  { pattern: /\b(cvss[\s:]*(?:10|9[.\d]*)|critical[\s-]+(?:severity|vulnerability|cve|flaw|rce|exploit)|remote[\s-]+code[\s-]+execution)\b/i, value: 0.90 },
  // High severity CVE / privilege escalation / auth bypass
  { pattern: /\b(cvss[\s:]*[78][.\d]*|high[\s-]+(?:severity|cvss|risk)|privilege[\s-]+escalation|auth(?:entication)?[\s-]+bypass)\b/i, value: 0.75 },
  // Major version release — explicit "v" prefix (v2.0, v3.0.0)
  { pattern: /\bv([1-9]\d*)\.0(?:\.0)?(?:[^\d.]|$)/i, value: 0.80 },
  // Major version release — number + context word (2.0 release, 3.0 available)
  { pattern: /\b([1-9]\d*)\.0(?:\.0)?\s+(?:release[sd]?|launch(?:es|ed)?|stable|available|ships?|arrived?)\b/i, value: 0.80 },
  // Standards / specification change
  { pattern: /\b(rfc[\s-]*\d{4}|w3c[\s-]+(?:spec|standard|recommendation)|ietf[\s-]+(?:standard|rfc)|ecmascript[\s-]*\d+|tc39|ieee[\s-]+\d|owasp[\s-]+top)\b/i, value: 0.78 },
  // General availability / stable release
  { pattern: /\b(generally[\s-]+available|general[\s-]+availability|stable[\s-]+release|production[\s-]+ready|\bga\s+release\b)\b/i, value: 0.72 },
  // Any explicit CVE identifier
  { pattern: /\bcve-\d{4}-\d+\b/i, value: 0.65 },
  // New open-source project / major announcement
  { pattern: /\b(open[\s-]+source[sd]?|introduces?[\s-]+new|unveils?|announces?[\s-]+(?:new|open)|debuts?)\b/i, value: 0.65 },
  // Medium severity CVE
  { pattern: /\b(cvss[\s:]*[456][.\d]*|medium[\s-]+(?:severity|cvss))\b/i, value: 0.55 },
  // Deprecation / end-of-life
  { pattern: /\b(deprecated|end[\s-]+of[\s-]+(?:life|support|maintenance)|\beol\b|sunset|discontinue)\b/i, value: 0.55 },
  // Security advisory / patch
  { pattern: /\bsecurity[\s-]+(?:advisory|patch|update|fix|bulletin)\b/i, value: 0.55 },
  // Minor version — explicit "v" prefix (v1.2, v1.2.0)
  { pattern: /\bv\d+\.([1-9]\d*)(?:\.0)?(?:[^\d.]|$)/i, value: 0.60 },
  // Minor version — number + context word
  { pattern: /\b\d+\.([1-9]\d*)(?:\.0)?\s+(?:release[sd]?|update|available)\b/i, value: 0.60 },
  // Patch release — explicit "v" prefix (v1.2.3)
  { pattern: /\bv\d+\.\d+\.([1-9]\d*)(?:[^\d.]|$)/i, value: 0.40 },
  // Patch release — number + context word
  { pattern: /\b\d+\.\d+\.([1-9]\d*)\s+(?:patch|hotfix|release[sd]?|fix)\b/i, value: 0.40 },
  // Blog post / press release — lowers significance
  { pattern: /\b(press[\s-]+release|blog[\s-]+post|sponsored[\s-]+content)\b/i, value: 0.25 },
];

// Topics / keywords that attract the AI/platform-engineering significance bonus.
const AI_PLATFORM_PATTERN =
  /\b(generative[\s-]+ai|large[\s-]+language[\s-]+model|\bllm\b|foundation[\s-]+model|kubernetes|\bk8s\b|cloud[\s-]+native|platform[\s-]+engineering|opentelemetry|\bebpf\b|\bgpu\b|\bcuda\b|machine[\s-]+learning[\s-]+(?:model|framework)|deep[\s-]+learning|neural[\s-]+network|diffusion[\s-]+model|inference[\s-]+engine|fine[\s-]?tun)\b/i;

/** Build a lowercase search corpus from the cluster headline + all member texts. */
function buildCorpus(input: SignalInputs): string {
  const parts: string[] = [input.cluster.headline, input.cluster.topic, input.cluster.topicLabel];
  for (const m of input.members) {
    parts.push(m.title);
    if (m.summaryHint) parts.push(m.summaryHint);
  }
  return parts.join(' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Diversity — Shannon entropy of owner/type distribution.
// ---------------------------------------------------------------------------

type SourceCategory = 'official' | 'press' | 'academic';

function sourceCategory(tier: SourceTier): SourceCategory {
  if (tier === 'primary') return 'official';
  if (tier === 'paper') return 'academic';
  return 'press';
}

// ---------------------------------------------------------------------------
// Engagement baselines — documented placeholder values until rolling baselines
// are wired in from the aggregator. Tracked in the weight profile for a future
// profile field addition (see docs/spec.md §2.11).
// ---------------------------------------------------------------------------

/** Mentions-per-hour for a "moderately active" story — used to normalize velocity. */
const VELOCITY_BASELINE_PER_HOUR = 5.0;

// ---------------------------------------------------------------------------
// Extraction — implemented from contract data with documented fallbacks.
// ---------------------------------------------------------------------------

/**
 * Well-known two-part TLDs used by registrableDomain.
 *
 * This definition is MIRRORED verbatim in ardur-ranking-engine and
 * ardur-news-aggregator — edit both repos in lockstep.
 */
const KNOWN_TWO_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'co.nz', 'co.za', 'co.in', 'co.kr', 'co.id', 'co.il',
  'com.au', 'com.br', 'com.mx', 'com.ar', 'com.co', 'com.sg', 'com.hk', 'com.tw',
  'org.uk', 'net.au', 'net.nz', 'ac.uk', 'gov.uk', 'edu.au', 'edu.sg',
]);

/**
 * Reduce a raw hostname to its registrable domain (eTLD+1 heuristic).
 *
 * Handles the most common two-part TLDs (co.uk, com.au, etc.) without
 * requiring a Public Suffix List dependency.  Subdomains of the same
 * publisher collapse to one key so they can't inflate corroboration.
 *
 * This definition is MIRRORED verbatim in ardur-ranking-engine and
 * ardur-news-aggregator — edit both repos in lockstep.
 */
function registrableDomain(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const last2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (KNOWN_TWO_PART_TLDS.has(last2) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${last2}`;
  }
  return last2;
}

/**
 * Normalize a raw sourceDomain string for owner-dedup (CWE-20 defence).
 *
 * Strips userinfo (`user@`), port (`:8080`), and the `www.` prefix, then
 * lowercases and reduces to the registrable domain (eTLD+1) so that
 * subdomains of the same publisher (news.example.com, blog.example.com)
 * collapse to a single key and cannot inflate corroboration.
 */
export function normalizeOwnerDomain(domain: string): string {
  let d = domain.toLowerCase().trim();
  // Strip userinfo (e.g. "cdn@example.com" → "example.com")
  const atIdx = d.lastIndexOf('@');
  if (atIdx >= 0) d = d.slice(atIdx + 1);
  // Strip port (e.g. "example.com:8080" → "example.com")
  const colonIdx = d.lastIndexOf(':');
  if (colonIdx >= 0) d = d.slice(0, colonIdx);
  // Strip www. prefix (e.g. "www.example.com" → "example.com")
  if (d.startsWith('www.')) d = d.slice(4);
  return registrableDomain(d);  // collapse subdomains to eTLD+1
}

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
export function countIndependentOwners(input: SignalInputs): number {
  const { cluster, members, profile } = input;
  if (members.length === 0) {
    return cluster.distinctDomains;
  }
  const minValue = profile.sourceTier.values[profile.corroborationMinTier];
  const ownerDomains = new Set<string>();
  for (const m of members) {
    if (tierValue(m.tier, profile) >= minValue) {
      ownerDomains.add(normalizeOwnerDomain(m.sourceDomain));
    }
  }
  return ownerDomains.size;
}

/**
 * T — technical significance from rule matching over member title/summaryHint
 * text (§4 table T).  Take the max matched rule value, add the AI/platform lean
 * bonus from the weight profile, clamp to [0, 1].
 *
 * Default noise floor is 0.20 (unclassified content that still carries some
 * signal due to source-tier and corroboration filtering upstream).
 */
export function technicalSignificanceSignal(input: SignalInputs): number {
  const corpus = buildCorpus(input);
  let maxValue = 0.20;
  for (const rule of SIGNIFICANCE_RULES) {
    if (rule.pattern.test(corpus)) {
      maxValue = Math.max(maxValue, rule.value);
    }
  }
  if (AI_PLATFORM_PATTERN.test(corpus)) {
    maxValue = Math.min(1, maxValue + input.profile.aiPlatformSignificanceBonus);
  }
  return clamp(maxValue, 0, 1);
}

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
export function ownerDiversity(input: SignalInputs): number {
  const { members } = input;
  if (members.length === 0) {
    // No member data — fall back to a conservative estimate from distinctDomains.
    const n = input.cluster.distinctDomains;
    return n <= 1 ? 0 : Math.min(1, (n - 1) / 7);
  }

  // Count items per normalized domain and collect categories (#16: strip userinfo/port/www).
  const domainCounts = new Map<string, number>();
  const categories = new Set<SourceCategory>();
  for (const m of members) {
    const domain = normalizeOwnerDomain(m.sourceDomain);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    categories.add(sourceCategory(m.tier));
  }

  if (domainCounts.size <= 1) return 0; // Single owner → echo penalty

  // Shannon entropy over domain distribution.
  const total = members.length;
  let entropy = 0;
  for (const count of domainCounts.values()) {
    const p = count / total;
    entropy -= p * Math.log(p);
  }
  const maxEntropy = Math.log(domainCounts.size);
  const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

  // Source-type diversity factor: 3 categories = max bonus.
  const typeFactor = categories.size / 3;

  return clamp(normalizedEntropy * typeFactor, 0, 1);
}

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
export function platformVelocities(input: SignalInputs): Record<string, number> {
  const { members } = input;
  let totalVelocity = 0;
  let hasVelocity = false;

  for (const m of members) {
    if (m.interaction.velocity != null && m.interaction.velocity > 0) {
      totalVelocity += m.interaction.velocity;
      hasVelocity = true;
    }
  }

  if (hasVelocity) {
    return { feed: totalVelocity / VELOCITY_BASELINE_PER_HOUR };
  }

  // Fallback: take the max crossSourceMentions across members as a proxy.
  let maxMentions = 0;
  for (const m of members) {
    maxMentions = Math.max(maxMentions, m.interaction.crossSourceMentions);
  }
  if (maxMentions > 0) {
    return { feed: maxMentions / VELOCITY_BASELINE_PER_HOUR };
  }

  return {}; // No engagement data — 0 floor applied by engagementScore.
}

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
export function factCorroborationSignal(facts: ExtractedFact[], profile: WeightProfile): number {
  if (facts.length === 0) return 0;
  let sum = 0;
  for (const f of facts) {
    // #13: sanitize — NaN / Infinity / negative values must never reach the scorer.
    const raw = f.corroboration;
    const n = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    // #15/#18: apply log-saturation so a single owner (n=1) never reaches 1.0.
    sum += corroborationScore(n, profile);
  }
  // Mean is already in [0, 1] because corroborationScore is clamped to [0, 1].
  return sum / facts.length;
}

/**
 * C — corroboration signal.
 *
 * When Rev 3 facts are available, blends the domain-based estimate with the
 * fact-level signal: `max(domainBased, factLevel)`.  This guarantees a cluster
 * with corroborated facts always ranks ≥ an equal-domain cluster with no
 * agreeing facts — satisfying the R1 acceptance criterion — without ever
 * penalising a cluster that lacks extracted facts.
 */
export function corroborationSignal(input: SignalInputs): number {
  const domainBased = corroborationScore(countIndependentOwners(input), input.profile);
  const { facts } = input;
  if (!facts || facts.length === 0) return domainBased;
  const factLevel = factCorroborationSignal(facts, input.profile);
  return Math.max(domainBased, factLevel);
}

/** E — engagement signal (composes velocities + caps). */
export function engagementSignal(input: SignalInputs): number {
  return engagementScore(platformVelocities(input), input.profile);
}
