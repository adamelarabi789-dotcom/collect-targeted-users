---
name: collect-targeted-users
description: Browse X in one fast unified pass and collect NEW unique accounts matching YOUR niche. Criteria are customizable (niche keywords, follower ceiling, activity frequency); activity-checked and de-duplicated against the existing Google Sheet database, with each new user written straight to the Sheet via the API. No AI validation step, no local CSV database. Use when collecting an outreach list.
---

# Collect Targeted Users

## Overview
This skill builds an outreach list from X (Twitter) of the accounts you define, collected together in **one unified pass**. You describe your target niches as **buckets**; the shipped defaults are two generic buckets you replace with your own:
- **[INSERT_NICHE_KEYWORDS_A]** - `config.json` → `classification.buckets.A.name` + `search.keywords.A`
- **[INSERT_NICHE_KEYWORDS_B]** - `config.json` → `classification.buckets.B.name` + `search.keywords.B`

Out of the box there are **no** keywords: set yours in `config.json` (or the `X_NICHE_KEYWORDS` / `X_KEYWORDS_A` / `X_KEYWORDS_B` env vars) before the first run. Buckets are labels only - every profile is matched against the whole keyword set.

**Default goal: 20 NEW unique users total** (no per-bucket split), `<40,000` followers, last post within 7 days, and **at least 8 posts in the last 30 days** (~2 per week) - all overridable in `config.json`.

The **Google Sheet is the single source of truth**: its rows are read for de-duplication and every NEW user is written straight back to it. No local CSV database is produced (an optional mirror is available with `--local-csv`).

How it works:
1. **One unified pass.** The Playwright script searches X with Boolean queries built from **your** niche keywords (plus any hashtag/engagement seeds) and reads each author's **followers, activity, bio and recent posts once**, then scores that single profile against **both buckets at the same time** (`scoreSemantics`, driven by your `config.json` lexicon). The A/B result is only a **hint/label** - it does not gate the run.
2. **Single target, no bucket quotas.** The run keeps collecting until **20 NEW unique users** are found (or the time/profile budget runs out). There is no per-bucket early exit; the target counts new users overall.
3. **Activity gate.** A profile must have posted **`>= --min-posts-30d`** times in the last **`--activity-window-days`** (default 8 in 30 days), must have a newest post within `--max-last-post-days` (default 7), and be under the follower ceiling. If the run falls behind pace after a round, the threshold **relaxes toward `--min-posts-30d-floor`** (default 4, ~1/week) so a dry pool can't stall on an over-strict gate.
4. **Sheet de-duplication, in parallel with the scan.** Every hit is checked against the usernames already in the Google Sheet (plus any `--db <files>` CSVs). Anyone already present is skipped completely and **does not count** toward the 20. The check runs *inside the parallel check pool*, so known authors are skipped the instant they are seen while the scan keeps going.
5. **No AI validation.** There is no `decisions.json` step and no Phase-2 classification. Collected users are written directly to the Sheet.
6. **Strict output schema (8 columns).** `bucket`, `category`, `username`, `profileUrl`, `followers`, `bio`, `daysSinceLastPost`, `postsLast7Days` (defined in `scripts/columns.js`). The Sheet is upserted by `username` and the used grid is rewritten to exactly these columns, so stale legacy columns/rows disappear.

## Configuration Options
Define your target niche before running, or override it per run. Every option maps to a real key in `config.json` (there are no phantom knobs):

| Config option | What it controls | How to set it | Default |
|---------------|------------------|---------------|---------|
| `NICHE_KEYWORDS` | Topics/roles used to BUILD the search queries and (as a fallback) the A/B lexicon | `config.json` → `search.keywords.A` / `search.keywords.B`, or `X_NICHE_KEYWORDS` / `X_KEYWORDS_A` / `X_KEYWORDS_B`; optional flat list in `references/keywords.md` (`--refs <dir>`) | empty - **you must set these** |
| `MAX_FOLLOWERS` | Follower ceiling, exclusive (profiles at or above it are skipped) | `config.json` → `criteria.maxFollowers`, or `--max-followers <n>` / `X_MAX_FOLLOWERS` | `40000` |
| `MIN_POST_FREQUENCY` | Activity gate - posts inside the window plus freshness of the newest post | `config.json` → `criteria.minPosts30d` / `minPosts30dFloor` / `activityWindowDays` / `maxLastPostDays`, or the matching flags / env vars | `8` in `30` days, floor `4`; newest post within `7` days |
| `COLLECTION_BATCH_SIZE` | Number of NEW qualified users to collect this run | `config.json` → `criteria.target`, or `--target <n>` / `X_TARGET` | `20` (the `/collect` command caps it at `60`) |
| `OUTPUT_PATH` | Where collected profiles are saved | The Google Sheet is the database: `config.json` → `export.spreadsheetId` (+ `export.tokenPath`) / `sheet-config.json` / `X_SHEET_ID`. Optional CSV mirror with `--local-csv <file>` | Sheet tab `Targets` |

