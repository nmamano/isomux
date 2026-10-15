import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  openCodeConfigOverride,
  openCodeUserConfigDir,
} from "./config-layers.ts";

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

describe("openCodeConfigOverride", () => {
  const plugin = "file:///profile/isomux-safety-plugin.js";

  it("keeps every key but the MCP headers, and loads the safety plugin last", () => {
    const config = {
      share: "disabled",
      permission: { bash: "ask" },
      plugin: ["office-plugin"],
      mcp: {
        docs: {
          type: "remote",
          url: "https://docs.example.com/mcp",
          headers: { Authorization: "Bearer value" },
          enabled: true,
        },
      },
    };
    expect(openCodeConfigOverride(config, plugin)).toEqual({
      share: "disabled",
      permission: { bash: "ask" },
      plugin: ["office-plugin", plugin],
      mcp: {
        docs: {
          type: "remote",
          url: "https://docs.example.com/mcp",
          enabled: true,
        },
      },
    });
    expect(config.mcp.docs.headers, "the input is not changed").toBeDefined();
  });

  it("adds the safety plugin to a config without MCP servers", () => {
    expect(openCodeConfigOverride({ share: "disabled" }, plugin)).toEqual({
      share: "disabled",
      plugin: [plugin],
    });
  });
});
