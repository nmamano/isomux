// Reduces one run directory to one result row.
//   bun run analyze.ts <run-dir> [...]
// Reads gen-*.json (generator shards), engine.jsonl (engine receipt times),
// and proc.jsonl (tier A server samples) or sample.jsonl (tier B cgroup samples).
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

type Raw = { b: [number, number][]; n: number; max: number };
// One sampler.py line (tier B).
type Agg = { n: number; rssKB: number; anonKB: number; cpu: number };
type Sample = {
  t: number;
  agg: Partial<Record<"server" | "engine" | "other", Agg>>;
  cg: Record<string, number>;
  load1: number;
  memAvailKB: number | null;
};
function merge(rs: Raw[]): Raw {
  const m = new Map<number, number>();
  let n = 0;
  let max = 0;
  for (const r of rs) {
    for (const [k, v] of r.b) m.set(k, (m.get(k) ?? 0) + v);
    n += r.n;
    max = Math.max(max, r.max);
  }
  return { b: [...m.entries()].sort((a, b) => a[0] - b[0]), n, max };
}
function q(r: Raw, p: number): number | null {
  if (!r.n) return null;
  let c = 0;
  for (const [k, v] of r.b) {
    c += v;
    if (c >= p * r.n) return +(0.01 * Math.pow(1.01, k)).toFixed(1);
  }
  return +r.max.toFixed(1);
}
const sum = (r: Raw) => ({
  n: r.n,
  p50: q(r, 0.5),
  p95: q(r, 0.95),
  p99: q(r, 0.99),
  max: +r.max.toFixed(1),
});
function hist(vals: number[]): Raw {
  const m = new Map<number, number>();
  let max = 0;
  for (const v of vals) {
    const k = v <= 0.01 ? 0 : Math.ceil(Math.log(v / 0.01) / Math.log(1.01));
    m.set(k, (m.get(k) ?? 0) + 1);
    max = Math.max(max, v);
  }
  return {
    b: [...m.entries()].sort((a, b) => a[0] - b[0]),
    n: vals.length,
    max,
  };
}
const lines = (p: string) =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

for (const dir of process.argv.slice(2)) {
  const gens = readdirSync(dir)
    .filter((f) => /^gen-\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  if (!gens.length) continue;
  const g0 = gens.find((g) => g.params.SHARD === 0) ?? gens[0];
  const H = (k: string) => merge(gens.map((g) => g.raw[k]));
  const sendTimes: Record<string, number> = Object.assign(
    {},
    ...gens.map((g) => g.sendTimes),
  );
  const eng = lines(join(dir, "engine.jsonl")).filter((e) => e.id in sendTimes);
  const firstSeen = new Map<string, number>();
  for (const e of eng) if (!firstSeen.has(e.id)) firstSeen.set(e.id, e.t);
  const toEngine = hist(
    [...firstSeen.entries()].map(([id, t]) => t - sendTimes[id]),
  );
  const counters = gens.reduce(
    (a, g) => {
      for (const [k, v] of Object.entries(g.counters))
        a[k] = (a[k] ?? 0) + (v as number);
      return a;
    },
    {} as Record<string, number>,
  );
  const clients = gens.reduce((a, g) => a + g.params.CLIENTS, 0);
  const secs = g0.secs;
  // Resource samples inside the measuring window: the last `secs` seconds.
  let res: Record<string, unknown> = {};
  const nAgents = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"))
    .agents.length;
  const proc = lines(join(dir, "proc.jsonl"));
  const samp: Sample[] = lines(join(dir, "sample.jsonl"));
  const tEnd = Math.max(...gens.map((g) => g.endT ?? 0));
  if (proc.length) {
    const end = tEnd || proc[proc.length - 1].t;
    const w = proc.filter((s) => s.t <= end && s.t >= end - secs * 1000);
    res = {
      srvCpuMean: +(w.reduce((a, s) => a + s.cpu, 0) / w.length).toFixed(2),
      srvCpuMax: +Math.max(...w.map((s) => s.cpu)).toFixed(2),
      srvRssMaxMB: Math.round(Math.max(...w.map((s) => s.rss)) / 1e6),
    };
  } else if (samp.length) {
    const end = tEnd ? tEnd / 1000 : samp[samp.length - 1].t;
    const w = samp.filter((s) => s.t <= end && s.t >= end - secs);
    const mean = (f: (s: Sample) => number) =>
      w.reduce((a, s) => a + f(s), 0) / w.length;
    const max = (f: (s: Sample) => number) => Math.max(...w.map(f));
    res = {
      srvCpuMean: +mean((s) => s.agg.server?.cpu ?? 0).toFixed(2),
      srvCpuMax: +max((s) => s.agg.server?.cpu ?? 0).toFixed(2),
      srvRssMaxMB: Math.round(max((s) => s.agg.server?.rssKB ?? 0) / 1024),
      engines: max((s) => s.agg.engine?.n ?? 0),
      engCpuMean: +mean((s) => s.agg.engine?.cpu ?? 0).toFixed(2),
      engRssMBPerAgent: Math.round(
        mean((s) => (s.agg.engine ? s.agg.engine.rssKB / s.agg.engine.n : 0)) /
          1024,
      ),
      engAnonMBPerAgent: Math.round(
        mean((s) => (s.agg.engine ? s.agg.engine.anonKB / s.agg.engine.n : 0)) /
          1024,
      ),
      otherRssMB: Math.round(max((s) => s.agg.other?.rssKB ?? 0) / 1024),
      nAgents,
      engCpuPerBusyAgent: +(
        mean((s) => s.agg.engine?.cpu ?? 0) / Math.max(1, g0.params.BUSY)
      ).toFixed(3),
      cgMaxMB: Math.round(max((s) => s.cg["memory.current"] ?? 0) / 1048576),
      load1Max: +max((s) => s.load1).toFixed(1),
      memAvailMinMB: Math.round(
        Math.min(...w.map((s) => s.memAvailKB ?? Infinity)) / 1024,
      ),
    };
  }
  const row = {
    run: dir.replace(/\/+$/, "").split("/").pop(),
    clients,
    busy: g0.params.BUSY,
    events: g0.params.EVENTS,
    intervalMs: g0.params.INTERVAL,
    apiRps: g0.params.API_RPS,
    secs: Math.round(secs),
    turnsPerS: +(counters.turns / secs).toFixed(2),
    entriesPerS: +(counters.ltout / clients / secs).toFixed(1),
    framesPerS: Math.round(counters.frames / secs),
    mbPerS: +(counters.bytes / secs / 1e6).toFixed(2),
    errors: {
      send: counters.sendErr,
      api: counters.apiErr,
      ws: counters.wsErrors,
      closes: counters.wsCloses,
    },
    toEngine: sum(toEngine),
    ack: sum(H("ack")),
    deliver: sum(H("deliver")),
    api: sum(H("api")),
    connect: sum(H("connect")),
    replay: sum(H("replay")),
    connectAllMs: Math.round(Math.max(...gens.map((g) => g.connectAllMs))),
    ...res,
  };
  console.log(JSON.stringify(row));
}
