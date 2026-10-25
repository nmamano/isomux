import * as path from "node:path";

/** How one `next build` ended, with the output it printed. */
export type BuildRun = (
  workers: number | undefined,
) => Promise<{ code: number; signal: string | null; output: string }>;

/** Page-data workers for the run after a crash. */
export const RETRY_BUILD_WORKERS = 4;

// next.config.ts reads this; only this script sets it.
const WORKERS_ENV = "ISOMUX_WEB_BUILD_WORKERS";

const WEB_DIR = path.join(import.meta.dirname, "..", "control-plane", "web");

// Next.js 16.3.8 prints this line when a build worker ends abnormally, then
// exits 1 (next/dist/lib/worker.js), the same code as a build error. A worker
// that a signal killed (SIGSEGV in CI, 2026-10-25, task 65d244ad) is a crash;
// one that exited with a code ("signal: null") can be a real failure.
const WORKER_SIGNAL =
  /Next\.js build worker exited with code: \S+ and signal: (SIG[A-Z0-9]+)/;

// Bun reports a signal death as 128 plus the signal number.
const CRASH_EXIT = 128;

// After the build process exits, a worker that outlives it can hold the
// output pipes open. Read what is left for this long, then stop.
const DRAIN_MS = 2_000;

/** What crashed, or undefined when the run ended without a crash. */
export function buildCrash(result: {
  code: number;
  signal: string | null;
  output: string;
}): string | undefined {
  if (result.code === 0) return undefined;
  if (result.signal || result.code >= CRASH_EXIT)
    return result.signal
      ? `exit ${result.code}, ${result.signal}`
      : `exit ${result.code}`;
  const worker = WORKER_SIGNAL.exec(result.output);
  return worker ? `a build worker died of ${worker[1]}` : undefined;
}

/** Copies a stream to `sink` as it arrives and keeps the text. */
function tee(
  stream: ReadableStream<Uint8Array>,
  sink: NodeJS.WriteStream,
  chunks: string[],
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sink.write(value);
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Cancelled after the drain window.
    }
  })();
  return { done, cancel: () => reader.cancel().catch(() => {}) };
}

function spawnBuild(): BuildRun {
  return async (workers) => {
    const env = { ...process.env };
    delete env[WORKERS_ENV];
    if (workers !== undefined) env[WORKERS_ENV] = String(workers);
    const child = Bun.spawn(["bun", "run", "build"], {
      cwd: WEB_DIR,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const chunks: string[] = [];
    const pipes = [
      tee(child.stdout, process.stdout, chunks),
      tee(child.stderr, process.stderr, chunks),
    ];
    const code = await child.exited;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pipes.map((pipe) => pipe.done)),
      new Promise((resolve) => (timer = setTimeout(resolve, DRAIN_MS))),
    ]);
    clearTimeout(timer);
    for (const pipe of pipes) pipe.cancel();
    return { code, signal: child.signalCode, output: chunks.join("") };
  };
}

export async function runWebBuild(
  run: BuildRun = spawnBuild(),
): Promise<number> {
  const first = await run(undefined);
  const crash = buildCrash(first);
  if (!crash) return first.code;
  console.error(
    `next build crashed (${crash}), not a build error; running it again with ${RETRY_BUILD_WORKERS} workers`,
  );
  const second = await run(RETRY_BUILD_WORKERS);
  const again = buildCrash(second);
  if (again) console.error(`next build crashed again (${again})`);
  return second.code;
}

if (import.meta.main) process.exitCode = await runWebBuild();
