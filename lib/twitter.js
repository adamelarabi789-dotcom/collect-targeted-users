/**
 * lib/twitter.js — shared Playwright helpers for the collector scripts.
 *
 * Browser modes:
 *   - "cdp"     (default): attaches to your ALREADY-RUNNING Chrome via the
 *               DevTools protocol and works in tabs of your live default
 *               profile/session. Only the tab the script opens is ever
 *               closed — your Chrome, windows and tabs are left untouched.
 *               One-time requirement: Chrome must have been started with
 *               --remote-debugging-port=9222 (see First/start-chrome.cmd or
 *               First/start-chrome.sh).
 *               If that port is unreachable, falls back to "auth" mode when
 *               auth.json contains a valid session.
 *   - "auth":   standalone headless Chrome loaded with the session state saved
 *               in auth.json (Chrome can stay open). Refresh via: node First/login.js --refresh
 *   - "profile": reuses the real Chrome profile directly (requires ALL Chrome
 *               windows closed — only use this if you accept that constraint).
 *
 * Select the mode per-run without editing code:
 *   Windows PowerShell:  $env:X_MODE='cdp'; node find-post.js ...
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Load an optional local .env before the session/profile paths are resolved.
try {
  require('../scripts/env').loadEnv();
} catch {
  /* env.js is optional when the helpers are used from another project */
}

// P14: no hard-coded absolute paths. An explicit env override wins; otherwise
// resolve from the conventional install locations for the current machine.
const CHROME_EXE = (() => {
  if (process.env.X_CHROME_EXE) return process.env.X_CHROME_EXE;
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
})();
// Chrome user-data root per platform (override with X_PROFILE_DIR). Chrome
// stores the logged-in session in the "Default" subfolder of this root.
const PROFILE_DIR =
  process.env.X_PROFILE_DIR ||
  (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
      : path.join(os.homedir(), '.config', 'google-chrome'));
// Saved X session state (Playwright storageState). Override with X_AUTH_FILE.
// Default: auth.json at the repo root, next to package.json.
const AUTH_FILE = process.env.X_AUTH_FILE || path.join(__dirname, '..', 'auth.json');
const CDP_URL = 'http://127.0.0.1:9222';
const VIEWPORT = { width: 1280, height: 900 };
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const BASE_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * Attach to the user's running Chrome over CDP. Returns a page-scoped
 * session: `close()` only closes the tab we opened — never the browser.
 */
async function connectCdp({ timeout = 5000 } = {}) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout });
  } catch (err) {
    return { ok: false, error: err };
  }
  const context = browser.contexts()[0];
  const page = await context.newPage();
  return {
    ok: true,
    context,
    page,
    close: async () => {
      try {
        await page.close();
      } catch {
        /* page already gone */
      }
    },
  };
}

/** Build a Playwright storageState from X_AUTH_TOKEN (and optional X_AUTH_CT0). */
function envStorageState() {
  const token = (process.env.X_AUTH_TOKEN || '').trim();
  if (!token) return null;
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  const base = { domain: '.x.com', path: '/', expires, secure: true, sameSite: 'Lax' };
  const cookies = [{ ...base, name: 'auth_token', value: token, httpOnly: true }];
  const ct0 = (process.env.X_AUTH_CT0 || '').trim();
  if (ct0) cookies.push({ ...base, name: 'ct0', value: ct0, httpOnly: false });
  return { cookies, origins: [] };
}

/** Saved session state from auth.json, or one built from env vars, or null. */
function loadState() {
  const fromEnv = envStorageState();
  if (fromEnv) return fromEnv;
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** True when a session is available (auth.json cookie or X_AUTH_TOKEN env var). */
function hasAuthToken() {
  if ((process.env.X_AUTH_TOKEN || '').trim()) return true;
  try {
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return Array.isArray(state.cookies) && state.cookies.some((c) => c.name === 'auth_token');
  } catch {
    return false;
  }
}

/** Standalone headless browser loaded from auth.json (or X_AUTH_TOKEN) state. */
async function openAuth(headless) {
  const state = loadState();
  if (!state || !Array.isArray(state.cookies) || !state.cookies.some((c) => c.name === 'auth_token')) {
    throw new Error(
      `No valid X session. Set X_AUTH_TOKEN, or save a session at ${AUTH_FILE}. ` +
        'Run: node First/login.js --refresh'
    );
  }
  const browser = await chromium.launch({
    headless,
    ...(CHROME_EXE ? { executablePath: CHROME_EXE } : {}),
    args: BASE_ARGS,
  });
  const context = await browser.newContext({
    storageState: state,
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
  });
  return { context, page: await context.newPage(), close: () => browser.close() };
}

/** Launch a persistent context on the real Chrome profile (Chrome must be closed). */
async function openProfile(headless) {
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      ...(CHROME_EXE ? { executablePath: CHROME_EXE } : {}),
      args: BASE_ARGS,
      viewport: VIEWPORT,
      timeout: 60000,
    });
  } catch (err) {
    throw new Error(
      'Could not open the Chrome profile (probably locked). Close ALL Chrome windows, ' +
        'or prefer cdp/auth modes which keep Chrome running. Details: ' +
        err.message.split('\n')[0]
    );
  }
  const page = context.pages()[0] || (await context.newPage());
  return { context, page, close: () => context.close() };
}

