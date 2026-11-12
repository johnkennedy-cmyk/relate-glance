# relate-glance

Tiny terminal dashboard for watching a [relate](https://relatedb.ai)
agent-memory store (`~/.relate/memory`) as agents read and write it. Strictly
read-only: every query opens the store with `--read-only=live`, the same mode
the live MCP processes use, so it never blocks or corrupts writers.

```
● relate                last write 16h ago
330 ent · 202 ep · 92 fact · 1011 rel · 0.3 MB
writes 7d ▁▁▁▁▁▆█ 294 (+16)
reads  7d ▁▁▁▁▁█▂ 8/24h · last 25m ago
────────────────────────────────────────
11/11 18:00 FACT relate v1.0.0 graph mem…
11/11 11:03 EP   debugged the retry loop…
```

- **Glance:** live dot (write in last 10 min), "last write Xs ago", feed of the
  newest episodes and facts (fills whatever height the terminal has).
- **Health/growth:** node/relationship counts, on-disk size, 7-day cumulative
  sparkline of episodes + facts (computed from their timestamps — the app
  persists nothing).
- **Reads served:** MCP tool calls against the store (reads/24h + 7-day
  sparkline), scraped best-effort from the hosts' MCP logs: Claude Code's
  `~/Library/Caches/claude-cli-nodejs/*/mcp-logs-relate-memory/*.jsonl` and
  Claude Desktop's `~/Library/Logs/Claude/mcp-server-relate-memory.log`. A host
  that doesn't log tool calls won't be counted.

## Run

```sh
./run.sh          # TUI in the current terminal; size the window to taste
./run.sh --once   # print a single frame and exit
```

Redraws every 5s and on resize. Keys: `q` quit, `r` refresh now.

## Always running (login autostart)

`relate-glance.command` is a double-clickable launcher that opens the TUI in a
Terminal window, restarts it if it crashes, and stays quit after a clean `q`.
Add it to **System Settings → General → Login Items** (or:
`osascript -e 'tell application "System Events" to make login item at end with
properties {path:"<repo>/relate-glance.command", hidden:false}'`) and a glance
window appears at every login.

relate itself needs no autostart: it's an embedded database — this app (and
every MCP host) opens the store directly per query, and the `relate serve`
processes are spawned by Claude Desktop/Code on their own launch.

Env overrides: `RELATE_BIN` (default `~/.local/bin/relate`), `RELATE_DB`
(default `~/.relate/memory`).

## Requirements

- [bun](https://bun.sh)
- `relate` CLI with a store at `~/.relate/memory`
