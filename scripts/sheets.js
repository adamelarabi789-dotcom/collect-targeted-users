'use strict';
/**
 * sheets.js — append verified profiles to a Google Sheet.
 *
 * Two modes, picked automatically (first match wins):
 *   1. Web App mode  — POSTs to a Google Apps Script Web App URL (deployed
 *      from the Sheet: Extensions > Apps Script > Deploy > New deployment >
 *      Web app, "Anyone" access). Works on any machine with an internet
 *      connection; requires one manual deploy step.
 *   2. Direct mode — talks to the Google Sheets API v4 using a local OAuth
 *      token (tokens.json from the google-drive-mcp setup). No manual deploy
 *      needed: set `spreadsheetId` in sheet-config.json and the sync works
 *      with the credentials already on disk.
 *
 * Config resolution order for a Web App URL:
 *   1. explicit --sheet-url flag passed to the caller
 *   2. env X_SHEET_WEBAPP_URL (or GOOGLE_SHEETS_WEBAPP_URL)
 *   3. <repo>/sheet-config.json      ->  { "webAppUrl": "https://.../exec" }
 *   4. <repo>/data/sheet-config.json (same shape)
 *   5. <repo>/config.json            ->  { "export": { "webAppUrl": "..." } }
 *
 * Direct-mode config (env vars, sheet-config.json or config.json "export"):
 *   {
 *     "spreadsheetId": "YOUR_SPREADSHEET_ID",
 *     "sheetName": "Targets",
 *     "tokenPath": "~/.config/google-drive-mcp/tokens.json"
 *   }
 *
 * You can instead supply the same values purely via environment variables:
 *   X_SHEET_ID              -> spreadsheetId
 *   X_GOOGLE_TOKEN_PATH     -> tokenPath (default: ~/.config/google-drive-mcp/tokens.json)
 *
 * Rows are upserted by username, so logging a candidate during the scan and
 * again after AI verification updates the same row instead of duplicating it.
 * Each write wipes the used grid and rewrites ONLY the strict 8-column header +
 * upserted rows, so stale legacy columns/rows are cleared and malformed values
 * (e.g. a non-URL profileUrl) are repaired automatically.
 * If nothing is configured the helper no-ops (ok:false, skipped:true).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

// No hard-coded absolute paths - an explicit env override wins, otherwise fall
// back to the repo root when the shared Playwright helpers are bundled here
// (the default layout of this repository), else to the conventional
// <home>/twitter-playwright install.
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJ =
  process.env.PROJ_ROOT ||
  process.env.TWITTER_PLAYWRIGHT_DIR ||
  (fs.existsSync(path.join(REPO_ROOT, 'lib', 'twitter.js'))
    ? REPO_ROOT
    : path.join(os.homedir(), 'twitter-playwright'));
const SKILL_ROOT = REPO_ROOT;

// Default OAuth token path (match google-drive-mcp layout), overridable with
// X_GOOGLE_TOKEN_PATH or tokenPath in sheet-config.json.
const DEFAULT_TOKEN_PATH = process.env.X_GOOGLE_TOKEN_PATH ||
  path.join(os.homedir(), '.config', 'google-drive-mcp', 'tokens.json');

// Strict 8-column output schema, shared with the CSV output.
const { COLUMNS } = require('./columns');
const HEADERS = COLUMNS;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

// sheet-config.json locations, repo root first, then the project dir, then the
// legacy skill data/ folder.
const SHEET_CFG_FILES = [
  path.join(REPO_ROOT, 'sheet-config.json'),
  path.join(PROJ, 'sheet-config.json'),
  path.join(SKILL_ROOT, 'data', 'sheet-config.json'),
];

/**
 * Export endpoints from config.json (config.export), so the Sheet sink can be
 * configured in ONE place. Returns null when nothing is set.
 */
function configExport() {
  let cfg;
  try {
    cfg = require('./config').get();
  } catch {
    return null;
  }
  const e = (cfg && cfg.export) || {};
  const out = {};
  if (e.spreadsheetId) out.spreadsheetId = e.spreadsheetId;
  if (e.sheetName) out.sheetName = e.sheetName;
  if (e.tokenPath) out.tokenPath = e.tokenPath;
  if (e.webAppUrl) out.webAppUrl = e.webAppUrl;
  return Object.keys(out).length ? out : null;
}

