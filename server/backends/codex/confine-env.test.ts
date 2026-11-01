// The confinement a Codex session at folder or web hands its safety hook
// (task 25015e41): it survives the trip through the environment, it is
// absent when the variable is, and a value the hook cannot read is an error
// (the hook then denies every call).
import { describe, expect, it } from "bun:test";
import {
  CODEX_CONFINE_ENV,
  codexConfinedTools,
  codexConfineEnvValue,
  codexHookMcpToolName,
  readCodexConfine,
  type CodexConfine,
} from "./confine-env.ts";
import { FOLDER_FILES_MCP_SERVER } from "../../folder-mcp-endpoint.ts";
import { FOLDER_FILES_TOOLS } from "../../folder-files.ts";

describe("the confinement in the environment", () => {
  it("reads back what the session wrote", () => {
    for (const access of ["folder", "web"] as const) {
      const confine: CodexConfine = {
        access,
        folder: '/srv/agent folder/with "quotes"',
        tools: codexConfinedTools(["list_tasks"]),
      };
      expect(
        readCodexConfine({
          [CODEX_CONFINE_ENV]: codexConfineEnvValue(confine),
        }),
      ).toEqual(confine);
    }
  });

  it("is null when the variable is not set", () => {
    expect(readCodexConfine({})).toBeNull();
    expect(readCodexConfine({ [CODEX_CONFINE_ENV]: undefined })).toBeNull();
  });

  it("throws on a value it cannot read", () => {
    const good = { access: "folder", folder: "/srv/f", tools: ["apply_patch"] };
    for (const value of [
      "",
      "{",
      "null",
      "[]",
      JSON.stringify({ ...good, folder: "relative/f" }),
      JSON.stringify({ ...good, folder: "" }),
      JSON.stringify({ ...good, access: "standard" }),
      JSON.stringify({ ...good, access: "office" }),
      JSON.stringify({ ...good, access: "admin" }),
      JSON.stringify({ ...good, tools: "apply_patch" }),
      JSON.stringify({ ...good, tools: [7] }),
      JSON.stringify({ access: "folder", folder: "/srv/f" }),
    ])
      expect({
        value,
        threw: (() => {
          try {
            readCodexConfine({ [CODEX_CONFINE_ENV]: value });
            return false;
          } catch {
            return true;
          }
        })(),
      }).toEqual({ value, threw: true });
  });
});

describe("codexConfinedTools", () => {
  it("is apply_patch, request_user_input, the files tools and the office tools given, as the hook names them", () => {
    const office = ["list_tasks", "open_ask"];
    expect([...codexConfinedTools(office)].sort()).toEqual(
      [
        "apply_patch",
        "request_user_input",
        ...FOLDER_FILES_TOOLS.map((t) =>
          codexHookMcpToolName(FOLDER_FILES_MCP_SERVER, t),
        ),
        ...office.map((t) => codexHookMcpToolName("isomux", t)),
      ]
        .map((t) => t.toLowerCase())
        .sort(),
    );
  });

  it("names a server's tools apart from another server's tool of the same name", () => {
    expect(codexHookMcpToolName(FOLDER_FILES_MCP_SERVER, "read_file")).not.toBe(
      codexHookMcpToolName("planted", "read_file"),
    );
    expect(codexHookMcpToolName(FOLDER_FILES_MCP_SERVER, "read_file")).not.toBe(
      "read_file",
    );
  });
});
