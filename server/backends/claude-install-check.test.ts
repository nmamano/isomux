import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  isClaudeCodeAuthenticated,
  isClaudeCodeInstalled,
} from "./claude-install-check.ts";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "isomux-claude-probe-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("Claude Code effective-environment probes", () => {
  it("resolves credentials from the effective CLAUDE_CONFIG_DIR", () => {
    const signedIn = tempDir();
    const signedOut = tempDir();
    writeFileSync(join(signedIn, ".credentials.json"), "{}");

    expect(isClaudeCodeAuthenticated({ CLAUDE_CONFIG_DIR: signedIn })).toBe(
      true,
    );
    expect(isClaudeCodeAuthenticated({ CLAUDE_CONFIG_DIR: signedOut })).toBe(
      false,
    );
  });

  it("resolves an executable from the effective PATH without which", () => {
    const installed = tempDir();
    const absent = tempDir();
    const executable = join(installed, "claude");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);

    expect(isClaudeCodeInstalled({ PATH: installed })).toBe(true);
    expect(isClaudeCodeInstalled({ PATH: absent })).toBe(false);
  });
});
