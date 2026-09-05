// Process-level latency probe for the two hook runtime shapes. This does not
// claim Codex action coverage; it isolates hook launch
// and representative policy boot cost.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { performance } from "perf_hooks";

interface Distribution {
  n: number;
  concurrency: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function distribution(
  values: number[],
  concurrency: number,
): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ];
  return {
    n: sorted.length,
    concurrency,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: sorted.at(-1)!,
  };
}

async function one(command: string): Promise<number> {
  const start = performance.now();
  const child = Bun.spawn(["/bin/sh", "-lc", command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.stdin.write(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "printf reached" },
    }),
  );
  await child.stdin.end();
  await child.exited;
  return performance.now() - start;
}

async function sample(
  command: string,
  n: number,
  concurrency: number,
): Promise<Distribution> {
  const values: number[] = [];
  for (let offset = 0; offset < n; offset += concurrency) {
    values.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(concurrency, n - offset) }, () =>
          one(command),
        ),
      )),
    );
  }
  return distribution(values, concurrency);
}

export async function runLatencyProbe(
  n = Number(process.env.ISOMUX_TEST_CODEX_HOOK_LATENCY_N ?? "200"),
  concurrency = Number(
    process.env.ISOMUX_TEST_CODEX_HOOK_LATENCY_CONCURRENCY ?? "8",
  ),
) {
  const root = mkdtempSync(join(tmpdir(), "isomux-hook-latency-"));
  try {
    const floor = join(root, "floor.sh");
    writeFileSync(
      floor,
      "#!/bin/sh\ndd bs=1048576 count=1 >/dev/null 2>&1\nprintf '{}\\n'\n",
    );
    chmodSync(floor, 0o755);
    const representativeModule = join(root, "representative-module.ts");
    const patterns = Array.from(
      { length: 256 },
      (_, index) => `(?:probe_${index}|command_[a-z]+|/tmp/path_[0-9]+)`,
    );
    const modulePrefix = `export const patterns = ${JSON.stringify(patterns)};\n`;
    writeFileSync(
      representativeModule,
      `${modulePrefix}/*${"x".repeat(Math.max(0, 63_551 - modulePrefix.length - 4))}*/\n`,
    );
    const representative = join(root, "representative.ts");
    writeFileSync(
      representative,
      `import { patterns } from ${JSON.stringify(representativeModule)};
await Bun.stdin.text();
for (const pattern of patterns) new RegExp(pattern);
process.stdout.write("{}\\n");
`,
    );
    const floorCommand = floor;
    const representativeCommand = `${process.execPath} run ${representative}`;
    return {
      measuredAt: new Date().toISOString(),
      codexVersion: "0.153.4",
      conditions: {
        otherAgentsInFlight: Number(
          process.env.ISOMUX_TEST_CODEX_HOOK_OTHER_AGENTS ?? "0",
        ),
        memoryLimit: process.env.ISOMUX_TEST_CODEX_HOOK_MEMORY_LIMIT ?? null,
        host: process.env.ISOMUX_TEST_CODEX_HOOK_HOST ?? "unspecified",
      },
      floor: await sample(floorCommand, n, concurrency),
      representative: await sample(representativeCommand, n, concurrency),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runLatencyProbe(), null, 2));
}
