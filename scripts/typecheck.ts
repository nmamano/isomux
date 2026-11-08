// The type check of every gate: `bun run typecheck` runs the native compiler
// (TypeScript 7) once per partition of tsconfig.json's include entries, one
// after another. One program for the whole tree grew with every merge (2.5 GB
// peak RSS on 2026-11-03, task 53a41bd9); each partition's program holds only
// its area and what that area imports, so the peak is the largest partition.
//
// A partition entry can be a folder inside an include entry (server/test-support
// inside server). Every other program that holds that include entry excludes
// the folder, so each file is a root of exactly one program. A file that a
// program imports from another program's area is still in that program and
// still checked there. A program with such nested entries also includes the
// .d.ts files of their include entry (ui/**/*.d.ts), because no import pulls
// in a .d.ts that declares globals. tsc's exclude wins over include, so the
// parent program does not see a .d.ts placed under a nested folder.
//
// A partition checks its files with no other area's files in its program, so:
// - two areas that declare conflicting globals each pass alone, where the
//   whole program (the editor, with tsconfig.json) shows the conflict;
// - a global that one area declares and another area uses without an import
//   fails here, while the editor is green.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Areas that each get their own program; every other include entry shares one.
 * Peak RSS of each program on 2026-11-08 (task 754fbd7b): 1.0-1.2 GB.
 */
export const PARTITIONS: string[][] = [
  ["server/test-support"],
  ["server"],
  ["ui/components", "ui/log-view"],
  ["ui"],
];

const TSC = join(
  import.meta.dir,
  "..",
  "node_modules",
  "typescript-native",
  "bin",
  "tsc",
);

/** One program: its include entries, and the paths it leaves to other programs. */
export type Program = { include: string[]; exclude: string[] };

/** The include entry that holds `path` (the entry itself or a folder above it). */
function holder(include: string[], path: string): string | undefined {
  return include.find(
    (entry) => path === entry || path.startsWith(`${entry}/`),
  );
}

/** The programs of `include`, in run order: the partitions, then the rest. */
export function partitions(
  include: string[],
  table: string[][] = PARTITIONS,
): Program[] {
  const parts = table
    .map((partition) =>
      partition.filter((entry) => holder(include, entry) !== undefined),
    )
    .filter((program) => program.length > 0);
  const taken = parts.flat();
  const rest = include.filter((entry) => !taken.includes(entry));
  const groups = rest.length > 0 ? [...parts, rest] : parts;
  return groups.map((entries) => {
    // The .d.ts files of the include entries above this program's nested entries.
    const declarations = entries
      .filter((entry) => !include.includes(entry))
      .map((entry) => `${holder(include, entry)}/**/*.d.ts`);
    return {
      include: [...new Set([...entries, ...declarations])],
      // The folders inside this program's entries that another program takes.
      exclude: taken.filter(
        (path) =>
          !entries.includes(path) &&
          entries.some((entry) => path.startsWith(`${entry}/`)),
      ),
    };
  });
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
      ? partitions(config.include).map((program, index) => {
          const { include } = program;
          const path = join(dir, `tsconfig.${index}.json`);
          writeFileSync(
            path,
            JSON.stringify(
              partitionConfig(root, include, [...exclude, ...program.exclude]),
            ),
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
