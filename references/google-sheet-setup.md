# Google Sheet logging (Apps Script Web App)

The **scanner** (`scan-candidates.js`, Phase 1) writes every NEW user **straight
to a Google Sheet as it is found** (the Sheet is the database); the **builder**
(`build-targets.js`, Phase 2) is a Sheet-native verifier that re-reads the Sheet
and upserts the clean set. There is **no AI validation step and no CSV
database**. It either POSTs JSON to a Google Apps Script **Web App URL**, or
talks to the **Google Sheets API v4 directly** using the local OAuth token — no
npm packages, no service account.

The Sheet uses the **strict 8-column schema** (`bucket`, `category`, `username`,
`profileUrl`, `followers`, `bio`, `daysSinceLastPost`, `postsLast7Days`), shared
via `scripts/columns.js` (also used by the optional `--local-csv` mirror). The
Apps Script `HEADERS` array below must match it.

> **Preferred for local use: direct mode.** `sheet-config.json` only needs a
> `spreadsheetId` (plus optional `sheetName` and `tokenPath`) and sync works
> with the OAuth token already on disk (`~/.config/google-drive-mcp/tokens.json`).
> No manual Apps Script deploy required. The Web App is still supported for
> machines without a local token.

## 0. Quick start (direct mode, no Apps Script)

1. Create the spreadsheet in Google Drive (or use an existing one) and note the
   **spreadsheet ID** from its URL:
   `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
2. Copy `sheet-config.example.json` to `sheet-config.json` at the repo root and
   fill in your own ID (never commit the real file - it is git-ignored):

```json
{
  "spreadsheetId": "YOUR_SPREADSHEET_ID",
  "sheetName": "Targets",
  "tokenPath": "~/.config/google-drive-mcp/tokens.json"
}
```

   You can also provide the ID and token path purely through environment
   variables instead of a config file:

   ```bash
   export X_SHEET_ID="YOUR_SPREADSHEET_ID"
   export X_GOOGLE_TOKEN_PATH="$HOME/.config/google-drive-mcp/tokens.json"
   ```

3. Run the builder with `--sync-sheet` (or the scanner without extra flags):

```bash
node scripts/build-targets.js --target 20 --sync-sheet
```

You should see `Google Sheet: direct API (<spreadsheet id>)` / `N verified row(s)
appended/updated (direct API).`

Notes:
- The token must carry `https://www.googleapis.com/auth/spreadsheets` scope
  (the google-drive-mcp setup does). The helper refreshes expired tokens
  automatically using the OAuth client file next to `tokens.json`.
- Rows are **upserted by `username`**: the whole used grid is cleared and
  rewritten as the strict 8-column header + upserted rows, so re-syncing never
  duplicates and any **stale legacy columns/rows are removed automatically**.
  A malformed `profileUrl` (e.g. a bare handle) is repaired to `https://x.com/<handle>`.
  The default tab is `Targets`; the tab is created if missing.

## 1. Create the Sheet + Apps Script (Web App mode)

Use this instead when no local token exists (e.g. another machine).

1. Create/open the target Google Sheet.
2. **Extensions → Apps Script**.
3. Delete the boilerplate and paste the script below.
4. Change `SHEET_NAME` if you want a tab other than `Targets`.
5. **Save**.

