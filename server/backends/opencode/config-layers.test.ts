import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { openCodeUserConfigDir } from "./config-layers.ts";

describe("openCodeUserConfigDir", () => {
  it("uses the member's absolute OPENCODE_CONFIG_DIR", () => {
    expect(
      openCodeUserConfigDir({
        OPENCODE_CONFIG_DIR: "/srv/member/opencode",
        XDG_CONFIG_HOME: "/srv/xdg",
      }),
    ).toBe("/srv/member/opencode");
  });

  it("falls back to the OS user's XDG config directory", () => {
    expect(openCodeUserConfigDir({ XDG_CONFIG_HOME: "/srv/xdg" })).toBe(
      "/srv/xdg/opencode",
    );
    expect(openCodeUserConfigDir({})).toBe(
      join(homedir(), ".config", "opencode"),
    );
  });

  it("ignores relative directories, as Isomux expands no paths", () => {
    expect(
      openCodeUserConfigDir({
        OPENCODE_CONFIG_DIR: "~/opencode",
        XDG_CONFIG_HOME: "xdg",
      }),
    ).toBe(join(homedir(), ".config", "opencode"));
  });
});
