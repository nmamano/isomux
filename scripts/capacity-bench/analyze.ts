// Reduces one or more capacity-benchmark arm directories to the numbers the
// results section reports. Run it wherever the results were rsynced to:
//
//   bun run scripts/capacity-bench/analyze.ts <results-dir> [...]
//
// Prints a per-arm summary and a markdown table across arms.
import { readFileSync, existsSync, readdirSync } from "fs";
import { basename, join } from "path";

type Summary = Record<string, string | number>;

// One line of an agent's jsonl stream, as written by agentsim.ts.
type AgentEvent = {
  event?: string;
  turn?: number;
  touchMs?: number;
  totalMs?: number;
  periodMs?: number;
  rssKb?: number;
  anonKb?: number;
  t?: number;
};

const pct = (sorted: number[], p: number) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

function readCsv(path: string): Record<string, string>[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function num(rows: Record<string, string>[], key: string): number[] {
  return rows
    .map((r) => Number(r[key]))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

function summarize(dir: string): Summary {
  const meta = existsSync(join(dir, "meta.txt"))
    ? readFileSync(join(dir, "meta.txt"), "utf8")
    : "";
  const armLine = meta.match(/arm=(\S+) n=(\d+) build=(\d+) duration=(\d+)/);
  const limits = meta.match(/MemorySwapMax=(\S+)/);
  const events = existsSync(join(dir, "events.log"))
    ? readFileSync(join(dir, "events.log"), "utf8")
    : "";
  const alive = events.match(/agents-alive=(\d+) of=(\d+)/);

  // Per-turn latency, pooled across agents. The first turn of each agent is
  // dropped: it runs while later agents are still allocating, so it measures the
  // ramp rather than steady state.
  const agentsDir = join(dir, "agents");
  const totals: number[] = [];
  const touches: number[] = [];
  const periods: number[] = [];
  const rss: number[] = [];
  const anon: number[] = [];
  let ready = 0;
  let turns = 0;
  let firstT = Infinity;
  let lastT = 0;
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((f) =>
      f.endsWith(".jsonl"),
    )) {
      const lines = readFileSync(join(agentsDir, f), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      let seen = 0;
      for (const line of lines) {
        let e: AgentEvent;
        try {
          e = JSON.parse(line) as AgentEvent;
        } catch {
          continue; // a truncated last line means the process was killed mid-write
        }
        if (e.event === "ready") {
          ready++;
          continue;
        }
        if (e.event !== "turn") continue;
        seen++;
        turns++;
        if (typeof e.t === "number") {
          firstT = Math.min(firstT, e.t);
          lastT = Math.max(lastT, e.t);
        }
        if (seen === 1) continue;
        totals.push(e.totalMs);
        touches.push(e.touchMs);
        if (typeof e.periodMs === "number") periods.push(e.periodMs);
        if (e.rssKb > 0) rss.push(e.rssKb);
        if (e.anonKb > 0) anon.push(e.anonKb);
      }
    }
  }
  totals.sort((a, b) => a - b);
  touches.sort((a, b) => a - b);
  periods.sort((a, b) => a - b);

  const rows = readCsv(join(dir, "samples.csv"));
  // Prefer the external probe: it is the only one that crosses the network the
  // customer uses. It runs continuously off-box for the whole session rather
  // than per arm, so it is sliced to this arm's sampling window. Fall back to
  // the on-box loopback series when no external probe was attached.
  const globalProbe = process.env.BENCH_PROBE_FILE;
  let probe: string[] = [];
  let probeFile: string | undefined;
  if (globalProbe && existsSync(globalProbe) && rows.length > 0) {
    const from = Number(rows[0].ts) * 1000;
    const to = Number(rows[rows.length - 1].ts) * 1000;
    probe = readFileSync(globalProbe, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l && !l.startsWith("ts_ms"))
      .filter((l) => {
        const t = Number(l.split(",")[0]);
        return Number.isFinite(t) && t >= from && t <= to;
      });
    if (probe.length > 0) probeFile = "external";
  }
  if (!probeFile) {
    const f = [
      "ssh-probe-external.csv",
      "ssh-probe-loopback.csv",
      "ssh-probe.csv",
    ]
      .map((f) => join(dir, f))
      .find(existsSync);
    if (f) {
      probeFile = f;
      probe = readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l && !l.startsWith("ts_ms"));
    }
  }
  const probeFails = probe.filter((l) => l.includes(",FAIL,")).length;
  const probeMs = probe
    .map((l) => Number(l.split(",")[2]))
    .filter(Number.isFinite);

  const final = existsSync(join(dir, "final.txt"))
    ? readFileSync(join(dir, "final.txt"), "utf8")
    : "";
  const peak = final.match(/== memory\.peak\n(\d+)/);
  const swapPeak = final.match(/== memory\.swap\.peak\n(\d+)/);
  const oomKill = final.match(
    /== memory\.events\.local\n[\s\S]*?oom_kill (\d+)/,
  );
  const highEv = final.match(/== memory\.events\.local\n[\s\S]*?high (\d+)/);
  const maxEv = final.match(/== memory\.events\.local\n[\s\S]*?max (\d+)/);

  return {
    arm: armLine?.[1] ?? basename(dir),
    n: Number(armLine?.[2] ?? 0),
    build: Number(armLine?.[3] ?? 0),
    swapMax: limits?.[1] ?? "?",
    agentsReady: ready,
    agentsAlive: alive ? Number(alive[1]) : -1,
    turns,
    // Throughput catches what the active phase cannot: a loop that falls behind
    // its own period still shows a healthy per-turn latency.
    turns_per_agent_min:
      ready > 0 && lastT > firstT
        ? Number((turns / ready / ((lastT - firstT) / 60000)).toFixed(2))
        : 0,
    period_p95: pct(periods, 0.95),
    period_max: max(periods),
    lat_p50: pct(totals, 0.5),
    lat_p90: pct(totals, 0.9),
    lat_p95: pct(totals, 0.95),
    lat_p99: pct(totals, 0.99),
    lat_max: max(totals),
    touch_p50: pct(touches, 0.5),
    touch_p95: pct(touches, 0.95),
    touch_p99: pct(touches, 0.99),
    agent_rss_max_mb: Math.round(max(rss) / 1024),
    agent_anon_max_mb: Math.round(max(anon) / 1024),
    cg_peak_mb: peak ? mb(Number(peak[1])) : -1,
    // Reported separately and labelled approximate on purpose: memory.peak is an
    // instantaneous kernel maximum, while anon and file come from sampled
    // memory.stat reads that need not coincide with it or with each other. The
    // "at_peak" pair is the single sample whose memory.current came closest to
    // memory.peak, which is the nearest thing to a composition of that peak.
    anon_max_mb: mb(max(num(rows, "anon"))),
    file_max_mb: mb(max(num(rows, "file"))),
    ...(() => {
      const target = peak ? Number(peak[1]) : 0;
      let best: Record<string, string> | undefined;
      let bestGap = Infinity;
      for (const r of rows) {
        const gap = Math.abs(Number(r.mem_current) - target);
        if (Number.isFinite(gap) && gap < bestGap) {
          bestGap = gap;
          best = r;
        }
      }
      return {
        at_peak_current_mb: best ? mb(Number(best.mem_current)) : -1,
        at_peak_anon_mb: best ? mb(Number(best.anon)) : -1,
        at_peak_file_mb: best ? mb(Number(best.file)) : -1,
        at_peak_gap_mb: best ? mb(bestGap) : -1,
      };
    })(),
    cg_swap_peak_mb: swapPeak ? mb(Number(swapPeak[1])) : -1,
    cg_swap_max_mb: mb(max(num(rows, "mem_swap_current"))),
    psi_mem_some_max: max(num(rows, "psi_mem_some_avg10")),
    psi_mem_full_max: max(num(rows, "psi_mem_full_avg10")),
    psi_mem_full_stall_s: Math.round(sum(num(rows, "d_psi_mem_full_us")) / 1e6),
    psi_io_full_max: max(num(rows, "psi_io_full_avg10")),
    psi_cpu_some_max: max(num(rows, "psi_cpu_some_avg10")),
    // Swap traffic, not residency: this is the number the swap arm turns on.
    swap_in_pages: sum(num(rows, "d_pswpin")),
    swap_out_pages: sum(num(rows, "d_pswpout")),
    majfaults: sum(num(rows, "d_pgmajfault")),
    cpu_throttled_s: Math.round(sum(num(rows, "d_cpu_throttled_us")) / 1e6),
    host_psi_mem_some_max: max(num(rows, "host_psi_mem_some_avg10")),
    host_psi_io_full_max: max(num(rows, "host_psi_io_full_avg10")),
    // What the 1 GiB reserve is meant to protect, measured rather than assumed.
    nonbench_mem_mb_max: max(num(rows, "nonbench_mem_mb")),
    load1_max: max(num(rows, "load1")),
    steal_jiffies: sum(num(rows, "d_steal_jiffies")),
    ev_high: highEv ? Number(highEv[1]) : sum(num(rows, "ev_high")),
    ev_max: maxEv ? Number(maxEv[1]) : sum(num(rows, "ev_max")),
    ev_oom_kill: oomKill ? Number(oomKill[1]) : sum(num(rows, "ev_oom_kill")),
    ssh_probe:
      probeFile === "external"
        ? "external"
        : probeFile
          ? basename(probeFile).replace("ssh-probe-", "").replace(".csv", "")
          : "none",
    ssh_fails: probeFails,
    ssh_ms_p95: pct(
      [...probeMs].sort((a, b) => a - b),
      0.95,
    ),
    ssh_ms_max: max(probeMs),
  };
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: analyze.ts <results-dir> [...]");
  process.exit(1);
}

const summaries = dirs.map(summarize);
for (const s of summaries) {
  console.log(`\n### ${s.arm}`);
  for (const [k, v] of Object.entries(s))
    if (k !== "arm") console.log(`  ${k.padEnd(20)} ${v}`);
}

const cols = [
  "arm",
  "n",
  "build",
  "swapMax",
  "agentsAlive",
  "turns_per_agent_min",
  "lat_p50",
  "lat_p95",
  "lat_p99",
  "lat_max",
  "period_p95",
  "cg_peak_mb",
  "cg_swap_max_mb",
  "swap_out_pages",
  "swap_in_pages",
  "psi_mem_some_max",
  "psi_mem_full_max",
  "psi_mem_full_stall_s",
  "psi_cpu_some_max",
  "load1_max",
  "nonbench_mem_mb_max",
  "ev_high",
  "ev_max",
  "ev_oom_kill",
  "ssh_fails",
  "ssh_ms_p95",
  "ssh_ms_max",
];
console.log("\n| " + cols.join(" | ") + " |");
console.log("| " + cols.map(() => "---").join(" | ") + " |");
for (const s of summaries)
  console.log("| " + cols.map((c) => s[c]).join(" | ") + " |");
