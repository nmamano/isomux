import { describe, expect, it } from "bun:test";
import {
  modelFamilyMismatchError,
  resolveAgentEngineSettings,
  validateCodexSandbox,
  validateCronjobPermissionMode,
  validatePermissionMode,
} from "./agent-validators.ts";

describe("validateCodexSandbox", () => {
  it("leaves an absent raw value undefined for non-agent consumers", () => {
    expect(validateCodexSandbox(undefined)).toBeUndefined();
    expect(
      validateCodexSandbox(
        "garbage" as Parameters<typeof validateCodexSandbox>[0],
      ),
    ).toBeUndefined();
  });
});

describe("resolveAgentEngineSettings", () => {
  it("defaults an omitted OpenCode permission to bypass without widening explicit Ask", () => {
    expect(resolveAgentEngineSettings("codex", {})).toMatchObject({
      permissionMode: "never",
      codexSandbox: "danger-full-access",
    });
    expect(resolveAgentEngineSettings("claude", {})).toMatchObject({
      permissionMode: "auto",
      codexSandbox: undefined,
    });
    expect(
      resolveAgentEngineSettings("opencode", {
        modelFamily: "provider/model",
      }),
    ).toMatchObject({
      modelFamily: "provider/model",
      effort: "high",
      permissionMode: "bypassPermissions",
      codexSandbox: undefined,
    });
    expect(
      resolveAgentEngineSettings("opencode", {
        modelFamily: "provider/model",
        permissionMode: "default",
      }).permissionMode,
    ).toBe("default");
  });

  it("preserves an explicit valid Codex choice and fills only absent values", () => {
    expect(
      resolveAgentEngineSettings("codex", {
        permissionMode: "on-request",
      }),
    ).toMatchObject({
      permissionMode: "on-request",
      codexSandbox: "danger-full-access",
    });
  });

  it("is idempotent", () => {
    const once = resolveAgentEngineSettings("codex", {});
    expect(resolveAgentEngineSettings("codex", once)).toEqual(once);
  });
});

describe("OpenCode model validation", () => {
  it("accepts composite provider/model IDs and rejects other families", () => {
    expect(modelFamilyMismatchError("opencode", "provider/model")).toBeNull();
    expect(modelFamilyMismatchError("opencode", "opus")).toContain(
      "provider/model",
    );
    expect(modelFamilyMismatchError("opencode", undefined)).toContain(
      "requires",
    );
    expect(modelFamilyMismatchError("opencode", "opencode/fake")).toContain(
      "not available",
    );
    expect(resolveAgentEngineSettings("opencode", {})).toMatchObject({
      modelFamily: "",
      permissionMode: "bypassPermissions",
    });
  });
});

describe("OpenCode permission validation", () => {
  it("keeps explicit Ask while invalid input takes the new default", () => {
    expect(validatePermissionMode("opencode", "default")).toBe("default");
    expect(validatePermissionMode("opencode", "never")).toBe(
      "bypassPermissions",
    );
  });

  it("preserves the explicit interactive bypass mode", () => {
    expect(validatePermissionMode("opencode", "bypassPermissions")).toBe(
      "bypassPermissions",
    );
  });
});

describe("OpenCode cron validation", () => {
  it("uses the fixed unattended permission mode", () => {
    expect(validateCronjobPermissionMode("opencode", undefined)).toBe(
      "bypassPermissions",
    );
    expect(validateCronjobPermissionMode("opencode", "default")).toBe(
      "bypassPermissions",
    );
  });
});
