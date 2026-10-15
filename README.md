# This is a free to use skill for tanjawi zaml
## collect-targeted-users

An automated **lead-generation scanner for X (Twitter)**. In a single, human-paced
pass it searches X for the accounts **you define** and writes each qualifying
profile straight into a **Google Sheet** (the database):

- **Bucket A — [INSERT_NICHE_KEYWORDS_A]**
- **Bucket B — [INSERT_NICHE_KEYWORDS_B]**

The buckets are just labels for the two halves of your target audience. Configure
your own keywords, follower ceiling and activity rules in **`config.json`** (or
via environment variables) — nothing niche-specific ships in the code.

It is **activity-checked and de-duplicated**: a profile must be under a follower
ceiling, have posted recently, and post regularly; anyone already in the Sheet is
skipped. There is **no AI validation step and no local CSV database** — the Sheet
is the single source of truth.

> **Note on scope & etiquette.** This tool drives a real, logged-in X session with
> Playwright and reads public profile data. Use it responsibly: keep the built-in
> throttling on, respect X's Terms of Service and [Automation Rules](https://help.x.com/en/rules-and-policies/x-automation),
> and follow the privacy/GDPR/anti-spam law that applies where you operate. You
> are responsible for how you use the collected data and any outreach you send.

---

## Table of contents

