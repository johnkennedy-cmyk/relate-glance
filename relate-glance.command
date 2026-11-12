#!/usr/bin/env bash
# Double-clickable launcher — add to System Settings > Login Items to get a
# relate-glance terminal window at every login.
set -u
cd "$(dirname "$0")"

# Login Items don't get a login-shell PATH — add bun and relate explicitly.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# Ask Terminal for a compact default size (user can still resize freely).
printf '\e[8;18;80t'

# Restart on crash; a clean quit (q / Ctrl-C) stays quit.
while true; do
  if bun tui.ts; then break; fi
  echo "relate-glance exited abnormally — restarting in 3s (Ctrl-C to stop)"
  sleep 3 || break
done
