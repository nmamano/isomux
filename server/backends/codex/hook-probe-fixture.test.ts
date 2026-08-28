import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  hookEntryHash,
  trustHook,
  writeHookFixture,
} from "./hook-probe-fixture.ts";

describe("Codex hook probe fixture (no coverage claim)", () => {
  it("writes an isolated deny hook and its exact trust-state key", () => {
    const home = mkdtempSync(join(tmpdir(), "isomux-hook-fixture-"));
    try {
      const fixture = writeHookFixture(home, "deny", 2);
      const hooks = JSON.parse(readFileSync(fixture.hooksPath, "utf8"));
      expect(hooks.hooks.PreToolUse[0].hooks[0]).toEqual({
        type: "command",
        command: fixture.hookPath,
        timeout: 2,
      });
      trustHook(fixture, "sha256:fixture");
      expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
        `${fixture.hooksPath}:pre_tool_use:0:0`,
      );
      expect(hookEntryHash(hooks)).toHaveLength(64);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
