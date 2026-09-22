const ESLINT_HEAP_MB = 1_600;

export const lintBatches = [
  [".", "--ignore-pattern", "server/**", "--ignore-pattern", "ui/**"],
  ["ui"],
  ["server"],
] as const;

type RunBatch = (args: readonly string[]) => Promise<number>;

export function eslintCommand(
  batch: readonly string[],
  fix: boolean,
): string[] {
  return [
    "bun",
    "x",
    "eslint",
    ...batch,
    "--concurrency=off",
    ...(fix ? ["--fix"] : []),
  ];
}

export function eslintNodeOptions(existing?: string): string {
  return [existing, `--max-old-space-size=${ESLINT_HEAP_MB}`]
    .filter(Boolean)
    .join(" ");
}

export async function runLintBatches(runBatch: RunBatch): Promise<number> {
  let exitCode = 0;
  for (const args of lintBatches) {
    const batchExit = await runBatch(args);
    if (exitCode === 0 && batchExit !== 0) exitCode = batchExit;
  }
  return exitCode;
}

async function main(): Promise<void> {
  const fix = process.argv.includes("--fix");
  const nodeOptions = eslintNodeOptions(process.env.NODE_OPTIONS);
  const exitCode = await runLintBatches(async (batch) => {
    const child = Bun.spawn(eslintCommand(batch, fix), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    });
    return child.exited;
  });
  process.exitCode = exitCode;
}

if (import.meta.main) await main();
