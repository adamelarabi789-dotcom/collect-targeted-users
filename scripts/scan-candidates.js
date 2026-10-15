#!/usr/bin/env node
/**
 * scan-candidates.js — Phase 1 of the `collect-targeted-users` skill (FAST).
 *
 * Scans a rotating pool of high-yield X Boolean queries (built from the niche
 * keywords in config.json, treated as ONE unified pool) plus optional
 * hashtag/engagement entry points, gathers each author's profile metrics + bio +
 * recent posts, applies ONLY the machine-verifiable filters (follower ceiling +
 * recent activity + >=N posts/30d), de-dups each candidate against the Google
 * Sheet IN THE SAME parallel pass, and writes every survivor straight back to
 * the Sheet via the API. It keeps scanning (extra seeds, then deeper re-scrolls)
 * until the target of NEW unique users is reached.
 *
 * Storage: the Google Sheet is the only database. No candidates.csv /
 * targeted_users.csv / batch snapshot is written. Pass --local-csv <file> for
 * an optional CSV mirror (with lock-retry); the Sheet stays authoritative.
 *
 * Speed design:
 *   - a rotating pool of high-intent Boolean queries (from config.json keywords),
 *     plus optional hashtag/engagement entry points, with auto-expansion rounds
 *   - images/media/fonts/stylesheets blocked via Playwright route interception
 *   - SearchTimeline GraphQL payloads are parsed to PRE-FILTER obvious misses
 *     (follower ceiling / stale last post) so those profiles are never opened;
 *     the profile page is only visited to compute the 30-day activity count,
 *     which a search payload cannot provide
 *   - profile metrics are read from X's own GraphQL JSON responses
 *     (page.on('response')), with the DOM as a fallback
 *   - a concurrency-5 worker pool checks profiles on reused tabs with dynamic,
 *     response/selector-based waits instead of fixed sleeps
 *   - both buckets are scored in a single pass and the run exits as soon as the
 *     single-pool target of NEW users is reached
 *
 * There is intentionally NO rigid bio-keyword gate and NO Phase-2 AI gate.
 *
 * Usage:
 *   node scan-candidates.js [options]
 *
 * Core options:
 *   --bucket <A,B>            Only scan these buckets        (default all)
 *   --per-bucket <spec>       Quotas, e.g. A=10,B=10         (default A=10,B=10)
 *   --concurrency <n>         Parallel profile tabs          (default 5)
 *   --max-followers <n>       Follower ceiling, exclusive    (default 40000)
 *   --min-posts <n>           Min posts in the last 7 days   (default 4)
 *   --min-posts-30d <n>       Min posts in the last 30 days  (default 8)
 *   --min-posts-30d-floor <n> Relaxed 30d floor when behind  (default 4)
 *   --max-last-post-days <n>  Max age of newest post         (default 7)
 *   --max-scrolls-per-seed <n>   Scrolls per seed            (default 16)
 *   --max-authors-per-seed <n>   Authors queued per seed     (default 24)
 *   --max-profiles <n>        Global profile-check cap       (default 200)
 *   --max-minutes <n>         Hard safety cap (typical run: a few minutes) (default 20)
 *   --expand-rounds <n>       Auto-expansion rounds          (default 3)
 *   --local-csv <file>        Optional CSV mirror (Sheet is the DB)
 *   --refs <dir>              Dir with keywords.md
 *
 *   --no-block-media          Do not block images/media/fonts/stylesheets
 *   --no-graphql              Read profiles from the DOM only (skip JSON fast-path)
 *   --no-prefilter            Always open the profile (skip SearchTimeline pre-filter)
 *   --no-relax                Never lower the 30d threshold when behind pace
 *   --no-separator            Do not insert the solid-black separator row
 *   --no-format               Do not replicate the table styling (raw values)
 *   --fresh                   Ignore an existing --local-csv mirror
 *   --resume                  Count existing Sheet rows toward quota, then top up
 *   --dry-run                 Scan without writing anywhere
 *
 * Throttling (MANDATORY - built in, not optional extras):
 *   Human jitter is always on (default 1.0-3.0s/profile), a randomized
 *   cooldown rest runs after every 12 checks (15-35s), and a growing adaptive
 *   back-off pauses after consecutive failures / bot-block shells. Tune with:
 *   --stealth                 Preset: 1.5-3.5s jitter + cooldown every 25
 *   --jitter-secs <min-max>   Random delay before each profile (default 1.0-3.0)
 *   --cooldown-every <n>      Idle rest after every n profiles (default 12)
 *   --cooldown-secs <min-max> Rest window seconds (default 15-35)
 *   --no-jitter               Drop jitter to its safety floor (0.3-0.8s)
 *   -h, --help
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Load an optional local .env before any config is read at module load time.
require('./env').loadEnv();

// ---------------------------------------------------------------------------
// Locate the shared Playwright helpers. No hard-coded absolute paths - an
// explicit env override wins; otherwise use the bundled ./lib/twitter.js in
// this repo, and only then the conventional <home>/twitter-playwright install.
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJ =
  process.env.PROJ_ROOT ||
  process.env.TWITTER_PLAYWRIGHT_DIR ||
  (fs.existsSync(path.join(REPO_ROOT, 'lib', 'twitter.js'))
    ? REPO_ROOT
    : path.join(os.homedir(), 'twitter-playwright'));

let twitter;
try {
  twitter = require(path.join(PROJ, 'lib', 'twitter'));
} catch (err) {
  console.error(`Could not load Playwright helpers from ${path.join(PROJ, 'lib', 'twitter.js')}`);
  console.error(`  ${err.message}`);
  process.exit(1);
}
const { openX, ensureLoggedIn } = twitter;
// The Google Sheet is the single source of truth: its rows are read for
// de-duplication and each NEW user is written straight back to the Sheet via the
// API. No CSV database is written unless --local-csv is passed explicitly.
const { scoreSemantics } = require('./semantics');
const sheets = require('./sheets');
// All search terms, criteria and bucket labels come from config.json / env.
const config = require('./config');
// The strict 8-column output schema (shared with the Sheet sink + builder).
const { COLUMNS: SHEET_COLUMNS } = require('./columns');

const SKILL_ROOT = path.resolve(__dirname, '..');

// Effective configuration (config.json + config.local.json + X_* env vars).
const CONFIG = config.get();

// Bucket display names come from config.classification.buckets.<key>.name.
const BUCKET_NAMES = config.bucketNames(CONFIG);

// Block non-essential requests (images, media, fonts AND stylesheets) so pages
// hydrate in a fraction of the time. Disable with --no-block-media.
const BLOCK_GLOB =
  '**/*.{png,jpg,jpeg,gif,webp,avif,svg,ico,bmp,mp4,webm,mov,m4s,mp3,m4a,ogg,woff,woff2,ttf,otf,eot,css}';

// ---------------------------------------------------------------------------
// Query pool: a rotating set of high-intent Boolean queries, auto-generated
// from the per-bucket niche keywords in config.json (search.keywords) unless an
// explicit search.queries list is provided. Each query is scanned in turn; when
// one yields fewer than QUERY_ROTATE_MIN_NEW new unique candidates it is
// abandoned in favour of the next (see the rotation logic in main). Buckets are
// NOT assigned per query - every candidate is scored against both categories in
// one pass (see classifyCandidate); the tag only interleaves topics so no single
// theme starves the run.
// ---------------------------------------------------------------------------
const QUERY_ROTATE_MIN_NEW = 3;

const QUERY_POOL = config.buildQueries(CONFIG);

// Optional expansion seeds reserved for the expansion rounds: hashtag/engagement
// style queries (config.search.expansionQueries) that surface very different
// authors from the plain keyword searches above. Empty by default.
const EXTRA_QUERIES = config.buildExpansionQueries(CONFIG);

const q = (s) => `https://x.com/search?q=${encodeURIComponent(s)}&src=typed_query&f=live`;
const toSeeds = (pool) => pool.map((e) => ({ bucket: e.bucket, url: q(e.query), query: e.query }));

// Base seeds = the Boolean query pool; extra seeds = hashtag/engagement queries
// used only by the expansion rounds (see main).
const SEEDS = toSeeds(QUERY_POOL);
const EXTRA_SEEDS = toSeeds(EXTRA_QUERIES);

// ---------------------------------------------------------------------------
// Category evaluation — every candidate is scored against BOTH buckets in a
// single unified pass, which drives routing + early-exit quotas.
//
// Routing is delegated entirely to semantics.scoreSemantics(), which is driven
// by the config.json classification lexicon and lets a decisive ROLE term win
// over domain terms (so a profile that merely mentions another bucket's domain
// is not mis-bucketed). With no lexicon configured the hint is null and the
// source seed's bucket tag is used as the fallback.
// ---------------------------------------------------------------------------

/** Route a candidate to bucket A or B from its bio + recent posts (or null). */
function classifyCandidate(bio, posts, profile = {}) {
  const s = scoreSemantics({
    displayName: profile.displayName || '',
    username: profile.username || '',
    bio: bio || '',
    recentPosts: posts || '',
  });
  return s.bucket; // config-driven semantic hint (may be null); the seed tag is the fallback
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCount(text) {
  if (text == null) return null;
  const m = String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KkMm])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suffix = (m[2] || '').toLowerCase();
  if (suffix === 'k') n *= 1e3;
  if (suffix === 'm') n *= 1e6;
  return Math.round(n);
}

