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
import { join } from "node:path";
import { stages } from "./ci";
import { PARTITIONS, partitions } from "./typecheck";

const ROOT = join(import.meta.dir, "..");
const tsc = stages.find((s) => s.name === "tsc")!;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const CLEAN = {
  "server/a.ts": 'import { s } from "../lib/shared";\nexport const n = s;\n',
  "ui/a.ts": 'import { s } from "../lib/shared";\nexport const n = s;\n',
  "lib/a.ts": 'import { s } from "./shared";\nexport const n = s;\n',
  "lib/shared.ts": "export const s: number = 1;\n",
};

/**
 * A package with the repository's typecheck script (or `script`), a
 * tsconfig.json with a comment (as the repository's has), the include entries
 * server, ui and lib (the last one in no partition), and lib/skip excluded.
 */
function fixture(
  files: Record<string, string> = {},
  script?: string,
  include: string[] | null = ["server", "ui", "lib"],
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
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      types: [],
    },
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

describe("partitions", () => {
  it("gives each partition its own program and every other entry one more, last", () => {
    expect(PARTITIONS.length).toBeGreaterThan(0);
    const include = ["shared", ...PARTITIONS.flat(), "api", "middleware.ts"];
    const programs = partitions(include);
    expect(programs.slice(0, -1)).toEqual(PARTITIONS);
    expect(programs.at(-1)).toEqual(["shared", "api", "middleware.ts"]);
  });

  it("covers every include entry of the repository's tsconfig.json exactly once, a new entry too", () => {
    const config = Bun.JSONC.parse(
      readFileSync(join(ROOT, "tsconfig.json"), "utf8"),
    ) as { include: string[] };
    // The condition the check rests on: the real config has the partitions.
    for (const entry of PARTITIONS.flat())
      expect(config.include).toContain(entry);
    for (const include of [config.include, [...config.include, "newarea"]]) {
      const programs = partitions(include);
      expect(programs.flat().sort()).toEqual([...include].sort());
      expect(programs.every((program) => program.length > 0)).toBe(true);
    }
    expect(partitions([...config.include, "newarea"]).at(-1)).toContain(
      "newarea",
    );
  });

  it("skips a partition that is not in include, and gives no empty program", () => {
    const [first] = PARTITIONS;
    expect(partitions(["lib"])).toEqual([["lib"]]);
    expect(partitions([...first, "lib"])).toEqual([first, ["lib"]]);
    expect(partitions(first)).toEqual([first]);
    expect(partitions(PARTITIONS.flat())).toEqual(PARTITIONS);
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

  // One fixture per case: each run is three tsc runs.
  it.each(["server", "ui", "lib"])(
    "fails on a type error in %s and names it",
    async (area) => {
      const dir = fixture({
        [`${area}/bad.ts`]: 'export const n: number = "one";\n',
      });
      const res = await run(dir);
      expect(res.code).not.toBe(0);
      expect(res.out).toContain("TS2322");
      expect(res.out).toContain(`${area}/bad.ts`);
    },
  );

  it("runs every program after one fails", async () => {
    const dir = fixture({
      "server/bad.ts": 'export const n: number = "one";\n',
      "lib/bad.ts": 'export const m: number = "two";\n',
    });
    const res = await run(dir);
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("server/bad.ts");
    expect(res.out).toContain("lib/bad.ts");
  });

  it("keeps tsconfig.json's exclude", async () => {
    // The same file fails in lib/ (the type error case above).
    const dir = fixture({
      "lib/skip/bad.ts": 'export const n: number = "one";\n',
    });
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

  it("checks each area in its own program, every area once", async () => {
    // Extra arguments go to every tsc run. With --listFilesOnly each program
    // lists its files: the shared file is in all three programs, each
    // area's own file in exactly one.
    expect(PARTITIONS).toContainEqual(["server"]);
    expect(PARTITIONS).toContainEqual(["ui"]);
    const dir = fixture();
    const res = await run(dir, ["--listFilesOnly"]);
    expect(res.code, res.out).toBe(0);
    const listed = (path: string) =>
      res.out.split("\n").filter((line) => line.trim().endsWith(path)).length;
    expect({
      shared: listed("lib/shared.ts"),
      server: listed("server/a.ts"),
      ui: listed("ui/a.ts"),
      lib: listed("lib/a.ts"),
    }).toEqual({ shared: 3, server: 1, ui: 1, lib: 1 });
  });

  it("is the native compiler, TypeScript 7", async () => {
    const dir = fixture();
    const res = await run(dir, ["--version"]);
    expect(res.code, res.out).toBe(0);
    const major = /Version (\d+)\./.exec(res.out)?.[1];
    expect(major).toBe("7");
  });
});
