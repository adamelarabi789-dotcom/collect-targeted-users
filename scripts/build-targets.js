#!/usr/bin/env node
/**
 * build-targets.js — Phase 2 of the `collect-targeted-users` skill.
 *
 * Phase 1 (scan-candidates.js) already writes every NEW user STRAIGHT to the
 * Google Sheet, so this phase is a Sheet-native finalizer / verifier. It does
 * NOT validate with AI and it does NOT need candidates.csv or targeted_users.csv.
 *
 * What it does:
 *   1. reads the Google Sheet (the single source of truth) for its rows,
 *   2. optionally ingests a local CSV (--candidates) into the set,
 *   3. enforces the strict 8-column schema and de-duplicates by username while
 *      PRESERVING the Sheet's row order and its solid-black separator row,
 *   4. upserts the clean set back to the Sheet (idempotent - never duplicates)
 *      and re-applies the table's visual design (fonts, colours, alignment),
 *   5. optionally writes a local CSV mirror (--local-csv, retry-safe), and
 *   6. prints the clickable Google Sheet URL.
 *
 * Sheet modes (auto-detected): direct Google Sheets API via sheet-config.json
 * { "spreadsheetId": "..." }, or an Apps Script Web App URL (write-only - reads
 * need direct mode).
 *
 * Output columns (strict): bucket, category, username, profileUrl, followers,
 * bio, daysSinceLastPost, postsLast7Days
 *
 * Usage:
 *   node build-targets.js [options]
 *
 * Options:
 *   --candidates <file>   Optional CSV to ingest into the Sheet
 *   --local-csv <file>    Optional local mirror written from the Sheet (also read)
 *   --target <n>          Informational NEW-user target              (default 20)
 *   --sheet-url <url>     Override the configured Sheet (or env X_SHEET_WEBAPP_URL)
 *   --sync-sheet          Upsert the clean rows to the Sheet         (default: on)
 *   --no-sheet            Do not touch the Sheet (needs --candidates/--local-csv)
 *   -h, --help
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Load an optional local .env before sheets.js resolves its config.
require('./env').loadEnv();

const sheets = require('./sheets');
const { COLUMNS } = require('./columns');
// Bucket labels/criteria come from config.json (no hard-coded niche names).
const config = require('./config');
const CONFIG = config.get();

// No hard-coded absolute paths - honour an explicit env override first, then
// the repo root when the Sheet config lives beside these scripts, else fall
// back to the conventional <home>/twitter-playwright install.
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJ =
  process.env.PROJ_ROOT ||
  process.env.TWITTER_PLAYWRIGHT_DIR ||
  (fs.existsSync(path.join(REPO_ROOT, 'lib', 'twitter.js'))
    ? REPO_ROOT
    : path.join(os.homedir(), 'twitter-playwright'));

const BUCKET_NAMES = config.bucketNames(CONFIG);
const BUCKET_KEYS = config.bucketKeys(CONFIG);

// The strict 8-column output schema, shared with the Google Sheet sink.
const OUT_COLUMNS = COLUMNS;

// Number of rename attempts + delay between them when a mirror is locked (P5).
const RENAME_ATTEMPTS = 3;
const RENAME_DELAY_MS = 500;

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return /[",]/.test(s) ? `"${s}"` : s;
}

function toCsv(rows, headers = OUT_COLUMNS) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Block the current thread for `ms` (used between rename retries). */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy fallback */ }
  }
}

/**
 * Write a local CSV mirror safely: stage to <name>.new.csv, then atomically
 * rename it into place. A locked destination (EBUSY/EPERM - often Excel) is
 * retried, then the staged copy is KEPT and a degraded result returned (P5).
 * @returns {{ok: boolean, staged: boolean, degraded: boolean, staging: string, attempts: number, error?: string}}
 */
function safeWriteCsv(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.parse(file);
  const staging = path.join(dir, `${p.name}.new${p.ext}`);
  try {
    fs.writeFileSync(staging, text, 'utf8');
  } catch (err) {
    return { ok: false, staged: false, degraded: true, staging, attempts: 0, error: err.message };
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(staging, file);
      return { ok: true, staged: false, degraded: false, staging, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt < RENAME_ATTEMPTS) sleepSync(RENAME_DELAY_MS);
    }
  }
  return {
    ok: false,
    staged: true,
    degraded: true,
    staging,
    attempts: RENAME_ATTEMPTS,
    error: lastErr && lastErr.message,
  };
}