/**
 * First configured sheet-config.json found (project wins), or null. Values from
 * config.json's `export` block are merged in as a base, so sheet-config.json
 * overrides it but you only need one of the two.
 */
function loadConfig() {
  let fileCfg = null;
  for (const p of SHEET_CFG_FILES) {
    const j = readJson(p);
    if (j) { fileCfg = j; break; }
  }
  const exportCfg = configExport();
  if (fileCfg && exportCfg) return { ...exportCfg, ...fileCfg };
  return fileCfg || exportCfg;
}

/**
 * Direct-mode (Sheets API v4) config. Reads and writes both need this mode;
 * a Web App URL alone cannot be read back. Returns null when no spreadsheetId.
 */
function resolveDirectConfig(explicit) {
  const envId = (process.env.X_SHEET_ID || '').trim();
  const cfg = loadConfig();
  const spreadsheetId = (cfg && cfg.spreadsheetId) || envId || null;
  if (!spreadsheetId) return null;
  return {
    mode: 'direct',
    spreadsheetId: String(spreadsheetId).trim(),
    sheetName: String((cfg && cfg.sheetName) || 'Targets').trim(),
    tokenPath: (cfg && cfg.tokenPath) || DEFAULT_TOKEN_PATH,
  };
}

/** Public, clickable edit URL for a spreadsheet id. */
function sheetEditUrl(spreadsheetId) {
  return spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : null;
}

/**
 * Read the configured tab back as strict 8-column row objects. This is the
 * de-duplication source AND the "existing database" for the quota report.
 * Never throws: returns { ok, rows, header, config, url } or { ok:false, error }.
 */
async function fetchSheetRows(opts = {}) {
  const sink = opts.spreadsheetId
    ? {
        mode: 'direct',
        spreadsheetId: String(opts.spreadsheetId).trim(),
        sheetName: (opts.sheetName || 'Targets').trim(),
        tokenPath: opts.tokenPath || DEFAULT_TOKEN_PATH,
      }
    : resolveDirectConfig(opts.url);
  if (!sink) {
    return { ok: false, skipped: true, reason: 'no spreadsheetId configured (reads need direct API mode)', rows: [] };
  }
  try {
    const token = await getAccessToken(sink.tokenPath);
    const meta = await findSheet(token, sink.spreadsheetId, sink.sheetName);
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sink.spreadsheetId)}/values`;
    const range = `${meta.title}!A1:${colLetter(Math.max(meta.columnCount, HEADERS.length))}${meta.rowCount}`;
    const snap = await sheetsRequest(`${base}/${encodeURIComponent(range)}`, token);
    const vals = (snap && snap.values) || [];
    const header = (vals[0] || []).map((h) => String(h).trim());
    const rows = [];
    if (header.length) {
      const idx = {};
      header.forEach((h, i) => { if (h) idx[h] = i; });
      for (const line of vals.slice(1)) {
        if (!line || !line.length) continue;
        const obj = {};
        for (const h of HEADERS) obj[h] = line[idx[h]] == null ? '' : line[idx[h]];
        if (String(obj.username || '').trim()) rows.push(normalizeRow(obj));
      }
    }
    return { ok: true, rows, header, config: sink, url: sheetEditUrl(sink.spreadsheetId) };
  } catch (err) {
    return { ok: false, error: err.message, rows: [] };
  }
}

/** Resolve the sheet sink from explicit flag -> env -> config files. */
function resolveSheetConfig(explicit) {
  const cfg = loadConfig();

  const explicitUrl = explicit && String(explicit).trim();
  const envUrl = (process.env.X_SHEET_WEBAPP_URL || process.env.GOOGLE_SHEETS_WEBAPP_URL || '').trim();

  if (explicitUrl) return { mode: 'webapp', url: explicitUrl };
  if (envUrl) return { mode: 'webapp', url: envUrl };
  if (cfg && (cfg.webAppUrl || cfg.url)) return { mode: 'webapp', url: String(cfg.webAppUrl || cfg.url).trim() };
  if (cfg && cfg.spreadsheetId) {
    return {
      mode: 'direct',
      spreadsheetId: String(cfg.spreadsheetId).trim(),
      sheetName: (cfg.sheetName || 'Targets').trim(),
      tokenPath: cfg.tokenPath || DEFAULT_TOKEN_PATH,
    };
  }
  return null;
}

/** Back-compat: just the Web App URL, or null. */
function resolveSheetUrl(explicit) {
  const c = resolveSheetConfig(explicit);
  return c && c.mode === 'webapp' ? c.url : null;
}

function requestOnce(url, { method = 'POST', body = null, timeoutMs = 20000, headers = {}, form = false } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('Invalid URL: ' + url));
    }
    const lib = u.protocol === 'http:' ? http : https;
    const hs = { ...headers };
    let payload = null;
    if (body != null) {
      payload = Buffer.from(body);
      if (!form) hs['Content-Type'] = hs['Content-Type'] || 'application/json';
      hs['Content-Length'] = payload.length;
    }
    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: hs,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Apps Script web apps reply with a 302 to a googleusercontent result URL,
// so POST then follow the redirect with GET (browsers/`fetch` do the same).
async function requestFollow(url, { method = 'POST', body = null, timeoutMs = 20000, maxRedirects = 5 } = {}) {
  let res = await requestOnce(url, { method, body, timeoutMs });
  let hops = 0;
  while (res.status >= 300 && res.status < 400 && res.headers.location && hops < maxRedirects) {
    const next = new URL(res.headers.location, url).toString();
    res = await requestOnce(next, { method: 'GET', body: null, timeoutMs });
    hops++;
  }
  if (res.status >= 200 && res.status < 300) return res.body;
  throw new Error(`HTTP ${res.status}: ${String(res.body || '').slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Direct Google Sheets API v4 mode (no Apps Script Web App needed)
// ---------------------------------------------------------------------------

async function sheetsRequest(url, token, { method = 'GET', body = null } = {}) {
  const res = await requestOnce(url, {
    method,
    body: body == null ? null : JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + token },
  });
  if (res.status >= 200 && res.status < 300) {
    return res.body ? JSON.parse(res.body) : null;
  }
  if (res.status === 404) return null;
  throw new Error(`Sheets API HTTP ${res.status}: ${String(res.body || '').slice(0, 300)}`);
}

