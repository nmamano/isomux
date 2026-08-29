/** Quiet-window benchmark for the standalone Codex safety hook. */

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { loadavg, tmpdir } from "os";
import { join } from "path";
import { evaluateProposedAction } from "../../safety-policy.ts";
import { buildCodexSafetyHook } from "./safety-hook-build.ts";

const coldSamples = 50;
const warmupSamples = 30;
const warmSamples = 300;
const policySamples = 20_000;
const hashSamples = 300;

function percentile(sorted: number[], fraction: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1),
    meanMs: total / sorted.length,
  };
}

async function runProcess(executablePath: string, payload: string) {
  const started = performance.now();
  const child = Bun.spawn([executablePath], {
    stdin: new Blob([payload]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const durationMs = performance.now() - started;
  if (exitCode !== 0 || stderr || JSON.stringify(JSON.parse(stdout)) !== "{}") {
    throw new Error(
      `benchmark hook failed: exit=${exitCode}, stderr=${stderr}, stdout=${stdout}`,
    );
  }
  return durationMs;
}

function policyDurationMs() {
  const started = performance.now();
  const decision = evaluateProposedAction({
    kind: "shell",
    command: "git status --short",
  });
  const durationMs = performance.now() - started;
  if (decision.decision !== "allow") {
    throw new Error("benchmark policy control did not allow");
  }
  return durationMs;
}

function sha256DurationMs(executablePath: string) {
  const started = performance.now();
  const bytes = readFileSync(executablePath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const digest = hasher.digest("hex");
  const durationMs = performance.now() - started;
  if (digest.length !== 64) throw new Error("benchmark hash control failed");
  return durationMs;
}

export async function runSafetyHookBenchmark() {
  const root = mkdtempSync(join(tmpdir(), "isomux-safety-hook-benchmark-"));
  const keepArtifact = process.env.ISOMUX_BENCHMARK_KEEP === "1";
  try {
    const executablePath = join(root, "isomux-codex-safety-hook");
    const windowStartedAt = new Date().toISOString();
    const loadAverageAtStart = loadavg();
    const buildStarted = performance.now();
    const built = await buildCodexSafetyHook(executablePath);
    const buildDurationMs = performance.now() - buildStarted;
    const payload = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
    });

    // Every sample starts a new process. "Pre-warmup" is the first series
    // immediately after the build-time stamp check; "warmed" follows explicit
    // page-cache/runtime warmups. The benchmark does not claim to flush the OS
    // page cache, which would require a disruptive host-wide operation.
    const preWarmupProcessMs: number[] = [];
    for (let index = 0; index < coldSamples; index++) {
      preWarmupProcessMs.push(await runProcess(executablePath, payload));
    }
    for (let index = 0; index < warmupSamples; index++) {
      await runProcess(executablePath, payload);
    }
    const warmedProcessMs: number[] = [];
    for (let index = 0; index < warmSamples; index++) {
      warmedProcessMs.push(await runProcess(executablePath, payload));
    }

    const policyOnlyMs: number[] = [];
    for (let index = 0; index < policySamples; index++) {
      policyOnlyMs.push(policyDurationMs());
    }

    const fullFileSha256Ms: number[] = [];
    for (let index = 0; index < hashSamples; index++) {
      fullFileSha256Ms.push(sha256DurationMs(executablePath));
    }

    return {
      measuredAt: windowStartedAt,
      completedAt: new Date().toISOString(),
      loadAverageAtStart,
      loadAverageAtEnd: loadavg(),
      concurrency: 1,
      input: "PreToolUse Bash allow: git status --short",
      binary: {
        executablePath: keepArtifact ? executablePath : undefined,
        sizeBytes: built.sizeBytes,
        executableSha256: built.executableSha256,
        sourceSha256: built.sourceSha256,
        sourceFiles: built.sourceFiles,
        buildDurationMs,
      },
      processStartup: {
        definition:
          "fresh process per sample; pre-warmup runs immediately after build stamp check; warmed follows 30 explicit warmups; OS page cache not flushed",
        preWarmup: distribution(preWarmupProcessMs),
        warmed: distribution(warmedProcessMs),
      },
      policyOnly: {
        definition:
          "in-process provider-neutral policy evaluation, no JSON or process",
        ...distribution(policyOnlyMs),
      },
      fullFileSha256: {
        definition: "synchronous full executable read plus Bun SHA-256",
        ...distribution(fullFileSha256Ms),
      },
    };
  } finally {
    if (!keepArtifact) rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runSafetyHookBenchmark(), null, 2));
}
