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
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { claudeBackend } from "./claude.ts";
import { codexBackend } from "./codex/adapter.ts";
import {
  codexWrapperCommandForShell,
  isCodexAuthenticated,
} from "./codex/native-bin.ts";
import { CLAUDE_NATIVE_BIN } from "../cwd-utils.ts";
import { opencodeBackend } from "./opencode/adapter.ts";
import type { LoginInstructions } from "./types.ts";
import type { Translator } from "../../shared/i18n/translate.ts";
import { callFor, render, spyWords } from "../test-support/spy-words.ts";

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

describe("getLoginInstructions - already-authed short-circuit", () => {
  it("claudeBackend: ANTHROPIC_API_KEY in env -> /clear hint, no command cards", async () => {
    const r = await claudeBackend.getLoginInstructions({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    });
    expect(r.commands).toBeUndefined();
    expect(r.text).toMatch(/\/clear/i);
  });

  it("codexBackend: OPENAI_API_KEY in env -> /clear hint, no command cards", async () => {
    const r = await codexBackend.getLoginInstructions({
      env: { OPENAI_API_KEY: "sk-test" },
    });
    expect(r.commands).toBeUndefined();
    expect(r.text).toMatch(/\/clear/i);
  });
});

// A dead Codex refresh token leaves auth.json on disk (task 1403b454). Once
// Codex has rejected it, auth.json is no proof of a sign-in: the member gets
// the same walkthrough as a signed-out one. An env key and a typed /login keep
// the /clear hint.
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

  for (const [name, env, credentialsRejected] of [
    ["auth.json on a typed /login", { OPENAI_API_KEY: "" }, undefined],
    ["OPENAI_API_KEY", { OPENAI_API_KEY: "sk-test" }, true],
  ] as const) {
    it(`${name}: the /clear hint`, async () => {
      const r = await codexBackend.getLoginInstructions({
        env: { ...env, CODEX_HOME: tempCodexHome(true) },
        credentialsRejected,
      });
      expect(r.kind).toBe("already_authed");
      expect(r.commands).toBeUndefined();
    });
  }
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
    expect(r.text).toContain(r.commands![0]);
  });

  // The /logout terminal fallback resolves the binary as sign-in does.
  it("signs out with the bundled binary when claude is not on PATH", () => {
    const command = claudeBackend.logoutCommand!({
      env: { PATH: tempDir(), CLAUDE_CONFIG_DIR: tempDir() },
    });
    expect(command.replaceAll("'", "")).toBe(
      `${CLAUDE_NATIVE_BIN} auth logout`,
    );
  });

  it("signs out with claude when it is on PATH", () => {
    const bin = tempDir();
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(bin, "claude"), 0o755);
    const command = claudeBackend.logoutCommand!({
      env: { PATH: bin, CLAUDE_CONFIG_DIR: tempDir() },
    });
    expect(command).toBe("claude auth logout");
  });

  it("runs claude when it is on PATH", async () => {
    const bin = tempDir();
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(bin, "claude"), 0o755);
    const r = await claudeBackend.getLoginInstructions({
      env: { PATH: bin, CLAUDE_CONFIG_DIR: tempDir() },
    });
    expect(r.kind).toBe("login");
    expect(r.commands).toEqual(["claude"]);
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

// The sign-in walkthrough is written to the chat for a person, so each
// backend words it in the reader's language when the caller passes words,
// and in English when it does not (task beb6089b). The terminal command is a
// value in the sentence: a translation never changes the command it names.
describe("getLoginInstructions in the reader's words", () => {
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "isomux-login-words-"));
    tempDirs.push(dir);
    return dir;
  }

  async function wordedAndEnglish(
    get: (words?: Translator["t"]) => Promise<LoginInstructions>,
  ) {
    const { t, calls } = spyWords();
    const worded = await get(t);
    const english = await get();
    const call = callFor(calls, worded.text);
    expect(call).toBeDefined();
    expect(english.text).toBe(render("en", call!));
    // The words change the text only: the kind and the cards stay.
    expect(worded.kind).toBe(english.kind);
    expect(worded.commands).toEqual(english.commands);
    return { worded, call: call! };
  }

  it("claudeBackend, signed out: the walkthrough, with the command as a value", async () => {
    const env = { PATH: tempDir(), CLAUDE_CONFIG_DIR: tempDir() };
    const { worded, call } = await wordedAndEnglish((words) =>
      claudeBackend.getLoginInstructions({ env, words }),
    );
    expect(worded.kind).toBe("login");
    expect(Object.values(call.params ?? {})).toContain(worded.commands![0]);
  });

  it("claudeBackend, signed in: the /clear hint", async () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
    const { worded } = await wordedAndEnglish((words) =>
      claudeBackend.getLoginInstructions({ env, words }),
    );
    expect(worded.kind).toBe("already_authed");
  });

  it("codexBackend, signed out: the walkthrough, with the command as a value", async () => {
    const env = { CODEX_HOME: tempCodexHome(false) };
    const { worded, call } = await wordedAndEnglish((words) =>
      codexBackend.getLoginInstructions({ env, words }),
    );
    expect(worded.kind).toBe("login");
    const command = worded.commands![0];
    expect(
      Object.values(call.params ?? {}).some(
        (value) => String(value).length > 0 && command.includes(String(value)),
      ),
    ).toBe(true);
  });

  it("codexBackend, signed in: the /clear hint", async () => {
    const env = { OPENAI_API_KEY: "sk-test" };
    const { worded } = await wordedAndEnglish((words) =>
      codexBackend.getLoginInstructions({ env, words }),
    );
    expect(worded.kind).toBe("already_authed");
  });

  it("opencodeBackend: the API key guidance", async () => {
    const { worded } = await wordedAndEnglish((words) =>
      opencodeBackend.getLoginInstructions({ words }),
    );
    expect(worded.kind).toBe("login");
  });
});
