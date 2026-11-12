# relate-glance

Tiny dashboard for watching a [relate](https://relatedb.ai) agent-memory store
(`~/.relate/memory`) as agents read and write it. Strictly read-only: every
query opens the store with `--read-only=live`, the same mode the live MCP
processes use, so it never blocks or corrupts writers.

```
┌─ relate ──────────────────────┐
│ ● live              3m ago    │
│ 330 ents 202 eps 92 facts 42MB│
│ ▁▂▂▃▃▄▅▆ events · 7d          │
│───────────────────────────────│
│ 10/13 16:55 EP  3 PRs compl…  │
│ 10/13 15:13 EP  Evaluated A…  │
└───────────────────────────────┘
```

- **Glance:** live dot (write in last 10 min), "last write Xs ago", feed of the
  newest episodes and facts.
- **Health/growth:** node/relationship counts, on-disk size, 7-day cumulative
  sparkline of episodes + facts (computed from their timestamps — the app
  persists nothing).
- **Reads served:** MCP tool calls against the store (reads-24h tile + per-day
  bars), scraped best-effort from the hosts' MCP logs: Claude Code's
  `~/Library/Caches/claude-cli-nodejs/*/mcp-logs-relate-memory/*.jsonl` and
  Claude Desktop's `~/Library/Logs/Claude/mcp-server-relate-memory.log`. A host
  that doesn't log tool calls won't be counted.

## Run

```sh
./run.sh        # starts the server (bun) and opens a small Chrome app window
```

Or manually: `bun server.ts` then open http://localhost:7877.

Env overrides: `RELATE_BIN` (default `~/.local/bin/relate`), `RELATE_DB`
(default `~/.relate/memory`), `PORT` (default `7877`).

## Requirements

- [bun](https://bun.sh)
- `relate` CLI with a store at `~/.relate/memory`
