#!/usr/bin/env bash
# Start relate-glance and open it in a small chromeless window.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-7877}"

# A generic 200 on this port could be some other service — check for our API shape.
if ! curl -sf "http://localhost:${PORT}/api/state" 2>/dev/null | grep -q '"counts"'; then
  nohup bun server.ts >/tmp/relate-glance.log 2>&1 &
  ready=0
  for _ in $(seq 1 20); do
    if curl -sf "http://localhost:${PORT}/api/state" 2>/dev/null | grep -q '"counts"'; then ready=1; break; fi
    sleep 0.25
  done
  if [ "$ready" -ne 1 ]; then
    echo "relate-glance failed to start — see /tmp/relate-glance.log" >&2
    exit 1
  fi
fi

open -na "Google Chrome" --args "--app=http://localhost:${PORT}" --window-size=360,460
