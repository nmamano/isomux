// Load generator. Reads $LT_DIR/server.json, opens member WebSockets, drives
// turns and API calls, and writes $LT_OUT/gen-<shard>.json.
//
// Env: LT_DIR, LT_OUT (default LT_DIR), LT_RUN (prefix for turn ids),
// LT_CLIENTS (sockets in this shard), LT_SHARD (0 drives turns and API),
// LT_BUSY (agents with a turn in flight), LT_EVENTS, LT_INTERVAL_MS, LT_BYTES,
// LT_GAP_MS (pause between turns), LT_API_RPS, LT_DURATION_S, LT_WARMUP_S,
// LT_HOST (default 127.0.0.1), LT_SCHEME (http).
//
// A turn is the member message "LT <id> <events> <intervalMs> <bytes>". The
// engine (FakeBackend in tier A, mock.ts in tier B) answers with log entries
// that carry "LTOUT <id> <k> <emitMs>"; the generator times each one on arrival.
// The level files (levels-a.txt, levels-b.txt) are written in these variables.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const env = (k: string, d: string) => process.env[k] ?? d;
const DIR = env("LT_DIR", ".");
const CLIENTS = Number(env("LT_CLIENTS", "10"));
const SHARD = Number(env("LT_SHARD", "0"));
const BUSY = Number(env("LT_BUSY", "3"));
const EVENTS = Number(env("LT_EVENTS", "20"));
const INTERVAL = Number(env("LT_INTERVAL_MS", "250"));
const BYTES = Number(env("LT_BYTES", "400"));
const GAP = Number(env("LT_GAP_MS", "1000"));
const API_RPS = Number(env("LT_API_RPS", "5"));
const DURATION = Number(env("LT_DURATION_S", "60"));
const WARMUP = Number(env("LT_WARMUP_S", "10"));
const HOST = env("LT_HOST", "127.0.0.1");
const SCHEME = env("LT_SCHEME", "http");
const RUN = env("LT_RUN", "r");
const OUT = env("LT_OUT", DIR);

const cfg = JSON.parse(readFileSync(join(DIR, "server.json"), "utf8")) as {
  port: number;
  origin: string;
  cookie: string;
  sessions: string[];
  agents: string[];
  tokens: (string | null)[];
};
const base = `${SCHEME}://${HOST}:${cfg.port}`;
const wsBase = `${SCHEME === "https" ? "wss" : "ws"}://${HOST}:${cfg.port}/ws`;
const now = () => performance.timeOrigin + performance.now();

// Log-bucket histogram, 1% resolution, in ms.
class Hist {
  b = new Map<number, number>();
  n = 0;
  max = 0;
  add(v: number) {
    const k = v <= 0.01 ? 0 : Math.ceil(Math.log(v / 0.01) / Math.log(1.01));
    this.b.set(k, (this.b.get(k) ?? 0) + 1);
    this.n++;
    if (v > this.max) this.max = v;
  }
  q(p: number) {
    if (!this.n) return null;
    const keys = [...this.b.keys()].sort((a, b) => a - b);
    let c = 0;
    for (const k of keys) {
      c += this.b.get(k)!;
      if (c >= p * this.n) return +(0.01 * Math.pow(1.01, k)).toFixed(2);
    }
    return this.max;
  }
  sum() {
    return {
      n: this.n,
      p50: this.q(0.5),
      p95: this.q(0.95),
      p99: this.q(0.99),
      max: +this.max.toFixed(1),
    };
  }
  dump() {
    return { b: [...this.b.entries()], n: this.n, max: this.max };
  }
}

let measuring = false;
const h = {
  deliver: new Hist(),
  ack: new Hist(),
  api: new Hist(),
  connect: new Hist(),
  replay: new Hist(),
};
const c = {
  frames: 0,
  bytes: 0,
  ltout: 0,
  wsErrors: 0,
  wsCloses: 0,
  sendErr: 0,
  apiErr: 0,
  turns: 0,
  sends: 0,
};
const sendTimes: Record<string, number> = {};
const turnDone = new Map<string, () => void>();

// Every socket uses the first (owner) session: a member session cannot post
// to agents it does not manage.
function connect(i: number): Promise<void> {
  const sid = cfg.sessions[0];
  const t0 = now();
  return new Promise((resolve) => {
    const ws = new WebSocket(wsBase, {
      headers: { Cookie: `${cfg.cookie}=${sid}`, Origin: cfg.origin },
    } as unknown as string[]);
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      h.connect.add(now() - t0);
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      const t = now();
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      if (measuring) {
        c.frames++;
        c.bytes += data.length;
      }
      if (data.startsWith('{"type":"log_replay_complete"')) {
        h.replay.add(t - t0);
        resolve();
        return;
      }
      if (!data.includes("LTOUT ")) return;
      const re = /LTOUT (\S+) (\d+) ([\d.]+)/g;
      let m: RegExpExecArray | null;
      const once = new Set<string>();
      while ((m = re.exec(data))) {
        const key = `${m[1]} ${m[2]}`;
        if (once.has(key)) continue;
        once.add(key);
        if (measuring) {
          h.deliver.add(t - Number(m[3]));
          c.ltout++;
        }
        if (i === 0) {
          const k = Number(m[2]);
          if (k >= EVENTS - 1) turnDone.get(m[1])?.();
        }
      }
    });
    ws.addEventListener("error", () => c.wsErrors++);
    ws.addEventListener("close", () => {
      c.wsCloses++;
      if (!opened) resolve();
    });
    setTimeout(resolve, 60000);
  });
}

