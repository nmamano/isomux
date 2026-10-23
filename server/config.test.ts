import { describe, it, expect } from "bun:test";
import { homedir } from "os";
import { join, resolve } from "path";
import { resolveStateRoot, STATE_ROOT } from "./config.ts";

describe("resolveStateRoot", () => {
  const DEFAULT = join(homedir(), ".isomux");

  it.each([
    ["unset", undefined, DEFAULT],
    // Whitespace only reads as unset.
    ["whitespace", "   ", DEFAULT],
    ["absolute", "/tmp/isomux-test-root", "/tmp/isomux-test-root"],
    ["relative", "rel/state-dir", resolve("rel/state-dir")],
  ])("an ISOMUX_HOME that is %s", (_label, home, expected) => {
    expect(
      resolveStateRoot(home === undefined ? {} : { ISOMUX_HOME: home }),
    ).toBe(expected);
  });
});

describe("STATE_ROOT", () => {
  it("matches the resolver applied to the current process env", () => {
    expect(STATE_ROOT).toBe(resolveStateRoot(process.env));
  });
});
