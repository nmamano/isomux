// The type check of every gate: `bun run typecheck` runs the native compiler
// (TypeScript 7) once per partition of tsconfig.json's include entries, one
// after another. One program for the whole tree grew with every merge (2.5 GB
// peak RSS on 2026-11-03, task 53a41bd9); each partition's program holds only
// its area and what that area imports, so the peak is the largest partition.
//
// A partition checks its files with no other area's files in its program, so:
// - two areas that declare conflicting globals each pass alone, where the
//   whole program (the editor, with tsconfig.json) shows the conflict;
// - a global that one area declares and another area uses without an import
//   fails here, while the editor is green.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Areas that each get their own program; every other include entry shares one. */
export const PARTITIONS: string[][] = [["server"], ["ui"]];

const TSC = join(
  import.meta.dir,
  "..",
  "node_modules",
  "typescript-native",
  "bin",
  "tsc",
);

/** The include entries of each program, in run order. */
export function partitions(include: string[]): string[][] {
  const programs = PARTITIONS.map((partition) =>
    partition.filter((entry) => include.includes(entry)),
  ).filter((program) => program.length > 0);
  const taken = new Set(programs.flat());
  const rest = include.filter((entry) => !taken.has(entry));
  return rest.length > 0 ? [...programs, rest] : programs;
}

/** The config of one program: absolute paths, the root tsconfig.json's options. */
export function partitionConfig(
  root: string,
  include: string[],
  exclude: string[],
): { extends: string; include: string[]; exclude: string[] } {
  return {
    extends: join(root, "tsconfig.json"),
    include: include.map((entry) => resolve(root, entry)),
    exclude: exclude.map((entry) => resolve(root, entry)),
  };
}

/** Type-checks the package at `root`, one program at a time; extra `args` go to every tsc run. */
export async function runTypecheck(
  root: string,
  args: string[],
): Promise<number> {
  const config = Bun.JSONC.parse(
    readFileSync(join(root, "tsconfig.json"), "utf8"),
  ) as { include?: string[]; exclude?: string[] };
  // tsc's own default when a config sets no exclude.
  const exclude = config.exclude ?? ["node_modules"];
  const dir = mkdtempSync(join(tmpdir(), "isomux-typecheck-"));
  let result = 0;
  try {
    // With no include entry, tsc's default is every file under the root, which
    // no partition can split: one program on tsconfig.json itself. An empty
    // include stays tsc's own error.
    const programs = config.include?.length
      ? partitions(config.include).map((include, index) => {
          const path = join(dir, `tsconfig.${index}.json`);
          writeFileSync(
            path,
            JSON.stringify(partitionConfig(root, include, exclude)),
          );
          return { name: include.join(", "), path };
        })
      : [{ name: "tsconfig.json", path: join(root, "tsconfig.json") }];
    for (const { name, path } of programs) {
      console.log(`typecheck: ${name}`);
      // Every program runs, also after one failed, so one run names every error.
      const code = await Bun.spawn(
        [process.execPath, TSC, "--noEmit", "-p", path, ...args],
        { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
      ).exited;
      if (code !== 0 && result === 0) result = code;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

if (import.meta.main)
  process.exitCode = await runTypecheck(process.cwd(), process.argv.slice(2));
