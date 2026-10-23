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
  // [case, engine, raw input, expected fields]
  it.each([
    [
      "an empty Codex input gets never with full access",
      "codex",
      {},
      { permissionMode: "never", codexSandbox: "danger-full-access" },
    ],
    [
      "an explicit valid Codex mode is kept and only the sandbox is filled",
      "codex",
      { permissionMode: "on-request" },
      { permissionMode: "on-request", codexSandbox: "danger-full-access" },
    ],
    [
      "an empty Claude input gets auto and no sandbox",
      "claude",
      {},
      { permissionMode: "auto", codexSandbox: undefined },
    ],
    [
      "an omitted OpenCode permission defaults to bypass",
      "opencode",
      { modelFamily: "provider/model" },
      {
        modelFamily: "provider/model",
        effort: "high",
        permissionMode: "bypassPermissions",
        codexSandbox: undefined,
      },
    ],
    [
      "an explicit OpenCode Ask is not widened",
      "opencode",
      { modelFamily: "provider/model", permissionMode: "default" },
      { permissionMode: "default" },
    ],
    [
      "an OpenCode input with no model keeps an empty family",
      "opencode",
      {},
      { modelFamily: "", permissionMode: "bypassPermissions" },
    ],
  ] as const)("%s", (_case, engine, raw, expected) => {
    expect(resolveAgentEngineSettings(engine, raw)).toMatchObject(expected);
  });

  it("is idempotent", () => {
    const once = resolveAgentEngineSettings("codex", {});
    expect(resolveAgentEngineSettings("codex", once)).toEqual(once);
  });
});

describe("OpenCode model validation", () => {
  it("accepts composite provider/model IDs and rejects a missing, bare or tracer model", () => {
    expect(modelFamilyMismatchError("opencode", "provider/model")).toBeNull();
    for (const raw of [undefined, "opus", "opencode/fake"])
      expect(modelFamilyMismatchError("opencode", raw)).not.toBeNull();
  });
});

describe("interactive model selection validation", () => {
  it("accepts unknown Codex-shaped slugs but rejects Claude families and shapes case-insensitively", () => {
    for (const model of ["gpt-5.6-sol", "gpt-7-x"]) {
      expect(
        resolveInteractiveModelSelection("codex", model, model).error,
      ).toBeNull();
    }
    for (const model of ["opus", "claude-fable-5-1", "fable-5", "Opus-4"]) {
      expect(
        resolveInteractiveModelSelection("codex", model, model).error,
      ).not.toBeNull();
    }
  });

  it("requires a concrete model assertion to agree with its family", () => {
    expect(
      resolveInteractiveModelSelection("claude", "fable", "claude-fable-5")
        .error,
    ).not.toBeNull();
    expect(
      resolveInteractiveModelSelection("claude", "fable", "claude-fable-5-1")
        .error,
    ).toBeNull();
    expect(
      resolveInteractiveModelSelection("codex", "gpt-5.6-sol", "gpt-5.6-sol")
        .error,
    ).toBeNull();
  });

  it("derives a family from model-only input", () => {
    expect(
      resolveInteractiveModelSelection("claude", undefined, "claude-fable-5-1"),
    ).toEqual({ modelFamily: "fable", error: null });
    expect(
      resolveInteractiveModelSelection("codex", undefined, "gpt-7-x"),
    ).toEqual({ modelFamily: "gpt-7-x", error: null });
    // A runtime OpenCode ID stays unchecked when no list is available.
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

  const full = { permissionMode: "never", codexSandbox: "danger-full-access" };
  const bypass = { permissionMode: "bypassPermissions" };
  const auto = { permissionMode: "auto" };
  // [spawner engine, child engine, child mode for each spawner mode]
  it.each([
    // auto and bypass carry over; prompting modes become auto.
    [
      "claude",
      "claude",
      { default: auto, acceptEdits: auto, bypassPermissions: bypass, auto },
    ],
    [
      "claude",
      "codex",
      { default: full, acceptEdits: full, bypassPermissions: full, auto: full },
    ],
    // The 2026-08-30 OpenCode default stays.
    [
      "claude",
      "opencode",
      {
        default: bypass,
        acceptEdits: bypass,
        bypassPermissions: bypass,
        auto: bypass,
      },
    ],
    ["codex", "claude", { untrusted: auto, "on-request": auto, never: auto }],
    // never carries over with the spawner's sandbox.
    [
      "codex",
      "codex",
      {
        untrusted: full,
        "on-request": full,
        never: { permissionMode: "never", codexSandbox: "read-only" },
      },
    ],
    [
      "codex",
      "opencode",
      { untrusted: bypass, "on-request": bypass, never: bypass },
    ],
    // bypass carries over; Ask becomes auto.
    ["opencode", "claude", { default: auto, bypassPermissions: bypass }],
    ["opencode", "codex", { default: full, bypassPermissions: full }],
    ["opencode", "opencode", { default: bypass, bypassPermissions: bypass }],
  ] as const)("%s -> %s", (from, to, expected) => {
    expect(childModes(from, to)).toEqual(expected);
  });
});
