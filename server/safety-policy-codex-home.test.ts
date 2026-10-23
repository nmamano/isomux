// A member may point CODEX_HOME at a directory of any name (task be7f9436).
// The backend credential list matches the Codex login only by its known
// directory shapes, because auth.json is a generic name. So the login in a
// custom home is matched by path, from the CODEX_HOME the agent runs with:
// directly, relative to the cwd, through $CODEX_HOME in a shell line, and
// through a symlink. An auth.json anywhere else stays readable.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  evaluateProposedAction,
  type PolicyContext,
  type PolicyDecision,
} from "./safety-policy.ts";
import { handleCodexHookInput } from "./backends/codex/safety-hook.ts";

const root = mkdtempSync(join(tmpdir(), "codex-home-policy-"));
// A name that none of the known shapes (.codex, codex-home,
// provider-homes/<id>/codex) match.
const home = join(root, "my-codex");
const login = join(home, "auth.json");
const project = join(root, "project");
const localeAuth = join(project, "locales", "en", "auth.json");
const link = join(project, "notes.json");
mkdirSync(home);
mkdirSync(join(project, "locales", "en"), { recursive: true });
writeFileSync(login, "{}");
writeFileSync(localeAuth, "{}");
symlinkSync(login, link);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ctx: PolicyContext = { cwd: project, codexHome: home };
const read = (path: string, context: PolicyContext = ctx): PolicyDecision =>
  evaluateProposedAction(
    { kind: "read-files", toolName: "Read", input: { file_path: path } },
    context,
  );
const shell = (command: string, context: PolicyContext = ctx): PolicyDecision =>
  evaluateProposedAction({ kind: "shell", command }, context);

describe("the login in a custom CODEX_HOME", () => {
  it("is refused by direct path, relative path, $CODEX_HOME and symlink", () => {
    const cases: [string, PolicyDecision][] = [
      ["Read, absolute", read(login)],
      ["cat, absolute", shell(`cat ${login}`)],
      ["cat, relative", shell("cat auth.json", { cwd: home, codexHome: home })],
      ["cat, quoted $CODEX_HOME", shell('cat "$CODEX_HOME/auth.json"')],
      ["cat, $CODEX_HOME", shell("cat $CODEX_HOME/auth.json")],
      ["cat, ${CODEX_HOME}", shell("cat ${CODEX_HOME}/auth.json")],
      ["Read, symlink", read(link)],
      ["cat, symlink", shell("cat notes.json")],
      [
        "Read, padded CODEX_HOME",
        read(login, { cwd: project, codexHome: ` ${home} ` }),
      ],
    ];
    // One comparison, so a red run names every case that passed through.
    expect(cases.map(([name, d]) => [name, d.decision])).toEqual(
      cases.map(([name]) => [name, "deny"]),
    );
  });

  it("leaves an auth.json outside the home readable", () => {
    expect(read(localeAuth).decision).toBe("allow");
    expect(shell("cat locales/en/auth.json").decision).toBe("allow");
  });

  it("is matched only through the agent's CODEX_HOME", () => {
    // The refusals above come from codexHome: without it, or with a value
    // that is not an absolute path, the same reads pass as before.
    for (const context of [
      { cwd: project },
      { cwd: project, codexHome: null },
      { cwd: project, codexHome: "" },
      { cwd: project, codexHome: "  " },
      { cwd: project, codexHome: "my-codex" },
      { cwd: project, codexHome: "./my-codex" },
    ]) {
      expect(read(login, context).decision).toBe("allow");
      expect(shell(`cat ${login}`, context).decision).toBe("allow");
    }
  });
});

describe("the Codex hook entry", () => {
  // Codex runs the hook with the app-server env (probe, Codex 0.160.0,
  // 2026-10-19), so the hook takes CODEX_HOME from its own process env.
  const envelope = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: `cat ${login}` },
    cwd: project,
  });
  const decisionOf = (out: ReturnType<typeof handleCodexHookInput>) =>
    "hookSpecificOutput" in out
      ? out.hookSpecificOutput.permissionDecision
      : "allow";

  it("refuses the login in the CODEX_HOME it runs with", () => {
    const prev = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = home;
      expect(decisionOf(handleCodexHookInput(envelope))).toBe("deny");
      delete process.env.CODEX_HOME;
      expect(decisionOf(handleCodexHookInput(envelope))).toBe("allow");
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});
