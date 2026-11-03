import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { evaluateProposedAction } from "./safety-policy.ts";

// The names a write below standard never reaches are matched as a
// case-insensitive file system (macOS) opens them, so a spelling that opens
// the same file as an engine's settings is denied too. Each engine's adapter
// sends its writes through this one check.
const folder = mkdtempSync(join(tmpdir(), "safety-confined-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function write(name: string) {
  return evaluateProposedAction(
    {
      kind: "write-files",
      toolName: "Write",
      input: { file_path: join(folder, name), content: "x" },
    },
    { cwd: folder, confine: { access: "folder", folder } },
  );
}

describe("a write below standard never reaches engine settings", () => {
  it.each([
    // OpenCode loads both opencode.json and opencode.jsonc as project config.
    ["opencode.jsonc", "opencode.jsonc"],
    ["sub/opencode.jsonc", "opencode.jsonc"],
    // OpenCode and Codex load skills from .agents/skills.
    [".agents/skills/x/SKILL.md", ".agents"],
    // Codex reads AGENTS.override.md before AGENTS.md in each folder.
    ["AGENTS.override.md", "AGENTS.override.md"],
    ["sub/AGENTS.override.md", "AGENTS.override.md"],
    // Another case opens the same file on a case-insensitive file system.
    ["OpenCode.JSONC", "OpenCode.JSONC"],
    ["sub/Claude.md", "Claude.md"],
    [".Claude/settings.json", ".Claude"],
    ["agents.override.MD", "agents.override.MD"],
    // The long s (U+017F) folds to "s" there.
    ["opencode.j\u017Fon", "opencode.j\u017Fon"],
    ["AGENT\u017F.md", "AGENT\u017F.md"],
    // HFS+ ignores these code points in a name (git's CVE-2014-9390).
    [".g\u200Cit/config", ".g\u200Cit"],
    ["CLAUDE\uFEFF.md", "CLAUDE\uFEFF.md"],
    [".env\u202Erc", ".env\u202Erc"],
  ])("%s", (name, part) => {
    // The reason names the part as the agent wrote it.
    expect(write(name)).toEqual({
      decision: "deny",
      reason: expect.stringContaining(`(${part})`),
    });
  });

  it.each([
    "opencode.jsonc.txt",
    "notes/opencode.jsonc5",
    "agents/x.md",
    "my.agents/x.md",
    "AGENTS.override.md.bak",
    "sub/claude.mdx",
    "j\u017Fon.md",
  ])("%s stays writable", (name) => {
    expect(write(name).decision).toBe("allow");
  });
});
