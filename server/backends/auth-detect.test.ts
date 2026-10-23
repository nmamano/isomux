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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { claudeBackend } from "./claude.ts";
import { codexBackend } from "./codex/adapter.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import {
  localizeLogParts,
  logParts,
  msg,
  renderLogText,
  type LogMessage,
} from "../../shared/i18n/log-message.ts";
import {
  codexWrapperCommandForShell,
  ISOMUX_CODEX_HOME,
  isCodexAuthenticated,
} from "./codex/native-bin.ts";
import { CLAUDE_NATIVE_BIN } from "../cwd-utils.ts";
import { opencodeBackend } from "./opencode/adapter.ts";
import type { LoginInstructions } from "./types.ts";

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
  "invalid token provided",
  "authentication failed",
];
// A 403 is the provider refusing the request, not a sign-in failure: the
// member reads the provider's words instead of a login card (task 2bd836d5).
const BENIGN = [
  "rate limit reached, retrying",
  "tool execution failed: exit code 1",
  "Operation completed successfully",
  "request failed with status 403",
  "unexpected status 403 Forbidden: Request not allowed",
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

// A dead Codex refresh token leaves auth.json on disk (task 1403b454). Once
// Codex has rejected it, auth.json is no proof of a sign-in: the member gets
// the same walkthrough as a signed-out one. A typed /login keeps the /clear
// hint. A stored sign-in wins over OPENAI_API_KEY (task 23c1992a), so a
// rejection with auth.json is the sign-in's; with no auth.json the key was
// used, and the member must fix or remove it (task 5e0917f3): no /clear hint,
// no sign-in commands.
describe("codexBackend after the engine rejected its credentials", () => {
  const signedOut = () =>
    codexBackend.getLoginInstructions({
      env: { CODEX_HOME: tempCodexHome(false), OPENAI_API_KEY: "" },
    });

  it("auth.json only: the signed-out walkthrough", async () => {
    const env = { CODEX_HOME: tempCodexHome(true), OPENAI_API_KEY: "" };
    expect(isCodexAuthenticated(env)).toBe(true);
    const r = await codexBackend.getLoginInstructions({
      env,
      credentialsRejected: true,
    });
    const expected = await signedOut();
    expect(expected.kind).toBe("login");
    expect(expected.commands?.length).toBeGreaterThan(0);
    expect(r).toEqual(expected);
  });

  it("auth.json on a typed /login: the /clear hint", async () => {
    const r = await codexBackend.getLoginInstructions({
      env: { OPENAI_API_KEY: "", CODEX_HOME: tempCodexHome(true) },
    });
    expect(r.kind).toBe("already_authed");
    expect(r.commands).toBeUndefined();
  });

  it("a rejected OPENAI_API_KEY with no auth.json: fix the key, with no /clear loop and no sign-in", async () => {
    const r = await codexBackend.getLoginInstructions({
      env: { OPENAI_API_KEY: "sk-test", CODEX_HOME: tempCodexHome(false) },
      credentialsRejected: true,
    });
    expect(r).toEqual({
      kind: "login",
      cardEligible: false,
      text: msg("systemEntries.loginInstructions.codexKeyRejected"),
    });
  });

  it("auth.json and an OPENAI_API_KEY: the sign-in was used, so the signed-out walkthrough", async () => {
    const r = await codexBackend.getLoginInstructions({
      env: { OPENAI_API_KEY: "sk-test", CODEX_HOME: tempCodexHome(true) },
      credentialsRejected: true,
    });
    const expected = await signedOut();
    expect(expected.cardEligible).toBe(true);
    expect(r).toEqual(expected);
  });

  // An empty CODEX_HOME is unset: the agent runs on the office Codex home
  // (withIsomuxCodexHome), so a sign-in there is what Codex used.
  it("an empty CODEX_HOME and a key: a sign-in in the office Codex home was used", async () => {
    const officeAuth = join(ISOMUX_CODEX_HOME, "auth.json");
    expect(existsSync(officeAuth)).toBe(false);
    expect(existsSync("auth.json")).toBe(false);
    mkdirSync(ISOMUX_CODEX_HOME, { recursive: true });
    writeFileSync(officeAuth, "{}");
    try {
      const r = await codexBackend.getLoginInstructions({
        env: { OPENAI_API_KEY: "sk-test", CODEX_HOME: "" },
        credentialsRejected: true,
      });
      expect(r).toEqual(await signedOut());
    } finally {
      rmSync(officeAuth);
    }
  });
});

describe("claudeBackend terminal sign-in", () => {
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "isomux-claude-login-"));
    tempDirs.push(dir);
    return dir;
  }

  it("runs the bundled binary when claude is not on PATH", async () => {
    const r = await claudeBackend.getLoginInstructions({
      env: { PATH: tempDir(), CLAUDE_CONFIG_DIR: tempDir() },
    });
    expect(r.kind).toBe("login");
    expect(r.commands).toHaveLength(1);
    expect(r.commands![0].replaceAll("'", "")).toBe(CLAUDE_NATIVE_BIN);
    // The /logout terminal fallback resolves the binary as sign-in does.
    const logout = claudeBackend.logoutCommand!({
      env: { PATH: tempDir(), CLAUDE_CONFIG_DIR: tempDir() },
    });
    expect(logout.replaceAll("'", "")).toBe(`${CLAUDE_NATIVE_BIN} auth logout`);
  });

  it("runs claude when it is on PATH", async () => {
    const bin = tempDir();
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(bin, "claude"), 0o755);
    const env = { PATH: bin, CLAUDE_CONFIG_DIR: tempDir() };
    const r = await claudeBackend.getLoginInstructions({ env });
    expect(r.kind).toBe("login");
    expect(r.commands).toEqual(["claude"]);
    expect(claudeBackend.logoutCommand!({ env })).toBe("claude auth logout");
  });
});