```javascript
const SHEET_NAME = 'Targets';
const HEADERS = [
  'bucket', 'category', 'username', 'profileUrl',
  'followers', 'bio', 'daysSinceLastPost', 'postsLast7Days'
];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const rows = body.rows || (body.username ? [body] : []);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

    // 1. Read the existing block, but only trust it when its header is EXACTLY
    //    our 8 columns. Anything else is stale legacy content and is discarded.
    const merged = {};
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow > 1 && lastCol > 0) {
      const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
      const strict = header.length === HEADERS.length &&
        HEADERS.every(function (h, i) { return String(header[i]).trim() === h; });
      if (strict) {
        const vals = sh.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
        vals.forEach(function (line) {
          const obj = {};
          HEADERS.forEach(function (h, i) { obj[h] = line[i]; });
          const name = String(obj.username || '').trim().replace(/^@/, '');
          if (name) { obj.username = name; merged[name.toLowerCase()] = obj; }
        });
      }
    }

    // 2. Upsert the incoming rows (repairing a malformed profileUrl).
    let added = 0, updated = 0;
    rows.forEach(function (r) {
      const name = String(r.username || '').trim().replace(/^@/, '');
      if (!name) return;
      const key = name.toLowerCase();
      const obj = {};
      HEADERS.forEach(function (h) { obj[h] = r[h] == null ? '' : r[h]; });
      obj.username = name;
      if (!/^https?:\/\//i.test(String(obj.profileUrl || ''))) obj.profileUrl = 'https://x.com/' + name;
      if (merged[key]) updated++; else added++;
      merged[key] = obj;
    });

    // 3. Rewrite the used grid cleanly, which clears any stale legacy columns.
    const out = [HEADERS];
    Object.keys(merged).forEach(function (k) {
      out.push(HEADERS.map(function (h) { return merged[k][h] == null ? '' : merged[k][h]; }));
    });
    sh.clear();
    sh.getRange(1, 1, out.length, HEADERS.length).setValues(out);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, added: added, updated: updated }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

Profiles are **upserted by `username`**, so the scanner logging a candidate and
the builder syncing the same candidate updates one row instead of duplicating,
and stale legacy rows/columns are cleared on every sync.

## 2. Deploy as a Web App

1. **Deploy → New deployment**.
2. Select type **Web app**.
3. **Execute as:** *Me*. **Who has access:** *Anyone*.
4. **Deploy**, authorize, and copy the **Web app URL** (ends in `/exec`).

## 3. Give the URL to the scripts

Any one of these works (first match wins):

| Method | How |
|--------|-----|
| CLI flag | `--sheet-url "https://script.google.com/macros/s/.../exec"` |
| Env var | `X_SHEET_WEBAPP_URL` (or `GOOGLE_SHEETS_WEBAPP_URL`) |
| Config file | `config.json` → `export.webAppUrl` |
| Config file | `sheet-config.json` (repo root) → `{ "webAppUrl": "https://script.google.com/macros/s/.../exec" }` |
| Skill config | `<repo>/data/sheet-config.json` (same shape) |

For **direct mode**, use the same config files but with a spreadsheet ID
instead of a `webAppUrl`:

| Method | How |
|--------|-----|
| Config file | `config.json` → `{ "export": { "spreadsheetId": "YOUR_SPREADSHEET_ID", "sheetName": "Targets", "tokenPath": "~/.config/google-drive-mcp/tokens.json" } }` |
| Config file | `sheet-config.json` → `{ "spreadsheetId": "YOUR_SPREADSHEET_ID", "sheetName": "Targets", "tokenPath": "~/.config/google-drive-mcp/tokens.json" }` |
| Env var | `X_SHEET_ID` (spreadsheet ID) and `X_GOOGLE_TOKEN_PATH` (token file) |

Example `sheet-config.json` (direct mode):

```json
{ "spreadsheetId": "YOUR_SPREADSHEET_ID", "sheetName": "Targets" }
```

If no Sheet sink is configured the scanner stops before scanning (unless you
pass `--local-csv <file>` for a CSV fallback), so a misconfigured sink never
silently loses a run.

## 4. Verifying

- Scanner prints `Google Sheet: direct API (...)` or `Google Sheet: <url>` at start and `Google Sheet: N row(s) appended` at the end.
- Builder prints the same when run with `--sync-sheet`.
- On failure you'll see `! sheet append failed: <reason>` next to the candidate.

## Notes

- The Web App must be deployed with access **Anyone** (not "Anyone with a Google account") or the POST will be rejected.
- Re-deploy after editing the script (**Deploy → Manage deployments → Edit → Version: New version**) or Apps Script keeps serving the old code.
- Apps Script returns a redirect to the JSON result; `scripts/sheets.js` follows it automatically.
