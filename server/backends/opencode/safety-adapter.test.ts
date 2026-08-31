import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { STATE_ROOT } from "../../config.ts";
import { SAFETY_WARNING } from "../codex/safety-hook.ts";
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
  it("maps the authoritative full bash command instead of patterns", () => {
    expect(
      openCodePermissionToAction(
        permission({
          patterns: ["printf safe"],
          metadata: { command: "git reset --hard" },
        }),
      ),
    ).toEqual({ kind: "shell", command: "git reset --hard" });
    expect(
      evaluateOpenCodePermission(
        permission({ metadata: { command: "git reset --hard" } }),
        "/tmp",
      ),
    ).toMatchObject({ kind: "policy", decision: { decision: "deny" } });
  });

  it("maps edit from the absolute metadata filepath and protects state", () => {
    const filepath = `${STATE_ROOT}/protected.json`;
    expect(
      openCodePermissionToAction(
        permission({
          permission: "edit",
          patterns: ["protected.json"],
          metadata: { filepath },
        }),
      ),
    ).toEqual({
      kind: "write-files",
      toolName: "write",
      input: { filepath },
    });
    expect(
      evaluateOpenCodePermission(
        permission({ permission: "edit", metadata: { filepath } }),
        "/tmp",
      ),
    ).toMatchObject({ kind: "policy", decision: { decision: "deny" } });
  });

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
    expect(relativeResult.decision.reason).toContain(
      "Writing to ~/.isomux/ is not allowed",
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

  it("fails open with the shared visible warning on an unknown shape", () => {
    expect(
      evaluateOpenCodePermission(
        permission({ permission: undefined, metadata: undefined }),
        "/tmp",
      ),
    ).toEqual({ kind: "fail_open", warning: SAFETY_WARNING });
  });

  it("fails open with the shared visible warning when evaluation throws", () => {
    expect(
      evaluateOpenCodePermission(permission(), "/tmp", () => {
        throw new Error("mutant evaluator fault");
      }),
    ).toEqual({ kind: "fail_open", warning: SAFETY_WARNING });
  });
});
