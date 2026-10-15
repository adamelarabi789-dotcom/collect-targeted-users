/**
 * login.js — open/verify the X session without ever touching your Chrome.
 *
 * Behavior:
 *   - If your Chrome is running with remote debugging (First/start-chrome.cmd
 *       on Windows, First/start-chrome.sh on macOS/Linux):
 *       opens x.com/home in a new tab of your live Chrome (tab stays open).
 *   - Otherwise, if auth.json holds a valid session:
 *       confirms "auth mode" is armed — find/reply/post run headless while
 *       your Chrome stays open.
 *   - --refresh: saves the live session to auth.json (requires CDP above).
 */
const fs = require('fs');
const { connectCdp, hasAuthToken, ensureLoggedIn, AUTH_FILE, CDP_URL } = require('../lib/twitter');

const REFRESH = process.argv.includes('--refresh');

async function main() {
  const cdp = await connectCdp();
  if (cdp.ok) {
    const { page, context } = cdp;
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    await ensureLoggedIn(page);
    console.log('Opened X in your Chrome — tab stays open.');
    if (REFRESH) {
      try {
        const state = await context.storageState();
        fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));
        console.log(`Saved ${state.cookies.length} cookies to ${AUTH_FILE}`);
      } catch (err) {
        console.error('Could not save session cookies:', err.message);
        process.exitCode = 1;
      }
    }
    return;
  }

  // Chrome isn't attached to CDP — fall back to the saved session.
  if (hasAuthToken()) {
    console.log(`Running Chrome isn't reachable at ${CDP_URL} (remote debugging off).`);
    console.log('auth.json has a valid session — "auth mode" is armed.');
    console.log('The collector scripts will run headless while your Chrome stays open.');
  } else {
    console.error(
      `Could not attach to Chrome at ${CDP_URL} and auth.json has no valid session.\n` +
        '  To enable the no-restart workflow, enable remote debugging once:\n' +
        '    close Chrome, run First/start-chrome.cmd (Windows) or First/start-chrome.sh (macOS/Linux),\n' +
        '    sign in to X, then re-run this script.'
    );
    process.exitCode = 3;
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});