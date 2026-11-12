#!/usr/bin/env node
/**
 * glance — a Relate extension (MCP stdio client).
 *
 * Scaffolded by `relate extension init glance`. The package is
 * `extension.json` (the manifest the host parses — mount name, MCP revision,
 * flag table, commit policy) plus this executable (the file the host
 * spawns); `README.md` is the quickstart and is not part of the install.
 *
 * Glue: the transport contract lives in docs/api/extensions/spec.md, "The Transport contract". The line reader and
 * the minimal client below are generated inline — no published client
 * dependency to install or manage: re-scaffold with `relate extension
 * init` or copy that section when the contract changes. No imports either:
 * after Node's type strip this file is plain CommonJS-compatible JavaScript,
 * so `node` runs it as it is (Node 22.18+ strips the types).
 *
 * Edit `walk()`; everything above it is the generated glue.
 */

type Json = Record<string, unknown>;

/** The MCP revision this package speaks — the manifest's `protocol`. */
const PROTOCOL_VERSION = "2025-06-18";
const NAME = "glance";
const VERSION = "0.1.0";

/** A JSON-RPC 2.0 message, the fields the client reads. */
interface RpcMessage {
  id?: number;
  result?: Json;
  error?: { code: number; message: string };
}

/** The host's messages, one JSON line each, read from the process's stdin. */
class Lines {
  private buffer = "";
  private queue: string[] = [];
  private waiters: ((line: string) => void)[] = [];

  constructor() {
    process.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const waiter = this.waiters.shift();
        if (waiter !== undefined) waiter(line);
        else this.queue.push(line);
      }
    });
    process.stdin.resume();
  }

  next(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * The minimal MCP client: one JSON-RPC line per message, ids echoed. The
 * host is the MCP server — it alone owns the store — so every call below is
 * a `tools/call` on its five-tool table. The handshake publishes the mount's
 * caps and the store's capacity; both stay on the client after `start()`.
 */
class Client {
  private lines = new Lines();
  private nextId = 0;
  caps: Json = {};
  capacity: Json = {};

  private send(message: Json): void {
    process.stdout.write(JSON.stringify(message) + "\n");
  }

  private async request(method: string, params: Json): Promise<Json> {
    const id = ++this.nextId;
    this.send({ jsonrpc: "2.0", id, method, params });
    for (;;) {
      const message = JSON.parse(await this.lines.next()) as RpcMessage;
      if (message.id !== id) continue; // a notification, or an answer nobody asked for
      if (message.error !== undefined) {
        throw new Error(`${method} refused: ${JSON.stringify(message.error)}`);
      }
      return message.result ?? {};
    }
  }

  /** Read the envelope, run the initialize handshake, confirm it. */
  async start(): Promise<Json> {
    const envelope = JSON.parse(await this.lines.next()) as Json;
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: NAME, version: VERSION },
    });
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`the host speaks ${String(result.protocolVersion)}, not ${PROTOCOL_VERSION}`);
    }
    this.caps = (result.caps ?? {}) as Json;
    this.capacity = (result.capacity ?? {}) as Json;
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return envelope;
  }

  /** One `tools/call`; returns the tool's JSON result. */
  async call(tool: string, args: Json): Promise<Json> {
    const result = await this.request("tools/call", { name: tool, arguments: args });
    const blocks = (result.content ?? []) as { type: string; text?: string }[];
    for (const block of blocks) {
      if (block.type === "text" && block.text !== undefined) {
        return JSON.parse(block.text) as Json;
      }
    }
    throw new Error(`'${tool}' answered no text content`);
  }
}

/** All rows of a read result, objects keyed by the statement's RETURN names. */
function rows(result: Json): Json[] {
  return (result.rows ?? []) as Json[];
}

/**
 * Read-only glance at the store: node counts by label, relationship count,
 * and — when the store is a relate agent-memory graph (Episode/Fact labels)
 * — the newest write timestamp. Writes nothing.
 */
async function walk(client: Client): Promise<void> {
  const byLabel = await client.call("read_cypher", {
    statement: "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS c ORDER BY c DESC",
  });
  const rels = await client.call("read_cypher", {
    statement: "MATCH ()-[r]->() RETURN count(r) AS c",
  });
  const lastWrite = await client.call("read_cypher", {
    statement:
      "OPTIONAL MATCH (e:Episode) WITH max(e.at) AS ep OPTIONAL MATCH (f:Fact) " +
      "RETURN ep, max(f.recordedAt) AS fa",
  });

  const labelParts = rows(byLabel).map((r) => `${String(r.c)} ${String(r.label)}`);
  const relCount = rows(rels)[0]?.c ?? 0;
  const lw = rows(lastWrite)[0] ?? {};
  const newest = [lw.ep, lw.fa].filter((t) => t != null).map(String).sort().pop();

  await client.call("report_output", {
    text:
      `${NAME}: ` +
      (labelParts.length > 0 ? labelParts.join(" · ") : "empty store") +
      ` · ${String(relCount)} rels` +
      (newest !== undefined ? ` · last write ${newest}` : ""),
    starters: [
      "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS c ORDER BY c DESC",
      "MATCH (e:Episode) RETURN e.at, e.kind, left(e.text, 80) ORDER BY e.at DESC LIMIT 10",
      "MATCH (f:Fact)-[:ABOUT]->(en:Entity) RETURN f.recordedAt, f.slot, en.name ORDER BY f.recordedAt DESC LIMIT 10",
    ],
  });
}

async function main(): Promise<void> {
  const client = new Client();
  await client.start();
  await walk(client);
}

main().then(
  // The session is over: exit. The stdin handle the line reader holds would
  // otherwise keep the process alive while the host waits for requests that
  // never come, and only its read deadline would end the run.
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`glance: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