> **Design note.** This version searches X with a rotating Boolean query pool (built from your keywords, plus any hashtag/engagement seeds) and stores results in the **Google Sheet**, not a local JSON/SQLite file. The Sheet is read for de-duplication and written back per candidate. No niche, industry or account data is baked into the code.

### Execution steps (at a glance)
1. **Initialize browser** - open X with the saved session from `auth.json` (or `X_AUTH_TOKEN`); no Chrome attachment.
2. **Scan** - interleave the query pool (built from `NICHE_KEYWORDS`), extracting authors whose bios/recent posts match your niche.
3. **Verify profile** - enforce `MAX_FOLLOWERS` and confirm `MIN_POST_FREQUENCY`.
4. **Save profile** - upsert `bucket`, `category`, `username`, `profileUrl`, `followers`, `bio`, `daysSinceLastPost`, `postsLast7Days` into the Sheet (`OUTPUT_PATH`), skipping anyone already present.
5. **Batch control** - stop as soon as `COLLECTION_BATCH_SIZE` (`--target`) NEW users are collected, or the safety budgets are hit.

## Required Reference Files
1. **Brand Guide:** `references/brand-guide.md` - example value proposition, pillars and tone. Replace it with your own (or ignore it: it is not read by the scripts).
2. **Keywords & Criteria:** `references/keywords.md` - an **optional** flat keyword list. The authoritative niche keywords and account criteria live in `config.json` (`search.keywords`, `criteria`).
3. **Google Sheet setup:** `references/google-sheet-setup.md` - the Apps Script `doPost` code + deploy steps, and the direct Sheets API (`spreadsheetId`) alternative. **Reading rows needs direct API mode** (`spreadsheetId`), so configure that for the de-dup database.

---

## Core Workflow

### Step 1: Initialize Session
- The repo bundles the shared Playwright helpers in `lib/twitter.js` and a session refresher in `First/login.js`. No hard-coded paths: the helper dir resolves from `PROJ_ROOT` → `TWITTER_PLAYWRIGHT_DIR` → the repo root (when `lib/twitter.js` sits here) → `<home>/twitter-playwright`. Chrome/profile paths resolve dynamically too (`X_CHROME_EXE` / `X_PROFILE_DIR` override).
- **Session:** the scanner loads the saved session in `auth.json` **directly** - it never probes for or attaches to a running Chrome. If the session is missing or expired, refresh it with `node First/login.js --refresh` (the saved path is overridable with `X_AUTH_FILE`).
- The Sheet sink is **required** for the default flow: set `config.json` → `export.spreadsheetId` (+ `export.tokenPath`), or a top-level `sheet-config.json` `{ "spreadsheetId": "...", "sheetName": "Targets", "tokenPath": "..." }`, or the `X_SHEET_ID` / `X_GOOGLE_TOKEN_PATH` env vars - see `references/google-sheet-setup.md`. If it is missing the scanner exits unless you pass `--local-csv <file>` for a CSV fallback.

### Step 2 (Phase 1 - script): Unified scan + gather
Run the scanner. In **one interleaved pass** it rotates through a **Boolean query pool** built from your `config.json` keywords (then any hashtag/engagement seeds), checks each author once, applies the machine filters (`< 40,000` followers, newest post within the last week, `>= min-posts-30d` posts in the last 30 days), labels the account with `scoreSemantics` (driven by your lexicon), and keeps going until **20 NEW unique users** are collected (or the budget is reached). Each collected user is **upserted straight to the Google Sheet** (strict 8 columns) as soon as it is found.

