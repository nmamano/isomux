// The type check of every gate (tasks 382fe948, 53a41bd9): the CI tsc stage
// runs `bun run typecheck`, and scripts/typecheck.ts runs the native compiler
// (TypeScript 7) once per partition of tsconfig.json's include entries, one
// after another, so the peak memory is one partition's, not the whole tree's.
// Each run case runs the tsc stage's own command in a small fixture package
// whose typecheck script is the repository's.
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stages } from "./ci";
import { PARTITIONS, type Program, partitions } from "./typecheck";

const ROOT = join(import.meta.dir, "..");
const tsc = stages.find((s) => s.name === "tsc")!;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Every area that has its own program, and lib, which has none. */
const AREAS = [...PARTITIONS.flat(), "lib"];

/** A file in each area that imports lib/shared.ts: no program is empty. */
const CLEAN: Record<string, string> = {
  ...Object.fromEntries(
    AREAS.map((area) => [
      `${area}/a.ts`,
      `import { s } from "${relative(area, "lib") || "."}/shared";\nexport const n = s;\n`,
    ]),
  ),
  "lib/shared.ts": "export const s: number = 1;\n",
};

/**
 * A package with the repository's typecheck script (or `script`), a
 * tsconfig.json with a comment (as the repository's has), the include entries
 * server, ui and lib (the last one in no partition), lib/skip excluded, and
 * no ambient types and the ES5 standard library (or `compilerOptions`).
 */
function fixture(
  files: Record<string, string> = {},
  script?: string,
  include: string[] | null = ["server", "ui", "lib"],
  compilerOptions: Record<string, unknown> = {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    skipLibCheck: true,
    types: [],
    // The smallest standard library: tsc reads lib.esnext and lib.dom in
    // about a second per program, and a run case runs one program per
    // partition.
    lib: ["ES5"],
  },
): string {
  const dir = mkdtempSync(join(tmpdir(), "typecheck-test-"));
  roots.push(dir);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  // The fixture has no scripts/ folder: run the repository's script by path.
  const repoScript = pkg.scripts.typecheck.replace(
    "scripts/",
    `${ROOT}/scripts/`,
  );
  expect(repoScript).not.toBe(pkg.scripts.typecheck);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { typecheck: script ?? repoScript } }),
  );
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const config = {
    compilerOptions,
    ...(include ? { include } : {}),
    exclude: ["lib/skip"],
  };
  writeFileSync(
    join(dir, "tsconfig.json"),
    `// A comment, as in the repository's tsconfig.json.\n${JSON.stringify(config, null, 2)}\n`,
  );
  for (const [path, source] of Object.entries({ ...CLEAN, ...files })) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  return dir;
}

/** Every file and folder under `dir`, node_modules left out. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((path) => !path.startsWith("node_modules"))
    .sort();
}

async function run(
  dir: string,
  extra: string[] = [],
): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([...tsc.command, ...extra], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: out + err };
}

/** The nested entries (a/b) of a partition table, not the top-level ones. */
const nested = (table: string[][]) =>
  table.flat().filter((entry) => entry.includes("/"));

/**
 * The indexes of the programs that have `file` as a root: an include entry
 * holds it (the path or a folder above it) and no exclude entry does. A glob
 * include entry adds only declaration files, so it never holds a .ts file.
 */
function rootsOf(programs: Program[], file: string): number[] {
  const holds = (entry: string) =>
    file === entry || file.startsWith(`${entry}/`);
  return programs.flatMap((program, index) =>
    program.include.some((entry) => !entry.includes("*") && holds(entry)) &&
    !program.exclude.some(holds)
      ? [index]
      : [],
  );
}

