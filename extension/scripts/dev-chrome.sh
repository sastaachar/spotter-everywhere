#!/usr/bin/env bash
# Launch Chrome for Testing with this extension loaded and remote debugging on,
# so `npm run reload` can drive it. An unmanaged Chrome for Testing is used
# because managed Chrome blocks unpacked extensions. Override paths with env vars.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${CFT_APP:-$HOME/Applications/Google Chrome for Testing.app}"
BIN="$APP/Contents/MacOS/Google Chrome for Testing"
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
