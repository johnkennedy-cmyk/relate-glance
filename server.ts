// relate-glance: tiny read-only dashboard over a relate memory store.
// Zero deps. Run with: bun server.ts
declare const Bun: any;

const HOME = process.env.HOME ?? "";
const RELATE_BIN = process.env.RELATE_BIN ?? `${HOME}/.local/bin/relate`;
const RELATE_DB = process.env.RELATE_DB ?? `${HOME}/.relate/memory`;
const PORT = Number(process.env.PORT ?? 7877);
const POLL_CACHE_MS = 4000;

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  // Drain both pipes concurrently so a chatty stderr can't deadlock the child.
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${err}`);
  return out;
}

async function cypher(stmt: string): Promise<any[]> {
  const out = await run([RELATE_BIN, "query", stmt, "-d", RELATE_DB, "--read-only=live", "--json"]);
  return JSON.parse(out).data ?? [];
}

type Event = { at: string; typ: "episode" | "fact"; kind: string; text: string; about?: string };

import { readdir, readFile, stat } from "node:fs/promises";

// Reads served: MCP tool calls against the store, scraped from the hosts' MCP logs.
// Claude Code logs `"Calling MCP tool: <name>"` per call; Claude Desktop logs
// `Message from client: method="tools/call"`. Best-effort — a host that doesn't
// log calls won't be counted.
async function readTraffic(sinceMs: number): Promise<number[]> {
  const stamps: number[] = [];
  const base = `${HOME}/Library/Caches/claude-cli-nodejs`;
  for (const proj of await readdir(base).catch(() => [] as string[])) {
    const dir = `${base}/${proj}/mcp-logs-relate-memory`;
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const path = `${dir}/${f}`;
      const st = await stat(path).catch(() => null);
      if (!st || st.mtimeMs < sinceMs) continue;
      const txt = await readFile(path, "utf8").catch(() => "");
      for (const line of txt.split("\n")) {
        if (!line.includes("Calling MCP tool:")) continue;
        const m = line.match(/"timestamp":"([^"]+)"/);
        const t = m ? Date.parse(m[1]) : NaN;
        if (t >= sinceMs) stamps.push(t);
      }
    }
  }
  const desktop = await readFile(`${HOME}/Library/Logs/Claude/mcp-server-relate-memory.log`, "utf8").catch(() => "");
  for (const line of desktop.split("\n")) {
    if (!line.includes('method="tools/call"')) continue;
    const t = Date.parse(line.split(" ", 1)[0]);
    if (t >= sinceMs) stamps.push(t);
  }
  return stamps;
}

async function snapshot() {
  // relate one-shot output is capped at 100 rows, so never SELECT whole tables:
  // feed uses LIMIT, growth uses per-day aggregation (<=8 rows).
  // 7 calendar-day window: today plus the 6 prior days.
  const windowStart = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10) + "T00:00:00Z";
  const [counts, rels, episodes, facts, epDays, factDays, du] = await Promise.all([
    cypher("MATCH (n) RETURN labels(n)[0] AS l, count(n) AS c"),
    cypher("MATCH ()-[r]->() RETURN count(r) AS c"),
    cypher("MATCH (e:Episode) RETURN e.at AS at, e.kind AS kind, e.text AS text ORDER BY at DESC LIMIT 15"),
    cypher(
      "MATCH (f:Fact) OPTIONAL MATCH (f)-[:ABOUT]->(en:Entity) WITH f, collect(en.name) AS about " +
        "RETURN f.recordedAt AS at, f.slot AS slot, coalesce(f.text, f.body) AS text, about ORDER BY at DESC LIMIT 15",
    ),
    cypher(`MATCH (e:Episode) WHERE e.at >= datetime("${windowStart}") RETURN left(toString(e.at),10) AS day, count(*) AS c`),
    cypher(`MATCH (f:Fact) WHERE f.recordedAt >= datetime("${windowStart}") RETURN left(toString(f.recordedAt),10) AS day, count(*) AS c`),
    run(["du", "-sk", RELATE_DB]).catch(() => "0"),
  ]);
  const readStamps = await readTraffic(Date.parse(windowStart));

  const byLabel: Record<string, number> = {};
  for (const row of counts) byLabel[row.l] = row.c;

  const events: Event[] = [
    ...episodes.map((e: any): Event => ({ at: e.at, typ: "episode", kind: e.kind ?? "", text: e.text ?? "" })),
    ...facts.map(
      (f: any): Event => ({
        at: f.at,
        typ: "fact",
        kind: f.slot ?? "",
        text: f.text ?? "",
        about: (f.about ?? []).slice(0, 2).join(", "),
      }),
    ),
  ].filter((e) => e.at);
  events.sort((a, b) => (a.at < b.at ? 1 : -1));

  // Daily cumulative event count, last 7 days (health/growth).
  const perDay: Record<string, number> = {};
  let windowSum = 0;
  for (const row of [...epDays, ...factDays]) {
    perDay[row.day] = (perDay[row.day] ?? 0) + row.c;
    windowSum += row.c;
  }
  const total = (byLabel.Episode ?? 0) + (byLabel.Fact ?? 0);
  let cum = total - windowSum; // everything written before the window
  const days: { day: string; cum: number }[] = [];
  const reads: { day: string; c: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    cum += perDay[day] ?? 0;
    days.push({ day, cum });
    reads.push({ day, c: readStamps.filter((t) => new Date(t).toISOString().slice(0, 10) === day).length });
  }
  const reads24h = readStamps.filter((t) => t > Date.now() - 86400_000).length;
  const lastRead = readStamps.length ? new Date(Math.max(...readStamps)).toISOString() : null;

  return {
    ts: new Date().toISOString(),
    db: RELATE_DB,
    counts: {
      entities: byLabel.Entity ?? 0,
      episodes: byLabel.Episode ?? 0,
      facts: byLabel.Fact ?? 0,
      rels: rels[0]?.c ?? 0,
    },
    sizeKB: Number(String(du).trim().split(/\s+/)[0] || 0),
    lastWrite: events[0]?.at ?? null,
    growth: days,
    reads: { perDay: reads, last24h: reads24h, lastRead },
    feed: events.slice(0, 15).map((e) => ({ ...e, text: e.text.length > 110 ? e.text.slice(0, 110) + "…" : e.text })),
  };
}

let cache: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;

async function cachedState(): Promise<string> {
  if (cache && Date.now() - cache.at <= POLL_CACHE_MS) return cache.body;
  // Coalesce concurrent refreshes into one subprocess batch.
  inflight ??= (async () => {
    try {
      const body = JSON.stringify(await snapshot());
      cache = { at: Date.now(), body };
      return body;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const INDEX = await Bun.file(new URL("./index.html", import.meta.url).pathname).text();

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req: Request) {
    const path = new URL(req.url).pathname;
    if (path === "/api/state") {
      try {
        return new Response(await cachedState(), { headers: { "content-type": "application/json" } });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }
    if (path === "/") return new Response(INDEX, { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  },
});

console.log(`relate-glance on http://localhost:${PORT} (store: ${RELATE_DB}, read-only)`);
