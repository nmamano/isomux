import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { STATE_ROOT } from "../../config.ts";
import { SAFETY_WARNING } from "../codex/safety-hook.ts";
import { evaluateProposedAction } from "../../safety-policy.ts";
import {
  evaluateOpenCodePermission,
  openCodePermissionToAction,
  type OpenCodePermissionEnvelope,
} from "./safety-adapter.ts";

function permission(
  overrides: Partial<OpenCodePermissionEnvelope> = {},
): OpenCodePermissionEnvelope {
  return {
    id: "permission-1",
    sessionId: "session-1",
    permission: "bash",
    patterns: ["not authoritative"],
    metadata: { command: "printf safe" },
    ...overrides,
  };
}

describe("OpenCode safety adapter", () => {
  it("fails open when edit metadata has no readable filepath", () => {
    expect(
      evaluateOpenCodePermission(
        permission({ permission: "edit", metadata: {} }),
        "/tmp",
      ),
    ).toEqual({ kind: "fail_open", warning: SAFETY_WARNING });
  });

  it("resolves a relative edit filepath and preserves the policy reason", () => {
    const cwd = join(STATE_ROOT, "..", "opencode-safety-cwd");
    expect(
      evaluateOpenCodePermission(
        permission({
          permission: "edit",
          metadata: { filepath: "notes.md" },
        }),
        cwd,
      ),
    ).toMatchObject({ kind: "policy", decision: { decision: "allow" } });
    const relativeResult = evaluateOpenCodePermission(
      permission({
        permission: "edit",
        metadata: { filepath: relative(cwd, join(STATE_ROOT, "users.json")) },
      }),
      cwd,
    );
    expect(relativeResult).toMatchObject({
      kind: "policy",
      decision: { decision: "deny" },
    });
    if (
      relativeResult.kind !== "policy" ||
      relativeResult.decision.decision !== "deny"
    ) {
      throw new Error("expected the relative state path to be denied");
    }
    const direct = evaluateProposedAction(
      {
        kind: "write-files",
        toolName: "write",
        input: { filepath: relative(cwd, join(STATE_ROOT, "users.json")) },
      },
      { cwd },
    );
    expect(direct.decision).toBe("deny");
    expect(relativeResult.decision.reason).toBe(
      direct.decision === "deny" ? direct.reason : "",
    );
  });

  it("maps other named permissions to the neutral uncovered kind", () => {
    expect(
      openCodePermissionToAction(
        permission({ permission: "task", metadata: { description: "x" } }),
      ),
    ).toEqual({
      kind: "uncovered-tool",
      toolName: "task",
      input: { description: "x" },
    });
  });

  it("fails open with the shared visible warning when evaluation throws", () => {
    expect(
      evaluateOpenCodePermission(permission(), "/tmp", () => {
        throw new Error("mutant evaluator fault");
      }),
    ).toEqual({ kind: "fail_open", warning: SAFETY_WARNING });
  });
});
