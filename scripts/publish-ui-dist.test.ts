import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publishUiDist } from "./publish-ui-dist";

// An open tab imports lazy chunks of the build it loaded long after the next
// build, so the prune keeps the current and the previous build and anything
// written in the last 24 h, and removes the rest.

const HOUR = 3_600_000;
const NOW = Date.now() + 7 * 24 * HOUR;
const MANIFEST = ".build-manifest.json";

let root: string;
let ui: string;
let dist: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "publish-ui-dist-"));
  ui = join(root, "ui");
  dist = join(ui, "dist");
  mkdirSync(ui);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setAge(path: string, hours: number) {
  const t = (NOW - hours * HOUR) / 1000;
  utimesSync(path, t, t);
}

function write(dir: string, files: Record<string, string>, ageHours: number) {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    setAge(path, ageHours);
  }
}

// A stage dir named as scripts/build.sh names it, holding one build.
function stage(files: Record<string, string>, ageHours = 1): string {
  const dir = mkdtempSync(join(ui, ".dist-stage."));
  write(dir, files, ageHours);
  return dir;
}

function filesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) {
      out.push(...filesUnder(join(dir, entry.name), rel + "/"));
    } else out.push(rel);
  }
  return out.sort();
}

// Simulates time passing: every file in ui/dist is now older than the grace
// window, except the paths named in `fresh`.
function ageDist(fresh: string[] = []) {
  for (const rel of filesUnder(dist)) {
    setAge(join(dist, rel), fresh.includes(rel) ? 1 : 48);
  }
}

function build(tag: string, extra: Record<string, string> = {}) {
  return {
    "index.html": `<html>${tag}</html>`,
    "index.js": `import("./mermaid-${tag}.js")`,
    [`mermaid-${tag}.js`]: `mermaid ${tag}`,
    "shared-0000aaaa.js": "shared across builds",
    "katex/fonts/KaTeX_Main.woff2": "font",
    "icons/icon.svg": "<svg/>",
    ...extra,
  };
}

test("publishes every staged file with its bytes, entry files last", () => {
  const files = build("a");
  const result = publishUiDist(stage(files), dist, NOW);

  const published = Object.keys(files).sort();
  expect(filesUnder(dist).filter((rel) => rel !== MANIFEST)).toEqual(published);
  for (const [rel, body] of Object.entries(files)) {
    expect(readFileSync(join(dist, rel), "utf8")).toBe(body);
  }
  expect([...result.published].sort()).toEqual(published);
  // The new entry appears only once every chunk it imports is in place.
  expect(result.published.slice(-2)).toEqual(["index.js", "index.html"]);
});

test("the first publish, with no manifest yet, removes nothing", () => {
  // Pre-manifest ui/dist: a self-hoster's previous build, weeks old.
  write(dist, { "index.js": "old", "mermaid-old.js": "old" }, 24 * 30);
  write(dist, { "olddir/chunk-old.js": "old" }, 24 * 30);

  const result = publishUiDist(stage(build("a")), dist, NOW);

  expect(result.removed).toEqual([]);
  expect(existsSync(join(dist, "mermaid-old.js"))).toBe(true);
  expect(existsSync(join(dist, "olddir/chunk-old.js"))).toBe(true);
  expect(existsSync(join(dist, MANIFEST))).toBe(true);
});

test("keeps the current and the previous build and recent files, removes older builds", () => {
  write(dist, { "junk-old.js": "x", "olddir/chunk-old.js": "x" }, 48);
  publishUiDist(stage(build("a", { "only-a.js": "a" })), dist, NOW);
  write(dist, { "junk-fresh.js": "x" }, 1);
  ageDist(["junk-fresh.js"]);

  // Build b: a is now the previous build; the pre-manifest junk goes.
  const b = publishUiDist(stage(build("b", { "only-b.js": "b" })), dist, NOW);
  expect([...b.removed].sort()).toEqual(["junk-old.js", "olddir/chunk-old.js"]);
  expect(existsSync(join(dist, "olddir"))).toBe(false);
  ageDist(["junk-fresh.js"]);

  // Build c, with old staged mtimes: the current build is kept whatever its
  // age. b (previous) stays; a's own files go, the manifest stays.
  const c = publishUiDist(stage(build("c"), 48), dist, NOW);
  expect([...c.removed].sort()).toEqual(["mermaid-a.js", "only-a.js"]);
  expect(filesUnder(dist)).toEqual(
    [
      MANIFEST,
      "icons/icon.svg",
      "index.html",
      "index.js",
      "junk-fresh.js",
      "katex/fonts/KaTeX_Main.woff2",
      "mermaid-b.js",
      "mermaid-c.js",
      "only-b.js",
      "shared-0000aaaa.js",
    ].sort(),
  );
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("<html>c</html>");
});

