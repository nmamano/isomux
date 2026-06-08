import { describe, it, expect } from "bun:test";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { resolveStateRoot, STATE_ROOT } from "./config.ts";

describe("resolveStateRoot", () => {
  const DEFAULT = join(homedir(), ".isomux");

  it("defaults to ~/.isomux when ISOMUX_HOME is unset", () => {
    expect(resolveStateRoot({})).toBe(DEFAULT);
  });

  it("treats an empty ISOMUX_HOME as unset", () => {
    expect(resolveStateRoot({ ISOMUX_HOME: "" })).toBe(DEFAULT);
  });

  it("treats a whitespace-only ISOMUX_HOME as unset", () => {
    expect(resolveStateRoot({ ISOMUX_HOME: "   " })).toBe(DEFAULT);
  });

  it("uses an absolute ISOMUX_HOME verbatim", () => {
    expect(resolveStateRoot({ ISOMUX_HOME: "/tmp/isomux-test-root" })).toBe(
      "/tmp/isomux-test-root",
    );
  });

  it("normalizes a trailing slash", () => {
    expect(resolveStateRoot({ ISOMUX_HOME: "/tmp/isomux-test-root/" })).toBe(
      "/tmp/isomux-test-root",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolveStateRoot({ ISOMUX_HOME: "  /tmp/isomux-test-root  " })).toBe(
      "/tmp/isomux-test-root",
    );
  });

  it("resolves a relative ISOMUX_HOME to an absolute path", () => {
    const out = resolveStateRoot({ ISOMUX_HOME: "rel/state-dir" });
    expect(isAbsolute(out)).toBe(true);
    expect(out).toBe(resolve("rel/state-dir"));
  });
});

describe("STATE_ROOT", () => {
  it("matches the resolver applied to the current process env", () => {
    expect(STATE_ROOT).toBe(resolveStateRoot(process.env));
  });

  it("is an absolute path", () => {
    expect(isAbsolute(STATE_ROOT)).toBe(true);
  });
});