function cleanKeyword(s) {
  return String(s)
    .replace(/\[cite:\s*\d+\]/gi, '')
    .replace(/\*\*/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function expandKeywords(list) {
  const out = new Set();
  for (const item of list) {
    const whole = cleanKeyword(item);
    if (!whole) continue;
    out.add(whole);
    if (whole.includes('/')) {
      for (const part of whole.split('/')) {
        const t = cleanKeyword(part);
        if (t.length >= 2) out.add(t);
      }
    }
  }
  return [...out];
}

function hasKeyword(text, keywords) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return keywords.some((kw) => {
    const k = kw.toLowerCase().trim();
    if (k.length < 2) return false;
    if (k.includes(' ') || /[^a-z0-9]/.test(k)) return t.includes(k);
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(k)}([^a-z0-9]|$)`).test(t);
  });
}

function parseKeywordFile(text) {
  const bullets = [];
  const sections = { keywords: bullets, criteria: [] };
  let current = 'default';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^##\s+/.test(line)) {
      const h = line.toLowerCase();
      current = h.includes('filter') || h.includes('criteria') ? 'criteria' : 'default';
      continue;
    }
    if (current !== 'criteria' && /^[-*]\s+/.test(line)) {
      const kw = cleanKeyword(line.replace(/^[-*]\s+/, ''));
      if (kw && !config.isPlaceholder(kw)) bullets.push(kw);
    }
  }
  return sections;
}

function resolveRefs(explicitDir) {
  const dirs = [
    explicitDir,
    process.env.X_SKILL_REFS,
    path.join(SKILL_ROOT, 'references'),
    path.join(PROJ, 'references'),
    PROJ,
  ].filter(Boolean);
  const kwNames = ['keywords.md', 'Keywords.md', 'keywords.txt', 'Keywords.txt'];
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir);
      const kw = entries.find((f) => kwNames.includes(f));
      if (kw) return path.join(dir, kw);
    } catch {
      /* try next */
    }
  }
  return null;
}

function loadRelevanceKeywords(refsDir) {
  const file = resolveRefs(refsDir);
  if (!file) return { file: null, keywords: [] };
  const parsed = parseKeywordFile(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return {
    file,
    keywords: expandKeywords(parsed.keywords),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return /[",]/.test(s) ? `"${s}"` : s;
}

function toCsv(rows, headers = SHEET_COLUMNS) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((r) => r.length === headers.length).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function loadExisting(file) {
  try { return parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Candidate integrity (P3): reject synthetic fixtures before they are written,
// and purge any already sitting in the local mirror so they can never reach the
// Google Sheet through Phase 2.
// ---------------------------------------------------------------------------

/**
 * Bios used by known test-fixture rows that must never be collected. Empty by
 * default (config.integrity.placeholderBios); the duplicate-bio and invalid
 * timestamp rules below still run regardless.
 */
const PLACEHOLDER_BIOS = new Set(
  ((CONFIG.integrity && CONFIG.integrity.placeholderBios) || []).map((b) => normalizeBio(b))
);
/** Followers value that, paired with a placeholder bio, marks a fixture. */
const PLACEHOLDER_FOLLOWERS = Number((CONFIG.integrity && CONFIG.integrity.placeholderFollowers) || 100);

function normalizeBio(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function isValidIsoTimestamp(s) {
  if (!s) return false;
  return Number.isFinite(Date.parse(s));
}

/**
 * Split rows into {kept, rejected}:
 *   1. reject synthetic fixtures (placeholder bio + followers === 100),
 *   2. reject rows carrying an invalid collectedAt timestamp,
 *   3. reject clusters of different handles sharing one short identical bio.
 */
function pruneSuspects(rows) {
  const rejected = [];
  const stage1 = [];
  for (const r of rows || []) {
    const bio = normalizeBio(r && r.bio);
    const followers = Number(r && r.followers);
    if (PLACEHOLDER_BIOS.has(bio) && followers === PLACEHOLDER_FOLLOWERS) {
      rejected.push({ row: r, reason: 'synthetic placeholder (bio + followers=100)' });
      continue;
    }
    if (r && r.collectedAt && !isValidIsoTimestamp(r.collectedAt)) {
      rejected.push({ row: r, reason: 'invalid collectedAt timestamp' });
      continue;
    }
    stage1.push(r);
  }

  // Duplicate-bio clusters: two different handles sharing one short, identical
  // bio is a fixture signature, not a real coincidence.
  const byBio = new Map();
  for (const r of stage1) {
    const bio = normalizeBio(r && r.bio);
    if (!bio || bio.length > 80) continue;
    if (!byBio.has(bio)) byBio.set(bio, new Set());
    byBio.get(bio).add(String((r && r.username) || '').toLowerCase());
  }
  const duplicateBios = new Set(
    [...byBio.entries()].filter(([, users]) => users.size >= 2).map(([bio]) => bio)
  );

  const kept = [];
  for (const r of stage1) {
    const bio = normalizeBio(r && r.bio);
    if (bio && duplicateBios.has(bio)) {
      rejected.push({ row: r, reason: `duplicate bio cluster ("${bio.slice(0, 30)}")` });
      continue;
    }
    kept.push(r);
  }
  return { kept, rejected };
}

/** True when `row` looks synthetic given the already-collected `pool`. */
function rowIsSuspect(row, pool) {
  const { kept } = pruneSuspects([...(pool || []), row]);
  return !kept.includes(row);
}

// ---------------------------------------------------------------------------
// Page work
// ---------------------------------------------------------------------------
/** Read the author handle from a feed article (skips promoted posts). */
async function readAuthor(article) {
  try {
    const social = await article.$eval('[data-testid="socialContext"]', (el) => el.innerText).catch(() => '');
    if (/promoted|\bsponsored\b/i.test(social)) return null;
    return await article.evaluate((el) => {
      const block = el.querySelector('[data-testid="User-Name"]') || el;
      for (const link of block.querySelectorAll('a[href]')) {
        const h = link.getAttribute('href') || '';
        if (/^\/[A-Za-z0-9_]{1,15}$/.test(h)) return h.slice(1);
      }
      return null;
    });
  } catch {
    return null;
  }
}

/** Scroll a seed's feed and return its author handles (deduped via `seen`). */
async function collectAuthors(page, seed, opts, seen) {
  const authors = [];
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    await page.goto(seed.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    loaded = await page
      .waitForSelector('article[data-testid="tweet"]', { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    if (!loaded) {
      const wentWrong = await page
        .evaluate(() => /Something went wrong|Try reloading|rate limit/i.test(document.body.innerText))
        .catch(() => false);
      console.log(`  [seed retry ${attempt}/3] no results${wentWrong ? ' (X error page)' : ''} - reloading`);
      await sleep(1500 + attempt * 1500);
    }
  }
  if (!loaded) return authors;

  let scrolls = 0;
  while (scrolls < opts.maxScrollsPerSeed && authors.length < opts.maxAuthorsPerSeed) {
    const handles = await page
      .evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
          const social = a.querySelector('[data-testid="socialContext"]');
          if (social && /promoted|sponsored/i.test(social.innerText)) continue;
          const block = a.querySelector('[data-testid="User-Name"]') || a;
          for (const link of block.querySelectorAll('a[href]')) {
            const h = link.getAttribute('href') || '';
            if (/^\/[A-Za-z0-9_]{1,15}$/.test(h)) { out.push(h.slice(1)); break; }
          }
        }
        return out;
      })
      .catch(() => []);

    for (const u of handles) {
      const k = u.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      authors.push(u);
      if (authors.length >= opts.maxAuthorsPerSeed) break;
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * (1.8 + Math.random() * 0.7))).catch(() => {});
    await page.waitForTimeout(Math.round(opts.scrollWaitMs * (0.85 + Math.random() * 0.5)));
    scrolls++;
  }
  return authors;
}

/** Detect a Cloudflare/X challenge page or an empty 403 shell. */
async function detectShell(page) {
  try {
    return await page.evaluate(() => {
      const body = document.body;
      const text = (body && body.innerText || '').trim();
      return {
        short: text.length < 80,
        challenge:
          /checking your browser|just a moment|verify you are human|cf-chl|captcha|enable javascript and cookies|something went wrong|try reloading/i.test(
            text
          ),
      };
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GraphQL fast-path: X hydrates profiles from its own /i/api/graphql/... calls.
// We capture those JSON responses and read followers/bio/timestamps straight
// from the payloads instead of waiting on slow DOM renders and auto-scrolls.
// The DOM path below stays as a fallback whenever a payload is unavailable.
// ---------------------------------------------------------------------------
const GQL_RE = /\/i\/api\/graphql\/[^/]+\/([A-Za-z0-9_]+)/;
const GQL_SINKS = new WeakMap();

/** Attach a one-time response listener per page; returns its state. */
function attachGraphQL(page) {
  let state = GQL_SINKS.get(page);
  if (!state) {
    state = { gen: 0, items: [] };
    GQL_SINKS.set(page, state);
    page.on('response', (resp) => {
      let m;
      try { m = resp.url().match(GQL_RE); } catch { return; }
      if (!m) return;
      const op = m[1];
      if (!/^(UserByScreenName|UserByRestId|UserTweets|UserTweetsAndReplies)$/.test(op)) return;
      const gen = state.gen; // tag with the profile being read when it fired
      resp.json().then((json) => state.items.push({ gen, op, json })).catch(() => {});
    });
  }
  // New profile: bump the generation and drop stale payloads.
  state.gen += 1;
  state.items = state.items.filter((it) => it.gen === state.gen);
  return state;
}

/**
 * Normalise X's user object across BOTH API shapes:
 *   legacy shape:  { legacy: { screen_name, name, followers_count, description } }
 *   current shape: { core: { screen_name, name }, profile_bio: { description },
 *                    relationship_counts: { followers } }
 * Returns { username, displayName, followers, bio } or null.
 */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function extractUser(u) {
  if (!u || typeof u !== 'object') return null;
  const legacy = u.legacy || {};
  const core = u.core || {};
  const bioObj = u.profile_bio || {};
  const rel = u.relationship_counts || {};
  const username = core.screen_name || legacy.screen_name || null;
  const displayName = core.name || legacy.name || null;
  const followers = numOrNull(rel.followers) ?? numOrNull(legacy.followers_count);
  const description =
    bioObj.description != null ? bioObj.description
      : legacy.description != null ? legacy.description
        : null;
  if (!username && followers == null && description == null) return null;
  return { username, displayName, followers, bio: description };
}

/** Pull followers/bio/name out of a UserByScreenName|UserByRestId payload. */
function parseGqlUser(json) {
  const u = json && json.data && json.data.user && json.data.user.result;
  const ex = extractUser(u);
  if (!ex) return null;
  return { username: ex.username, displayName: ex.displayName, followers: ex.followers, bio: ex.bio || '' };
}

/** Pull created_at/full_text pairs out of a UserTweets|... payload. */
function parseGqlTweets(json) {
  const out = [];
  try {
    const instructions = json.data.user.result.timeline_v2.timeline.instructions || [];
    for (const ins of instructions) {
      for (const e of ins.entries || []) {
        const tr =
          e && e.content && e.content.itemContent &&
          e.content.itemContent.tweet_results && e.content.itemContent.tweet_results.result;
        const legacy = tr && (tr.legacy || (tr.tweet && tr.tweet.legacy));
        if (legacy && legacy.created_at) out.push({ createdAt: legacy.created_at, text: legacy.full_text || '' });
      }
    }
  } catch {
    /* shape changed - fall back to the DOM */
  }
  return out;
}

// ---------------------------------------------------------------------------
// SearchTimeline pre-filter (payload-only parsing).
// X's SearchTimeline payloads carry each tweet author's bio, follower count and
// tweet timestamp. We parse them while scrolling a seed so an obviously
// unqualified author (over the follower ceiling, or whose newest visible post is
// already too old) can be rejected WITHOUT opening their profile page.
//
// IMPORTANT: a search payload can never supply the >=N posts/30d activity count
// (that only exists on the author's own timeline), so a profile that survives
// the pre-filter is still opened once to measure its 30-day activity. The
// pre-filter therefore only removes wasted profile opens - it never replaces the
// activity gate.
// ---------------------------------------------------------------------------
const SEARCH_OP_RE = /\/i\/api\/graphql\/[^/]+\/(SearchTimeline|SearchTimelineTweets)\b/;
const SEARCH_SINKS = new WeakSet();

/** Merge every author found in a SearchTimeline payload into `index`. */
function parseGqlSearch(json, index) {
  try {
    const inst =
      (json.data.search_by_raw_query.search_timeline.timeline.instructions) || [];
    for (const ins of inst) {
      for (const e of ins.entries || []) {
        const res =
          e && e.content && e.content.itemContent &&
          e.content.itemContent.tweet_results && e.content.itemContent.tweet_results.result;
        if (!res) continue;
        const tweet = res.tweet || res; // some shapes nest the tweet one level down
        const legacy = tweet.legacy || {};
        const ex = extractUser(
          tweet.core && tweet.core.user_results && tweet.core.user_results.result
        );
        if (!ex || !ex.username) continue;
        const handle = ex.username;
        const key = String(handle).toLowerCase();
        const prev = index.get(key) || {};
        let lastPostMs = prev.lastPostMs ?? null;
        if (legacy.created_at) {
          const ms = Date.parse(legacy.created_at);
          if (!Number.isNaN(ms) && (lastPostMs == null || ms > lastPostMs)) lastPostMs = ms;
        }
        index.set(key, {
          username: handle,
          displayName: ex.displayName || prev.displayName || '',
          followers: ex.followers ?? prev.followers ?? null,
          bio: ex.bio != null ? ex.bio : prev.bio ?? '',
          lastPostMs,
        });
      }
    }
  } catch {
    /* shape changed - the pre-filter simply stays empty for this seed */
  }
}

/** Attach a one-time SearchTimeline listener to a seed-scanning page. */
function attachSearchIndex(page, index) {
  if (SEARCH_SINKS.has(page)) return;
  SEARCH_SINKS.add(page);
  page.on('response', (resp) => {
    let m;
    try { m = resp.url().match(SEARCH_OP_RE); } catch { return; }
    if (!m) return;
    resp.json().then((json) => parseGqlSearch(json, index)).catch(() => {});
  });
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Read one profile using a reused page (GraphQL fast-path + DOM fallback). */
async function gatherProfile(page, requested, opts) {
  try {
    // Capture this page's own GraphQL responses (generation-tagged per profile).
    const gqlState = opts.graphql !== false ? attachGraphQL(page) : null;
    const gqlItems = () => (gqlState ? gqlState.items.filter((it) => it.gen === gqlState.gen) : []);

    // Dynamic waits, set up BEFORE navigation so no payload is ever missed.
    const waitUser = opts.graphql !== false
      ? page
          .waitForResponse((r) => /\/i\/api\/graphql\/[^/]+\/UserByScreenName/.test(r.url()), { timeout: opts.profileTimeoutMs })
          .catch(() => null)
      : Promise.resolve(null);
    const waitTweets = opts.graphql !== false
      ? page
          .waitForResponse((r) => /\/i\/api\/graphql\/[^/]+\/UserTweets/.test(r.url()), { timeout: opts.tweetsTimeoutMs })
          .catch(() => null)
      : Promise.resolve(null);

    await page.goto(`https://x.com/${requested}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitUser;

    const waitForProfile = (ms) =>
      page
        .waitForSelector('[data-testid="UserName"]', { timeout: ms })
        .then(() => true)
        .catch(() => false);
    let ok = await waitForProfile(opts.profileTimeoutMs);
    if (!ok) {
      // X hydrates profiles slowly (often 5-8s). A "short" body alone is NOT a
      // bot-block - it is usually just a slow first render - so only bail out
      // immediately on an explicit challenge/login page, otherwise reload and
      // give the page a second, full-length chance to render.
      const shell = await detectShell(page);
      if (shell && shell.challenge) return { error: 'bot-block shell (X/Cloudflare)' };
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      ok = await waitForProfile(opts.profileTimeoutMs);
      if (!ok) {
        const shell2 = await detectShell(page);
        if (shell2 && (shell2.challenge || shell2.short)) return { error: 'bot-block shell (X/Cloudflare)' };
        return { error: 'profile did not render after reload' };
      }
    }
    await page.waitForSelector('a[href*="followers"]', { timeout: 3000 }).catch(() => {});

    // Timeline: dynamic selector wait, with a scroll nudge fallback.
    const waitForTweets = (ms) =>
      page
        .waitForSelector('article[data-testid="tweet"] time', { timeout: ms })
        .then(() => true)
        .catch(() => false);
    let hasTweets = await waitForTweets(opts.tweetsTimeoutMs);
    if (!hasTweets) {
      await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
      hasTweets = await waitForTweets(Math.max(3000, Math.round(opts.tweetsTimeoutMs / 2)));
    }
    await waitTweets;

    const raw = await page.evaluate((maxPosts) => {
      const txt = (el) => (el ? el.innerText.trim() : '');
      const followersEl =
        document.querySelector('a[href*="/verified_followers"]') ||
        document.querySelector('a[href*="/followers"]');
      const posts = [...document.querySelectorAll('article[data-testid="tweet"] [data-testid="tweetText"]')]
        .map((e) => e.innerText.trim())
        .filter(Boolean)
        .slice(0, maxPosts);
      const times = [...document.querySelectorAll('article[data-testid="tweet"] time')]
        .map((t) => t.getAttribute('datetime'))
        .filter(Boolean);
      return {
        userNameText: txt(document.querySelector('[data-testid="UserName"]')),
        bio: txt(document.querySelector('[data-testid="UserDescription"]')),
        followersText: txt(followersEl),
        posts,
        times,
      };
    }, opts.postsPerProfile);

    // Parse the captured GraphQL payloads (preferred over the slow DOM read).
    let gqlUser = null;
    let gqlTweets = [];
    if (opts.graphql !== false) {
      for (const g of gqlItems()) {
        if (g.op === 'UserByScreenName' || g.op === 'UserByRestId') gqlUser = gqlUser || parseGqlUser(g.json);
        else if (/^UserTweets/.test(g.op)) gqlTweets = gqlTweets.concat(parseGqlTweets(g.json));
      }
    }

    // Activity rule (rule 2): >= --min-posts-30d posts in the last
    // --activity-window-days. GraphQL timestamps usually cover the window at
    // once; only when they don't do we scroll the DOM timeline (dynamic waits).
    const activityWindowMs = (opts.activityWindowDays || 30) * 86400000;
    const stampsOf = (list) => list.map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n));
    let times = gqlTweets.map((t) => t.createdAt).filter(Boolean);
    let domTimes = Array.isArray(raw.times) ? raw.times.slice() : [];
    {
      let seenMs = stampsOf(times.concat(domTimes));
      let covered = seenMs.length > 0 && Date.now() - Math.min(...seenMs) >= activityWindowMs;
      for (let s = 0; s < (opts.activityScrolls || 0) && !covered; s++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => {});
        await page.waitForSelector('article[data-testid="tweet"] time', { timeout: 1500 }).catch(() => {});
        domTimes = await page
          .evaluate(() =>
            [...document.querySelectorAll('article[data-testid="tweet"] time')]
              .map((t) => t.getAttribute('datetime'))
              .filter(Boolean)
          )
          .catch(() => domTimes);
        seenMs = stampsOf(times.concat(domTimes));
        covered = seenMs.length > 0 && Date.now() - Math.min(...seenMs) >= activityWindowMs;
        if (seenMs.length >= (opts.activityMaxPosts || 40)) break;
      }
      // Scrolling the DOM can trigger additional timeline payloads.
      if (opts.graphql !== false && domTimes.length) {
        gqlTweets = [];
        for (const g of gqlItems()) if (/^UserTweets/.test(g.op)) gqlTweets = gqlTweets.concat(parseGqlTweets(g.json));
      }
    }
    times = Array.from(new Set([...gqlTweets.map((t) => t.createdAt), ...domTimes].filter(Boolean)));

    const lines = raw.userNameText.split('\n').map((s) => s.trim()).filter(Boolean);
    const handleLine = lines.find((l) => l.startsWith('@'));
    const username = (gqlUser && gqlUser.username) || (handleLine ? handleLine.slice(1) : requested);
    const displayName = (gqlUser && gqlUser.displayName) || lines.find((l) => !l.startsWith('@')) || username;
    const followers = gqlUser && isNum(gqlUser.followers) ? gqlUser.followers : parseCount(raw.followersText);
    const bio = (gqlUser && gqlUser.bio ? gqlUser.bio : raw.bio).replace(/\s*\n\s*/g, ' ').trim();
    const gqlPosts = gqlTweets.map((t) => t.text).filter(Boolean);
    const postSource = raw.posts.length ? raw.posts : gqlPosts;

    const now = Date.now();
    const stamps = stampsOf(times).sort((a, b) => b - a);
    const lastPostMs = stamps[0] ?? null;

    return {
      username,
      displayName,
      profileUrl: `https://x.com/${username}`,
      followers,
      bio,
      recentPosts: postSource.map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).join(' || ').slice(0, 900),
      daysSinceLastPost: lastPostMs ? Number(((now - lastPostMs) / 86400000).toFixed(1)) : null,
      postsLast7Days: stamps.filter((t) => now - t <= 7 * 86400000).length,
      postsLast30Days: stamps.filter((t) => now - t <= activityWindowMs).length,
    };
  } catch (err) {
    return { error: err.message.split('\n')[0] };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseRange(v, dflt) {
  if (v == null) return dflt;
  const m = String(v).match(/(\d+)\s*-\s*(\d+)/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? [n, n] : dflt;
}

/** Parse "A=10,B=10" (or a bare number for all buckets). */
function parseQuotaSpec(v) {
  const out = {};
  for (const part of String(v).split(',')) {
    const m = part.trim().match(/^([ABab])\s*[=:]\s*(\d+)$/);
    if (m) out[m[1].toUpperCase()] = parseInt(m[2], 10);
  }
  if (!Object.keys(out).length) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return { A: n, B: n };
  }
  return out;
}

function parseArgs(argv) {
  const c = CONFIG.criteria;
  const opts = {
    buckets: null,
    quotas: { A: 10, B: 10 },
    candidatesPerBucket: null, // legacy: uniform override for all buckets
    concurrency: c.concurrency,
    maxFollowers: c.maxFollowers,
    minPosts: 4, // legacy 7-day gate (superseded by minPosts30d)
    minPosts30d: c.minPosts30d, // rule 2: >= ~2 posts/week over the last month
    minPosts30dFloor: c.minPosts30dFloor, // relaxed floor (~1/week) used when the run falls behind pace
    effectiveMinPosts30d: c.minPosts30d, // mutated at runtime by the relaxed-filters fallback
    relax: c.relax !== false, // allow the 30d threshold to relax when quota progress slows
    relaxBelowPct: c.relaxBelowPct, // relax once collected < this fraction of the target
    prefilter: c.prefilter !== false, // skip obvious misses using SearchTimeline author payloads
    activityWindowDays: c.activityWindowDays,
    activityScrolls: c.activityScrolls == null ? 2 : c.activityScrolls, // extra timeline scrolls used to see a full 30-day window
    activityMaxPosts: c.activityMaxPosts == null ? 40 : c.activityMaxPosts, // stop scrolling once this many timestamps are visible
    maxLastPostDays: c.maxLastPostDays,
    postsPerProfile: c.postsPerProfile == null ? 4 : c.postsPerProfile,
    maxScrollsPerSeed: c.maxScrollsPerSeed,
    maxAuthorsPerSeed: c.maxAuthorsPerSeed,
    maxProfiles: c.maxProfiles,
    maxMinutes: c.maxMinutes,
    expandRounds: c.expandRounds, // keep scanning (wider -> deeper) until the NEW-user target is met
    profileTimeoutMs: 8000,
    tweetsTimeoutMs: 8000,
    scrollWaitMs: 500,
    localCsv: CONFIG.export && CONFIG.export.localCsv ? path.resolve(CONFIG.export.localCsv) : null, // optional CSV mirror/fallback (the Sheet is the DB)
    refs: null,
    target: null, // single-pool target of NEW unique users (config.criteria.target)
    perBucketRaw: null,
    db: [], // extra CSV de-dup files (the Google Sheet is always checked)
    requireKeyword: false,
    blockMedia: true,
    sheetUrl: null,
    syncSheet: true,
    separator: true, // black empty row between the old table and this run's rows
    formatSheet: true, // replicate the table's visual design on written rows
    graphql: true, // read profile metrics from X's GraphQL JSON (DOM fallback)
    fresh: false,
    resume: false,
    dryRun: false,
    headless: true,
    jitterMin: (c.jitterSecs && c.jitterSecs[0]) || 1.0,
    jitterMax: (c.jitterSecs && c.jitterSecs[1]) || 3.0,
    cooldownEvery: c.cooldownEvery == null ? 12 : c.cooldownEvery,
    cooldownMin: (c.cooldownSecs && c.cooldownSecs[0]) || 15,
    cooldownMax: (c.cooldownSecs && c.cooldownSecs[1]) || 35,
    stealth: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--bucket': opts.buckets = String(next()).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--candidates-per-bucket': opts.candidatesPerBucket = parseInt(next(), 10); break;
      case '--target': opts.target = Math.max(1, parseInt(next(), 10)); break;
      case '--per-bucket':
      case '--quota': { const raw = String(next()); opts.perBucketRaw = raw; Object.assign(opts.quotas, parseQuotaSpec(raw)); break; }
      case '--concurrency': opts.concurrency = Math.max(1, parseInt(next(), 10)); break;
      case '--max-followers': opts.maxFollowers = parseInt(next(), 10); break;
      case '--min-posts': opts.minPosts = parseInt(next(), 10); break;
      case '--min-posts-30d': opts.minPosts30d = Math.max(1, parseInt(next(), 10)); break;
      case '--min-posts-30d-floor': opts.minPosts30dFloor = Math.max(1, parseInt(next(), 10)); break;
      case '--no-relax': opts.relax = false; break;
      case '--relax-below-pct': opts.relaxBelowPct = Math.min(1, Math.max(0, parseFloat(next()))); break;
      case '--no-prefilter': opts.prefilter = false; break;
      case '--activity-window-days': opts.activityWindowDays = Math.max(1, parseInt(next(), 10)); break;
      case '--activity-scrolls': opts.activityScrolls = Math.max(0, parseInt(next(), 10)); break;
      case '--activity-max-posts': opts.activityMaxPosts = Math.max(1, parseInt(next(), 10)); break;
      case '--db': opts.db = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--max-last-post-days': opts.maxLastPostDays = parseInt(next(), 10); break;
      case '--posts-per-profile': opts.postsPerProfile = parseInt(next(), 10); break;
      case '--max-scrolls-per-seed': opts.maxScrollsPerSeed = parseInt(next(), 10); break;
      case '--max-authors-per-seed': opts.maxAuthorsPerSeed = parseInt(next(), 10); break;
      case '--max-profiles-per-seed': opts.maxAuthorsPerSeed = parseInt(next(), 10); break; // legacy alias
      case '--max-profiles': opts.maxProfiles = parseInt(next(), 10); break;
      case '--max-minutes': opts.maxMinutes = parseFloat(next()); break;
      case '--expand-rounds': opts.expandRounds = Math.max(1, parseInt(next(), 10)); break;
      case '--local-csv': opts.localCsv = path.resolve(next()); break;
      case '--out': opts.localCsv = path.resolve(next()); break; // legacy alias for --local-csv
      case '--refs': opts.refs = path.resolve(next()); break;
      case '--no-graphql': opts.graphql = false; break;
      // --require-keyword removed
      case '--no-block-media': opts.blockMedia = false; break;
      case '--sheet-url': opts.sheetUrl = String(next()).trim(); break;
      case '--no-sheet': opts.syncSheet = false; break;
      case '--no-separator': opts.separator = false; break;
      case '--no-format': opts.formatSheet = false; break;
      case '--no-jitter': opts.jitterMin = 0.3; opts.jitterMax = 0.8; break;
      case '--headful': opts.headless = false; break;
      case '--headless': opts.headless = true; break;
      case '--fresh': opts.fresh = true; break;
      case '--resume': opts.resume = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--jitter-secs': { const r = parseRange(next(), [0, 0]); opts.jitterMin = r[0]; opts.jitterMax = r[1]; break; }
      case '--cooldown-every': opts.cooldownEvery = parseInt(next(), 10); break;
      case '--cooldown-secs': { const r = parseRange(next(), [20, 40]); opts.cooldownMin = r[0]; opts.cooldownMax = r[1]; break; }
      case '--stealth': opts.stealth = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default: break;
    }
  }
  if (Number.isFinite(opts.candidatesPerBucket)) {
    opts.quotas = { A: opts.candidatesPerBucket, B: opts.candidatesPerBucket };
    if (opts.target == null) opts.target = opts.candidatesPerBucket;
  }
  // Rule 1: a single unified scan with NO per-bucket split. The run collects
  // exactly `target` NEW unique users in total (default 20). An explicit
  // --target wins; otherwise a legacy --per-bucket spec maps to its total
  // (bare number = that total, A=..,B=.. = the sum).
  if (opts.target == null) {
    if (opts.perBucketRaw != null) {
      const bare = String(opts.perBucketRaw).trim().match(/^\d+$/);
      opts.target = bare ? parseInt(bare[0], 10) : (opts.quotas.A || 0) + (opts.quotas.B || 0);
    } else {
      opts.target = CONFIG.criteria.target;
    }
  }
  if (opts.stealth) {
    // Deepen the (mandatory) throttling: longer jitter, less frequent but
    // much longer cooldown rests.
    if (opts.jitterMax < 1.5) { opts.jitterMin = 1.5; opts.jitterMax = 3.5; }
    if (opts.cooldownEvery === 0 || opts.cooldownEvery < 25) opts.cooldownEvery = 25;
    if (opts.cooldownMax < 25) { opts.cooldownMin = 25; opts.cooldownMax = 60; }
  }
  // Jitter is mandatory: even an explicit --jitter-secs 0-0 request is floored
  // to a minimal randomized pause so X/Cloudflare never see mechanical timing.
  if (opts.jitterMax <= 0) { opts.jitterMin = 1.0; opts.jitterMax = 3.0; }
  if (opts.jitterMin < 0.5) opts.jitterMin = 0.5;
  if (opts.jitterMax < opts.jitterMin) opts.jitterMax = opts.jitterMin + 0.8;
  // Cooldown is mandatory too: 0 disables the periodic rest entirely, which is
  // exactly what gets sessions 403-blocked - enforce a sane floor.
  if (opts.cooldownEvery === 0) { opts.cooldownEvery = 12; }
  // Expansion is capped so a pathological run can't loop forever.
  opts.expandRounds = Math.min(Math.max(opts.expandRounds || 1, 1), 6);
  // Relaxed-filters fallback: begin at the requested 30-day threshold; main()
  // lowers it toward the floor (~1 post/week) only if quota progress slows.
  opts.effectiveMinPosts30d = opts.minPosts30d;
  if (opts.minPosts30dFloor > opts.minPosts30d) opts.minPosts30dFloor = opts.minPosts30d;
  return opts;
}