describe("partitions", () => {
  it("gives each partition its own program, every other entry one more, last, and no empty program", () => {
    const programs = partitions(["c", "a", "b", "d"], [["a"], ["b"]]);
    expect(programs.map((program) => program.include[0])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(programs.at(-1)!.include).toEqual(["c", "d"]);
    expect(partitions(["c"], [["a"], ["b"]])).toEqual([
      { include: ["c"], exclude: [] },
    ]);
    expect(partitions(["a"], [["a"], ["b"]])).toHaveLength(1);
  });

  it("makes each file a root of exactly one program, also with nested partitions, in any partition order", () => {
    const include = ["a", "s", "lib"];
    const files = ["a/x.ts", "a/n/x.ts", "a/m/x.ts", "a/nn/x.ts"];
    files.push("s/x.ts", "s/p/x.ts", "lib/x.ts");
    const tables = [
      [["a/n", "a/m"], ["a"], ["s/p"]],
      [["s/p"], ["a"], ["a/n", "a/m"]],
    ];
    for (const table of tables) {
      const programs = partitions(include, table);
      const owner = (file: string) => {
        const roots = rootsOf(programs, file);
        expect(roots, `${file} in ${JSON.stringify(programs)}`).toHaveLength(1);
        return programs[roots[0]].include.filter((e) => !e.includes("*"));
      };
      // A nested partition takes its paths from the partition above it and
      // from the program of the entries no partition takes.
      expect(owner("a/n/x.ts")).toEqual(["a/n", "a/m"]);
      expect(owner("a/m/x.ts")).toEqual(["a/n", "a/m"]);
      expect(owner("a/x.ts")).toEqual(["a"]);
      expect(owner("a/nn/x.ts")).toEqual(["a"]);
      expect(owner("s/p/x.ts")).toEqual(["s/p"]);
      expect(owner("s/x.ts")).toEqual(["s", "lib"]);
      expect(owner("lib/x.ts")).toEqual(["s", "lib"]);
      // The entries no partition takes stay last.
      expect(programs.at(-1)!.include).toEqual(["s", "lib"]);
    }
  });

  it("skips a nested partition whose top-level entry is not in include", () => {
    const programs = partitions(["b", "c"], [["a/n"], ["b"]]);
    expect(programs.map((program) => program.include)).toEqual([["b"], ["c"]]);
    expect(programs.flatMap((program) => program.exclude)).toEqual([]);
  });

  it("splits the repository's tsconfig.json with a nested partition and makes each file a root once, a new entry too", () => {
    const config = Bun.JSONC.parse(
      readFileSync(join(ROOT, "tsconfig.json"), "utf8"),
    ) as { include: string[] };
    // The condition the check rests on: the real config has the partitions,
    // and at least one of them is nested in another include entry.
    expect(nested(PARTITIONS).length).toBeGreaterThan(0);
    for (const entry of PARTITIONS.flat())
      expect(config.include).toContain(entry.split("/")[0]);
    for (const include of [config.include, [...config.include, "newarea"]]) {
      const programs = partitions(include);
      expect(programs.every((program) => program.include.length > 0)).toBe(
        true,
      );
      const files = [...include, ...PARTITIONS.flat()].map((entry) =>
        entry.endsWith(".ts") ? entry : `${entry}/x.ts`,
      );
      for (const file of files)
        expect(rootsOf(programs, file), file).toHaveLength(1);
    }
    expect(
      partitions([...config.include, "newarea"]).at(-1)!.include,
    ).toContain("newarea");
  });
});

describe("bun run typecheck", () => {
  it("the tsc stage runs the package's typecheck script", async () => {
    const dir = fixture({}, "exit 7");
    expect((await run(dir)).code).toBe(7);
  });

  it("passes a clean package and writes no file into it", async () => {
    const dir = fixture();
    const before = tree(dir);
    const res = await run(dir);
    expect(res.code, res.out).toBe(0);
    expect(tree(dir)).toEqual(before);
  });

  it("keeps tsconfig.json's exclude", async () => {
    // The same file fails in lib/ (the type error case below). One program:
    // the exclude goes to each program alike.
    const dir = fixture(
      { "lib/skip/bad.ts": 'export const n: number = "one";\n' },
      undefined,
      ["lib"],
    );
    const res = await run(dir);
    expect(res.code, res.out).toBe(0);
  });

  it("checks every file when tsconfig.json has no include entry", async () => {
    // tsc's own default then: every file under the package, not none.
    const dir = fixture(
      { "server/bad.ts": 'export const n: number = "one";\n' },
      undefined,
      null,
    );
    const res = await run(dir);
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("server/bad.ts");
  });

  it("checks each area in its own program, every area once, nested partitions too", async () => {
    // Extra arguments go to every tsc run. With --listFilesOnly each program
    // lists its files: the shared file is in every program, each area's own
    // file in exactly one.
    expect(nested(PARTITIONS).length).toBeGreaterThan(0);
    for (const area of AREAS)
      expect(["server", "ui", "lib"]).toContain(area.split("/")[0]);
    const dir = fixture();
    const res = await run(dir, ["--listFilesOnly"]);
    expect(res.code, res.out).toBe(0);
    const listed = (path: string) =>
      res.out.split("\n").filter((line) => line.trim() === join(dir, path))
        .length;
    const programs = res.out
      .split("\n")
      .filter((line) => line.startsWith("typecheck: ")).length;
    expect(programs).toBe(partitions(["server", "ui", "lib"]).length);
    expect(listed("lib/shared.ts")).toBe(programs);
    for (const area of AREAS) expect(listed(`${area}/a.ts`), area).toBe(1);
  });

  // One run for every area: each program runs, also after one failed.
  it("names a type error in every area in one run, nested partitions and their parents too", async () => {
    expect(nested(PARTITIONS).length).toBeGreaterThan(0);
    const dir = fixture(
      Object.fromEntries(
        AREAS.map((area) => [
          `${area}/bad.ts`,
          'export const n: number = "one";\n',
        ]),
      ),
    );
    const res = await run(dir);
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("TS2322");
    for (const area of AREAS)
      expect(res.out, area).toContain(join(area, "bad.ts"));
  });

  it("gives a nested partition the globals its top-level area declares in a .d.ts", async () => {
    // A .d.ts with no import or export declares globals, and no import pulls
    // it into a program (ui/speech-recognition.d.ts in the repository).
    const inner = nested(PARTITIONS);
    expect(inner.length).toBeGreaterThan(0);
    const files: Record<string, string> = {};
    for (const area of inner) {
      const top = area.split("/")[0];
      files[`${top}/fixture-globals.d.ts`] =
        "declare var fixtureGlobal: number;\n";
      files[`${top}/uses.ts`] = "export const g: number = fixtureGlobal;\n";
      files[`${area}/uses.ts`] = "export const g: number = fixtureGlobal;\n";
    }
    const dir = fixture(files);
    const res = await run(dir);
    expect(res.code, res.out).toBe(0);
    // The same use with no .d.ts fails: the case checks the global.
    const bare = fixture(
      { "lib/uses.ts": files[`${inner[0]}/uses.ts`] },
      undefined,
      ["lib"],
    );
    expect((await run(bare)).out).toContain("TS2304");
  });

  it("gives a program the Bun globals with the repository's compiler options, with no import of bun", async () => {
    // TS 7 adds no ambient types by default, and tsc reads each program's
    // config from a temporary folder outside the package.
    const { compilerOptions } = Bun.JSONC.parse(
      readFileSync(join(ROOT, "tsconfig.json"), "utf8"),
    ) as { compilerOptions: Record<string, unknown> };
    const use = "export const v: string = Bun.version + import.meta.dir;\n";
    // One program: the types load into each program alike, and they make
    // each tsc run about a second slower.
    const dir = fixture(
      { "lib/bun.ts": use },
      undefined,
      ["lib"],
      compilerOptions,
    );
    const res = await run(dir);
    expect(res.code, res.out).toBe(0);
    // The same file fails with no ambient types: the case checks the globals.
    const bare = fixture({ "lib/bun.ts": use }, undefined, ["lib"]);
    expect((await run(bare)).out).toContain("TS2868");
  });

  it("is the native compiler, TypeScript 7", async () => {
    const dir = fixture();
    const res = await run(dir, ["--version"]);
    expect(res.code, res.out).toBe(0);
    const major = /Version (\d+)\./.exec(res.out)?.[1];
    expect(major).toBe("7");
  });
});
