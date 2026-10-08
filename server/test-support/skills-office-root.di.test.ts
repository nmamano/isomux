// The office Claude root reaches the skills page on every engine, with or
// without a personal Claude account (Isomux PM ruling, 2026-10-08). With a
// custom office CLAUDE_CONFIG_DIR, a skill the page creates goes there, and
// the creating member's catalog lists it before and after their personal
// account is active. Before the fix, the production Claude source root was
// fixed to ~/.claude, so a personal account dropped the office root from all
// three catalogs (Reviewer 4's office-root probe).

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createProductionAgentManager } from "../agent-manager.ts";
import { managedOfficeEnvPath, writeManagedOfficeEnv } from "../user-env.ts";
import { setPersonalProviderActiveProvider } from "../env-loader.ts";
import { buildSkillCatalog, createSkill } from "../skill-catalog.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

describe("skills page and the office Claude root", () => {
  it("lists a skill created in a custom office root on every engine, with and without a personal Claude account", () => {
    const envPath = managedOfficeEnvPath();
    const previousEnv = existsSync(envPath)
      ? readFileSync(envPath, "utf8")
      : null;
    cleanup.push(() => {
      if (previousEnv === null) rmSync(envPath, { force: true });
      else writeFileSync(envPath, previousEnv);
    });
    const officeRoot = mkdtempSync(join(tmpdir(), "isomux-office-claude-"));
    cleanup.push(() => rmSync(officeRoot, { recursive: true, force: true }));
    writeManagedOfficeEnv({ CLAUDE_CONFIG_DIR: officeRoot });

    const mgr = createProductionAgentManager();
    expect(mgr.newSkillDir()).toBe(join(officeRoot, "skills"));
    const name = "office-root-check";
    expect(
      createSkill(mgr.newSkillDir(), {
        name,
        description: "fixture",
        instructions: "fixture body",
      }).kind,
    ).toBe("ok");

    const seen = () =>
      buildSkillCatalog(
        mgr.skillEngineContexts("fixture-member", () => true),
        {},
        mgr.newSkillDir(),
        "/home",
      ).engines.map((e): [string, boolean] => [
        e.engine,
        e.skills.some((s) => s.name === name),
      ]);
    const everywhere: [string, boolean][] = [
      ["claude", true],
      ["codex", true],
      ["opencode", true],
    ];
    expect(seen()).toEqual(everywhere);

    const previous = setPersonalProviderActiveProvider(
      (userId, provider) =>
        userId === "fixture-member" && provider === "claude",
    );
    cleanup.push(() => setPersonalProviderActiveProvider(previous));
    expect(seen()).toEqual(everywhere);
  });
});
