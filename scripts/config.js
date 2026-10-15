'use strict';
/**
 * config.js — single source of runtime configuration for the collector.
 *
 * Resolution order (later wins):
 *   1. built-in DEFAULTS below (generic, no niche/industry terms),
 *   2. config.json at the repo root (or CONFIG_PATH),
 *   3. config.local.json at the repo root (git-ignored override),
 *   4. environment variables (X_* names documented in .env.example).
 *
 * Nothing niche-specific is hard-coded here: search queries, bucket names,
 * classification terms and criteria all come from the user's config file. If no
 * keywords/queries are configured the scanner stops with a clear message.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  // --- What to search for -------------------------------------------------
  search: {
    // Per-bucket niche keywords. Queries are auto-generated from these when
    // search.queries is empty. Prefer editing config.json (or set the
    // X_NICHE_KEYWORDS / X_KEYWORDS_A / X_KEYWORDS_B env vars).
    keywords: { A: [], B: [] },
    // Optional explicit Boolean queries: [{ "bucket": "A", "query": "..." }].
    queries: [],
    // Optional expansion seeds used after the base pool runs dry.
    expansionQueries: [],
    // Appended to every auto-generated keyword query.
    querySuffix: '-filter:replies',
    // Optional flat keyword list file (one term per bullet line).
    keywordsFile: 'references/keywords.md',
  },

  // --- Machine-verifiable account criteria --------------------------------
  criteria: {
    target: 20, // COLLECTION_BATCH_SIZE: NEW unique users per run
    maxFollowers: 40000, // MAX_FOLLOWERS (exclusive ceiling)
    minPosts30d: 8, // MIN_POST_FREQUENCY: min posts in the activity window
    minPosts30dFloor: 4, // relaxed floor used when the run falls behind pace
    relax: true,
    relaxBelowPct: 0.6,
    activityWindowDays: 30,
    activityScrolls: 2,
    activityMaxPosts: 40,
    maxLastPostDays: 7, // newest post must be within this many days
    postsPerProfile: 4,
    maxScrollsPerSeed: 16,
    maxAuthorsPerSeed: 24,
    maxProfiles: 200,
    maxMinutes: 20,
    expandRounds: 3,
    concurrency: 5,
    prefilter: true,
    jitterSecs: [1.0, 3.0],
    cooldownEvery: 12,
    cooldownSecs: [15, 35],
  },

  // --- A/B labelling lexicon (hint only; never gates the run) -------------
  classification: {
    roleWeight: 3,
    buckets: {
      A: { name: 'Bucket A', roleTerms: [], strongTerms: [], weakTerms: [] },
      B: { name: 'Bucket B', roleTerms: [], strongTerms: [], weakTerms: [] },
    },
  },

  // --- Integrity filter (reject synthetic fixtures) ----------------------
  integrity: {
    placeholderBios: [],
    placeholderFollowers: 100,
  },

  // --- Output sink --------------------------------------------------------
  export: {
    mode: 'auto', // auto | sheets | webapp | csv
    spreadsheetId: '',
    sheetName: 'Targets',
    webAppUrl: '',
    tokenPath: '',
    localCsv: '',
  },
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively merge `over` onto a copy of `base` (arrays are replaced). */
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(over || {})) {
    const b = out[key];
    const o = over[key];
    out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o) : o;
  }
  return out;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function splitList(v) {
  return String(v == null ? '' : v)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True for template placeholders like [INSERT_ROLE_TERMS_A] or YOUR_SPREADSHEET_ID. */
function isPlaceholder(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\[.*\]$/.test(s) || /\b(?:INSERT|YOUR)_[A-Z0-9_]*/i.test(s);
}

/** Drop placeholder tokens so a freshly copied template never runs literally. */
function sanitize(cfg) {
  const s = cfg.search;
  for (const key of Object.keys(s.keywords || {})) {
    s.keywords[key] = (s.keywords[key] || []).filter((k) => !isPlaceholder(k));
  }
  const buckets = (cfg.classification && cfg.classification.buckets) || {};
  for (const key of Object.keys(buckets)) {
    const b = buckets[key] || {};
    for (const field of ['roleTerms', 'strongTerms', 'weakTerms']) {
      if (Array.isArray(b[field])) b[field] = b[field].filter((t) => !isPlaceholder(t));
    }
  }
  if (cfg.export && isPlaceholder(cfg.export.spreadsheetId)) cfg.export.spreadsheetId = '';
  if (cfg.export && isPlaceholder(cfg.export.webAppUrl)) cfg.export.webAppUrl = '';
  return cfg;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Config file candidates, in increasing precedence. */
function configFiles() {
  const files = [];
  if (process.env.CONFIG_PATH) {
    files.push(path.resolve(process.env.CONFIG_PATH));
  } else {
    files.push(path.join(process.cwd(), 'config.json'));
    const rootCfg = path.join(ROOT, 'config.json');
    if (!files.includes(rootCfg)) files.push(rootCfg);
  }
  files.push(path.join(ROOT, 'config.local.json'));
  return files;
}

/** Apply X_* environment overrides on top of the merged config object. */
function applyEnv(cfg) {
  const env = process.env;
  const c = cfg.criteria;
  const e = cfg.export;
  const s = cfg.search;

  if (env.X_TARGET != null) c.target = num(env.X_TARGET, c.target);
  if (env.X_MAX_FOLLOWERS != null) c.maxFollowers = num(env.X_MAX_FOLLOWERS, c.maxFollowers);
  if (env.X_MIN_POSTS_30D != null) c.minPosts30d = num(env.X_MIN_POSTS_30D, c.minPosts30d);
  if (env.X_MIN_POSTS_30D_FLOOR != null) c.minPosts30dFloor = num(env.X_MIN_POSTS_30D_FLOOR, c.minPosts30dFloor);
  if (env.X_ACTIVITY_WINDOW_DAYS != null) c.activityWindowDays = num(env.X_ACTIVITY_WINDOW_DAYS, c.activityWindowDays);
  if (env.X_MAX_LAST_POST_DAYS != null) c.maxLastPostDays = num(env.X_MAX_LAST_POST_DAYS, c.maxLastPostDays);
  if (env.X_CONCURRENCY != null) c.concurrency = num(env.X_CONCURRENCY, c.concurrency);
  if (env.X_MAX_PROFILES != null) c.maxProfiles = num(env.X_MAX_PROFILES, c.maxProfiles);
  if (env.X_MAX_MINUTES != null) c.maxMinutes = num(env.X_MAX_MINUTES, c.maxMinutes);
  if (env.X_EXPAND_ROUNDS != null) c.expandRounds = num(env.X_EXPAND_ROUNDS, c.expandRounds);
  if (env.X_QUERY_SUFFIX != null) s.querySuffix = String(env.X_QUERY_SUFFIX);
  if (env.X_KEYWORDS_FILE != null) s.keywordsFile = String(env.X_KEYWORDS_FILE);

  // Niche keywords: one shared list, or per-bucket lists.
  const shared = splitList(env.X_NICHE_KEYWORDS);
  if (shared.length) {
    s.keywords = { ...s.keywords, A: shared.slice(), B: shared.slice() };
  }
  if (env.X_KEYWORDS_A != null) s.keywords.A = splitList(env.X_KEYWORDS_A);
  if (env.X_KEYWORDS_B != null) s.keywords.B = splitList(env.X_KEYWORDS_B);

  if (env.X_SHEET_ID != null) e.spreadsheetId = String(env.X_SHEET_ID).trim();
  if (env.X_SHEET_NAME != null) e.sheetName = String(env.X_SHEET_NAME).trim();
  if (env.X_GOOGLE_TOKEN_PATH != null) e.tokenPath = String(env.X_GOOGLE_TOKEN_PATH).trim();
  if (env.X_SHEET_WEBAPP_URL != null) e.webAppUrl = String(env.X_SHEET_WEBAPP_URL).trim();
  else if (env.GOOGLE_SHEETS_WEBAPP_URL != null) e.webAppUrl = String(env.GOOGLE_SHEETS_WEBAPP_URL).trim();
  if (env.X_LOCAL_CSV != null) e.localCsv = String(env.X_LOCAL_CSV).trim();

  return cfg;
}

/** Load, merge and return the effective configuration. */
function loadConfig() {
  let cfg = deepMerge(DEFAULTS, {});
  const used = [];
  for (const file of configFiles()) {
    const j = readJson(file);
    if (j) {
      cfg = deepMerge(cfg, j);
      used.push(file);
    }
  }
  cfg = applyEnv(cfg);
  sanitize(cfg);
  cfg._files = used;
  return cfg;
}

let CACHE = null;
/** Cached config for the current process (style: shared across modules). */
function get() {
  if (!CACHE) CACHE = loadConfig();
  return CACHE;
}

/** Build Boolean queries from per-bucket niche keywords (when none are set). */
function buildQueries(cfg = get()) {
  const explicit = (cfg.search && cfg.search.queries) || [];
  if (Array.isArray(explicit) && explicit.length) {
    return explicit.filter((q) => q && q.query);
  }
  const suffix = cfg.search.querySuffix == null ? '' : String(cfg.search.querySuffix);
  const out = [];
  for (const bucket of Object.keys(cfg.search.keywords || {})) {
    const kws = (cfg.search.keywords[bucket] || [])
      .map((k) => String(k).replace(/^"|"$/g, '').trim())
      .filter(Boolean);
    if (!kws.length) continue;
    const terms = kws.map((k) => (/\s/.test(k) ? `"${k}"` : k)).join(' OR ');
    out.push({ bucket, query: `(${terms})${suffix ? ' ' + suffix : ''}`.trim() });
  }
  return out;
}

/** Expansion seeds (explicit only; empty means "re-scroll the base pool"). */
function buildExpansionQueries(cfg = get()) {
  return ((cfg.search && cfg.search.expansionQueries) || []).filter((q) => q && q.query);
}

/** { A: 'Bucket A', B: 'Bucket B', ... } display names for the bucket column. */
function bucketNames(cfg = get()) {
  const buckets = (cfg.classification && cfg.classification.buckets) || {};
  const names = {};
  for (const key of Object.keys(buckets)) names[key] = (buckets[key] && buckets[key].name) || key;
  return names;
}

/** Bucket keys in config order (default: A, B). */
function bucketKeys(cfg = get()) {
  return Object.keys((cfg.classification && cfg.classification.buckets) || {});
}

module.exports = {
  ROOT,
  DEFAULTS,
  deepMerge,
  isPlaceholder,
  loadConfig,
  get,
  buildQueries,
  buildExpansionQueries,
  bucketNames,
  bucketKeys,
};