// The test preload sets ISOMUX_HOME, so the wrapper is not at
// ~/.isomux/bin/codex here: a hard-coded path fails this case.
describe("codexBackend terminal sign-out", () => {
  it("runs the wrapper that sign-in writes", () => {
    const command = codexBackend.logoutCommand!();
    const wrapper = codexWrapperCommandForShell();
    expect(wrapper.startsWith("~")).toBe(false);
    expect(command).toBe(`${wrapper} logout`);
    expect(existsSync(wrapper.replaceAll("'", ""))).toBe(true);
  });
});

// The sign-in walkthrough is written to the chat, where every reader of the
// agent sees it, so each backend returns it as a message each reader words
// (task c37a7365). The terminal command is a value in the sentence: a
// translation never changes the command it names.
describe("getLoginInstructions as a message", () => {
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "isomux-login-words-"));
    tempDirs.push(dir);
    return dir;
  }

  /** The instructions' text is one message, worded differently in Catalan. */
  function messageOf(instructions: LoginInstructions): LogMessage {
    const parts = logParts(instructions.text);
    expect(parts).toHaveLength(1);
    expect(typeof parts[0]).toBe("object");
    const english = renderLogText(translatorFor("en"), parts);
    const catalan = localizeLogParts(translatorFor("ca"), parts);
    expect(catalan).not.toBeNull();
    expect(catalan).not.toBe(english);
    return parts[0] as LogMessage;
  }

  it("claudeBackend, signed out: the walkthrough, with the command as a value", async () => {
    const env = { PATH: tempDir(), CLAUDE_CONFIG_DIR: tempDir() };
    const r = await claudeBackend.getLoginInstructions({ env });
    expect(r.kind).toBe("login");
    expect(Object.values(messageOf(r).params ?? {})).toContain(r.commands![0]);
  });

  it("claudeBackend, signed in: the /clear hint, with no command cards", async () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
    const r = await claudeBackend.getLoginInstructions({ env });
    expect(r.kind).toBe("already_authed");
    expect(r.commands).toBeUndefined();
    messageOf(r);
  });

  it("codexBackend, signed out: the walkthrough, with the command as a value", async () => {
    const env = { CODEX_HOME: tempCodexHome(false) };
    const r = await codexBackend.getLoginInstructions({ env });
    expect(r.kind).toBe("login");
    const command = r.commands![0];
    expect(
      Object.values(messageOf(r).params ?? {}).some(
        (value) =>
          typeof value === "string" &&
          value.length > 0 &&
          command.includes(value),
      ),
    ).toBe(true);
  });

  it("codexBackend, signed in: the /clear hint, with no command cards", async () => {
    const env = { OPENAI_API_KEY: "sk-test" };
    const r = await codexBackend.getLoginInstructions({ env });
    expect(r.kind).toBe("already_authed");
    expect(r.commands).toBeUndefined();
    messageOf(r);
  });

  it("opencodeBackend: the API key guidance", async () => {
    const r = await opencodeBackend.getLoginInstructions({});
    expect(r.kind).toBe("login");
    messageOf(r);
  });
});
