import { afterEach, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import { resolveClaudeSessionRoot } from "./claude-session-root.ts";
import { claudeProjectDir, diagnoseProcessExit } from "./cwd-utils.ts";
import { personalProviderHome } from "./provider-homes.ts";
import {
  ensureSessionClaudeConfigDir,
  getSessionClaudeConfigDir,
  ensureSessionCwd,
  loadSessionsMap,
  listAgentSessions,
} from "./persistence.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./test-support/managed-office-env.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import { renderLogText } from "../shared/i18n/log-message.ts";
import { LocalizedError } from "./localized-error.ts";

afterEach(clearTestManagedOfficeEnv);
function fixture() {
  const user = `root-${crypto.randomUUID()}`,
    session = crypto.randomUUID();
  const cwd = join(STATE_ROOT, user),
    office = join(cwd, "office"),
    current = join(cwd, "current");
  mkdirSync(cwd, { recursive: true });
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: office });
  const write = (root: string) => {
    const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: root });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${session}.jsonl`), "{}\n");
  };
  return { user, session, cwd, office, current, write };
}
it("legacy root discovery checks current, office, then only the owner's personal home", () => {
  const f = fixture(),
    personal = personalProviderHome(f.user, "claude");
  f.write(personal);
  const find = () =>
    resolveClaudeSessionRoot(
      f.session,
      f.cwd,
      { CLAUDE_CONFIG_DIR: f.current },
      undefined,
      f.user,
    );
  expect(find()).toBe(personal);
  f.write(f.office);
  expect(find()).toBe(f.office);
  f.write(f.current);
  expect(find()).toBe(f.current);
  expect(
    resolveClaudeSessionRoot(
      f.session,
      f.cwd,
      { CLAUDE_CONFIG_DIR: f.current },
      f.office,
      f.user,
    ),
  ).toBe(f.office);
});
it("keeps legacy metadata compatible, stamps the launch root once, and keeps it off the wire", () => {
  const f = fixture();
  ensureSessionCwd(f.user, f.session, f.cwd);
  expect(getSessionClaudeConfigDir(f.user, f.session)).toBeUndefined();
  const modified = loadSessionsMap(f.user)[f.session].lastModified;
  expect(ensureSessionClaudeConfigDir(f.user, f.session, f.office)).toBe(
    f.office,
  );
  expect(ensureSessionClaudeConfigDir(f.user, f.session, f.current)).toBe(
    f.office,
  );
  expect(loadSessionsMap(f.user)[f.session].claudeConfigDir).toBe(f.office);
  expect(loadSessionsMap(f.user)[f.session].lastModified).toBe(modified);
  writeFileSync(join(STATE_ROOT, "logs", f.user, `${f.session}.jsonl`), "{}\n");
  expect(listAgentSessions(f.user)).toHaveLength(1);
  expect(JSON.stringify(listAgentSessions(f.user))).not.toContain(
    "claudeConfigDir",
  );
});
it("missing legacy files name all checked paths without checking another user's home", () => {
  const f = fixture();
  f.write(personalProviderHome("other-owner", "claude"));
  // The error carries its message for the log (task c37a7365); each
  // language's render names the paths.
  let thrown: unknown;
  try {
    resolveClaudeSessionRoot(
      f.session,
      f.cwd,
      { CLAUDE_CONFIG_DIR: f.current },
      undefined,
      f.user,
    );
  } catch (caught) {
    thrown = caught;
  }
  expect(thrown).toBeInstanceOf(LocalizedError);
  for (const language of ["en", "es", "ca"] as const) {
    const error = renderLogText(
      translatorFor(language),
      (thrown as LocalizedError).logMessage,
    );
    for (const root of [
      f.current,
      f.office,
      personalProviderHome(f.user, "claude"),
    ]) {
      expect(error).toContain(
        join(
          claudeProjectDir(f.cwd, { CLAUDE_CONFIG_DIR: root }),
          `${f.session}.jsonl`,
        ),
      );
    }
    expect(error).not.toContain("other-owner");
    expect(error).not.toContain("moved");
    expect(error).not.toContain("renamed");
  }
  const exitHint = renderLogText(
    translatorFor("en"),
    diagnoseProcessExit(f.cwd, f.session, { CLAUDE_CONFIG_DIR: f.current })!,
  );
  expect(exitHint).toContain(f.current);
  expect(exitHint).not.toContain("moved");
});
