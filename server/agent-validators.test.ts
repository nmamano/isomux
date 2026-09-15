import { describe, expect, it } from "bun:test";
import {
  modelFamilyMismatchError,
  resolveInteractiveModelSelection,
  resolveAgentEngineSettings,
  validateCodexSandbox,
  validateCronjobPermissionMode,
  validateEffort,
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

describe("interactive model selection validation", () => {
  it("rejects a Claude-shaped model for Codex", () => {
    const result = resolveInteractiveModelSelection(
      "codex",
      "fable-5",
      "fable-5",
    );
    expect(result.error).toContain('"fable-5"');
  });

  it("accepts unknown Codex-shaped slugs but rejects Claude shapes case-insensitively", () => {
    for (const model of ["gpt-5.6-sol", "gpt-7-x"]) {
      expect(
        resolveInteractiveModelSelection("codex", model, model).error,
      ).toBeNull();
    }
    for (const model of ["claude-fable-5-1", "fable-5", "Opus-4"]) {
      expect(
        resolveInteractiveModelSelection("codex", model, model).error,
      ).not.toBeNull();
    }
  });

  it("requires a concrete model assertion to agree with its family", () => {
    expect(
      resolveInteractiveModelSelection("claude", "fable", "claude-fable-5")
        .error,
    ).toContain('resolves to model "claude-fable-5-1"');
    expect(
      resolveInteractiveModelSelection("claude", "fable", "claude-fable-5-1")
        .error,
    ).toBeNull();
    expect(
      resolveInteractiveModelSelection("codex", "gpt-5.6-sol", "gpt-5.6-sol")
        .error,
    ).toBeNull();
  });

  it("keeps runtime OpenCode IDs unchecked when no list is available", () => {
    expect(
      resolveInteractiveModelSelection(
        "opencode",
        "provider/runtime-model",
        "provider/runtime-model",
      ).error,
    ).toBeNull();
  });

  it("derives a family from model-only input", () => {
    expect(
      resolveInteractiveModelSelection("claude", undefined, "claude-fable-5-1"),
    ).toEqual({ modelFamily: "fable", error: null });
    expect(
      resolveInteractiveModelSelection("codex", undefined, "gpt-7-x"),
    ).toEqual({ modelFamily: "gpt-7-x", error: null });
    expect(
      resolveInteractiveModelSelection(
        "opencode",
        undefined,
        "provider/runtime-model",
      ),
    ).toEqual({ modelFamily: "provider/runtime-model", error: null });
  });
});

describe("OpenCode effort validation", () => {
  it("preserves an enum effort and rejects provider-specific names", () => {
    expect(validateEffort("opencode", "provider/model", "low")).toBe("low");
    expect(
      validateEffort(
        "opencode",
        "provider/model",
        "thinking" as Parameters<typeof validateEffort>[2],
      ),
    ).toBe("high");
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