/** Load an access token; refresh through the token endpoint when needed. */
async function getAccessToken(tokenPath = DEFAULT_TOKEN_PATH) {
  const tok = readJson(tokenPath);
  if (!tok || !tok.access_token) throw new Error('token file missing access_token: ' + tokenPath);
  if (tok.expiry_date && Date.now() < tok.expiry_date - 60 * 1000) return tok.access_token;
  if (!tok.refresh_token) throw new Error('token expired and no refresh_token in ' + tokenPath);

  // Locate OAuth client id/secret next to the token file.
  const dir = path.dirname(tokenPath);
  const candidates = ['gcp-oauth.keys.json', 'credentials.json', 'client_secret.json'];
  const oauthFile = candidates.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!oauthFile) throw new Error('no OAuth client file found next to ' + tokenPath);

  const j = JSON.parse(fs.readFileSync(oauthFile, 'utf8').replace(/^\uFEFF/, ''));
  const c = j.installed || j.web || j;
  const tokenUri = c.token_uri || 'https://oauth2.googleapis.com/token';
  const formBody =
    'grant_type=refresh_token' +
    '&refresh_token=' + encodeURIComponent(tok.refresh_token) +
    '&client_id=' + encodeURIComponent(c.client_id) +
    '&client_secret=' + encodeURIComponent(c.client_secret);

  const res = await requestOnce(tokenUri, {
    method: 'POST',
    body: formBody,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (res.status >= 200 && res.status < 300) {
    const t = JSON.parse(res.body);
    tok.access_token = t.access_token;
    if (t.expires_in) tok.expiry_date = Date.now() + (t.expires_in - 60) * 1000;
    fs.writeFileSync(tokenPath, JSON.stringify(tok, null, 2), 'utf8');
    return tok.access_token;
  }
  throw new Error('token refresh failed HTTP ' + res.status + ': ' + String(res.body || '').slice(0, 200));
}

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Coerce a row into the strict 8-column schema (regenerating a bad profileUrl). */
function normalizeRow(r) {
  const out = {};
  for (const h of HEADERS) out[h] = r[h] == null ? '' : String(r[h]);
  const name = out.username.trim().replace(/^@/, '');
  out.username = name;
  if (!/^https?:\/\//i.test(out.profileUrl)) out.profileUrl = name ? `https://x.com/${name}` : '';
  return out;
}

/**
 * Find the target tab + its grid size, creating the tab when it is missing.
 * @returns {Promise<{title: string, sheetId: number, rowCount: number, columnCount: number}>}
 */
async function findSheet(token, spreadsheetId, sheetName) {
  const field = 'sheets.properties(sheetId,title,gridProperties)';
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(field)}`;
  const pick = (meta) => {
    const list = (meta && meta.sheets) || [];
    return list.find((s) => String(s.properties.title).toLowerCase() === String(sheetName).toLowerCase());
  };
  let hit = pick(await sheetsRequest(metaUrl, token));
  if (!hit) {
    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
    await sheetsRequest(batchUrl, token, {
      method: 'POST',
      body: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    hit = pick(await sheetsRequest(metaUrl, token));
  }
  if (!hit) throw new Error('Could not find or create sheet tab: ' + sheetName);
  const g = hit.properties.gridProperties || {};
  return {
    title: hit.properties.title,
    sheetId: hit.properties.sheetId,
    rowCount: g.rowCount || 1000,
    columnCount: g.columnCount || 26,
  };
}

// ---------------------------------------------------------------------------
// Visual design (matches the existing "Targets" table exactly).
//   bucket col A : dark gold     category/username/url left, numbers centered
//   data cols B-H: light gray    bio col F stays centered (as in the table)
//   separator    : solid black   an empty black row between runs
// NOTE: the Sheets API quantises colors to 8-bit and treats pure #000000 as
// "unset" (which renders white), so the separator uses #010101 - the darkest
// representable fill, visually indistinguishable from solid black.
// ---------------------------------------------------------------------------
const SEPARATOR_RGB = 0.00392156862745098; // 1/255 == #010101
const SHEET_STYLE = {
  bucketBg: { red: 0.7490196, green: 0.5647059, blue: 0 },
  dataBg: { red: 0.9529412, green: 0.9529412, blue: 0.9529412 },
  separatorBg: { red: SEPARATOR_RGB, green: SEPARATOR_RGB, blue: SEPARATOR_RGB },
};

/** True when every one of the 8 columns in a row is blank (a separator row). */
function isBlankRow(r) {
  return HEADERS.every((_, i) => String(r[i] == null ? '' : r[i]).trim() === '');
}

/**
 * Build the batchUpdate requests that replicate the table's visual design over
 * a matrix of data rows (index 0 = sheet row 2). Blank rows become solid-black
 * separators; everything below the table is reset so stale paints never linger.
 */
function buildFormatRequests(sheetId, rowCount, columnCount, matrix) {
  const n = matrix.length;
  if (!n || sheetId == null) return [];
  const cols = Math.max(columnCount, HEADERS.length, 1);
  const dataStart = 2; // sheet row of matrix[0]
  const dataEnd = 1 + n; // inclusive
  const range = (r0, r1, c0, c1) => ({
    sheetId,
    startRowIndex: r0 - 1,
    endRowIndex: r1,
    startColumnIndex: c0 - 1,
    endColumnIndex: c1,
  });
  const BG = 'userEnteredFormat.backgroundColor';
  const ALIGN = 'userEnteredFormat.horizontalAlignment';
  const requests = [];

  // 1. Wipe any stale formatting across the whole data block (all columns).
  requests.push({
    repeatCell: { range: range(dataStart, dataEnd, 1, cols), cell: {}, fields: 'userEnteredFormat' },
  });
  // 2. Column A (bucket) - dark gold.
  requests.push({
    repeatCell: {
      range: range(dataStart, dataEnd, 1, 1),
      cell: { userEnteredFormat: { backgroundColor: SHEET_STYLE.bucketBg } },
      fields: BG,
    },
  });
  // 3. Columns B-C (category, username) - light gray, left aligned.
  requests.push({
    repeatCell: {
      range: range(dataStart, dataEnd, 2, 3),
      cell: { userEnteredFormat: { backgroundColor: SHEET_STYLE.dataBg, horizontalAlignment: 'LEFT' } },
      fields: `${BG},${ALIGN}`,
    },
  });
  // 4. Column D (profileUrl) - left aligned + a real hyperlink per row.
  requests.push({
    updateCells: {
      range: range(dataStart, dataEnd, 4, 4),
      rows: matrix.map((r) => {
        const uri = String(r[3] == null ? '' : r[3]).trim();
        const fmt = { backgroundColor: SHEET_STYLE.dataBg, horizontalAlignment: 'LEFT' };
        if (uri) fmt.textFormat = { link: { uri } };
        return { values: [{ userEnteredFormat: fmt }] };
      }),
      fields: `${BG},${ALIGN},userEnteredFormat.textFormat.link`,
    },
  });
  // 5. Columns E-H (numbers) - light gray, centered.
  requests.push({
    repeatCell: {
      range: range(dataStart, dataEnd, 5, 8),
      cell: { userEnteredFormat: { backgroundColor: SHEET_STYLE.dataBg, horizontalAlignment: 'CENTER' } },
      fields: `${BG},${ALIGN}`,
    },
  });
  // 6. Separator rows - solid black (overrides the data background above).
  matrix.forEach((r, i) => {
    if (!isBlankRow(r)) return;
    const rowNo = dataStart + i;
    requests.push({
      repeatCell: {
        range: range(rowNo, rowNo, 1, HEADERS.length),
        cell: { userEnteredFormat: { backgroundColor: SHEET_STYLE.separatorBg } },
        fields: BG,
      },
    });
  });
  // 7. Reset formatting below the table so old separator paints don't linger.
  if (dataEnd < rowCount) {
    requests.push({
      repeatCell: { range: range(dataEnd + 1, rowCount, 1, cols), cell: {}, fields: 'userEnteredFormat' },
    });
  }
  return requests;
}

/**
 * Write a full ordered matrix of data rows (array of 8-value arrays; an
 * all-blank row renders as a solid-black separator row). Rewrites the header +
 * matrix and re-applies the table's visual design. This is the single writer
 * used by both the scanner (append/upsert) and the finalizer (preserve order).
 */
async function writeMatrix(token, spreadsheetId, meta, matrix, { format = true } = {}) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values`;
  const cols = Math.max(meta.columnCount, HEADERS.length, 1);
  const fullGrid = `${meta.title}!A1:${colLetter(cols)}${meta.rowCount}`;
  const clean = matrix.map((r) => HEADERS.map((_, i) => {
    const v = r[i];
    return v == null ? '' : typeof v === 'string' ? v : String(v);
  }));
  const block = [HEADERS.slice(), ...clean];
  const blockRange = `${meta.title}!A1:${colLetter(HEADERS.length)}${block.length}`;

  await sheetsRequest(`${base}/${encodeURIComponent(fullGrid)}:clear`, token, { method: 'POST', body: {} });
  await sheetsRequest(`${base}/${encodeURIComponent(blockRange)}?valueInputOption=RAW`, token, {
    method: 'PUT',
    body: { values: block, majorDimension: 'ROWS' },
  });

  if (format) {
    const requests = buildFormatRequests(meta.sheetId, meta.rowCount, meta.columnCount, clean);
    if (requests.length) {
      const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
      await sheetsRequest(batchUrl, token, { method: 'POST', body: { requests } });
    }
  }
  return { rows: clean.length };
}

/**
 * Upsert rows into a sheet via the Sheets API v4 and strictly enforce the
 * 8-column schema. The whole used grid is cleared and rewritten with a clean
 * header + upserted rows, so stale legacy columns/rows disappear automatically
 * and re-syncing never duplicates. Malformed rows (bad profileUrl) are repaired.
 *
 * With `separator` the writer keeps exactly ONE solid-black empty row between
 * the pre-existing table and the rows being written, and paints the rows to
 * match the table's visual design. Because the caller re-sends the whole run
 * each write, this is idempotent (one separator per run) and crash-safe.
 */
async function appendRowsDirect(rows, { spreadsheetId, sheetName = 'Targets', tokenPath = DEFAULT_TOKEN_PATH, separator = false, format = true } = {}) {
  if (!spreadsheetId) return { ok: false, skipped: true, reason: 'no spreadsheetId configured' };
  if (!rows || !rows.length) return { ok: true, count: 0 };

  const token = await getAccessToken(tokenPath);
  const meta = await findSheet(token, spreadsheetId, sheetName);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values`;
  const cols = Math.max(meta.columnCount, HEADERS.length, 1);
  const fullGrid = `${meta.title}!A1:${colLetter(cols)}${meta.rowCount}`;

  // Read whatever is currently in the grid.
  let vals = [];
  try {
    const snap = await sheetsRequest(`${base}/${encodeURIComponent(fullGrid)}`, token);
    vals = (snap && snap.values) || [];
  } catch {
    vals = [];
  }

  // Only trust existing data when its header is EXACTLY our 8 columns; anything
  // else is stale legacy content (e.g. a wide 13-column block) and is cleared.
  const headerRow = vals[0] || [];
  const strictHeader =
    headerRow.length === HEADERS.length &&
    HEADERS.every((h, i) => String(headerRow[i]).trim() === h);
  const clearedLegacy = !strictHeader;

  // Existing rows in sheet order (separator/blank rows are skipped here).
  const existing = new Map();
  if (strictHeader) {
    const idx = {};
    headerRow.forEach((h, i) => { idx[String(h).trim()] = i; });
    for (const line of vals.slice(1)) {
      if (!line || !line.length) continue;
      const obj = {};
      for (const h of HEADERS) obj[h] = line[idx[h]];
      const norm = normalizeRow(obj);
      if (norm.username) existing.set(norm.username.toLowerCase(), norm);
    }
  }

  // This write's rows (the run's NEW users), de-duped in first-seen order.
  const runMap = new Map();
  for (const r of rows) {
    const norm = normalizeRow(r);
    const key = norm.username.toLowerCase();
    if (!key) continue;
    runMap.set(key, norm);
  }
  if (!runMap.size) return { ok: true, added: 0, updated: 0, count: 0, rows: existing.size, cleared: clearedLegacy };

  const runKeys = new Set(runMap.keys());
  // Baseline = everything already in the Sheet that is NOT part of this write.
  const baseline = [...existing.entries()].filter(([k]) => !runKeys.has(k)).map(([, v]) => v);

  let added = 0;
  let updated = 0;
  for (const key of runMap.keys()) { if (existing.has(key)) updated++; else added++; }

  const toArr = (o) => HEADERS.map((h) => o[h]);
  const blank = HEADERS.map(() => '');
  const useSep = separator && baseline.length > 0;
  const matrix = [
    ...baseline.map(toArr),
    ...(useSep ? [blank] : []),
    ...[...runMap.values()].map(toArr),
  ];

  const wrote = await writeMatrix(token, spreadsheetId, meta, matrix, { format });
  return { ok: true, added, updated, count: runMap.size, rows: wrote.rows, cleared: clearedLegacy, separator: useSep };
}

/**
 * Read the tab as a raw, order-preserving matrix of 8-value rows (blank
 * separator rows are KEPT, unlike fetchSheetRows). Trailing blanks are trimmed.
 * @returns {Promise<{ok: boolean, header?: string[], rows: string[][], config?: object, url?: string, error?: string}>}
 */
async function fetchSheetGrid(opts = {}) {
  const sink = opts.spreadsheetId
    ? {
        mode: 'direct',
        spreadsheetId: String(opts.spreadsheetId).trim(),
        sheetName: (opts.sheetName || 'Targets').trim(),
        tokenPath: opts.tokenPath || DEFAULT_TOKEN_PATH,
      }
    : resolveDirectConfig(opts.url);
  if (!sink) return { ok: false, skipped: true, reason: 'no spreadsheetId configured (reads need direct API mode)', rows: [] };
  try {
    const token = await getAccessToken(sink.tokenPath);
    const meta = await findSheet(token, sink.spreadsheetId, sink.sheetName);
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sink.spreadsheetId)}/values`;
    const range = `${meta.title}!A1:${colLetter(HEADERS.length)}${meta.rowCount}`;
    const snap = await sheetsRequest(`${base}/${encodeURIComponent(range)}`, token);
    const vals = (snap && snap.values) || [];
    const header = (vals[0] || []).map((h) => String(h).trim());
    let last = vals.length - 1;
    while (last > 0 && (!vals[last] || !vals[last].some((c) => String(c == null ? '' : c).trim()))) last--;
    const rows = [];
    for (let i = 1; i <= last; i++) {
      const line = vals[i] || [];
      rows.push(HEADERS.map((_, c) => (line[c] == null ? '' : String(line[c]))));
    }
    return { ok: true, header, rows, config: sink, url: sheetEditUrl(sink.spreadsheetId) };
  } catch (err) {
    return { ok: false, error: err.message, rows: [] };
  }
}