async function driver(a: number, stopAt: number) {
  const agent = cfg.agents[a];
  const sid = cfg.sessions[0];
  let n = 0;
  while (now() < stopAt) {
    const id = `${RUN}-${SHARD}-${a}-${n++}`;
    const done = new Promise<void>((r) => {
      turnDone.set(id, r);
      setTimeout(r, EVENTS * INTERVAL + 30000);
    });
    const t0 = now();
    if (measuring) sendTimes[id] = t0;
    try {
      const res = await fetch(`${base}/api/agents/${agent}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: cfg.origin,
          Cookie: `${cfg.cookie}=${sid}`,
        },
        body: JSON.stringify({
          text: `LT ${id} ${EVENTS} ${INTERVAL} ${BYTES}`,
        }),
      });
      await res.arrayBuffer();
      if (measuring) h.ack.add(now() - t0);
      if (!res.ok) {
        c.sendErr++;
        await Bun.sleep(1000);
        continue;
      }
      c.sends++;
    } catch {
      c.sendErr++;
      await Bun.sleep(1000);
      continue;
    }
    if (CLIENTS === 0) await Bun.sleep(EVENTS * INTERVAL + 200);
    else await done;
    turnDone.delete(id);
    if (measuring) c.turns++;
    await Bun.sleep(GAP * (0.5 + Math.random()));
  }
}

// Agent-token API calls when the server exported tokens (tier A), else the
// owner cookie (tier B).
const API_PATHS = [
  "/agents",
  "/api/tasks",
  (id: string) => `/api/agents/${id}/queue`,
];
async function apiLoad(stopAt: number) {
  if (API_RPS <= 0) return;
  const toks = (cfg.tokens ?? []).filter(Boolean) as string[];
  const period = 1000 / API_RPS;
  let next = now();
  const inflight = new Set<Promise<void>>();
  let i = 0;
  while (now() < stopAt) {
    next += period;
    const k = i++;
    const p = (async () => {
      const tok = toks.length ? toks[k % toks.length] : null;
      const pick = API_PATHS[k % API_PATHS.length];
      const path =
        typeof pick === "string"
          ? pick
          : pick(cfg.agents[k % cfg.agents.length]);
      const t0 = now();
      try {
        const headers: Record<string, string> = tok
          ? { Authorization: `Bearer ${tok}` }
          : { Origin: cfg.origin, Cookie: `${cfg.cookie}=${cfg.sessions[0]}` };
        const res = await fetch(`${base}${path}`, { headers });
        await res.arrayBuffer();
        if (!res.ok) c.apiErr++;
        else if (measuring) h.api.add(now() - t0);
      } catch {
        c.apiErr++;
      }
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    const wait = next - now();
    if (wait > 0) await Bun.sleep(wait);
  }
  await Promise.all(inflight);
}

const tStart = now();
// Connect in batches of 25 so the connect storm is measured but not absurd.
for (let i = 0; i < CLIENTS; i += 25) {
  await Promise.all(
    Array.from({ length: Math.min(25, CLIENTS - i) }, (_, j) => connect(i + j)),
  );
}
const connectAllMs = now() - tStart;
const stopAt = now() + (WARMUP + DURATION) * 1000;
let measureT0 = 0;
setTimeout(() => {
  measuring = true;
  measureT0 = now();
}, WARMUP * 1000);
const work: Promise<void>[] = [];
if (SHARD === 0) {
  for (let a = 0; a < Math.min(BUSY, cfg.agents.length); a++)
    work.push(driver(a, stopAt));
  work.push(apiLoad(stopAt));
}
await Promise.race([
  Promise.all(work),
  Bun.sleep((WARMUP + DURATION) * 1000 + 60000),
]);
// Always run to the end of the window, also when no agent is busy.
await Bun.sleep(Math.max(0, stopAt - now()));
measuring = false;
const secs = (now() - measureT0) / 1000;

writeFileSync(
  join(OUT, `gen-${SHARD}.json`),
  JSON.stringify({
    params: {
      CLIENTS,
      SHARD,
      BUSY,
      EVENTS,
      INTERVAL,
      BYTES,
      GAP,
      API_RPS,
      DURATION,
      WARMUP,
    },
    secs,
    endT: now(),
    connectAllMs,
    counters: c,
    rates: {
      framesPerS: c.frames / secs,
      mbPerS: c.bytes / secs / 1e6,
      ltoutPerS: c.ltout / secs,
      turnsPerS: c.turns / secs,
    },
    hist: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.sum()])),
    raw: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.dump()])),
    sendTimes,
  }),
);
console.log(
  JSON.stringify({
    shard: SHARD,
    secs,
    counters: c,
    hist: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.sum()])),
  }),
);
process.exit(0);