test("an unreadable manifest removes nothing, and the next publish prunes", () => {
  publishUiDist(stage(build("a")), dist, NOW);
  write(dist, { [MANIFEST]: "{not json", "junk-old.js": "x" }, 48);

  const b = publishUiDist(stage(build("b")), dist, NOW);
  expect(b.removed).toEqual([]);
  expect(existsSync(join(dist, "junk-old.js"))).toBe(true);

  ageDist();
  const c = publishUiDist(stage(build("c")), dist, NOW);
  expect([...c.removed].sort()).toEqual(["junk-old.js", "mermaid-a.js"]);
});

test("the prune does not follow a symlink out of ui/dist", () => {
  const outside = join(root, "outside");
  write(outside, { "keep.js": "outside file" }, 48);
  publishUiDist(stage(build("a")), dist, NOW);
  symlinkSync(outside, join(dist, "linked"));
  ageDist();

  publishUiDist(stage(build("b")), dist, NOW);
  ageDist();
  const c = publishUiDist(stage(build("c")), dist, NOW);

  expect(c.removed).toContain("mermaid-a.js");
  expect(readFileSync(join(outside, "keep.js"), "utf8")).toBe("outside file");
});

test("removes stale sibling stage dirs only", () => {
  // A SIGKILLed build leaves its stage dir; the trap in build.sh never ran.
  const stale = stage({ "index.js": "killed build" }, 48);
  setAge(stale, 48);
  const fresh = stage({ "index.js": "concurrent build" }, 1);
  setAge(fresh, 1);
  // ui/ source files and dirs are siblings too and are never touched.
  write(ui, { "index.tsx": "source", ".dist-stagey/keep": "not a stage" }, 48);
  setAge(join(ui, ".dist-stagey"), 48);
  const own = stage(build("a"));
  setAge(own, 48);

  publishUiDist(own, dist, NOW);

  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(readFileSync(join(ui, "index.tsx"), "utf8")).toBe("source");
  expect(existsSync(join(ui, ".dist-stagey/keep"))).toBe(true);
  expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("<html>a</html>");
  expect(lstatSync(dist).isDirectory()).toBe(true);
});

test("rebuilding the same build keeps the build before it as the previous one", () => {
  publishUiDist(stage(build("a", { "only-a.js": "a" })), dist, NOW);
  ageDist();
  publishUiDist(stage(build("b")), dist, NOW);
  ageDist();

  // The same build again (an installer re-run): a stays the previous build.
  const again = publishUiDist(stage(build("b")), dist, NOW);
  expect(again.removed).toEqual([]);
  expect(existsSync(join(dist, "mermaid-a.js"))).toBe(true);
  ageDist();

  const c = publishUiDist(stage(build("c")), dist, NOW);
  expect([...c.removed].sort()).toEqual(["mermaid-a.js", "only-a.js"]);
});

// Root ignores the read-only mode the test relies on.
test.skipIf(process.getuid?.() === 0)(
  "a file the cleanup cannot remove does not fail the publish",
  () => {
    publishUiDist(stage(build("a")), dist, NOW);
    write(dist, { "junk-old.js": "x", "locked/chunk-old.js": "x" }, 48);
    const lockedStage = stage({ "locked/index.js": "killed build" }, 48);
    const locked = [join(dist, "locked"), join(lockedStage, "locked")];
    for (const dir of locked) chmodSync(dir, 0o555);
    setAge(lockedStage, 48);
    try {
      for (const dir of locked) {
        expect(() => writeFileSync(join(dir, "probe"), "")).toThrow();
      }
      const b = publishUiDist(stage(build("b")), dist, NOW);
      expect(b.removed).toEqual(["junk-old.js"]);
      expect(readFileSync(join(dist, "index.html"), "utf8")).toBe(
        "<html>b</html>",
      );
      expect(existsSync(join(dist, "locked/chunk-old.js"))).toBe(true);
    } finally {
      for (const dir of locked) chmodSync(dir, 0o755);
    }
  },
);
