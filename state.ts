// relate-glance data layer: read-only snapshot of a relate memory store.
declare const Bun: any;

const HOME = process.env.HOME ?? "";
const RELATE_BIN = process.env.RELATE_BIN ?? `${HOME}/.local/bin/relate`;
const RELATE_DB = process.env.RELATE_DB ?? `${HOME}/.relate/memory`;

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

// System memory view: summed RSS of relate processes (the serve/query
// processes holding the live graph), total RAM, and free-ish memory.
async function systemMem() {
  // Best-effort and macOS-specific (vm_stat, hw.memsize); on other platforms
  // this returns zeros and the TUI hides the line rather than erroring.
  const [psOut, totalOut, vmOut] = await Promise.all([
    run(["ps", "-axo", "rss=,args="]).catch(() => ""),
    run(["sysctl", "-n", "hw.memsize"]).catch(() => "0"),
    run(["vm_stat"]).catch(() => ""),
  ]);
  let relateKB = 0;
  for (const line of psOut.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && m[2].includes(RELATE_BIN)) relateKB += Number(m[1]);
  }
  const pageSize = Number(vmOut.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (name: string) => Number(vmOut.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? 0);
  // ponytail: free+inactive+purgeable ≈ macOS "available"; close enough for a glance
  const freeKB = ((pages("Pages free") + pages("Pages inactive") + pages("Pages purgeable")) * pageSize) / 1024;
  return { relateKB, totalKB: Number(totalOut.trim()) / 1024, freeKB };
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

export async function snapshot() {
  // relate one-shot output is capped at 100 rows, so never SELECT whole tables:
  // feed uses LIMIT, growth uses per-day aggregation (<=8 rows).
  // 7 calendar-day window: today plus the 6 prior days.
  const windowStart = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10) + "T00:00:00Z";
  const [counts, rels, episodes, facts, epDays, factDays, du] = await Promise.all([
    cypher("MATCH (n) RETURN labels(n)[0] AS l, count(n) AS c"),
    cypher("MATCH ()-[r]->() RETURN count(r) AS c"),
    cypher("MATCH (e:Episode) RETURN e.at AS at, e.kind AS kind, e.text AS text ORDER BY at DESC LIMIT 40"),
    cypher(
      "MATCH (f:Fact) OPTIONAL MATCH (f)-[:ABOUT]->(en:Entity) WITH f, collect(en.name) AS about " +
        "RETURN f.recordedAt AS at, f.slot AS slot, coalesce(f.text, f.body) AS text, about ORDER BY at DESC LIMIT 40",
    ),
    cypher(`MATCH (e:Episode) WHERE e.at >= datetime("${windowStart}") RETURN left(toString(e.at),10) AS day, count(*) AS c`),
    cypher(`MATCH (f:Fact) WHERE f.recordedAt >= datetime("${windowStart}") RETURN left(toString(f.recordedAt),10) AS day, count(*) AS c`),
    run(["du", "-sk", RELATE_DB]).catch(() => "0"),
  ]);
  const [readStamps, mem] = await Promise.all([readTraffic(Date.parse(windowStart)), systemMem()]);

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
    mem,
    lastWrite: events[0]?.at ?? null,
    growth: days,
    reads: { perDay: reads, last24h: reads24h, lastRead },
    // ponytail: 40 rows fills any sane glance terminal; taller than ~45 rows pads short
    feed: events.slice(0, 40).map((e) => ({ ...e, text: e.text.length > 200 ? e.text.slice(0, 200) + "…" : e.text })),
  };
}
