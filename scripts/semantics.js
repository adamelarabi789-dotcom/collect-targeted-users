'use strict';
/**
 * semantics.js — config-driven bucketing helper for the `collect-targeted-users`
 * skill (used by Phase 1 only).
 *
 * WHY THIS EXISTS
 * ---------------
 * Keyword matching is a *routing hint*, not a gate. A profile can clearly belong
 * to a bucket without ever naming it. So Phase 1 (scan-candidates.js) calls
 * scoreSemantics() to attach a PROVISIONAL bucket + confidence to every
 * metric-qualified profile. That label is only a hint - there is no AI gate and
 * no separate decision file: the collected user is written straight to the
 * Sheet.
 *
 * NO NICHE IS HARD-CODED. The lexicon comes from `config.json`
 * (`classification.buckets.<KEY>.roleTerms / strongTerms / weakTerms`) or from
 * the per-bucket `search.keywords` as a fallback. If nothing is configured the
 * scorer returns a null bucket and the caller falls back to the source seed's
 * bucket tag.
 *
 * ROLE TERMS BEAT DOMAIN TERMS
 * ----------------------------
 * A weighted aggregate alone can mis-bucket a profile that merely mentions
 * another bucket's domain. The scorer therefore tracks ROLE terms (weight
 * `classification.roleWeight`, default 3) separately from DOMAIN terms and lets
 * a decisive role on one side win outright. Domain terms still break ties.
 *
 * The scorer is deliberately cheap and deterministic (no network).
 */
const config = require('./config');

let ACTIVE = null;

