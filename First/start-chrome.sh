#!/usr/bin/env bash
# start-chrome.sh - start Chrome with remote debugging so the collector can
# attach to your running session (used only to refresh auth.json).
# Close Chrome first, then run this once. After that keep Chrome running.
set -euo pipefail

if [[ -n "${CHROME_EXE:-}" ]]; then
  chrome="$CHROME_EXE"
elif [[ "$(uname)" == "Darwin" ]]; then
  chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  chrome="$(command -v google-chrome || command -v google-chrome-stable || true)"
fi

if [[ -z "${chrome:-}" || ! -x "$chrome" ]]; then
  echo "Could not find Chrome. Set CHROME_EXE and re-run." >&2
  exit 1
fi

# macOS: the live profile is under ~/Library/Application Support/Google/Chrome
# Linux: ~/.config/google-chrome
if [[ "$(uname)" == "Darwin" ]]; then
  profile="$HOME/Library/Application Support/Google/Chrome"
else
  profile="$HOME/.config/google-chrome"
fi

"$chrome" --remote-debugging-port=9222 --user-data-dir="$profile" >/dev/null 2>&1 &
echo "Chrome started with remote debugging on port 9222."