- **Sheet is the database.** At startup the scanner reads the Sheet's existing rows ONCE into an in-memory de-dup `Set`. A known user is skipped the instant it is seen and never counted. Every NEW user is written back to the Sheet immediately via a serialized queue (crash-safe; no duplicate/lost writes).
- **Table styling + separator.** Every write re-applies the table's visual design to the written rows (bucket column dark gold `#BF9000`; data columns light gray `#F3F3F3`; category/username/url left-aligned, numeric columns centered, profileUrl hyperlinked) and keeps exactly ONE solid-black empty separator row between the pre-existing table and this run's new rows. Because the whole run is re-sent on each write, the separator stays idempotent (one per run) and the write stays crash-safe. (`#000000` is the target; the API quantises colors and treats pure black as "unset", so the closest representable `#010101` is used - visually identical.)
- **Query rotation.** A query that yields **fewer than 3** new unique candidates is abandoned in favour of the next query in the pool, so the run never grinds on a dead query.
- **SearchTimeline pre-filter.** While a seed scrolls, X's own `SearchTimeline` GraphQL payloads are parsed for each author's bio/followers/last-post. An author who is over the follower ceiling, or whose newest visible post is already too old, is rejected **without opening their profile**. A search payload cannot supply the 30-day activity count, so survivors are still opened once to measure it - the pre-filter only removes wasted profile opens, it never replaces the gate.
- **Auto-expansion until the target is met.** The existence check runs **per candidate inside the parallel check pool**. If the base queries run dry before 20 NEW users are found, the run does **not** stop short: it automatically escalates through `--expand-rounds` (default `3`) - round 2 adds hashtag/engagement seeds, later rounds re-scroll all queries with larger author/scroll caps - until the target is reached or the hard budgets (`--max-profiles` / `--max-minutes`) are hit.
- **Existing rows never count** toward the target unless `--resume` is passed (which tops the Sheet up to `--target`).
- **Performance:** images/media/fonts/stylesheets are blocked via route interception; profile metrics are read from X's own **GraphQL JSON** responses (`page.on('response')`) with the DOM as a fallback; a **concurrency-5** worker pool checks profiles on reused tabs using **dynamic, response/selector-based waits** instead of fixed sleeps.
- **Integrity filter.** Synthetic/test fixtures are rejected before writing: a placeholder bio paired with `followers = 100`, an invalid timestamp, or a cluster of different handles sharing one short identical bio.
- **No CSV is written** unless `--local-csv <file>` is passed (a retry-safe atomic-rename mirror; a locked file is retried, never lost).