const HELP = `scan-candidates.js — collect NEW X users into the Google Sheet (phase 1)

  node scan-candidates.js [options]

  Default goal: ${CONFIG.criteria.target} NEW unique users (built from the niche
  keywords in config.json) in a single unified pass with NO per-bucket split,
  then the run stops.

  Queries: auto-generated from config.json (search.keywords) unless
  search.queries is set, plus optional hashtag/engagement seeds
  (search.expansionQueries). A query yielding <${QUERY_ROTATE_MIN_NEW} new unique
  users is dropped in favour of the next. SearchTimeline payloads pre-filter
  obvious misses before the profile is opened; the profile is still visited once
  to count activity.

  --target <n>                Total NEW unique users to collect (default ${CONFIG.criteria.target})
  --bucket <A,B>              Only scan these seeds/buckets   (default all)
  --db <files>                Extra CSV de-dup DBs (comma separated). The Google
                              Sheet is ALWAYS checked for de-duplication.
  --concurrency <n>           Parallel profile tabs          (default ${CONFIG.criteria.concurrency})
  --max-followers <n>         Follower ceiling (exclusive)   (default ${CONFIG.criteria.maxFollowers})
  --min-posts-30d <n>         Min posts in last ${CONFIG.criteria.activityWindowDays} days      (default ${CONFIG.criteria.minPosts30d})
  --min-posts-30d-floor <n>   Relaxed 30d floor (~1/week) the
                              run may fall back to when it is
                              behind pace                      (default ${CONFIG.criteria.minPosts30dFloor})
  --no-relax                  Never relax the 30d threshold (off)
  --relax-below-pct <0-1>     Relax once collected < this
                              fraction of the target           (default ${CONFIG.criteria.relaxBelowPct})
  --no-prefilter              Always open the profile (skip the
                              SearchTimeline pre-filter)       (off)
  --activity-window-days <n>  Activity window in days        (default ${CONFIG.criteria.activityWindowDays})
  --activity-scrolls <n>      Extra timeline scrolls for the
                              activity read                    (default ${CONFIG.criteria.activityScrolls == null ? 2 : CONFIG.criteria.activityScrolls})
  --max-last-post-days <n>    Max age of newest post         (default ${CONFIG.criteria.maxLastPostDays})
  --max-scrolls-per-seed <n>  Scrolls per query/seed         (default ${CONFIG.criteria.maxScrollsPerSeed})
  --max-authors-per-seed <n>  Authors checked per seed       (default ${CONFIG.criteria.maxAuthorsPerSeed})
  --max-profiles <n>          Global profile-check cap       (default ${CONFIG.criteria.maxProfiles})
  --max-minutes <n>           Hard safety cap, then stop. NOT an expected
                              duration: with the pre-filter + query rotation a
                              typical run finishes in a few minutes and exits as
                              soon as the target is met.        (default ${CONFIG.criteria.maxMinutes})
  --expand-rounds <n>         Auto-expansion rounds: if the base seeds run dry
                              before the target is reached, the run keeps going
                              with extra seeds (round 2) and deeper re-scrolls
                              (later rounds) until the target NEW users or the
                              budget is hit. 1 disables expansion.   (default ${CONFIG.criteria.expandRounds})
  --local-csv <file>          OPTIONAL local CSV mirror (retry-safe). The Google
                              Sheet is the database; nothing local is written by
                              default. (--out is a legacy alias)
  --sheet-url <url>           Override the configured Google Sheet
  --no-sheet                  Do not read/write the Google Sheet
  --no-separator              Do not insert the solid-black separator row
  --no-format                 Do not replicate the table styling (raw values)
  (Storage: the Google Sheet is read for de-dup and every NEW user is written
   straight back via the API; no CSV is produced unless --local-csv is passed.
   Each write re-applies the table's visual design and keeps ONE solid-black
   empty row between the pre-existing table and this run's new rows.)
  --refs <dir>                Dir with the optional keywords list (keywords.md)
  --no-block-media            Keep loading images/media/fonts/stylesheets
  --no-graphql                Read profiles from the DOM only (skip the JSON path)
  --no-jitter                 Drop jitter to its safety floor (0.3-0.8s, mandatory)
  --headful                   Show a visible browser window (may help if X bot-blocks headless)
  --headless                  Force headless (default)
  --jitter-secs <min-max>     Random pause before each profile (default ${opts_jitter()}, always on)
  --cooldown-every <n>        Idle rest after every n profiles (default ${CONFIG.criteria.cooldownEvery == null ? 12 : CONFIG.criteria.cooldownEvery}, always on)
  --cooldown-secs <min-max>   Rest window seconds            (default ${cooldownDefault()})
  --stealth                   Preset: longer jitter + less frequent, longer cooldowns
  --fresh                     Ignore an existing --local-csv mirror
  --resume                    Count existing Sheet rows toward the quota, then top up
  --dry-run                   Scan without writing anywhere
  -h, --help                  This help

  Throttling is MANDATORY by default (human jitter + periodic cooldown +
  adaptive back-off on failures). Runs are a bit slower but far less likely to
  be 403-bot-blocked into empty shells.
`;

