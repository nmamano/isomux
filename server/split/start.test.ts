import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readSplitConfig, startSplitMode } from "./start.ts";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("split-mode start", () => {
  it("stays single-user without ISOMUX_AGENT_RUNNER", async () => {
    expect(await startSplitMode({}, "/nonexistent")).toEqual({
      mode: "single",
    });
    expect(
      await startSplitMode({ ISOMUX_AGENT_RUNNER: "  " }, "/nonexistent"),
    ).toEqual({ mode: "single" });
  });

  it("refuses split mode without the rig gate, before it reads anything", async () => {
    const result = await startSplitMode(
      { ISOMUX_AGENT_RUNNER: "/run/x.sock" },
      "/nonexistent",
    );
    expect(result.mode).toBe("refused");
  });

  it("refuses when split.json is missing or incomplete", async () => {
    dir = mkdtempSync(join(tmpdir(), "split-start-"));
    const env = { ISOMUX_AGENT_RUNNER: "/run/x.sock", ISOMUX_SPLIT_RIG: "1" };
    const missing = await startSplitMode(env, dir);
    expect(missing.mode).toBe("refused");
    writeFileSync(join(dir, "split.json"), JSON.stringify({ agentUser: "a" }));
    expect(() => readSplitConfig(dir!)).toThrow();
    expect((await startSplitMode(env, dir)).mode).toBe("refused");
  });
});
