#!/usr/bin/env bash
# Runs the native browser journeys against a disposable fixture and a matching ChromeDriver.
set -euo pipefail

chrome=${1:?usage: native-browser-journeys.sh CHROME CHROMEDRIVER [ARTIFACT_DIR]}
driver=${2:?usage: native-browser-journeys.sh CHROME CHROMEDRIVER [ARTIFACT_DIR]}
root=$(cd "$(dirname "$0")/.." && pwd)
artifacts=${3:-$root/test-results/rust-browser}
exe=""
if [[ "${OS:-}" == "Windows_NT" ]]; then exe=".exe"; fi

cargo build --locked -p llmup-gui --example browser_fixture --example browser_smoke
mkdir -p "$artifacts"

"$driver" --port=48232 --allowed-ips=127.0.0.1 &
driver_pid=$!
RUST_GUI_TEST_PORT=48231 "$root/target/debug/examples/browser_fixture$exe" &
fixture_pid=$!
trap 'kill "$fixture_pid" "$driver_pid" 2>/dev/null || true' EXIT

ready=false
for _ in $(seq 1 100); do
  if curl -sf -o /dev/null http://127.0.0.1:48231/ && curl -sf -o /dev/null http://127.0.0.1:48232/status; then
    ready=true
    break
  fi
  sleep 0.2
done
if [[ "$ready" != true ]]; then
  echo "fixture or ChromeDriver did not become ready" >&2
  exit 1
fi

"$root/target/debug/examples/browser_smoke$exe" http://127.0.0.1:48232 http://127.0.0.1:48231 "$chrome" "$artifacts"