/** Flatten [weight, terms] lists into [term, weight] pairs, longest first. */
function buildTerms(lists) {
  const out = [];
  for (const [weight, terms] of lists || []) {
    for (const t of terms || []) {
      const term = String(t == null ? '' : t).trim().toLowerCase();
      if (term && !config.isPlaceholder(term)) out.push([term, weight]);
    }
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

/**
 * Build the active lexicon from a config object. Exposed so callers (and tests)
 * can reconfigure explicitly instead of relying on the cached config.
 */
function configure(cfg = config.get()) {
  const cls = (cfg && cfg.classification) || {};
  const roleWeight = Number.isFinite(Number(cls.roleWeight)) ? Number(cls.roleWeight) : 3;
  const buckets = cls.buckets || {};
  const keywords = (cfg && cfg.search && cfg.search.keywords) || {};
  const keys = Object.keys(buckets);

  const terms = {};
  const names = {};
  for (const key of keys) {
    const spec = buckets[key] || {};
    const fallback = Array.isArray(keywords[key]) ? keywords[key] : [];
    const weak = [...(spec.weakTerms || []), ...fallback];
    terms[key] = buildTerms([
      [roleWeight, spec.roleTerms || []],
      [2, spec.strongTerms || []],
      [1, weak],
    ]);
    names[key] = spec.name || key;
  }
  ACTIVE = { roleWeight, keys, terms, names };
  return ACTIVE;
}

function active() {
  if (!ACTIVE) configure();
  return ACTIVE;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary-aware contains: a multi-word / punctuated term is matched as a
 * substring, a plain token must stand on its own (so "ai" never matches "aim").
 */
function hasTerm(text, term) {
  if (!term) return false;
  const t = String(text).toLowerCase();
  if (term.includes(' ') || /[^a-z0-9]/.test(term)) return t.includes(term.toLowerCase());
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`).test(t);
}

/**
 * Sum weighted term hits for one bucket's lexicon, keeping ROLE terms
 * (weight >= roleWeight) separate from domain terms so a decisive role can win
 * outright.
 */
function scoreSide(text, terms, roleWeight) {
  let score = 0;
  let roleScore = 0;
  const hits = [];
  const roleHits = [];
  for (const [term, weight] of terms) {
    if (hasTerm(text, term)) {
      score += weight;
      hits.push(term);
      if (weight >= roleWeight) { roleScore += weight; roleHits.push(term); }
    }
  }
  return { score, roleScore, hits, roleHits };
}

/**
 * Score a profile's display name + username + bio + recent posts against every
 * configured bucket and return a PROVISIONAL routing hint.
 *
 * Decision order:
 *   1. the side with the stronger ROLE score wins,
 *   2. otherwise the higher aggregate domain score wins,
 *   3. a tie leaves the bucket null.
 *
 * @param {{displayName?:string, username?:string, bio?:string, recentPosts?:string}} profile
 * @returns {{
 *   bucket: string|null,
 *   confidence: 'high'|'medium'|'low'|'none',
 *   scores: Record<string, number>,
 *   roleScores: Record<string, number>,
 *   terms: Record<string, string[]>,
 *   roleTerms: Record<string, string[]>,
 *   allTerms: string[]
 * }}
 */
function scoreSemantics(profile = {}) {
  const a = active();
  const text = [
    profile.displayName || '',
    profile.username || '',
    profile.bio || '',
    profile.recentPosts || '',
  ]
    .join(' \n ')
    .toLowerCase();

  const scores = {};
  const roleScores = {};
  const termHits = {};
  const roleHits = {};
  for (const key of a.keys) {
    const side = scoreSide(text, a.terms[key], a.roleWeight);
    scores[key] = side.score;
    roleScores[key] = side.roleScore;
    termHits[key] = side.hits;
    roleHits[key] = side.roleHits;
  }

  const allTerms = [...new Set(a.keys.flatMap((k) => termHits[k]))];

  // No lexicon configured -> nothing to route on.
  if (!a.keys.length || allTerms.length === 0) {
    return { bucket: null, confidence: 'none', scores, roleScores, terms: termHits, roleTerms: roleHits, allTerms };
  }

  const ranked = a.keys
    .map((k) => ({ key: k, score: scores[k], roleScore: roleScores[k] }))
    .sort((x, y) => y.roleScore - x.roleScore || y.score - x.score);
  const top = ranked[0];
  const second = ranked[1] || { roleScore: 0, score: 0 };

  let bucket = null;
  if (top.roleScore > second.roleScore) bucket = top.key;
  else if (top.roleScore === second.roleScore && top.score > second.score) bucket = top.key;

  const best = top.score;
  let confidence = 'none';
  if (bucket) {
    if (top.roleScore > 0 && top.roleScore > second.roleScore) confidence = 'high';
    else if (best >= 4) confidence = 'high';
    else if (best >= 2) confidence = 'medium';
    else confidence = 'low';
  }

  return { bucket, confidence, scores, roleScores, terms: termHits, roleTerms: roleHits, allTerms };
}

/** True when a scored profile is safe to count toward a bucket quota. */
function isCountable(score) {
  return !!score && !!score.bucket && score.confidence !== 'none';
}

/** Numeric score of a scored profile for ONE bucket (deterministic ordering). */
function scoreForBucket(score, bucket) {
  if (!score) return 0;
  const b = String(bucket || '').toUpperCase();
  const role = (score.roleScores && score.roleScores[b]) || 0;
  const total = (score.scores && score.scores[b]) || 0;
  return role * 100 + total;
}

/**
 * Compact payload of the profile fields an LLM needs to judge context/intent.
 * Used to hand candidates to an AI (and to emit a review bundle).
 */
function buildValidationPayload(candidates = []) {
  return candidates.map((c) => ({
    username: c.username,
    displayName: c.displayName,
    followers: c.followers === '' || c.followers == null ? null : Number(c.followers),
    bucketHint: c.bucketHint || null,
    bucketConfidence: c.bucketConfidence || null,
    postsLast7Days: c.postsLast7Days === '' || c.postsLast7Days == null ? null : Number(c.postsLast7Days),
    daysSinceLastPost: c.daysSinceLastPost === '' || c.daysSinceLastPost == null ? null : Number(c.daysSinceLastPost),
    bio: c.bio || '',
    recentPosts: c.recentPosts || '',
  }));
}

/**
 * Check an optional AI decision set against the candidate pool.
 * @returns {{
 *   decided: Set<string>, undecided: string[],
 *   invalid: Array<object>, fitTrue: number, fitFalse: number,
 *   reBucketed: Array<{username:string, from:any, to:string}>
 * }}
 */
function validateDecisions(decisions = [], candidates = []) {
  const byUser = new Map();
  for (const c of candidates) byUser.set(String(c.username || '').toLowerCase(), c);

  const validBuckets = new Set(active().keys.map((k) => k.toUpperCase()));
  const decided = new Set();
  const invalid = [];
  const reBucketed = [];
  let fitTrue = 0;
  let fitFalse = 0;

  for (const d of decisions) {
    const user = String((d && d.username) || '').toLowerCase();
    if (!user) { invalid.push({ decision: d, error: 'missing username' }); continue; }
    decided.add(user);
    const bucket = String((d && d.bucket) || '').toUpperCase();
    if (d && d.fit === false) { fitFalse++; continue; }
    if (!validBuckets.has(bucket)) {
      invalid.push({ decision: d, error: `invalid bucket "${d && d.bucket}" (use ${[...validBuckets].join('|')} or fit:false)` });
      continue;
    }
    fitTrue++;
    const c = byUser.get(user);
    const hint = c ? String(c.bucketHint || '').toUpperCase() : '';
    if (hint && hint !== bucket) reBucketed.push({ username: d.username, from: hint, to: bucket });
  }

  const undecided = [];
  for (const [user, c] of byUser) if (!decided.has(user)) undecided.push(c.username || user);

  return { decided, undecided, invalid, fitTrue, fitFalse, reBucketed };
}

module.exports = {
  configure,
  buildTerms,
  hasTerm,
  scoreSemantics,
  scoreForBucket,
  isCountable,
  buildValidationPayload,
  validateDecisions,
};
