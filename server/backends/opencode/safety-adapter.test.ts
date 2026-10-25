import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { STATE_ROOT } from "../../config.ts";
import { SAFETY_WARNING } from "../codex/safety-hook.ts";
import {
  evaluateProposedAction,
  type ProposedAction,
} from "../../safety-policy.ts";
import {
  evaluateOpenCodePermission,
  type OpenCodePermissionEnvelope,
} from "./safety-adapter.ts";

// A permission.asked frame of @opencode/cli 2.1.4 (fixtures/v2): an action
// and its resources. A shell request names its command; an edit request
// names its files relative to the session's folder (task e47be82a).
function permission(
  overrides: Partial<OpenCodePermissionEnvelope> = {},
): OpenCodePermissionEnvelope {
  return {
    id: "per_1",
    sessionId: "ses_1",
    action: "shell",
    resources: ["printf safe"],
    metadata: {},
    ...overrides,
  };
}

const cwd = join(STATE_ROOT, "..", "opencode-safety-cwd");
// A path under Isomux state, written relative to the folder.
const stateFile = relative(cwd, join(STATE_ROOT, "users.json"));

describe("OpenCode safety adapter", () => {
  it("checks a shell request's command", () => {
    expect(evaluateOpenCodePermission(permission(), cwd)).toEqual({
      kind: "policy",
      decision: { decision: "allow" },
    });
    expect(
      evaluateOpenCodePermission(
        permission({ resources: ["git reset --hard"] }),
        cwd,
      ),
    ).toMatchObject({ kind: "policy", decision: { decision: "deny" } });
  });

  it("checks every file of an edit, resolved against the folder", () => {
    expect(
      evaluateOpenCodePermission(
        permission({ action: "edit", resources: ["notes.md"] }),
        cwd,
      ),
    ).toMatchObject({ kind: "policy", decision: { decision: "allow" } });
    const direct = evaluateProposedAction(
      {
        kind: "write-files",
        toolName: "write",
        input: { filepath: join(cwd, stateFile) },
      },
      { cwd },
    );
    expect(direct.decision).toBe("deny");
    // MUTANT: only the first file is checked.
    const result = evaluateOpenCodePermission(
      permission({ action: "edit", resources: ["notes.md", stateFile] }),
      cwd,
    );
    expect(result).toEqual({ kind: "policy", decision: direct });
  });

  it("reads an edit's files from its metadata when it names no resource", () => {
    const result = evaluateOpenCodePermission(
      permission({
        action: "edit",
        resources: [],
        metadata: { files: [{ file: stateFile, patch: "", status: "added" }] },
      }),
      cwd,
    );
    expect(result).toMatchObject({
      kind: "policy",
      decision: { decision: "deny" },
    });
  });

  it("fails open with the shared visible warning when a request names nothing to check", () => {
    for (const envelope of [
      permission({ resources: [] }),
      permission({ action: "edit", resources: [], metadata: {} }),
      permission({ action: undefined }),
      permission({ resources: "printf safe" }),
    ])
      expect(evaluateOpenCodePermission(envelope, cwd)).toEqual({
        kind: "fail_open",
        warning: SAFETY_WARNING,
      });
  });

  it("maps another action to the neutral uncovered kind", () => {
    const seen: ProposedAction[] = [];
    evaluateOpenCodePermission(
      permission({ action: "webfetch", resources: ["https://example.com"] }),
      cwd,
      (action, context) => {
        seen.push(action);
        return evaluateProposedAction(action, context);
      },
    );
    // The policy allows an uncovered tool whatever its input.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "uncovered-tool",
      toolName: "webfetch",
    });
  });

  it("fails open with the shared visible warning when evaluation throws", () => {
    expect(
      evaluateOpenCodePermission(permission(), cwd, () => {
        throw new Error("mutant evaluator fault");
      }),
    ).toEqual({ kind: "fail_open", warning: SAFETY_WARNING });
  });
});
