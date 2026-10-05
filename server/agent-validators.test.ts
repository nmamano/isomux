import { describe, expect, it } from "bun:test";
import {
  modelFamilyMismatchError,
  resolveInteractiveModelSelection,
  resolveAgentEngineSettings,
  spawnedAgentMode,
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

// Task a7bdd069: one test per row of SPAWN_MODE_CARRY_OVER. Expectations are
// written out, not read from the table.
describe("spawnedAgentMode", () => {
  const modes = {
    claude: ["default", "acceptEdits", "bypassPermissions", "auto"],
    codex: ["untrusted", "on-request", "never"],
    opencode: ["default", "bypassPermissions"],
  } as const;
  type Engine = keyof typeof modes;
  function childModes(from: Engine, to: Engine): Record<string, unknown> {
    return Object.fromEntries(
      modes[from].map((m) => [
        m,
        spawnedAgentMode(
          {
            agentType: from,
            permissionMode: m,
            codexSandbox: from === "codex" ? "read-only" : undefined,
          },
          to,
        ),
      ]),
    );
  }

  it("claude -> claude: auto and bypass carry over; prompting modes become auto", () => {
    expect(childModes("claude", "claude")).toEqual({
      default: { permissionMode: "auto" },
      acceptEdits: { permissionMode: "auto" },
      bypassPermissions: { permissionMode: "bypassPermissions" },
      auto: { permissionMode: "auto" },
    });
  });

  it("claude -> codex: always never with full access", () => {
    const full = { permissionMode: "never", codexSandbox: "danger-full-access" };
    expect(childModes("claude", "codex")).toEqual({
      default: full,
      acceptEdits: full,
      bypassPermissions: full,
      auto: full,
    });
  });

  it("claude -> opencode: always bypass (the 2026-08-30 default stays)", () => {
    const bypass = { permissionMode: "bypassPermissions" };
    expect(childModes("claude", "opencode")).toEqual({
      default: bypass,
      acceptEdits: bypass,
      bypassPermissions: bypass,
      auto: bypass,
    });
  });

  it("codex -> claude: always auto", () => {
    const auto = { permissionMode: "auto" };
    expect(childModes("codex", "claude")).toEqual({
      untrusted: auto,
      "on-request": auto,
      never: auto,
    });
  });

  it("codex -> codex: never carries over with the spawner's sandbox; prompting modes become never with full access", () => {
    const full = { permissionMode: "never", codexSandbox: "danger-full-access" };
    expect(childModes("codex", "codex")).toEqual({
      untrusted: full,
      "on-request": full,
      never: { permissionMode: "never", codexSandbox: "read-only" },
    });
  });

  it("codex -> opencode: always bypass", () => {
    const bypass = { permissionMode: "bypassPermissions" };
    expect(childModes("codex", "opencode")).toEqual({
      untrusted: bypass,
      "on-request": bypass,
      never: bypass,
    });
  });

  it("opencode -> claude: bypass carries over; Ask becomes auto", () => {
    expect(childModes("opencode", "claude")).toEqual({
      default: { permissionMode: "auto" },
      bypassPermissions: { permissionMode: "bypassPermissions" },
    });
  });

  it("opencode -> codex: always never with full access", () => {
    const full = { permissionMode: "never", codexSandbox: "danger-full-access" };
    expect(childModes("opencode", "codex")).toEqual({
      default: full,
      bypassPermissions: full,
    });
  });

  it("opencode -> opencode: always bypass", () => {
    const bypass = { permissionMode: "bypassPermissions" };
    expect(childModes("opencode", "opencode")).toEqual({
      default: bypass,
      bypassPermissions: bypass,
    });
  });
});
