// The type check of every gate (task 382fe948): the CI tsc stage runs
// `bun run typecheck`, and that script runs the native compiler (TypeScript 7)
// by path. Each case runs the tsc stage's own command in a small fixture
// package whose typecheck script is the repository's.
import { afterEach, expect, it } from "bun:test";
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

const ROOT = join(import.meta.dir, "..");
const tsc = stages.find((s) => s.name === "tsc")!;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A package with the repository's typecheck script (or `script`) and one source file. */
function fixture(source: string, script?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "typecheck-test-"));
  roots.push(dir);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      scripts: { typecheck: script ?? pkg.scripts.typecheck },
    }),
  );
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["src"],
    }),
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), source);
  return dir;
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

it("the tsc stage runs the package's typecheck script", async () => {
  const dir = fixture("export const n = 1;\n", "exit 7");
  expect((await run(dir)).code).toBe(7);
});

it("passes a clean file and writes no output", async () => {
  const dir = fixture("export const n: number = 1;\n");
  const res = await run(dir);
  expect(res.code, res.out).toBe(0);
  expect(readdirSync(join(dir, "src"))).toEqual(["a.ts"]);
  expect(readdirSync(dir).sort()).toEqual([
    "node_modules",
    "package.json",
    "src",
    "tsconfig.json",
  ]);
});

it("fails on a type error and names it", async () => {
  const dir = fixture('export const n: number = "one";\n');
  const res = await run(dir);
  expect(res.code).not.toBe(0);
  expect(res.out).toContain("TS2322");
  expect(readdirSync(join(dir, "src"))).toEqual(["a.ts"]);
});

it("is the native compiler, TypeScript 7", async () => {
  const dir = fixture("export const n = 1;\n");
  const res = await run(dir, ["--version"]);
  expect(res.code, res.out).toBe(0);
  const major = /Version (\d+)\./.exec(res.out)?.[1];
  expect(major).toBe("7");
});
