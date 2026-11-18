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
import { FAMILY_TO_MODEL } from "../shared/types.ts";

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
      "an empty Claude input gets bypass and no sandbox",
      "claude",
      {},
      { permissionMode: "bypassPermissions", codexSandbox: undefined },
    ],
    // A restored agent keeps its stored Auto (task f49289bd).
    [
      "a stored Claude auto is kept",
      "claude",
      { modelFamily: "opus", permissionMode: "auto" },
      { permissionMode: "auto" },
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
      resolveInteractiveModelSelection("claude", "fable", FAMILY_TO_MODEL.fable)
        .error,
    ).toBeNull();
    expect(
      resolveInteractiveModelSelection("codex", "gpt-5.6-sol", "gpt-5.6-sol")
        .error,
    ).toBeNull();
  });

  it("derives a family from model-only input", () => {
    expect(
      resolveInteractiveModelSelection(
        "claude",
        undefined,
        FAMILY_TO_MODEL.fable,
      ),
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

// A model of another engine must name the engine to switch to, so a caller
// that sent a Codex agent "opus" learns to send agentType with it instead of
// concluding the engine cannot change (task 45a9040b). The hint is read as
// the protocol value after agentType, not as copy.
describe("model of another engine points to agentType", () => {
  const ENGINE_HINT = /\bagentType\b[^"]*"(claude|codex|opencode)"/;
  const hintedEngine = (message: string | null): string | null => {
    if (message === null) throw new Error("expected a rejection");
    return ENGINE_HINT.exec(message)?.[1] ?? null;
  };

  it("names the engine a rejected value belongs to, through every entry", () => {
    const cases: [string, string | null, string | null, string | null][] = [
      // [target engine, modelFamily, model, engine the hint names]
      ["codex", "opus", null, "claude"],
      ["codex", "Opus-4", null, "claude"],
      ["codex", "claude-fable-5-1", null, "claude"],
      ["codex", "fable-5", null, "claude"],
      ["codex", null, "claude-opus-4-5", "claude"],
      ["opencode", "opus", null, "claude"],
      ["opencode", "claude-opus-4-5", null, "claude"],
      ["claude", "gpt-5.5", null, "codex"],
      ["claude", "anthropic/claude-opus-4-5", null, "opencode"],
      // An unknown Claude-shaped family is no other engine's model.
      ["claude", "claude-opus-4-5", null, null],
      ["claude", null, "gpt-5.5", "codex"],
      ["claude", null, "openai/gpt-5", "opencode"],
    ];
    // One compare over every row, so a red run lists each wrong row.
    const got = cases.map(([engine, family, model]) => [
      engine,
      family,
      model,
      hintedEngine(
        resolveInteractiveModelSelection(
          engine as "claude" | "codex" | "opencode",
          family ?? undefined,
          model ?? undefined,
        ).error,
      ),
    ]);
    expect(got).toStrictEqual(cases);
  });

  it("an unmapped Claude model ID points to modelFamily, not to another engine", () => {
    const { error } = resolveInteractiveModelSelection(
      "claude",
      undefined,
      "claude-fable-5",
    );
    expect(hintedEngine(error)).toBeNull();
    expect(error).toContain("modelFamily");
  });

  it("accepts each engine's own values as before", () => {
    expect(modelFamilyMismatchError("claude", "opus")).toBeNull();
    expect(modelFamilyMismatchError("codex", "gpt-5.5")).toBeNull();
    expect(modelFamilyMismatchError("opencode", "openai/gpt-5")).toBeNull();
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

// Tasks a7bdd069 and f49289bd: the child's mode for each spawner engine, mode
// and child engine, written out.
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
  // [spawner engine, child engine, child mode for each spawner mode]
  it.each([
    // Every Claude child starts in bypass (task f49289bd): an Auto spawner's
    // child too, which a limited family would run as Ask.
    [
      "claude",
      "claude",
      {
        default: bypass,
        acceptEdits: bypass,
        bypassPermissions: bypass,
        auto: bypass,
      },
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
    [
      "codex",
      "claude",
      { untrusted: bypass, "on-request": bypass, never: bypass },
    ],
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
    ["opencode", "claude", { default: bypass, bypassPermissions: bypass }],
    ["opencode", "codex", { default: full, bypassPermissions: full }],
    ["opencode", "opencode", { default: bypass, bypassPermissions: bypass }],
  ] as const)("%s -> %s", (from, to, expected) => {
    expect(childModes(from, to)).toEqual(expected);
  });
});
