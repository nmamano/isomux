import { test, expect } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBrowserExtension,
  EXTENSION_ENTRIES,
} from "./build-browser-extension";

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