Anti-bot behavior is **mandatory and built in** (tune it, you can't switch it off; heavier with `--stealth`):
- **Human jitter** - a random pause (default `1.0-3.0s`) before every profile open (floored, never fully off) plus randomized scroll wobble while scanning feeds.
- **Cooldown rests** - a random idle rest (`15-35s`) after every `12` profile checks, so X never sees a sustained burst.
- **Adaptive back-off** - after consecutive failures/bot-block shells the pause grows exponentially (up to ~90s) and resets on the next success; a *Cloudflare/X challenge or empty 403 shell* is detected explicitly and triggers a longer rest.
- **Worker recovery** - each parallel tab has crash/error handlers and is transparently recreated (with back-off) if it dies; a failed profile is retried up to 3x on a fresh tab.

```bash
node scripts/scan-candidates.js --target 20
```

### Step 3 (Phase 2 - script): Verify/repair the Sheet (NO AI validation)
Phase 1 already wrote the new users to the Sheet, so the builder is a **Sheet-native finalizer/verifier** (no CSV database, no AI). It:
- reads the Sheet's rows,
- optionally ingests a CSV (`--candidates <file>`) or the local mirror (`--local-csv <file>`),
- enforces the strict 8-column schema and de-dups by `username` while **preserving the Sheet's row order and its black separator row** (it never re-sorts),
- upserts the clean set back to the Sheet (idempotent - re-runs never duplicate) and re-applies the table's visual design,
- prints the clickable Sheet URL.

```bash
node scripts/build-targets.js --target 20 --sync-sheet
```

Use `--no-sheet` to verify without writing, or `--sheet-url <url>` to override the sink.

### Step 4: Top up if short (rare)
- The scanner auto-expands (extra seeds, then deeper re-scrolls) until the target is met, so a single Step 2 normally returns all 20 NEW users. A "short" message should only appear if the hard budgets run out.
- If it still prints "short", re-run Step 2 with a bigger budget (`--max-profiles 300 --max-minutes 30 --expand-rounds 5`), then re-run Step 3.
- The scanner already skips everyone in the Sheet DB, so re-runs only find NEW users.

---

## Outputs
| Where | What |
|-------|------|
| Google Sheet (configured `sheet-config.json` / Web App) | The database, strict 8 columns: `bucket`, `category`, `username`, `profileUrl`, `followers`, `bio`, `daysSinceLastPost`, `postsLast7Days`. Upserted by `username`, styled to match the table, with a solid-black separator row before each run's new rows. |
| `--local-csv <file>` (optional) | A CSV mirror of the Sheet (retry-safe atomic rename). Off by default. |

The scanner prints the clickable Sheet URL at the end of every run: `https://docs.google.com/spreadsheets/d/<spreadsheetId>/edit`.

`<project>` resolves from `PROJ_ROOT` → `TWITTER_PLAYWRIGHT_DIR` → the repo root → `<home>/twitter-playwright`.

## How to run it
- Quickest: ask your agent to run the skill (e.g. OpenCode's `/collect` command). `/collect` collects the default **20 NEW users**; `/collect 30` sets the total to 30; `/collect B` scans only the B seeds (the target still counts new users overall).
- Otherwise run the two scripts directly as shown above (see `README.md` for the full CLI reference).

### scan-candidates.js options
| Flag | Meaning | Default |
|------|---------|---------|
| `--target <n>` | Total NEW unique users to collect | `20` |
| `--bucket <A,B>` | Only scan these seeds/buckets | all |
| `--db <files>` | Extra CSV de-dup DBs (comma separated) | (Sheet only) |
| `--concurrency <n>` | Parallel profile tabs | `5` |
| `--max-followers <n>` | Follower ceiling, exclusive | `40000` |
| `--min-posts-30d <n>` | Min posts in the last 30 days | `8` |
| `--min-posts-30d-floor <n>` | Relaxed 30d floor used when behind pace | `4` |
| `--no-relax` | Never relax the 30d threshold | off |
| `--relax-below-pct <0-1>` | Relax once collected < this fraction of the target | `0.6` |
| `--no-prefilter` | Always open the profile (skip the SearchTimeline pre-filter) | off |
| `--activity-window-days <n>` | Activity window in days | `30` |
| `--activity-scrolls <n>` | Extra timeline scrolls for the activity read | `2` |
| `--max-last-post-days <n>` | Max age of newest post | `7` |
| `--max-scrolls-per-seed <n>` | Scrolls per query/seed | `16` |
| `--max-authors-per-seed <n>` | Authors queued per seed | `24` |
| `--max-profiles <n>` | Global profile-check cap | `200` |
| `--max-minutes <n>` | Hard safety cap for the whole run (NOT an expected duration; typical run: a few minutes) | `20` |
| `--expand-rounds <n>` | Auto-expansion rounds until the target is met (`1` disables) | `3` |
| `--local-csv <file>` | Optional local candidates CSV mirror (the Sheet is the DB); `--out` is an alias | off |
| `--sheet-url <url>` | Override the configured Sheet | env/config |
| `--no-sheet` | Do not read/write the Google Sheet | off |
| `--no-separator` | Do not insert the solid-black separator row | off |
| `--no-format` | Do not replicate the table styling (write raw values) | off |
| `--no-graphql` | Read profiles from the DOM only (skip the JSON fast-path) | off |
| `--no-jitter` | Drop jitter to its safety floor (`0.3-0.8s`); cannot be fully off | off |
| `--jitter-secs <min-max>` | Random pause before each profile (always on) | `1.0-3.0` |
| `--cooldown-every <n>` | Idle rest after every n profiles (mandatory; `0` re-floored to `12`) | `12` |
| `--cooldown-secs <min-max>` | Rest window seconds | `15-35` |
| `--stealth` | Preset: `1.5-3.5s` jitter + cooldown every 25 profiles | off |
| `--refs <dir>` | Dir with keywords.md | repo `references/` |
| `--no-block-media` | Keep loading images/media/fonts/stylesheets | blocking on |
| `--headful` | Show a visible browser window (evades headless bot-blocks) | off |
| `--fresh` | Ignore an existing `--local-csv` mirror on load | off |
| `--resume` | Count existing Sheet rows toward the quota, then top up | off |
| `--dry-run` | Scan without writing anywhere | off |

**Performance:** the scanner rotates through the Boolean query pool, caps authors at **24 per query** and **200 profiles total**, and **auto-expands** (hashtag/engagement seeds, then deeper re-scrolls) until the NEW-user target is met. It blocks images/media/fonts/stylesheets, parses **SearchTimeline** payloads to skip obvious misses before opening a profile, reads profile metrics from X's **GraphQL JSON** (DOM fallback), uses dynamic waits (`profileTimeoutMs 8000`, `tweetsTimeoutMs 8000`), reuses tabs, checks `--concurrency 5` profiles in parallel, verifies login once, and stops as soon as the target is met. The mandatory jitter/cooldown make runs a little slower, but they prevent 403 lock-outs. If X throttles you, drop `--concurrency` to `2` and/or add `--stealth`.

Queries scanned by default (Latest results): the pool is **generated from your niche keywords** in `config.json` (`search.keywords.A` / `search.keywords.B`) - each bucket's keywords become one Boolean query `("kw1" OR "kw2" ...) -filter:replies`, or you can supply explicit `search.queries` and optional `search.expansionQueries` seeds. Buckets are decided per candidate, not per query. (The template ships placeholder values that are ignored until you replace them.)

### build-targets.js options
| Flag | Meaning | Default |
|------|---------|---------|
| `--candidates <file>` | Optional CSV to ingest into the Sheet | off |
| `--local-csv <file>` | Optional local mirror written from the Sheet (also read); `--out` is an alias | off |
| `--target <n>` | Informational NEW-user target | `20` |
| `--sheet-url <url>` | Override the configured Sheet | env/config |
| `--sync-sheet` | Upsert the clean rows into the Sheet | **on** |
| `--no-sheet` | Do not touch the Sheet (needs `--candidates`/`--local-csv`) | off |

The builder reads the Sheet, de-dups by `username`, orders deterministically and rewrites the strict 8 columns, so re-runs never duplicate a row. A locked `--local-csv` mirror is staged to `<name>.new.csv` and reported **DEGRADED** rather than failing silently.

## Sheet sync modes
The Sheet sink is auto-detected, **first match wins** (see `scripts/sheets.js`):
1. **Web App mode** - POST to a Google Apps Script Web App URL. Sources, in order: `--sheet-url` → env `X_SHEET_WEBAPP_URL` (or `GOOGLE_SHEETS_WEBAPP_URL`) → `config.json` `export.webAppUrl` → `sheet-config.json` `{ "webAppUrl": "https://.../exec" }`. Requires the one-time Apps Script deploy in `references/google-sheet-setup.md`. **Write-only** - reads need direct mode.
2. **Direct API mode** - Google Sheets API v4 with the local OAuth token. Set `config.json` `export.spreadsheetId` (+ `export.sheetName` / `export.tokenPath`), or `sheet-config.json` `{ "spreadsheetId": "...", "sheetName": "Targets", "tokenPath": "..." }` at the repo root, or the `X_SHEET_ID` env var (the token path defaults to `~/.config/google-drive-mcp/tokens.json`, override with `X_GOOGLE_TOKEN_PATH`). No Apps Script deploy needed. If the tab is missing it is created. **This is the required mode for the de-dup database** (reading rows).

## Notes & gotchas
- **Session:** `auth.json` only - the scanner loads it directly and never connects to a running Chrome. If it fails or expires, run `node First/login.js --refresh` in the repo.
- **Bot blocks (403/Cloudflare shells):** the scanner detects empty/challenge shells explicitly, backs off adaptively, and prints a hint. If the block persists, rerun with `--headful --no-block-media`, or refresh the session via `First/login.js --refresh`.
- **Worker crashes:** every parallel tab has `crash`/`error` handlers and is recreated on demand; a failed profile check is retried up to 3x on a fresh tab.
- **File locks / DEGRADED:** only relevant to the optional `--local-csv` mirror; the Sheet stays authoritative.
- **De-duplication / "NEW":** the scanner skips anyone already in the Google Sheet (or `--db` CSVs); those users never count toward the 20. The Sheet is upserted by `username`, so previously collected users are never lost or duplicated.
- **Strict 8-column schema:** the Google Sheet and the optional CSV mirror use the exact columns defined in `scripts/columns.js`.
- **Script labels, no AI gate.** `scoreSemantics` assigns the script-side A/B label (for the `bucket`/`category` columns). It does **not** filter the list - the activity + follower filters do.
- **Integrity:** synthetic fixtures (placeholder bio + `followers=100`), invalid timestamps, and duplicate-bio clusters are rejected at collection.
- **Activity** uses timestamps from X's GraphQL timeline payloads (DOM timeline as fallback); empty/protected profiles are skipped.
- If X returns *"no results"* for several seeds (search throttling), wait a few minutes and retry, or use `--headful --no-block-media`.
- Change paths with `PROJ_ROOT` / `TWITTER_PLAYWRIGHT_DIR` / `X_CHROME_EXE` / `X_PROFILE_DIR` / `X_AUTH_FILE` if the project or Chrome moves.
