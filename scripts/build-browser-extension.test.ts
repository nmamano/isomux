import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildBrowserExtension,
  distFingerprint,
  extensionCatalogs,
  recordFingerprint,
  EXTENSION_ENTRIES,
} from "./build-browser-extension";
import { CATALOGS, type Catalog } from "../shared/i18n/translate";

test("packaged extension has exact root entries, valid CRCs and no stale build files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-package-")),
    out = join(dir, "unpacked");
  try {
    await buildBrowserExtension(out);
    writeFileSync(join(out, "stale.js"), "old credential must never ship");
    const before = readFileSync(`${out}.zip`);
    await buildBrowserExtension(out);
    expect(existsSync(join(out, "stale.js"))).toBe(false);
    expect(readFileSync(`${out}.zip`).equals(before)).toBe(true);
    const result = Bun.spawnSync(["unzip", "-t", `${out}.zip`]);
    expect(result.exitCode).toBe(0);
    const list = Bun.spawnSync(["unzip", "-Z1", `${out}.zip`]);
    expect(list.stdout.toString().trim().split("\n")).toEqual([
      ...EXTENSION_ENTRIES,
    ]);
    const extracted = join(dir, "actual");
    expect(
      Bun.spawnSync(["unzip", "-q", `${out}.zip`, "-d", extracted]).exitCode,
    ).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(extracted, "manifest.json"), "utf8"),
    );
    expect(manifest.action.default_popup).toBe("connection.html");
    expect(manifest.permissions).toEqual([
      "debugger",
      "activeTab",
      "storage",
      "alarms",
      "webNavigation",
    ]);
    for (const file of EXTENSION_ENTRIES)
      expect(
        readFileSync(join(extracted, file)).equals(
          readFileSync(join(out, file)),
        ),
      ).toBe(true);
    expect(readFileSync(join(extracted, "connection.html"), "utf8")).toContain(
      'src="connection.js"',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const root = resolve(import.meta.dir, "..");
const browserOnly = (catalog: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(catalog).filter(([key]) => key.startsWith("browser.")),
  );

describe("the built extension", () => {
  let dir: string, out: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "extension-fingerprint-"));
    out = join(dir, "unpacked");
    await buildBrowserExtension(out);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The committed record is what keeps the version honest: a build that
  // differs from it needs a new version (internal-docs/browser-extension.md).
  test("matches the committed fingerprint record", () => {
    const record = JSON.parse(
      readFileSync(
        join(root, "browser-extension/dist-fingerprint.json"),
        "utf8",
      ),
    ) as { version: string; sha256: string };
    const version = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))
      .version as string;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    const sha256 = distFingerprint(out);
    if (version !== record.version || sha256 !== record.sha256)
      throw new Error(
        `The extension build differs from browser-extension/dist-fingerprint.json (version ${record.version}). Raise the version in browser-extension/manifest.json, then run: bun run build:extension --record`,
      );
    expect({ version, sha256 }).toEqual(record);
  });

  test("bundles only the browser.* catalog keys", () => {
    const keys = Object.keys(CATALOGS.en);
    const browser = keys.filter((key) => key.startsWith("browser."));
    expect(browser.length).toBeGreaterThan(0);
    for (const file of ["background.js", "connection.js"]) {
      const code = readFileSync(join(out, file), "utf8");
      expect(browser.filter((key) => !code.includes(`"${key}"`))).toEqual([]);
      expect(
        keys.filter(
          (key) => !key.startsWith("browser.") && code.includes(`"${key}"`),
        ),
      ).toEqual([]);
    }
  });
});

// Builds a tiny entry that exports CATALOGS through the plugin and returns
// what the bundle holds.
async function catalogsThrough(
  dir: string,
  catalogs?: Record<string, Catalog>,
) {
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `export { CATALOGS } from ${JSON.stringify(join(root, "shared/i18n/translate.ts"))};\n`,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: join(dir, "out"),
    target: "bun",
    plugins: [extensionCatalogs(catalogs)],
    throw: false,
  });
  if (!result.success) return undefined;
  return (await import(join(dir, "out", "entry.js"))).CATALOGS as Record<
    string,
    Record<string, string>
  >;
}