/** Enforce the strict 8-column schema + sanitize identity fields. */
function normalizeRow(r) {
  const out = {};
  for (const h of OUT_COLUMNS) out[h] = r && r[h] != null ? String(r[h]) : '';
  const name = out.username.trim().replace(/^@/, '');
  out.username = name;
  if (!/^https?:\/\//i.test(out.profileUrl)) out.profileUrl = name ? `https://x.com/${name}` : '';
  out.bucket = out.bucket.trim().toUpperCase();
  if (!BUCKET_KEYS.includes(out.bucket)) out.bucket = BUCKET_KEYS[0] || 'A';
  out.category = BUCKET_NAMES[out.bucket] || out.category;
  return out;
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

/** Normalise a handle for case-insensitive matching. */
function normUser(u) {
  return String(u == null ? '' : u).trim().replace(/^@/, '').toLowerCase();
}

/** Read + parse a CSV, returning [] when the file is missing/unreadable. */
function readCsvIfExists(file) {
  try { return parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return []; }
}

/** Upsert rows by username (later sources win); preserves first-seen order. */
function upsertRows(existing, adds) {
  const byKey = new Map();
  const order = [];
  for (const r of [...existing, ...adds]) {
    const k = normUser(r && r.username);
    if (!k) continue;
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, r);
  }
  return order.map((k) => byKey.get(k));
}

/** Deterministic order: bucket A then B, then category, then username. */
function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket === 'A' ? -1 : 1;
    if (a.category !== b.category) return String(a.category).localeCompare(String(b.category));
    return String(a.username).localeCompare(String(b.username));
  });
}

function parseArgs(argv) {
  const opts = {
    candidates: null, // optional CSV to ingest into the Sheet
    localCsv: null, // optional local mirror (read + written)
    target: CONFIG.criteria.target, // informational (rule 1: single-pool output of NEW users)
    sheetUrl: null,
    syncSheet: true, // P8: Sheet sync is on by default; --no-sheet opts out.
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--candidates': opts.candidates = path.resolve(next()); break;
      case '--local-csv':
      case '--out': opts.localCsv = path.resolve(next()); break;
      case '--target': opts.target = Math.max(1, parseInt(next(), 10)); break;
      case '--sheet-url': opts.sheetUrl = String(next()).trim(); break;
      case '--sync-sheet': opts.syncSheet = true; break;
      case '--no-sheet': opts.syncSheet = false; break;
      case '-h':
      case '--help': opts.help = true; break;
      default: break;
    }
  }
  return opts;
}

