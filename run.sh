#!/usr/bin/env bash
# Run the relate-glance TUI in the current terminal (size the window as you like).
set -euo pipefail
cd "$(dirname "$0")"
exec bun tui.ts "$@"