describe("extensionCatalogs", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "extension-catalogs-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("keeps every browser.* key and value of each catalog, and nothing else", async () => {
    const expected = Object.fromEntries(
      Object.entries(CATALOGS).map(([code, catalog]) => [
        code,
        browserOnly(catalog),
      ]),
    );
    for (const catalog of Object.values(expected))
      expect(Object.keys(catalog).length).toBeGreaterThan(0);
    mkdirSync(join(dir, "real"));
    expect(await catalogsThrough(join(dir, "real"))).toEqual(expected);
  });

  test("fails the build when a catalog has no browser.* key", async () => {
    const one = { ...CATALOGS, en: { "browser.x": "X" } as unknown as Catalog };
    mkdirSync(join(dir, "one"));
    expect((await catalogsThrough(join(dir, "one"), one))?.en).toEqual({
      "browser.x": "X",
    });
    const none = { ...CATALOGS, en: { "office.x": "X" } as unknown as Catalog };
    mkdirSync(join(dir, "none"));
    expect(await catalogsThrough(join(dir, "none"), none)).toBeUndefined();
  });
});

describe("recordFingerprint", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "extension-record-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  let n = 0;
  // A fake build: outdir with a manifest, and `${outdir}.zip`.
  function build(version: string, zip: string) {
    const outdir = join(dir, `build-${++n}`);
    mkdirSync(outdir);
    writeFileSync(join(outdir, "manifest.json"), JSON.stringify({ version }));
    writeFileSync(`${outdir}.zip`, zip);
    return outdir;
  }
  function record(contents?: { version: string; sha256: string }) {
    const path = join(dir, `record-${++n}.json`);
    if (contents) writeFileSync(path, `${JSON.stringify(contents)}\n`);
    return path;
  }
  const sha = (text: string) =>
    new Bun.CryptoHasher("sha256").update(text).digest("hex");

  test("distFingerprint is the sha256 of the zip", () => {
    expect(distFingerprint(build("1.0.0", "zip bytes"))).toBe(sha("zip bytes"));
  });

  test.each([
    ["a missing record", undefined, "0.7.3"],
    ["a higher patch", { version: "0.7.2", sha256: sha("old") }, "0.7.3"],
    [
      "a numeric patch (0.7.10 > 0.7.9)",
      { version: "0.7.9", sha256: sha("old") },
      "0.7.10",
    ],
    [
      "a higher minor with a lower patch",
      { version: "0.7.9", sha256: sha("old") },
      "0.8.0",
    ],
    ["a higher major", { version: "0.9.9", sha256: sha("old") }, "1.0.0"],
    [
      "a higher version with the same build",
      { version: "0.7.2", sha256: sha("new") },
      "0.7.3",
    ],
  ])("writes the record for %s", (_, previous, version) => {
    const path = record(previous);
    expect(recordFingerprint(build(version, "new"), path)).toBe("written");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version,
      sha256: sha("new"),
    });
  });

  test("leaves the record as it is for the same version and build", () => {
    const path = record({ version: "0.7.3", sha256: sha("same") });
    const before = readFileSync(path);
    expect(recordFingerprint(build("0.7.3", "same"), path)).toBe("unchanged");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test.each([
    [
      "the same version with a new build",
      { version: "0.7.3", sha256: sha("old") },
      "0.7.3",
    ],
    [
      "a lower version with a new build",
      { version: "0.7.3", sha256: sha("old") },
      "0.7.2",
    ],
    [
      "a lower version with the same build",
      { version: "0.7.3", sha256: sha("new") },
      "0.7.2",
    ],
    [
      "a lower numeric patch (0.7.9 < 0.7.10)",
      { version: "0.7.10", sha256: sha("old") },
      "0.7.9",
    ],
    [
      "a lower minor with a higher patch",
      { version: "0.8.0", sha256: sha("old") },
      "0.7.9",
    ],
    [
      "a version with two parts",
      { version: "0.7.2", sha256: sha("old") },
      "0.8",
    ],
    [
      "a prerelease version",
      { version: "0.7.2", sha256: sha("old") },
      "0.7.3-beta",
    ],
  ])("refuses %s and keeps the record", (_, previous, version) => {
    const path = record(previous);
    const before = readFileSync(path);
    const outdir = build(version, "new");
    // The reason names the version it refuses, which also tells a refusal
    // apart from a crash.
    expect(() => recordFingerprint(outdir, path)).toThrow(version);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
