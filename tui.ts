// relate-glance TUI: renders the store snapshot in the terminal, sized to fit.
// Run: bun tui.ts        (q or Ctrl-C quits; redraws every 5s and on resize)
//      bun tui.ts --once (print one frame and exit — no alt screen)
import { snapshot, type Snapshot } from "./state";

const POLL_MS = 5000;
const E = "\x1b[";
const C = {
  reset: `${E}0m`,
  bold: `${E}1m`,
  grey: `${E}90m`,
  green: `${E}32m`,
  blue: `${E}94m`,
  mag: `${E}95m`,
  teal: `${E}96m`,
  red: `${E}91m`,
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const vis = (s: string) => strip(s).length;

// Store content is untrusted: drop every control char (incl. ESC) so memory
// text can't inject terminal sequences; our own styling is added after this.
const sanitize = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ");

// Truncate an ANSI-colored string to `w` visible chars, preserving our escapes.
// ponytail: counts code points, not grapheme/display cells — emoji/CJK may
// overrun a cell or two; switch to Intl.Segmenter + wcwidth if it ever matters.
function fit(s: string, w: number): string {
  let out = "", n = 0;
  const cps = [...s];
  for (let i = 0; i < cps.length && n < w; ) {
    if (cps[i] === "\x1b") {
      const m = cps.slice(i).join("").match(/^\x1b\[[0-9;]*m/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += cps[i]; n++; i++;
  }
  return out + C.reset;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const BLOCKS = "▁▂▃▄▅▆▇█";
function spark(vals: number[]): string {
  const min = Math.min(...vals), max = Math.max(...vals);
  return vals.map((v) => BLOCKS[max === min ? 0 : Math.round(((v - min) / (max - min)) * 7)]).join("");
}

function buildFrame(s: Snapshot, cols: number, rows: number): string {
  const lines: string[] = [];
  const lastMs = s.lastWrite ? Date.now() - new Date(s.lastWrite).getTime() : Infinity;
  const dot = lastMs < 600_000 ? `${C.green}●${C.reset}` : `${C.grey}●${C.reset}`;
  const title = `${dot} ${C.bold}relate${C.reset}`;
  const right = `${C.grey}last write ${ago(s.lastWrite)}${C.reset}`;
  lines.push(title + " ".repeat(Math.max(1, cols - vis(title) - vis(right))) + right);

  const k = s.counts;
  const mb = (s.sizeKB / 1024).toFixed(s.sizeKB > 10240 ? 0 : 1);
  lines.push(
    `${C.bold}${k.entities}${C.reset}${C.grey} ent · ${C.reset}${C.bold}${k.episodes}${C.reset}${C.grey} ep · ` +
      `${C.reset}${C.bold}${k.facts}${C.reset}${C.grey} fact · ${C.reset}${C.bold}${k.rels}${C.reset}${C.grey} rel · ` +
      `${C.reset}${C.bold}${mb}${C.reset}${C.grey} MB${C.reset}`,
  );

  if (s.mem.totalKB > 0) {
    const gb = (kb: number) => (kb / 1048576).toFixed(1);
    const relMB = (s.mem.relateKB / 1024).toFixed(0);
    const relPct = ((s.mem.relateKB / s.mem.totalKB) * 100).toFixed(2);
    lines.push(
      `${C.grey}mem    relate ${C.reset}${C.bold}${relMB} MB${C.reset}${C.grey} · ${relPct}% of ${gb(s.mem.totalKB)} GB · ` +
        `${gb(s.mem.freeKB)} GB free${C.reset}`,
    );
  }

  const total = s.growth[s.growth.length - 1]?.cum ?? 0;
  const delta = total - (s.growth[0]?.cum ?? 0);
  lines.push(`${C.grey}writes 7d ${C.blue}${spark(s.growth.map((d) => d.cum))}${C.reset} ${total}${C.grey} (+${delta})${C.reset}`);
  lines.push(
    `${C.grey}reads  7d ${C.teal}${spark(s.reads.perDay.map((d) => d.c))}${C.reset} ${s.reads.last24h}${C.grey}/24h` +
      (s.reads.lastRead ? ` · last ${ago(s.reads.lastRead)}` : "") + C.reset,
  );
  lines.push(`${C.grey}${"─".repeat(cols)}${C.reset}`);

  for (const e of s.feed) {
    if (lines.length >= rows) break;
    const t = new Date(e.at);
    const when = isNaN(t.getTime()) ? "--/-- --:--" : `${t.getMonth() + 1}/${t.getDate()} ${t.toTimeString().slice(0, 5)}`;
    const tag = e.typ === "episode" ? `${C.blue}EP  ${C.reset}` : `${C.mag}FACT${C.reset}`;
    const about = e.about ? `${C.grey} → ${sanitize(e.about)}${C.reset}` : "";
    lines.push(fit(`${C.grey}${when.padStart(11)}${C.reset} ${tag} ${sanitize(e.text)}${about}`, cols));
  }
  return lines.slice(0, rows).map((l) => fit(l, cols)).join("\r\n");
}

const once = process.argv.includes("--once");
const out = (s: string) => process.stdout.write(s);

async function frame(): Promise<string> {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  try {
    return buildFrame(await snapshot(), cols, once ? 9999 : rows);
  } catch (err) {
    return `${C.red}relate-glance error:${C.reset} ${fit(String(err).replace(/\s+/g, " "), cols * 2)}`;
  }
}

if (once) {
  out((await frame()) + "\n");
  process.exit(0);
}

let rendering = false;
async function render() {
  if (rendering) return; // coalesce: skip a tick that overlaps a slow poll
  rendering = true;
  try {
    const f = await frame();
    out(`${E}H${E}2J` + f);
  } finally {
    rendering = false;
  }
}

function cleanup(code = 0) {
  out(`${E}?25h${E}?1049l`); // cursor back, leave alt screen
  process.exit(code);
}

out(`${E}?1049h${E}?25l`); // alt screen, hide cursor
process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());
process.stdout.on("resize", render);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (d: Buffer) => {
    const ch = d.toString();
    if (ch === "q" || ch === "\x03") cleanup();
    if (ch === "r") render();
  });
}
await render();
setInterval(render, POLL_MS);
