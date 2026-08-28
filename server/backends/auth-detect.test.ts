// Auth detection + login-instruction units (deterministic, zero LLM).
//
// Covers the deterministic half of the traceability row "Subscription auth
// (works if CLI works)": env-detect + login-instructions for Claude and Codex.
// actual interactive login stays a T3 manual step. Every input env is passed
// explicitly (never process.env), so the host's ambient auth can't influence
// the result: detectAuthError is pure regex, and the already-authed cases
// inject the key to exercise the short-circuit before any filesystem /
// process.env lookup. The auth.json path uses a temp CODEX_HOME. The codex
// login-command generation (wrapper script + paths) is already covered by
// server/backends/codex/native-bin.test.ts and not repeated.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { claudeBackend } from "./claude.ts";
import { codexBackend } from "./codex/adapter.ts";
import { isCodexAuthenticated } from "./codex/native-bin.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tempCodexHome(withAuthJson: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "isomux-auth-home-"));
  tempDirs.push(dir);
  if (withAuthJson) writeFileSync(join(dir, "auth.json"), "{}");
  return dir;
}

// Strings that should and shouldn't read as auth failures. The two backends
// share most patterns but are independently defined, so each is asserted
// against its own backend.
const AUTH_SHAPED = [
  "Error: 401 Unauthorized",
  "request failed with status 403",
  "invalid token provided",
  "authentication failed",
];
const BENIGN = [
  "rate limit reached, retrying",
  "tool execution failed: exit code 1",
  "Operation completed successfully",
];

describe("detectAuthError", () => {
  it("claudeBackend flags auth-shaped strings and ignores benign ones", () => {
    for (const s of AUTH_SHAPED)
      expect(claudeBackend.detectAuthError(s)).toBe(true);
    for (const s of BENIGN)
      expect(claudeBackend.detectAuthError(s)).toBe(false);
    // Claude-specific signal.
    expect(claudeBackend.detectAuthError("please run /login")).toBe(true);
  });

  it("codexBackend flags auth-shaped strings and ignores benign ones", () => {
    for (const s of AUTH_SHAPED)
      expect(codexBackend.detectAuthError(s)).toBe(true);
    for (const s of BENIGN) expect(codexBackend.detectAuthError(s)).toBe(false);
    // Codex-specific signal: env-var auth name.
    expect(codexBackend.detectAuthError("OPENAI_API_KEY is missing")).toBe(
      true,
    );
  });
});

describe("getLoginInstructions - already-authed short-circuit", () => {
  it("claudeBackend: ANTHROPIC_API_KEY in env -> /clear hint, no command cards", () => {
    const r = claudeBackend.getLoginInstructions({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    });
    expect(r.commands).toBeUndefined();
    expect(r.text).toMatch(/\/clear/i);
  });

  it("codexBackend: OPENAI_API_KEY in env -> /clear hint, no command cards", () => {
    const r = codexBackend.getLoginInstructions({
      env: { OPENAI_API_KEY: "sk-test" },
    });
    expect(r.commands).toBeUndefined();
    expect(r.text).toMatch(/\/clear/i);
  });
});

describe("isCodexAuthenticated env-detect", () => {
  it("OPENAI_API_KEY in env counts as authed (no filesystem needed)", () => {
    expect(isCodexAuthenticated({ OPENAI_API_KEY: "sk-test" })).toBe(true);
  });

  it("no key and an empty CODEX_HOME is not authed", () => {
    const home = tempCodexHome(false);
    expect(isCodexAuthenticated({ CODEX_HOME: home })).toBe(false);
  });

  it("auth.json present in CODEX_HOME counts as authed", () => {
    const home = tempCodexHome(true);
    expect(isCodexAuthenticated({ CODEX_HOME: home })).toBe(true);
  });
});
