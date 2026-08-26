#!/usr/bin/env bash
# Records an animated GIF demo of the local-llmup browser workspace.
# Requires: Google Chrome, ffmpeg, and a running `local-llmup gui` server.
#
# Usage: scripts/record-gui-demo.sh <appUrl> <outputGif>
set -euo pipefail

APP_URL="${1:-http://127.0.0.1:4173/}"
OUT_GIF="${2:-assets/gui-out.gif}"
CDP_PORT="${CDP_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FRAMES_DIR="$(mktemp -d /tmp/gui-frames.XXXXXX)"
PROFILE_DIR="$(mktemp -d /tmp/gui-cdp.XXXXXX)"

cleanup() {
  [[ -n "${CHROME_PID:-}" ]] && kill "$CHROME_PID" 2>/dev/null || true
  rm -rf "$PROFILE_DIR"
}
trap cleanup EXIT

pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true
sleep 1

"$CHROME" --headless=new --hide-scrollbars --disable-gpu \
  --remote-debugging-port="$CDP_PORT" --remote-allow-origins='*' \
  --user-data-dir="$PROFILE_DIR" --window-size=1280,800 about:blank \
  >"$PROFILE_DIR/chrome.log" 2>&1 &
CHROME_PID=$!

# Wait for the DevTools endpoint to come up.
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null; then break; fi
  sleep 0.5
done

node scripts/record-gui-demo.mjs "$CDP_PORT" "$APP_URL" "$FRAMES_DIR"

# Assemble the captured frames into a looping GIF (~2 fps hold cadence).
ffmpeg -y -framerate 2 -pattern_type glob -i "$FRAMES_DIR/frame-*.png" \
  -vf "scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  -loop 0 "$OUT_GIF"

echo "wrote $OUT_GIF"
ls -la "$OUT_GIF"