/**
 * Open an X session and return { context, page, close }.
 * default mode: 'cdp' — attaches to your running Chrome.
 */
async function openX({ headless = true, mode = process.env.X_MODE || 'cdp' } = {}) {
  if (mode === 'cdp') {
    const cdp = await connectCdp();
    if (cdp.ok) return cdp;
    if (hasAuthToken()) {
      console.log(
        `[cdp] Running Chrome is not reachable at ${CDP_URL}. ` +
          'Falling back to the saved session in auth.json (no Chrome restart needed).'
      );
      return openAuth(headless);
    }
    throw new Error(
      `Could not attach to your running Chrome at ${CDP_URL} (${cdp.error.message.split('\n')[0]}).\n` +
        '  One-time setup: Chrome must run with remote debugging enabled.\n' +
        '    close Chrome and run: First/start-chrome.cmd (Windows) or First/start-chrome.sh (macOS/Linux)\n' +
        '  Afterwards scripts attach to your Chrome and never reopen/touch the profile.'
    );
  }
  if (mode === 'auth') return openAuth(headless);
  return openProfile(headless);
}

/**
 * Detect a login redirect or a bot-blocked empty shell and throw with a
 * readable message. Call after page.goto + a short settle delay.
 */
async function ensureLoggedIn(page) {
  await page.waitForTimeout(3000);
  const probe = await page.evaluate(() => ({
    url: location.href,
    textLen: document.body ? document.body.innerText.trim().length : 0,
  }));
  if (/\/i\/flow\/login|\/login|\/i\/jf\/onboarding/.test(probe.url)) {
    throw new Error(`Not logged in — redirected to ${probe.url}. Sign in on X (or run: node First/login.js).`);
  }
  if (probe.textLen === 0) {
    throw new Error('X served an empty shell (HTTP 403 bot block or slow load). Try again.');
  }
}

/**
 * Reliably type text into a Draft.js composer (contenteditable).
 * Uses execCommand('insertText') first, falls back to keyboard input.
 */
async function fillComposer(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 15000 });
  const inserted = await page.evaluate(
    ({ sel, msg }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, msg);
      return true;
    },
    { sel: selector, msg: text }
  );
  if (inserted) {
    await page.waitForTimeout(400);
    const ok = await page.$eval(selector, (el) => el.innerText).catch(() => '');
    if (ok.includes(text.slice(0, 20))) return;
  }
  await page.evaluate((sel) => { document.querySelector(sel)?.focus(); }, selector);
  await page.waitForTimeout(250);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text, { delay: 30 });
  await page.waitForTimeout(400);
  const ok = await page.$eval(selector, (el) => el.innerText).catch(() => '');
  if (!ok.includes(text.slice(0, 20))) {
    throw new Error('Text did not enter the composer (selector: ' + selector + ').');
  }
}

/**
 * Submit an open composer: DOM-click the enabled Post button(s), then fall
 * back to Ctrl+Enter. Returns 'sent' or 'still-open'.
 */
async function submitComposer(
  page,
  composerSelector = '[data-testid="tweetTextarea_0"]',
  buttonSelector = '[data-testid="tweetButtonInline"]'
) {
  const clicked = await page.evaluate((sel) => {
    const btns = [...document.querySelectorAll(sel)].filter(
      (b) => b.getAttribute('aria-disabled') !== 'true'
    );
    btns.forEach((b) => b.click());
    return btns.length;
  }, buttonSelector);
  await page.waitForTimeout(4000);
  if (!(await page.$(composerSelector))) return 'sent';

  await page.evaluate((sel) => { document.querySelector(sel)?.focus(); }, composerSelector);
  await page.waitForTimeout(250);
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(5000);
  return (await page.$(composerSelector)) ? 'still-open' : 'sent';
}

module.exports = {
  PROFILE_DIR,
  CHROME_EXE,
  AUTH_FILE,
  CDP_URL,
  VIEWPORT,
  USER_AGENT,
  BASE_ARGS,
  connectCdp,
  hasAuthToken,
  openX,
  ensureLoggedIn,
  fillComposer,
  submitComposer,
};