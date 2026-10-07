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
  it("keeps the cwd's node_modules/.bin once and drops the walk above it", () => {
    const bunPath = [
      "/opt/isomux/node_modules/.bin",
      "/opt/isomux/node_modules/.bin",
      "/opt/node_modules/.bin",
      "/node_modules/.bin",
      SYSTEM,
    ].join(":");
    expect(normalizeBunRunPath(bunPath, "/opt/isomux")).toBe(
      `/opt/isomux/node_modules/.bin:${SYSTEM}`,
    );
  });

  it("drops repeated entries anywhere and keeps the first", () => {
    expect(
      normalizeBunRunPath("/a:/usr/bin:/a:/b:/usr/bin", "/opt/isomux"),
    ).toBe("/a:/usr/bin:/b");
  });

  it("keeps an ancestor's node_modules/.bin that the operator put later in PATH", () => {
    const path = `/opt/isomux/node_modules/.bin:/opt/node_modules/.bin:/usr/bin:/opt/node_modules/.bin`;
    expect(normalizeBunRunPath(path, "/opt/isomux")).toBe(
      "/opt/isomux/node_modules/.bin:/usr/bin:/opt/node_modules/.bin",
    );
  });

  it("leaves a configured ancestor entry alone when PATH has no bun prefix", () => {
    const configured = `/opt/node_modules/.bin:${SYSTEM}`;
    expect(normalizeBunRunPath(configured, "/opt/isomux")).toBe(configured);
  });

  it("keeps every empty entry in place", () => {
    expect(
      normalizeBunRunPath(
        `/opt/isomux/node_modules/.bin:/opt/isomux/node_modules/.bin:/opt/node_modules/.bin::/usr/bin::/bin`,
        "/opt/isomux",
      ),
    ).toBe("/opt/isomux/node_modules/.bin::/usr/bin::/bin");
  });

  it("keeps the root's own entry when the cwd is the root", () => {
    expect(normalizeBunRunPath(`/node_modules/.bin:${SYSTEM}`, "/")).toBe(
      `/node_modules/.bin:${SYSTEM}`,
    );
  });

  it("leaves a PATH without bun's entries as it is", () => {
    expect(normalizeBunRunPath(SYSTEM, "/opt/isomux")).toBe(SYSTEM);
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
      expect(cleaned.filter((entry) => entry.endsWith("node_modules/.bin")))
        .toEqual(raw.includes(own) ? [own] : []);
      expect(cleaned.join(":").endsWith(SYSTEM)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
