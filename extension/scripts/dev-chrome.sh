#!/usr/bin/env bash
# Launch Chrome for Testing with this extension loaded and remote debugging on,
# so `npm run reload` can drive it. An unmanaged Chrome for Testing is used
# because managed Chrome blocks unpacked extensions. Override paths with env vars.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${CFT_APP:-$HOME/Applications/Google Chrome for Testing.app}"
BIN="$APP/Contents/MacOS/Google Chrome for Testing"

# Fall back to a Chrome for Testing installed by @puppeteer/browsers (its default
# cache) when the app isn't at CFT_APP / the default path. Newest version wins.
if [[ ! -x "$BIN" ]]; then
  FALLBACK="$(ls -d "$HOME"/.cache/puppeteer/chrome/*/chrome-mac*/*.app 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$FALLBACK" ]]; then
    APP="$FALLBACK"
    BIN="$APP/Contents/MacOS/Google Chrome for Testing"
  fi
fi
if [[ ! -x "$BIN" ]]; then
  echo "Chrome for Testing not found. Set CFT_APP to its .app path, or install it:" >&2
  echo "  npx @puppeteer/browsers install chrome@stable" >&2
  exit 1
fi

PROFILE="${CFT_PROFILE:-$HOME/.spotter-extension-dev-profile}"
PORT="${CDP_PORT:-9222}"
mkdir -p "$PROFILE"
exec "$BIN" \
  --user-data-dir="$PROFILE" \
  --load-extension="$HERE" \
  --remote-debugging-port="$PORT" \
  --no-first-run --no-default-browser-check \
  --ignore-certificate-errors \
  "${@:-https://prod-in-a.online.tableau.com/}"
