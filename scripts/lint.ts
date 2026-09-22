const ESLINT_HEAP_MB = 4_096;

export function eslintCommand(fix: boolean): string[] {
  return [
    "bun",
    "x",
    "eslint",
    ".",
    "--concurrency=off",
    ...(fix ? ["--fix"] : []),
  ];
}

export function eslintNodeOptions(existing?: string): string {
  return [existing, `--max-old-space-size=${ESLINT_HEAP_MB}`]
    .filter(Boolean)
    .join(" ");
}

export async function runLint(fix: boolean): Promise<number> {
  const child = Bun.spawn(eslintCommand(fix), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: eslintNodeOptions(process.env.NODE_OPTIONS),
    },
  });
  return child.exited;
}

if (import.meta.main)
  process.exitCode = await runLint(process.argv.includes("--fix"));
