// Synthetic stand-in for one live agent process, for the capacity benchmark
// (task 6ce6b700, internal-docs/sizing-tiers-design.md).
//
// It is not a fake agent: it makes no model calls and holds no conversation. It
// reproduces the *resource* profile of one, which is all the benchmark asks
// about. A real agent process is a long-lived runtime holding a few hundred MB
// of live context, waking briefly on each turn to walk part of that context and
// do a short burst of work, and otherwise waiting on the network. Every question
// the benchmark answers - build-spike reserve, PSI watermark, whether RAM or CPU
// binds first, whether swap is a usability problem - is a question about that
// profile.
//
// The context is held in Buffers rather than JS objects on purpose: it is real
// anonymous memory, it is a swap candidate, and its resident size does not move
// under the GC, so a change in RSS during a run means something.
//
// Emits one JSON line per turn on stdout, which is the per-turn latency series
// the benchmark reports.

const AGENT_ID = process.env.BENCH_AGENT_ID ?? "0";
const CONTEXT_MB = Number(process.env.BENCH_CONTEXT_MB ?? 280);
const TOUCH_FRACTION = Number(process.env.BENCH_TOUCH_FRACTION ?? 0.15);
const CPU_MS = Number(process.env.BENCH_CPU_MS ?? 200);
const IDLE_MS = Number(process.env.BENCH_IDLE_MS ?? 3000);
// Jitter the wait, not just the start. A fixed startup stagger against a fixed
// period re-synchronises agents one period apart, which manufactures a
// thundering herd the real workload does not have.
const IDLE_JITTER = Number(process.env.BENCH_IDLE_JITTER ?? 0.4);
const START_DELAY_MS = Number(process.env.BENCH_START_DELAY_MS ?? 0);
const PAGE = 4096;
const CHUNK = 1 << 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Allocate and fault in the whole context, the way an agent's context is
// resident by the time it has taken a few turns.
function allocateContext(): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < CONTEXT_MB; i++) {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let off = 0; off < CHUNK; off += PAGE) buf[off] = (i + off) & 0xff;
    chunks.push(buf);
  }
  return chunks;
}

// Walk a random slice of the context, one byte read + one byte written per page.
// Under memory pressure this is where the stall lands: a page that was reclaimed
// or swapped has to come back before the turn can finish.
function touch(chunks: Buffer[], rng: () => number): number {
  const count = Math.max(1, Math.round(chunks.length * TOUCH_FRACTION));
  const start = Math.floor(rng() * chunks.length);
  let acc = 0;
  for (let n = 0; n < count; n++) {
    const buf = chunks[(start + n) % chunks.length];
    for (let off = 0; off < CHUNK; off += PAGE) {
      acc += buf[off];
      buf[off] = (acc + n) & 0xff;
    }
  }
  return acc;
}

// A short burst of ordinary work, standing in for the parsing and string
// handling an agent process does around a tool call.
function burn(ms: number): number {
  const until = performance.now() + ms;
  let acc = 0;
  let i = 0;
  while (performance.now() < until) {
    for (let k = 0; k < 20000; k++) acc += Math.sqrt((i++ % 9973) + 1);
  }
  return acc;
}

function rssKb(): number {
  try {
    const status = require("fs").readFileSync("/proc/self/status", "utf8");
    const m = status.match(/VmRSS:\s+(\d+) kB/);
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

// RSS is not the fixture size, and anon is the part that cannot be reclaimed.
// Reported per turn so the write-up can express capacity as a function of
// measured per-agent anon rather than as one agent count.
function anonKb(): number {
  try {
    const roll = require("fs").readFileSync("/proc/self/smaps_rollup", "utf8");
    const m = roll.match(/Anonymous:\s+(\d+) kB/);
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

let seed = Number(AGENT_ID) * 7919 + 13;
const rng = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

await sleep(START_DELAY_MS);

const allocStart = performance.now();
const context = allocateContext();
const allocMs = performance.now() - allocStart;
console.log(
  JSON.stringify({
    agent: AGENT_ID,
    event: "ready",
    allocMs: Math.round(allocMs),
    rssKb: rssKb(),
    t: Date.now(),
  }),
);

let turn = 0;
let sink = 0;
let lastWake = performance.now();
for (;;) {
  await sleep(Math.round(IDLE_MS * (1 + IDLE_JITTER * (rng() * 2 - 1))));
  // Period drift is the throughput signal: the active phase can look healthy
  // while the loop itself falls behind under scheduler or reclaim stalls.
  const wake = performance.now();
  const periodMs = wake - lastWake;
  lastWake = wake;
  const t0 = performance.now();
  sink += touch(context, rng);
  const touchMs = performance.now() - t0;
  sink += burn(CPU_MS);
  const totalMs = performance.now() - t0;
  turn++;
  console.log(
    JSON.stringify({
      agent: AGENT_ID,
      event: "turn",
      turn,
      touchMs: Math.round(touchMs),
      totalMs: Math.round(totalMs),
      periodMs: Math.round(periodMs),
      rssKb: rssKb(),
      anonKb: anonKb(),
      t: Date.now(),
    }),
  );
  if (sink === Number.MAX_SAFE_INTEGER) console.log(sink); // keep the work live
}