function opts_jitter() {
  const j = CONFIG.criteria.jitterSecs || [1.0, 3.0];
  return `${j[0]}-${j[1]}s`;
}

function cooldownDefault() {
  const c = CONFIG.criteria.cooldownSecs || [15, 35];
  return `${c[0]}-${c[1]}`;
}

async function restBreak(label, minSec, maxSec) {
  const sec = Math.max(minSec, 0) + Math.random() * Math.max(maxSec - minSec, 0);
  if (sec <= 0) return;
  console.log(`  [break] ${label}: idle ~${sec.toFixed(0)}s`);
  await sleep(sec * 1000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }

  const startedAt = Date.now();
  const runId = new Date().toISOString();
  const rel = loadRelevanceKeywords(opts.refs);
  if (rel.file) console.log(`Keywords: ${rel.file} (${rel.keywords.length} terms)`);

  // ---- Database: the Google Sheet is the single source of truth ------------
  // Existing rows are read from the Sheet for de-duplication; every NEW user is
  // written straight back to the Sheet. No CSV database is written by default.
  const sheetCfg = opts.syncSheet ? sheets.resolveDirectConfig(opts.sheetUrl) : null;
  let sheetRows = [];
  if (opts.syncSheet) {
    if (!sheetCfg) {
      if (!opts.localCsv) {
        console.error('No Google Sheet configured (sheet-config.json needs a spreadsheetId).');
        console.error('Fix sheet-config.json, or pass --local-csv <file> (optionally with --no-sheet) for a CSV fallback.');
        process.exit(2);
      }
      console.log('Google Sheet: not configured - using the --local-csv fallback as the database.');
    } else {
      const r = await sheets.fetchSheetRows(sheetCfg);
      if (r.ok) {
        sheetRows = r.rows;
        console.log(`Google Sheet DB: read ${sheetRows.length} existing row(s) from "${sheetCfg.sheetName}".`);
      } else {
        console.log(`Google Sheet DB: read failed (${r.error}) - continuing with an empty dedup set.`);
      }
    }
  }

  // Optional local CSV mirror/fallback (off by default; the Sheet is authoritative).
  const loadedExisting = opts.localCsv && !opts.fresh ? loadExisting(opts.localCsv) : [];
  const { kept: existing, rejected: purged } = pruneSuspects(loadedExisting);
  const candidates = existing.slice();

  // Rule 3: de-dup DB = Sheet usernames + optional --db CSVs + optional local
  // CSV. A username already present is skipped completely and never counts
  // toward the fresh target. `seen` is seeded from it too, so known authors are
  // not even queued (saves profile checks).
  const dbUsers = new Set();
  for (const r of sheetRows) {
    const u = String((r && r.username) || '').trim().replace(/^@/, '').toLowerCase();
    if (u) dbUsers.add(u);
  }
  const dbFiles = [
    ...(opts.localCsv ? [opts.localCsv] : []),
    ...(opts.db || []).map((f) => path.resolve(f)),
  ];
  for (const f of dbFiles) {
    for (const r of loadExisting(f)) {
      const u = String((r && r.username) || '').trim().replace(/^@/, '').toLowerCase();
      if (u) dbUsers.add(u);
    }
  }
  const seen = new Set(dbUsers);
  const candidateSeen = new Set(dbUsers);

  const seeds = SEEDS.filter((s) => !opts.buckets || opts.buckets.includes(s.bucket));
  if (!seeds.length) {
    if (!SEEDS.length) {
      console.error('No search queries configured.');
      console.error('Add your niche keywords to config.json (search.keywords.A / .B)');
      console.error('or set X_NICHE_KEYWORDS / X_KEYWORDS_A / X_KEYWORDS_B, or provide search.queries.');
      process.exit(2);
    }
    console.error('No seeds match --bucket. Use one of: ' + config.bucketKeys(CONFIG).join(', ') + '.');
    process.exit(2);
  }

  // Rule 1: one unified target of NEW unique users, no per-bucket split.
  const target = opts.target;
  const newCounts = { A: 0, B: 0, '': 0 };
  // --resume counts the rows already in the Sheet toward the target; by default
  // existing rows are de-dup only and NEVER counted.
  let newCount = opts.resume ? sheetRows.length : 0;
  // Run-scoped hard-stop counter: NEW unique users added by THIS run only. It
  // starts at 0 even under --resume (where newCount is seeded from the Sheet),
  // so the run knows exactly how many it still has to add.
  let runAdded = 0;
  // How many NEW users THIS run must add to reach the target: the full target
  // by default, or the remainder when --resume counts the existing rows.
  const runQuota = Math.max(0, target - (opts.resume ? sheetRows.length : 0));

  console.log(`Goal: ${target} NEW unique user(s) in one unified pass (no bucket split)`);
  console.log(
    `Criteria: <${opts.maxFollowers} followers | last post <=${opts.maxLastPostDays}d | >=${opts.effectiveMinPosts30d} posts/${opts.activityWindowDays}d` +
      `${opts.relax && opts.minPosts30dFloor < opts.minPosts30d ? ` (relaxes to ${opts.minPosts30dFloor} if behind pace)` : ''}`
  );
  console.log(
    `Query pool: ${SEEDS.length} Boolean queries + ${EXTRA_SEEDS.length} hashtag/engagement seeds; rotate when a query yields ` +
      `<${QUERY_ROTATE_MIN_NEW} new users | pre-filter=${opts.prefilter ? 'on' : 'off'}`
  );
  if (opts.localCsv) {
    console.log(
      `Output: Google Sheet + local mirror ${opts.localCsv} (${existing.length} existing row(s)` +
        `${purged.length ? `, ${purged.length} suspect row(s) purged` : ''})`
    );
  } else {
    console.log('Output: Google Sheet only (local CSV writes disabled)');
  }
  if (opts.syncSheet) {
    console.log(
      `Sheet style: ${opts.formatSheet ? 'table design replicated' : 'raw values only'} | ` +
        `separator=${opts.separator ? 'solid black row before this run\u2019s rows' : 'off'}`
    );
  }
  if (purged.length) console.log(`  Purged ${purged.length} suspect row(s) (synthetic fixtures / duplicate bios).`);
  console.log(
    `Dedup DB: ${dbFiles.length ? dbFiles.map((f) => path.basename(f)).join(', ') + ' + ' : ''}Google Sheet` +
      ` (${dbUsers.size} known user(s)) - existing users are skipped and never counted${opts.resume ? ' (except --resume)' : ''}.`
  );
  console.log(`Run id: ${runId}`);
  console.log(
    `Speed: concurrency=${opts.concurrency} | block-media=${opts.blockMedia} | graphql=${opts.graphql !== false} | ` +
      `jitter=${opts.jitterMax > 0 ? `${opts.jitterMin}-${opts.jitterMax}s` : 'off'} | ` +
      `cooldown=${opts.cooldownEvery > 0 ? `${opts.cooldownMin}-${opts.cooldownMax}s/${opts.cooldownEvery}` : 'off'}`
  );
  console.log(
    `Time: expects to finish in a few minutes (pre-filter + query rotation); ` +
      `${opts.maxMinutes} min is only a hard safety cap, and the run exits as soon as the target is met.`
  );

  // Local CSV mirror (opt-in). The atomic rename is retried so a transient file
  // lock (OneDrive/Excel) never loses the run; the Sheet stays authoritative.
  const save = async () => {
    if (!opts.localCsv || opts.dryRun) return;
    const dir = path.dirname(opts.localCsv);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    const p = path.parse(opts.localCsv);
    const staging = path.join(dir, `${p.name}.new${p.ext}`);
    const { kept: safeRows } = pruneSuspects(candidates);
    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        fs.writeFileSync(staging, toCsv(safeRows), 'utf8');
        fs.renameSync(staging, opts.localCsv);
        return;
      } catch (err) {
        lastErr = err;
        const lockish = err && ['EBUSY', 'EPERM', 'EACCES'].includes(err.code);
        if (!lockish) break;
        await sleep(200 * attempt);
      }
    }
    console.log(`  ! could not write ${opts.localCsv}: ${lastErr && lastErr.message}`);
  };

  // Serialized Sheet writer: every NEW user is upserted straight to the Sheet.
  // A promise chain prevents concurrent read-modify-write races between workers.
  let sheetQueue = Promise.resolve();
  const runRows = [];
  const queueSheetSync = () => {
    if (!opts.syncSheet || !sheetCfg || opts.dryRun || !runRows.length) return;
    const payload = runRows.slice();
    sheetQueue = sheetQueue.then(async () => {
      try {
        const res = await sheets.appendRowsDirect(payload, {
          ...sheetCfg,
          separator: opts.separator,
          format: opts.formatSheet,
        });
        if (res && res.ok === false && res.error) console.log(`  ! Sheet sync error: ${res.error}`);
      } catch (err) {
        console.log(`  ! Sheet sync failed: ${err.message}`);
      }
    });
  };

  // Auth-only session: load the saved session straight from auth.json. The
  // scanner never probes for or attaches to a running Chrome.
  const session = await openX({ headless: opts.headless, mode: 'auth' });
  const { context, page } = session;

  // Pre-filter index: authors parsed from SearchTimeline payloads while a seed
  // scrolls. Lets checkItem reject obvious misses without opening a profile.
  const searchIndex = new Map();
  if (opts.prefilter) attachSearchIndex(page, searchIndex);

  if (opts.blockMedia) {
    try {
      await context.route(BLOCK_GLOB, (route) => route.abort());
    } catch {
      console.log('  (media blocking unavailable in this browser mode - continuing)');
    }
  }

  let checks = 0;
  let prefiltered = 0;

  // Human-readable run summary, shared by the normal finish and the hard stop.
  const printSummary = () => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
    const sheetUrl = sheetCfg ? sheets.sheetEditUrl(sheetCfg.spreadsheetId) : null;
    console.log(`\nDone in ${secs}s. ${checks} profile check(s)${prefiltered ? `, ${prefiltered} pre-filtered before open` : ''}.`);
    console.log(`  New unique users: ${newCount}/${target}${newCount < target ? '  - short' : ''}`);
    console.log(
      `  Breakdown (hint only): A(${BUCKET_NAMES.A || 'A'})=${newCounts.A}  B(${BUCKET_NAMES.B || 'B'})=${newCounts.B}  unassigned=${newCounts[''] || 0}`
    );
    if (newCount < target) {
      console.log('  ! target not reached after all expansion rounds (pool/budget exhausted).');
      console.log('    Raise --max-profiles / --max-minutes / --expand-rounds, or add a seed.');
    }
    if (opts.dryRun) console.log('(dry-run - nothing written)');
    if (sheetUrl) console.log(`Google Sheet: ${sheetUrl}`);
    if (opts.localCsv && !opts.dryRun) console.log(`Local mirror: ${opts.localCsv}`);
  };

  try {
    // Home + login check, tolerant of transient bot-block shells: retry a few
    // times with a growing back-off before giving up.
    let sessionOk = false;
    for (let attempt = 1; attempt <= 4 && !sessionOk; attempt++) {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' }).catch(() => {});
      try {
        await ensureLoggedIn(page);
        sessionOk = true;
      } catch (err) {
        const wait = 12 * attempt + Math.floor(Math.random() * 8);
        console.log(`  [session retry ${attempt}/4] ${err.message} - waiting ${wait}s`);
        await sleep(wait * 1000);
      }
    }
    if (!sessionOk) {
      console.error('Could not reach a logged-in X session (persistent bot block or logged out).');
      console.error(`Fix: refresh the saved session with: node ${path.join(PROJ, 'First', 'login.js')} --refresh`);
      process.exit(3);
    }
    console.log('Session OK.');

    // Adaptive throttling state shared by every worker: a growing back-off on
    // consecutive failures and a bot-block streak that escalates the back-off.
    let failStreak = 0;
    let botBlockStreak = 0;

    const wireWorker = (pg, slot) => {
      pg.on('crash', () => console.log(`  [worker ${slot}] tab crashed - will be recreated on next use`));
      pg.on('error', () => {});
      return pg;
    };

    const workPages = [];
    for (let i = 0; i < opts.concurrency; i++) workPages.push(wireWorker(await context.newPage(), i));

    const deadline = Date.now() + opts.maxMinutes * 60000;
    let stop = false;
    let localCooldown = 0;

    // Hard stop: the instant THIS run has added its quota of NEW users, flush the
    // in-flight Sheet write(s) and terminate immediately - regardless of any
    // remaining --max-profiles / --max-minutes budget. Guarded so parallel
    // workers can't double-exit, and the per-candidate cap in checkItem still
    // guarantees the exact target is never overshot.
    let hardStopped = false;
    const finishAndExit = async () => {
      if (hardStopped) return;
      hardStopped = true;
      stop = true;
      // Flush the last write so the final user is always persisted to the Sheet.
      await sheetQueue.catch(() => {});
      printSummary();
      console.log('  (target reached - hard stop)');
      try { await session.close(); } catch { /* best effort */ }
      process.exit(0);
    };

    // Recreate a crashed/closed worker tab so one bad page can't kill the run.
    // Applies an escalating back-off first so we don't hammer X while it's upset.
    const replaceWorker = async (slot, oldPage) => {
      try { await oldPage.close().catch(() => {}); } catch { /* already dead */ }
      await restBreak('worker recovery', 5 + Math.min(failStreak * 3, 25), 10 + Math.min(failStreak * 5, 45));
      try {
        const fresh = wireWorker(await context.newPage(), slot);
        workPages[slot] = fresh;
        return fresh;
      } catch (err) {
        console.log(`  [worker ${slot}] could not recreate tab (${err.message}) - stopping pool`);
        stop = true;
        return oldPage;
      }
    };

    // Parallel pool over a batch of items, reusing the worker tabs. A transient
    // failure on one tab is retried (up to 3x) on a replacement tab instead of
    // crashing the whole run.
    const poolRun = async (items, fn) => {
      let idx = 0;
      const tasks = workPages.map(async (pg0, slot) => {
        let pg = pg0;
        while (!stop) {
          const i = idx++;
          if (i >= items.length) break;
          if (Date.now() > deadline) { stop = true; break; }
          const item = items[i];
          if (pg.isClosed()) pg = await replaceWorker(slot, pg);
          let lastErr = null;
          for (let attempt = 1; attempt <= 3 && !stop; attempt++) {
            try {
              await fn(item, pg);
              lastErr = null;
              break;
            } catch (err) {
              // A hard stop / budget stop closes the browser; bail out quietly.
              if (stop || hardStopped) return;
              lastErr = err;
              failStreak++;
              console.log(`  [worker ${slot}] @${item.username} check crashed: ${err.message} (attempt ${attempt}/3)`);
              pg = await replaceWorker(slot, pg);
            }
          }
          if (lastErr && !stop) {
            console.log(`  [worker ${slot}] giving up on @${item.username}`);
            await restBreak('item backoff', 8 + Math.min(failStreak * 4, 30), 15 + Math.min(failStreak * 6, 60));
          } else if (failStreak > 0) {
            failStreak = 0;
          }
        }
      });
      const results = await Promise.allSettled(tasks);
      for (const r of results) if (!stop && r.status === 'rejected') console.log(`  ! worker rejected: ${r.reason && r.reason.message ? r.reason.message : r.reason}`);
    };

    // Rule 1: the ONLY stop condition is reaching the single-pool target of NEW
    // unique users (there is no per-bucket quota).
    const allFull = () => newCount >= target;

    const checkItem = async (item, pg) => {
      if (hardStopped) return;
      if (allFull()) { stop = true; return; }
      if (checks >= opts.maxProfiles) { stop = true; return; }

      // Payload-only pre-filter: when the SearchTimeline payload already shows
      // this author is over the follower ceiling, or their newest visible post is
      // already older than the recency gate, skip the profile open entirely.
      // (The 30-day activity count still requires a visit, so survivors proceed.)
      if (opts.prefilter) {
        const pre = searchIndex.get(String(item.username).toLowerCase());
        if (pre) {
          const over = isNum(pre.followers) && pre.followers >= opts.maxFollowers;
          const stale =
            pre.lastPostMs != null && Date.now() - pre.lastPostMs > opts.maxLastPostDays * 86400000;
          if (over || stale) {
            prefiltered++;
            const why = [over ? `fol=${pre.followers}` : '', stale ? 'stale last post' : '']
              .filter(Boolean)
              .join(', ');
            console.log(`  [pre] @${item.username} -> skip before profile (${why})`);
            return;
          }
        }
      }

      const n = ++checks;
      if (opts.jitterMax > 0) {
        const lo = Math.min(opts.jitterMin, opts.jitterMax);
        await sleep((lo + Math.random() * (opts.jitterMax - lo)) * 1000);
      }

      const rec = await gatherProfile(pg, item.username, opts);
      if (!rec || rec.error) {
        // If the hard stop just closed the browser, don't log during shutdown.
        if (hardStopped) return;
        const msg = rec ? rec.error : 'no data';
        failStreak++;
        if (/bot-block/i.test(msg)) {
          botBlockStreak++;
          console.log(`  [${n}] @${item.username} -> bot-block shell detected, backing off`);
          await restBreak('bot-block backoff', 30, 60);
          if (botBlockStreak >= 3) {
            console.log('  [hint] persistent bot-block: retry with --headful --no-block-media, or refresh the session via First/login.js --refresh');
            botBlockStreak = 0;
          }
        } else {
          console.log(`  [${n}] @${item.username} -> error (${msg})`);
          const base = Math.min(failStreak * 4, 30);
          await restBreak('error backoff', 5 + base, 10 + base * 2);
        }
      } else {
        botBlockStreak = 0;
        failStreak = 0;

        // Rule 2: activity gate - at least --min-posts-30d posts in the last
        // --activity-window-days (default ~8 posts / 30 days = 2 per week).
        if (
          rec.followers == null ||
          rec.followers >= opts.maxFollowers ||
          rec.daysSinceLastPost == null ||
          rec.daysSinceLastPost > opts.maxLastPostDays ||
          rec.postsLast30Days == null ||
          rec.postsLast30Days < opts.effectiveMinPosts30d
        ) {
          console.log(
            `  [${n}] @${rec.username} -> skip (fol=${rec.followers}, last=${rec.daysSinceLastPost ?? 'n/a'}d, posts30d=${rec.postsLast30Days ?? 'n/a'}/${opts.effectiveMinPosts30d})`
          );
        } else {
          // Evaluate this candidate against BOTH categories at once (informational
          // hint only - there is no per-bucket quota any more).
          const bucket = classifyCandidate(rec.bio, rec.recentPosts, rec);
          const sem = scoreSemantics(rec);
          const effBucket = bucket || sem.bucket;
          const matchedKw = rel.keywords.filter((k) => hasKeyword(`${rec.bio} ${rec.recentPosts}`, [k]));
          const allMatched = Array.from(new Set([...matchedKw, ...sem.allTerms]));
          const ckey = String(rec.username).toLowerCase();
          // Rule 3: skip anyone already in the persistent database.
          if (dbUsers.has(ckey)) {
            console.log(`  [${n}] @${rec.username} -> skip (already in database)`);
            return;
          }
          if (candidateSeen.has(ckey)) {
            console.log(`  [${n}] @${rec.username} -> already collected this run, skipping duplicate`);
            return;
          }
          const effName = effBucket ? BUCKET_NAMES[effBucket] : '';
          const row = {
            // strict 8-column schema (so the optional local mirror matches the
            // Sheet and stays valid for build-targets --candidates)
            bucket: effBucket || item.bucket || '',
            category: effName || '',
            // richer candidate fields (kept for diagnostics; not in the 8-col output)
            bucketHint: effBucket || '',
            bucketName: effName || '',
            displayName: rec.displayName,
            username: rec.username,
            profileUrl: rec.profileUrl,
            followers: rec.followers,
            bio: rec.bio,
            recentPosts: rec.recentPosts,
            daysSinceLastPost: rec.daysSinceLastPost,
            postsLast7Days: rec.postsLast7Days,
            postsLast30Days: rec.postsLast30Days,
            matchedTerms: allMatched.join('; '),
            sourceSeed: item.seed,
            sourceBucket: item.bucket || '',
            runId,
            collectedAt: new Date().toISOString(),
            bucketConfidence: sem.confidence,
          };
          // P3: reject synthetic fixtures / duplicate-bio clusters before write.
          if (rowIsSuspect(row, candidates)) {
            console.log(`  [${n}] @${rec.username} -> reject (suspect/placeholder row)`);
            return;
          }
          // Cap EXACTLY at the target: a parallel worker may have filled the last
          // slot while this profile was being read, so never overshoot the Sheet.
          if (newCount >= target) { stop = true; return; }
          candidateSeen.add(ckey);
          dbUsers.add(ckey);
          candidates.push(row);
          newCount++;
          runAdded++;
          newCounts[effBucket || ''] = (newCounts[effBucket || ''] || 0) + 1;
          // Write the NEW user straight to the Google Sheet (strict 8 columns).
          const finalBucket = effBucket || row.sourceBucket || 'A';
          runRows.push({
            bucket: finalBucket,
            category: BUCKET_NAMES[finalBucket] || effName || '',
            username: rec.username,
            profileUrl: rec.profileUrl,
            followers: rec.followers,
            bio: rec.bio,
            daysSinceLastPost: rec.daysSinceLastPost,
            postsLast7Days: rec.postsLast7Days,
          });
          await save();
          queueSheetSync();
          console.log(
            `  [${n}] ${effBucket || '?'} NEW @${rec.username} (${rec.followers} fol, ${rec.postsLast30Days} posts/30d) [${newCount}/${target}]`
          );
          if (allFull()) stop = true;
          // Hard stop the moment this run has added its quota of NEW users.
          if (runAdded >= runQuota) { await finishAndExit(); return; }
        }
      }

      if (opts.cooldownEvery > 0 && ++localCooldown % opts.cooldownEvery === 0) {
        await restBreak('cooldown', opts.cooldownMin, opts.cooldownMax);
      }
    };

    // Round-robin the seeds by their topic so no one topic starves the run.
    const orderByBucket = (list) => {
      const byBucket = { A: [], B: [] };
      for (const s of list) (byBucket[s.bucket] || (byBucket[s.bucket] = [])).push(s);
      const out = [];
      const depth = Math.max(byBucket.A.length, byBucket.B.length);
      for (let i = 0; i < depth; i++) {
        for (const b of ['A', 'B']) if (byBucket[b][i]) out.push(byBucket[b][i]);
      }
      return out;
    };

    // Expansion plan: keep scanning (wider, then deeper) until `target` NEW
    // unique users are collected. The de-dup check runs PER CANDIDATE inside the
    // parallel pool (checkItem -> dbUsers), so a user already in the Google Sheet
    // is skipped the moment it is seen and the run simply keeps scanning.
    // Round 1 = base seeds; round 2 = fresh keyword seeds; later rounds re-scroll
    // everything with bigger author/scroll caps so the pool can't run dry before
    // the target is met.
    const baseOrdered = orderByBucket(seeds);
    const extraOrdered = orderByBucket(
      EXTRA_SEEDS.filter((s) => !opts.buckets || opts.buckets.includes(s.bucket))
    );

    const plans = [
      { seeds: baseOrdered, authors: opts.maxAuthorsPerSeed, scrolls: opts.maxScrollsPerSeed, label: 'round 1 - base seeds' },
    ];
    if (opts.expandRounds >= 2 && extraOrdered.length) {
      plans.push({ seeds: extraOrdered, authors: opts.maxAuthorsPerSeed, scrolls: opts.maxScrollsPerSeed, label: 'round 2 - extra seeds' });
    }
    for (let r = 3; r <= opts.expandRounds; r++) {
      const factor = Math.pow(1.6, r - 2);
      plans.push({
        seeds: baseOrdered.concat(extraOrdered),
        authors: Math.round(opts.maxAuthorsPerSeed * factor),
        scrolls: Math.round(opts.maxScrollsPerSeed * factor),
        label: `round ${r} - deeper re-scroll (${factor.toFixed(1)}x)`,
      });
    }

    // Relaxed-filters fallback: if the run is clearly behind pace after a round,
    // lower the 30-day activity threshold toward the floor (~1 post/week). This
    // keeps a dry pool from stalling the whole run on an over-strict gate.
    const queryYield = new Map();
    const maybeRelax = (label) => {
      if (!opts.relax || opts.effectiveMinPosts30d <= opts.minPosts30dFloor) return;
      if (stop || allFull()) return;
      if (newCount >= Math.ceil(target * opts.relaxBelowPct)) return;
      opts.effectiveMinPosts30d = opts.minPosts30dFloor;
      console.log(
        `  [relax] behind pace after ${label} (${newCount}/${target}) - min posts/${opts.activityWindowDays}d lowered to ${opts.effectiveMinPosts30d}`
      );
    };

    let round = 0;
    for (const plan of plans) {
      if (stop || allFull()) break;
      round++;
      console.log(
        `\n##### Expansion ${plan.label} (authors/seed=${plan.authors}, scrolls/seed=${plan.scrolls}) - ${newCount}/${target} new so far`
      );
      const roundOpts = { ...opts, maxAuthorsPerSeed: plan.authors, maxScrollsPerSeed: plan.scrolls };
      for (const seed of plan.seeds) {
        if (stop || allFull()) break;
        console.log(`\n=== Scanning :: ${seed.url}`);
        let authors = [];
        try {
          authors = await collectAuthors(page, seed, roundOpts, seen);
        } catch (err) {
          console.log(`  ! seed failed (${err.message}) - skipping`);
          await restBreak('seed error', 10, 25);
          continue;
        }
        const beforeSeed = newCount;
        console.log(`  queued ${authors.length} author(s)`);
        await poolRun(authors.map((u) => ({ username: u, seed: seed.url, bucket: seed.bucket })), checkItem);
        // Query rotation: a query that yields fewer than QUERY_ROTATE_MIN_NEW new
        // unique candidates is abandoned in favour of the next one in the pool.
        const yielded = newCount - beforeSeed;
        queryYield.set(seed.url, (queryYield.get(seed.url) || 0) + yielded);
        if (!allFull() && !stop && yielded < QUERY_ROTATE_MIN_NEW) {
          console.log(`  [rotate] ${yielded} new unique (<${QUERY_ROTATE_MIN_NEW}) - advancing to the next query`);
        }
        if (allFull()) { console.log('  (target reached - stopping)'); break; }
        if (stop) { console.log('  (time/profile budget reached - stopping)'); break; }
      }
      if (!allFull() && !stop) {
        console.log(`  [expansion] ${plan.label} exhausted - ${newCount}/${target} new, escalating`);
        maybeRelax(plan.label);
      }
    }

    await Promise.all(workPages.map((p) => p.close().catch(() => {})));

    // Flush any in-flight Sheet writes before reporting.
    await sheetQueue.catch(() => {});

    printSummary();
  } finally {
    if (opts.blockMedia) await context.unroute(BLOCK_GLOB).catch(() => {});
    await session.close();
  }
}

if (require.main === module) {
  const handleErr = (err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('\nError:', msg);
    if (err && err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    process.exitCode = 1;
    process.exit(1);
  };
  process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : String(reason);
    console.error('Unhandled rejection:', msg);
    process.exitCode = 1;
  });
  process.on('uncaughtException', handleErr);
  main().catch(handleErr);
}

module.exports = {
  parseCsv,
  toCsv,
  pruneSuspects,
  rowIsSuspect,
  normalizeBio,
  parseGqlSearch,
  parseArgs,
  QUERY_POOL,
  EXTRA_QUERIES,
  SEEDS,
  EXTRA_SEEDS,
  QUERY_ROTATE_MIN_NEW,
};