const HELP = `build-targets.js — verify/repair the targeted-users Google Sheet (phase 2)

  node build-targets.js [options]

  The scanner already writes each NEW user straight to the Sheet (CSV-free).
  This script does NOT validate with AI. It reads the Sheet, optionally ingests
  a CSV, enforces the strict 8-column schema / de-dup (preserving row order and
  the solid-black separator row), re-applies the table's visual design, and
  prints the Sheet URL. It never re-sorts the table.

  --candidates <file>   Optional CSV to ingest into the Sheet
  --local-csv <file>    Optional local mirror written from the Sheet (also read)
  --target <n>          Informational NEW-user target            (default ${CONFIG.criteria.target})
  --sheet-url <url>     Override the configured Sheet (or env X_SHEET_WEBAPP_URL)
  --sync-sheet          Upsert the clean rows to the Sheet       (default)
  --no-sheet            Do not touch the Sheet (needs --candidates/--local-csv)
  -h, --help

  Sheet modes (auto-detected): direct Google Sheets API via sheet-config.json
  { "spreadsheetId": "..." }, or an Apps Script Web App URL (write-only - reads
  need direct mode). A locked --local-csv mirror is reported as DEGRADED and the
  staged copy is preserved - never a false success.

  Output columns (strict): ${OUT_COLUMNS.join(', ')}
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }

  let degraded = false;

  // ---- 1. Read the Sheet (single source of truth; order + separators kept) --
  const sheetCfg = opts.syncSheet || opts.sheetUrl ? sheets.resolveDirectConfig(opts.sheetUrl) : null;
  let segments = [[]]; // groups of rows split by the solid-black separator row(s)
  if (sheetCfg) {
    const r = await sheets.fetchSheetGrid(sheetCfg);
    if (r.ok) {
      for (const raw of r.rows) {
        if (raw.every((v) => String(v == null ? '' : v).trim() === '')) {
          if (segments[segments.length - 1].length) segments.push([]);
          continue;
        }
        const obj = {};
        OUT_COLUMNS.forEach((h, i) => { obj[h] = raw[i]; });
        segments[segments.length - 1].push(normalizeRow(obj));
      }
      while (segments.length && !segments[segments.length - 1].length) segments.pop();
      if (!segments.length) segments = [[]];
      const readCount = segments.reduce((n, s) => n + s.length, 0);
      console.log(`Google Sheet DB: read ${readCount} existing row(s) from "${sheetCfg.sheetName}" (${segments.length} group(s)).`);
    } else {
      console.log(`Google Sheet DB: read failed (${r.error}).`);
      if (opts.syncSheet && !opts.candidates && !opts.localCsv) degraded = true;
    }
  } else if (opts.syncSheet) {
    console.log('Google Sheet: not configured (no spreadsheetId/webAppUrl).');
    if (!opts.candidates && !opts.localCsv) {
      console.error('Nothing to do: configure the Sheet, or pass --candidates/--local-csv.');
      process.exit(2);
    }
    degraded = true;
  }

  // ---- 2. Optional local CSV ingestion -------------------------------------
  const ingests = [];
  if (opts.candidates) {
    const rows = readCsvIfExists(opts.candidates);
    console.log(`Ingest: ${rows.length} row(s) from ${opts.candidates}`);
    ingests.push(...rows);
  }
  if (opts.localCsv) {
    const rows = readCsvIfExists(opts.localCsv);
    if (rows.length) console.log(`Ingest: ${rows.length} row(s) from the local mirror ${opts.localCsv}`);
    ingests.push(...rows);
  }

  // ---- 3. Normalise + de-dup in place (order preserved - NEVER re-sorted) ---
  // The Sheet's row order, its visual design and the black separator row are
  // preserved; any CSV rows are appended to the newest group (after the sep).
  if (ingests.length) {
    if (!segments.length) segments = [[]];
    segments[segments.length - 1].push(...ingests.map(normalizeRow));
  }
  const seenUsers = new Set();
  const keptSegments = segments
    .map((seg) => {
      const kept = [];
      for (const r of seg) {
        const k = normUser(r.username);
        if (!k || seenUsers.has(k)) continue;
        seenUsers.add(k);
        kept.push(r);
      }
      return kept;
    })
    .filter((s) => s.length);

  const clean = keptSegments.flat();
  const counts = {};
  for (const k of BUCKET_KEYS) counts[k] = 0;
  for (const r of clean) counts[r.bucket] = (counts[r.bucket] || 0) + 1;

  // Blank row between groups => a preserved solid-black separator row.
  const matrix = [];
  keptSegments.forEach((seg, i) => {
    if (i > 0) matrix.push(OUT_COLUMNS.map(() => ''));
    for (const r of seg) matrix.push(OUT_COLUMNS.map((h) => (r[h] == null ? '' : r[h])));
  });

  // ---- 4. Write the preserved-order set back to the Sheet (idempotent) ------
  if (opts.syncSheet && sheetCfg && matrix.length) {
    try {
      const res = await sheets.writeGridDirect(matrix, sheetCfg);
      if (res && res.ok) {
        console.log(`Google Sheet: ${clean.length} row(s) verified/upserted (order + separator preserved, design re-applied).`);
      } else {
        degraded = true;
        console.log(`Google Sheet: sync failed - ${(res && res.error) || 'unknown error'}`);
      }
    } catch (err) {
      degraded = true;
      console.log(`Google Sheet: sync failed - ${err.message}`);
    }
  } else if (opts.syncSheet && !matrix.length) {
    console.log('Google Sheet: nothing to sync (0 rows).');
  } else if (!opts.syncSheet) {
    console.log('Google Sheet: skipped (--no-sheet).');
  }

  // ---- 5. Optional local mirror --------------------------------------------
  if (opts.localCsv) {
    const writeRes = safeWriteCsv(opts.localCsv, toCsv(compactRows(clean)));
    if (writeRes.ok) {
      console.log(`Local mirror: ${opts.localCsv} (${clean.length} row(s))`);
    } else if (writeRes.staged) {
      degraded = true;
      console.log(`DEGRADED: mirror locked - latest state preserved in ${writeRes.staging}`);
    } else {
      degraded = true;
      console.log(`  ! could not write ${opts.localCsv}: ${writeRes.error}`);
    }
  }

  // ---- 6. Report ------------------------------------------------------------
  const countParts = BUCKET_KEYS.map((k) => `${k}(${BUCKET_NAMES[k] || k})=${counts[k] || 0}`);
  console.log(`Verified ${clean.length} target row(s): ${countParts.join('  ')}`);
  if (clean.length < opts.target) {
    console.log(`Note: ${clean.length} row(s) < --target ${opts.target} - run the scanner again to collect more.`);
  }
  const url = sheetCfg ? sheets.sheetEditUrl(sheetCfg.spreadsheetId) : null;
  if (url) console.log(`Google Sheet: ${url}`);

  if (degraded) {
    process.exitCode = 1;
    console.log('Status: DEGRADED (see warnings above).');
  }
}

/** Keep only the strict 8 columns, in order. */
function compactRows(rows) {
  return rows.map((r) => {
    const o = {};
    for (const h of OUT_COLUMNS) o[h] = r[h] == null ? '' : r[h];
    return o;
  });
}

if (require.main === module) {
  const handleErr = (err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('Error:', msg);
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

module.exports = { main, safeWriteCsv, normalizeRow, toCsv, compactRows, sortRows, upsertRows, OUT_COLUMNS };