/**
 * Write an exact ordered matrix (8-value rows; blank rows become black
 * separators) with the table's visual design. Used by the finalizer so it can
 * preserve row order + the separator instead of re-sorting the Sheet.
 */
async function writeGridDirect(matrix, { spreadsheetId, sheetName = 'Targets', tokenPath = DEFAULT_TOKEN_PATH, format = true } = {}) {
  if (!spreadsheetId) return { ok: false, skipped: true, reason: 'no spreadsheetId configured' };
  const token = await getAccessToken(tokenPath);
  const meta = await findSheet(token, spreadsheetId, sheetName);
  const wrote = await writeMatrix(token, spreadsheetId, meta, matrix || [], { format });
  return { ok: true, rows: wrote.rows };
}

/**
 * Append/upsert rows (any configured mode). Returns a small result object; never throws.
 * @param {Array<object>} rows
 * @param {{url?: string, label?: string}} [opts]
 */
async function appendRows(rows, { url, label } = {}) {
  const sink = resolveSheetConfig(url);
  if (!sink) return { ok: false, skipped: true, reason: 'no Google Sheet configured (webAppUrl or spreadsheetId)' };
  if (!rows || !rows.length) return { ok: true, count: 0 };
  try {
    if (sink.mode === 'webapp') {
      await requestFollow(sink.url, { method: 'POST', body: JSON.stringify({ action: 'upsert', rows }) });
      return { ok: true, count: rows.length };
    }
    return await appendRowsDirect(rows, sink);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DEFAULT_SHEET_NAME = 'Targeted Users Tracker';

async function ensureAndAppend(rows, { url, label } = {}) {
  const explicitUrl = url ? String(url).trim() : '';
  const envUrl = (process.env.X_SHEET_WEBAPP_URL || process.env.GOOGLE_SHEETS_WEBAPP_URL || '').trim();
  let cfg = configExport();
  const cfgFiles = [path.join(PROJ, 'sheet-config.json'), path.join(SKILL_ROOT, 'data', 'sheet-config.json')];
  for (const p of cfgFiles) {
    const j = readJson(p);
    if (j) { cfg = { ...(cfg || {}), ...j }; break; }
  }

  // Try direct mode first if we have spreadsheetId
  if (cfg && cfg.spreadsheetId) {
    try {
      const res = await appendRowsDirect(rows, { spreadsheetId: cfg.spreadsheetId, sheetName: cfg.sheetName || 'Targets', tokenPath: cfg.tokenPath || DEFAULT_TOKEN_PATH });
      return { ok: true, ...res, mode: 'direct-api' };
    } catch (e) {
      // If direct fails, try to create new sheet
    }
  }

  // Need to create new sheet
  try {
    const token = await getAccessToken(cfg && cfg.tokenPath ? cfg.tokenPath : DEFAULT_TOKEN_PATH);
    const body = {
      name: DEFAULT_SHEET_NAME,
      mimeType: 'application/vnd.google-apps.spreadsheet',
    };
    const res = await requestOnce(DRIVE_API, { method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer ' + token } });
    if (res.status >= 200 && res.status < 300) {
      const j = JSON.parse(res.body);
      const spreadsheetId = j.id;
      const spreadsheetUrl = j.webViewLink || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
      const newCfg = { spreadsheetId, sheetName: 'Targets', createdAt: new Date().toISOString() };
      for (const p of cfgFiles) {
        try { fs.writeFileSync(p, JSON.stringify(newCfg, null, 2), 'utf8'); break; } catch (e) {}
      }
      const appendRes = await appendRowsDirect(rows, { spreadsheetId, sheetName: 'Targets', tokenPath: cfg && cfg.tokenPath ? cfg.tokenPath : DEFAULT_TOKEN_PATH });
      return { ok: true, created: true, spreadsheetId, spreadsheetUrl, ...appendRes, mode: 'direct-api' };
    }
    throw new Error('Drive API failed: ' + res.status);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  resolveSheetUrl,
  resolveSheetConfig,
  resolveDirectConfig,
  loadConfig,
  sheetEditUrl,
  fetchSheetRows,
  fetchSheetGrid,
  appendRows,
  appendRowsDirect,
  writeGridDirect,
  writeMatrix,
  buildFormatRequests,
  findSheet,
  normalizeRow,
  getAccessToken,
  requestFollow,
  ensureAndAppend,
  HEADERS,
  SHEET_STYLE,
};