// normalizeBunRunPath: the PATH `bun run <file>` hands the office, cleaned
// before agents inherit it. Zero LLM.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { normalizeBunRunPath } from "./bun-run-path.ts";

const SYSTEM = "/usr/local/bin:/usr/bin:/bin";

describe("normalizeBunRunPath", () => {
  const OWN = "/opt/isomux/node_modules/.bin";
  it.each([
    [
      "keeps the cwd's node_modules/.bin once and drops the walk above it",
      [OWN, OWN, "/opt/node_modules/.bin", "/node_modules/.bin", SYSTEM],
      "/opt/isomux",
      `${OWN}:${SYSTEM}`,
    ],
    [
      "drops repeated entries anywhere and keeps the first",
      ["/a", "/usr/bin", "/a", "/b", "/usr/bin"],
      "/opt/isomux",
      "/a:/usr/bin:/b",
    ],
    [
      "keeps an ancestor's node_modules/.bin that the operator put later in PATH",
      [OWN, "/opt/node_modules/.bin", "/usr/bin", "/opt/node_modules/.bin"],
      "/opt/isomux",
      `${OWN}:/usr/bin:/opt/node_modules/.bin`,
    ],
    [
      "leaves a configured ancestor entry alone when PATH has no bun prefix",
      ["/opt/node_modules/.bin", SYSTEM],
      "/opt/isomux",
      `/opt/node_modules/.bin:${SYSTEM}`,
    ],
    [
      "keeps every empty entry in place",
      [OWN, OWN, "/opt/node_modules/.bin", "", "/usr/bin", "", "/bin"],
      "/opt/isomux",
      `${OWN}::/usr/bin::/bin`,
    ],
    [
      "keeps the root's own entry when the cwd is the root",
      ["/node_modules/.bin", SYSTEM],
      "/",
      `/node_modules/.bin:${SYSTEM}`,
    ],
  ])("%s", (_name, entries, cwd, expected) => {
    expect(normalizeBunRunPath(entries.join(":"), cwd)).toBe(expected);
  });

  it("cleans the PATH the running bun really produces for `bun run <file>`", () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-bun-run-path-"));
    try {
      writeFileSync(join(dir, "p.ts"), "console.log(process.env.PATH)");
      const res = spawnSync(process.execPath, ["run", "p.ts"], {
        cwd: dir,
        env: { HOME: process.env.HOME, PATH: SYSTEM },
        encoding: "utf8",
      });
      const raw = res.stdout.trim();
      expect(raw.endsWith(SYSTEM)).toBe(true);
      const own = join(dir, "node_modules", ".bin");
      const cleaned = normalizeBunRunPath(raw, dir).split(":");
      expect(
        cleaned.filter((entry) => entry.endsWith("node_modules/.bin")),
      ).toEqual(raw.includes(own) ? [own] : []);
      expect(cleaned.join(":").endsWith(SYSTEM)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