1. [How it works](#how-it-works)
2. [Repository layout](#repository-layout)
3. [Prerequisites](#prerequisites)
4. [Installation](#installation)
5. [Configuration (`config.json` + environment variables)](#configuration-configjson--environment-variables)
6. [Google Sheet setup](#google-sheet-setup)
7. [CLI usage](#cli-usage)
8. [Agent integration guide](#agent-integration-guide)
   - [OpenCode](#opencode)
   - [Claude Code](#claude-code)
   - [Claude Desktop](#claude-desktop)
   - [Cursor](#cursor)
   - [Custom MCP servers](#custom-mcp-servers)
9. [Options reference](#options-reference)
10. [Troubleshooting](#troubleshooting)
11. [Security & data hygiene](#security--data-hygiene)
12. [License](#license)

---

## How it works

The skill runs as **two scripts** (Phase 1 collects, Phase 2 verifies/repairs):

| Phase | Script | What it does |
|-------|--------|--------------|
| 1 | `scripts/scan-candidates.js` | Reads the existing Sheet rows **once** for de-duplication, then scans a rotating pool of Boolean queries (built from your `config.json` keywords) in one interleaved pass. Each author is checked once (followers, last-post age, posts in the last 30 days). Survivors are labelled by `scripts/semantics.js` and **written straight to the Sheet** as they are found. Auto-expands with extra seeds until the target of NEW users is met. |
| 2 | `scripts/build-targets.js` | Reads the Sheet back, de-dups by `username`, enforces the strict 8-column schema, **preserves row order and the separator row**, re-applies the table's visual design, and upserts the clean set. Idempotent — re-runs never duplicate rows. |

Key behaviours:

- **Unified pass, single target** (default **20 NEW unique users**), no per-bucket quota.
- **Activity gate:** `< 40,000` followers, newest post within 7 days, and `>= 8` posts in the last 30 days (relaxable to a floor of 4 when the pool runs dry).
- **Sheet-native de-duplication** runs *inside* the parallel check pool, so known authors are skipped instantly and never counted toward the target.
- **Human-paced by default:** randomised jitter before every profile open, an idle cooldown every 12 checks, adaptive exponential back-off on failures, and automatic worker-tab recovery. Images/media/fonts are blocked and `SearchTimeline` payloads are pre-filtered to avoid wasted profile opens.
- **Strict 8-column schema** (`scripts/columns.js`): `bucket`, `category`, `username`, `profileUrl`, `followers`, `bio`, `daysSinceLastPost`, `postsLast7Days`.

---

## Repository layout

```
collect-targeted-users/
├── SKILL.md                     # Standalone skill spec + agent prompt
├── README.md                    # This file
├── package.json                 # Dependencies & npm scripts
├── config.json                  # Niche keywords, criteria, export endpoints
├── .env.example                 # Environment variable template
├── .gitignore                   # Ignores secrets, logs, local state
├── sheet-config.example.json    # Google Sheet sink template (optional)
├── auth.json.example            # Session storageState template
├── LICENSE
├── lib/
│   └── twitter.js               # Shared Playwright helpers (openX, ensureLoggedIn)
├── First/
│   ├── login.js                 # Save/refresh the X session into auth.json
│   ├── start-chrome.cmd         # Start Chrome with remote debugging (Windows)
│   └── start-chrome.sh          # Start Chrome with remote debugging (macOS/Linux)
├── references/
│   ├── keywords.md              # Optional flat keyword list (placeholders)
│   ├── brand-guide.md           # Example brand voice / value proposition
│   └── google-sheet-setup.md    # Sheet / Apps Script / OAuth setup
└── scripts/
    ├── config.js                # Loads/merges config.json + env overrides
    ├── scan-candidates.js       # Phase 1 - unified scan + write to Sheet
    ├── build-targets.js         # Phase 2 - Sheet verifier/finalizer
    ├── semantics.js             # Config-driven A/B label scoring (hint only)
    ├── sheets.js                # Google Sheets sink (direct API / Web App)
    └── columns.js               # The strict 8-column schema
```

---

## Prerequisites

- **Node.js 18+** (uses the built-in `fetch`/`https` only — no extra HTTP deps).
- **Google Chrome / Chromium** installed (or run `npm run playwright:install`).
- An **X (Twitter) account** you can sign in to.
- A **Google account** with access to (or ability to create) a Google Sheet, and a
  Google OAuth token with the `https://www.googleapis.com/auth/spreadsheets` scope
  (see [Google Sheet setup](#google-sheet-setup)).

---

## Installation

```bash
# 1. Clone and install dependencies
git clone <your-fork-url> collect-targeted-users
cd collect-targeted-users
npm install

# 2. (Optional) install a bundled Chromium if you don't have Chrome
npm run playwright:install

# 3. Create your local env file from the template
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
# ...then edit .env with your values (see the next section)

# 4. Save your X session (opens Chrome; sign in if prompted)
npm run login               # or: node First/login.js
#    To capture the session cookies for headless runs:
npm run refresh-session     # or: node First/login.js --refresh
```

`node First/login.js --refresh` writes a Playwright `storageState` file to
`./auth.json` (override the path with `X_AUTH_FILE`). That file contains your
session cookies — it is git-ignored and must never be shared.

---

## Configuration (`config.json` + environment variables)

There are two ways to configure the collector; both feed the same settings, and
**environment variables win** when both are set:

1. **`config.json`** at the repo root — the primary, human-editable config.
   Copy it to **`config.local.json`** (git-ignored) to keep private values out of
   git, or point `CONFIG_PATH` at a file elsewhere.
2. **Environment variables** — best for CI and for keeping secrets out of the
   repo. Copy `.env.example` to `.env` and set the `X_*` variables below.

### `config.json` reference

```jsonc
{
  "search": {
    // YOUR niche keywords, per bucket. Queries are auto-generated from these.
    "keywords": { "A": ["[INSERT_NICHE_KEYWORDS_A]"], "B": ["[INSERT_NICHE_KEYWORDS_B]"] },
    "queries": [],            // optional explicit [{ "bucket": "A", "query": "..." }]
    "expansionQueries": [],   // optional extra seeds for the expansion rounds
    "querySuffix": "-filter:replies",
    "keywordsFile": "references/keywords.md"
  },
  "criteria": {
    "target": 20,             // COLLECTION_BATCH_SIZE
    "maxFollowers": 40000,    // MAX_FOLLOWERS (exclusive ceiling)
    "minPosts30d": 8,         // MIN_POST_FREQUENCY (posts per window)
    "minPosts30dFloor": 4,
    "activityWindowDays": 30,
    "maxLastPostDays": 7,
    "concurrency": 5,
    "maxProfiles": 200,
    "maxMinutes": 20,
    "expandRounds": 3
  },
  "classification": {
    // A/B hint lexicon (optional). Empty => labels come from the seed bucket.
    "roleWeight": 3,
    "buckets": {
      "A": { "name": "[INSERT_BUCKET_A_NAME]", "roleTerms": [], "strongTerms": [], "weakTerms": [] },
      "B": { "name": "[INSERT_BUCKET_B_NAME]", "roleTerms": [], "strongTerms": [], "weakTerms": [] }
    }
  },
  "integrity": { "placeholderBios": [], "placeholderFollowers": 100 },
  "export": {
    "spreadsheetId": "YOUR_SPREADSHEET_ID",
    "sheetName": "Targets",
    "tokenPath": "~/.config/google-drive-mcp/tokens.json",
    "webAppUrl": ""
  }
}
```

Placeholder values (anything like `[INSERT_...]` or `YOUR_...`) are **ignored** at
load time, so a fresh copy never runs with literal template text. With no keywords
configured the scanner exits with instructions rather than searching for garbage.

### Environment variables

All configuration is optional if you use `config.json` and `auth.json`, but
environment variables are the recommended way to keep secrets out of the repo:

| Variable | Purpose | Default |
|----------|---------|---------|
| `CONFIG_PATH` | Path to an alternative `config.json` | `./config.json` |
| `X_NICHE_KEYWORDS` | Comma-separated niche keywords (applied to both buckets) | from `config.json` |
| `X_KEYWORDS_A` / `X_KEYWORDS_B` | Per-bucket niche keywords (comma-separated) | from `config.json` |
| `X_TARGET` | NEW users to collect this run | `20` |
| `X_MAX_FOLLOWERS` | Follower ceiling (exclusive) | `40000` |
| `X_MIN_POSTS_30D` | Minimum posts in the activity window | `8` |
| `X_MIN_POSTS_30D_FLOOR` | Relaxed floor when behind pace | `4` |
| `X_ACTIVITY_WINDOW_DAYS` | Activity window in days | `30` |
| `X_MAX_LAST_POST_DAYS` | Max age of the newest post | `7` |
| `X_CONCURRENCY` | Parallel profile tabs | `5` |
| `X_MAX_PROFILES` | Global profile-check cap | `200` |
| `X_MAX_MINUTES` | Hard safety cap for the run | `20` |
| `X_EXPAND_ROUNDS` | Auto-expansion rounds | `3` |
| `X_AUTH_TOKEN` | `auth_token` cookie value, for CI/headless use | read from `auth.json` |
| `X_AUTH_CT0` | `ct0` CSRF cookie value (optional companion to `X_AUTH_TOKEN`) | – |
| `X_AUTH_FILE` | Path to the saved Playwright storageState | `./auth.json` |
| `X_SHEET_ID` | Target Google **spreadsheet ID** (direct API mode) | – |
| `X_GOOGLE_TOKEN_PATH` | Path to the OAuth `tokens.json` | `~/.config/google-drive-mcp/tokens.json` |
| `X_SHEET_NAME` | Target tab name | `Targets` |
| `X_SHEET_WEBAPP_URL` | Apps Script Web App URL (write-only fallback) | – |
| `GOOGLE_SHEETS_WEBAPP_URL` | Alias of the above | – |
| `X_LOCAL_CSV` | Optional local CSV mirror path | off |
| `PROJ_ROOT` | Root holding `lib/twitter.js` + session | this repo root |
| `TWITTER_PLAYWRIGHT_DIR` | Alias of `PROJ_ROOT` | – |
| `X_MODE` | Browser mode for the helper: `auth`, `cdp`, `profile` | `cdp` for the helper, `auth` for the scanner |
| `X_CHROME_EXE` | Explicit path to the Chrome/Chromium binary | auto-detected |
| `X_PROFILE_DIR` | Chrome profile dir (used by `profile`/`cdp` modes) | per-platform |
| `X_SKILL_REFS` | Folder containing the optional `keywords.md` | `./references` |

> The collector always loads your session **directly** from the storageState /
> `X_AUTH_TOKEN`; it never probes for or attaches to a running Chrome.

### Target criteria (configurable)

The conceptual knobs map directly onto `config.json` keys, CLI flags and env vars:

| Config option | Controls | Set via | Default |
|---------------|----------|---------|---------|
| `NICHE_KEYWORDS` | Topics/roles that BUILD the search queries (+ fallback A/B lexicon) | `config.json` `search.keywords.A/.B`, `X_NICHE_KEYWORDS` / `X_KEYWORDS_A` / `X_KEYWORDS_B`, or the optional `references/keywords.md` (`--refs <dir>`) | empty — **you must set these** |
| `MAX_FOLLOWERS` | Follower ceiling, exclusive | `config.json` `criteria.maxFollowers`, `--max-followers <n>` / `X_MAX_FOLLOWERS` | `40000` |
| `MIN_POST_FREQUENCY` | Posts per window + newest-post freshness | `config.json` `criteria.minPosts30d` / `minPosts30dFloor` / `activityWindowDays` / `maxLastPostDays`, or the matching flags/env | `8`/30d, floor `4`, within `7` days |
| `COLLECTION_BATCH_SIZE` | NEW users to collect per run | `config.json` `criteria.target`, `--target <n>` / `X_TARGET` | `20` |
| `OUTPUT_PATH` | Where profiles are saved | Google Sheet (`config.json` `export.spreadsheetId`, `X_SHEET_ID`); optional `--local-csv <file>` | Sheet tab `Targets` |

See [`SKILL.md`](SKILL.md#configuration-options) for the same table in agent-spec form.

---

## Google Sheet setup

The Sheet is the database, so reading rows back (for de-duplication) requires
**direct API mode**. The short version:

1. Create a Google Sheet and copy its **spreadsheet ID** from the URL:
   `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
2. Point the collector at it — either in `config.json`:
   ```json
   { "export": { "spreadsheetId": "YOUR_SPREADSHEET_ID", "sheetName": "Targets", "tokenPath": "~/.config/google-drive-mcp/tokens.json" } }
   ```
   …or with a `sheet-config.json` (`cp sheet-config.example.json sheet-config.json`):
   ```json
   { "spreadsheetId": "YOUR_SPREADSHEET_ID", "sheetName": "Targets", "tokenPath": "~/.config/google-drive-mcp/tokens.json" }
   ```
   (Or export `X_SHEET_ID` and `X_GOOGLE_TOKEN_PATH` instead.) `sheet-config.json`
   wins over `config.json` if both are present.
3. Make sure your OAuth token has the `.../auth/spreadsheets` scope; the helper
   refreshes expired tokens automatically using the OAuth client file next to
   `tokens.json`.

Full details — including the read-free **Apps Script Web App** fallback and the
`doPost` code — are in [`references/google-sheet-setup.md`](references/google-sheet-setup.md).

If no sink is configured the scanner exits unless you pass `--local-csv <file>`
for a CSV fallback.

---

## CLI usage

### Phase 1 — scan (collect)

```bash
# Default: 20 NEW unique users, one unified pass
node scripts/scan-candidates.js --target 20

# Prefer a visible browser if X is serving headless bot-block shells
node scripts/scan-candidates.js --target 20 --headful --no-block-media

# Heavier anti-throttle preset
node scripts/scan-candidates.js --target 30 --stealth

# Scan only one bucket's seeds (the target still counts new users overall)
node scripts/scan-candidates.js --target 20 --bucket B

# Write an optional CSV mirror alongside the Sheet
node scripts/scan-candidates.js --target 20 --local-csv ./data/targets.csv

# Dry run: scan and print without writing anywhere
node scripts/scan-candidates.js --target 20 --dry-run --no-sheet
```

### Phase 2 — verify / repair

```bash
# Re-read the Sheet, de-dup, enforce the schema, re-apply design
node scripts/build-targets.js --target 20 --sync-sheet

# Verify without touching the Sheet
node scripts/build-targets.js --no-sheet
```

Both scripts print the clickable Sheet URL, e.g.
`https://docs.google.com/spreadsheets/d/<spreadsheetId>/edit`.

### npm shortcuts

```bash
npm run collect     # node scripts/scan-candidates.js --target 20
npm run verify      # node scripts/build-targets.js --target 20 --sync-sheet
npm run dry-run     # scan against --dry-run --no-sheet
```

---

## Agent integration guide

`SKILL.md` is a self-contained spec + prompt (`name`, `description`, and the full
workflow). Point your assistant at it and it will discover when and how to run the
two scripts. Every integration below uses the same file; only the packaging differs.

### OpenCode

Place this repository (or just `SKILL.md`) in your skills directory:

- Project scope: `<your-project>/.opencode/skills/collect-targeted-users/SKILL.md`
- Global scope: `~/.config/opencode/skills/collect-targeted-users/SKILL.md`

OpenCode reads the YAML front-matter `name`/`description` and loads the body when a
request matches (e.g. *"collect 20 new accounts matching my `config.json` keywords"*). Keep the
`scripts/` and `references/` folders next to `SKILL.md` so relative paths resolve.

### Claude Code

Copy the folder into your project's `.claude/skills/` directory:

```bash
mkdir -p .claude/skills/collect-targeted-users
cp -r /path/to/collect-targeted-users/* .claude/skills/collect-targeted-users/
```

Claude Code auto-discovers skills by their front-matter and can invoke the CLI
scripts through its Bash tool. Add the same "run it responsibly" note to your
project `CLAUDE.md` if you want the etiquette rules enforced conversationally.

### Claude Desktop

Claude Desktop does not read skills directly; expose the workflow as an **MCP
server** (see below) or as a **tool**. Two common patterns:

1. **MCP server** — wrap `scripts/scan-candidates.js` / `scripts/build-targets.js`
   in a tiny stdio MCP server and register it in
   `claude_desktop_config.json` (details in *Custom MCP servers*).
2. **Project knowledge** — paste `SKILL.md` into a Project's custom instructions
   and include the scripts' CLI reference, so Claude knows exactly what to run.

### Cursor

- **Rules / project instructions:** add `SKILL.md` to `.cursor/rules/` (or paste it
  into *Settings → Rules*) so the agent knows the workflow and flags.
- **Runner:** Cursor's terminal can execute the same `node scripts/...` commands.
  Provide `.env` (git-ignored) or export the variables in your shell profile.

### Custom MCP servers

Wrap the two scripts as MCP tools so any MCP-capable client (Claude Desktop,
Cursor, Continue, OpenCode, etc.) can call them. Minimal stdio server sketch:

```js
// mcp-server.js
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const run = (script, args) =>
  new Promise((resolve) => {
    const p = spawn('node', [script, ...args], { cwd: process.cwd() });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

const server = new Server({ name: 'collect-targeted-users', version: '1.0.0' }, {
  capabilities: { tools: {} },
});

server.setRequestHandler('tools/list', async () => ({
  tools: [
    { name: 'scan_candidates', description: 'Phase 1: collect NEW users into the Sheet',
      inputSchema: { type: 'object', properties: { target: { type: 'number' }, stealth: { type: 'boolean' } } } },
    { name: 'build_targets', description: 'Phase 2: verify/repair the Sheet',
      inputSchema: { type: 'object', properties: { target: { type: 'number' } } } },
  ],
}));

server.setRequestHandler('tools/call', async (req) => {
  const { name, arguments: a = {} } = req.params;
  const args = [];
  if (a.target) args.push('--target', String(a.target));
  if (name === 'scan_candidates') {
    if (a.stealth) args.push('--stealth');
    return { content: [{ type: 'text', text: (await run('scripts/scan-candidates.js', args)).out }] };
  }
  args.push('--sync-sheet');
  return { content: [{ type: 'text', text: (await run('scripts/build-targets.js', args)).out }] };
});

await server.connect(new StdioServerTransport());
```

Register it (Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "collect-targeted-users": {
      "command": "node",
      "args": ["/absolute/path/to/collect-targeted-users/mcp-server.js"],
      "env": { "X_SHEET_ID": "YOUR_SPREADSHEET_ID" }
    }
  }
}
```

`SKILL.md` is written to double as the tool description and the agent prompt, so
the model knows the phases, flags, and guardrails.

---

## Options reference

### `scan-candidates.js`

| Flag | Meaning | Default |
|------|---------|---------|
| `--target <n>` | Total NEW unique users to collect | `20` |
| `--bucket <A,B>` | Only scan these seeds/buckets | all |
| `--db <files>` | Extra CSV de-dup DBs (comma separated) | Sheet only |
| `--concurrency <n>` | Parallel profile tabs | `5` |
| `--max-followers <n>` | Follower ceiling, exclusive | `40000` |
| `--min-posts-30d <n>` | Min posts in the last 30 days | `8` |
| `--min-posts-30d-floor <n>` | Relaxed 30d floor when behind pace | `4` |
| `--no-relax` | Never relax the 30d threshold | off |
| `--relax-below-pct <0-1>` | Relax once collected < this fraction of target | `0.6` |
| `--no-prefilter` | Always open the profile | off |
| `--activity-window-days <n>` | Activity window in days | `30` |
| `--activity-scrolls <n>` | Extra timeline scrolls for the activity read | `2` |
| `--max-last-post-days <n>` | Max age of newest post | `7` |
| `--max-scrolls-per-seed <n>` | Scrolls per query/seed | `16` |
| `--max-authors-per-seed <n>` | Authors queued per seed | `24` |
| `--max-profiles <n>` | Global profile-check cap | `200` |
| `--max-minutes <n>` | Hard safety cap for the whole run | `20` |
| `--expand-rounds <n>` | Auto-expansion rounds until target met | `3` |
| `--local-csv <file>` | Optional local CSV mirror | off |
| `--sheet-url <url>` | Override the configured Sheet | env/config |
| `--no-sheet` | Do not read/write the Sheet | off |
| `--no-separator` | Skip the solid-black separator row | off |
| `--no-format` | Write raw values (no table styling) | off |
| `--no-graphql` | Read profiles from the DOM only | off |
| `--no-jitter` | Drop jitter to its safety floor (`0.3-0.8s`) | off |
| `--jitter-secs <min-max>` | Random pause before each profile | `1.0-3.0` |
| `--cooldown-every <n>` | Idle rest after every n profiles | `12` |
| `--cooldown-secs <min-max>` | Rest window seconds | `15-35` |
| `--stealth` | Preset: `1.5-3.5s` jitter + cooldown every 25 profiles | off |
| `--refs <dir>` | Dir with `keywords.md` | `./references` |
| `--no-block-media` | Keep loading images/media/fonts/stylesheets | blocking on |
| `--headful` | Show a visible browser window | off |
| `--fresh` | Ignore an existing `--local-csv` mirror | off |
| `--resume` | Count existing Sheet rows toward the quota | off |
| `--dry-run` | Scan without writing anywhere | off |

### `build-targets.js`

| Flag | Meaning | Default |
|------|---------|---------|
| `--candidates <file>` | Optional CSV to ingest into the Sheet | off |
| `--local-csv <file>` | Optional local mirror written from the Sheet | off |
| `--target <n>` | Informational NEW-user target | `20` |
| `--sheet-url <url>` | Override the configured Sheet | env/config |
| `--sync-sheet` | Upsert the clean rows into the Sheet | **on** |
| `--no-sheet` | Do not touch the Sheet | off |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `No valid X session` / login redirect | Run `node First/login.js --refresh`, or set `X_AUTH_TOKEN` (and `X_AUTH_CT0`). |
| Empty page / HTTP 403 shell (bot block) | Re-run with `--headful --no-block-media`, refresh the session, or lower `--concurrency`. |
| `Could not load Playwright helpers from .../lib/twitter.js` | Make sure `lib/twitter.js` sits at the repo root, or set `PROJ_ROOT` / `TWITTER_PLAYWRIGHT_DIR`. |
| Sheet write skipped | Configure `X_SHEET_ID` + token (direct mode), or pass `--local-csv <file>`. |
| Run prints *"short"* | Raise the budget: `--max-profiles 300 --max-minutes 30 --expand-rounds 5`, then re-run Phase 2. |
| Excel locks the CSV mirror | The mirror is staged to `<name>.new.csv` and reported **DEGRADED**; the Sheet stays authoritative. |
| X throttles you | Drop `--concurrency` to `2` and/or add `--stealth`. |

---

## Security & data hygiene

- **Secrets stay local.** `auth.json`, `sheet-config.json`, `config.local.json`,
  `.env`, OAuth tokens and API credential files are all listed in `.gitignore`.
  Never commit them. (The tracked `config.json` ships only placeholder values;
  put anything private in `config.local.json` or env vars.)
- **No credentials in code.** Everything is read from environment variables or the
  ignored local config files; the repository ships only `*.example` templates.
- **Minimal data.** The output schema stores only publicly visible profile data
  (handle, URL, follower count, bio, post recency/frequency). No passwords, no DMs,
  no private account data.
- **Legal.** You are responsible for complying with X's Terms of Service and any
  applicable privacy, data-protection and anti-spam regulations in your
  jurisdiction.

---

## License

[MIT](LICENSE).
