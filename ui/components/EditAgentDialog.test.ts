// The unsaved-changes gate on the spawn/edit agent dialog (task 5a20e3f0). What
// matters is that EVERY field counts, not just the two big textareas - someone
// who retyped a name and clicked the backdrop should get the same prompt as
// someone who rewrote the agent's memory. Also the pure rules the dialog seeds
// its permission and template values with. The dialog's rendered behavior is
// in the EditAgentDialog.*.dom.test.tsx files.
import { describe, it, expect } from "bun:test";
import {
  agentFormDirty,
  initialPermissionModeFor,
  templateValuesAfterEngineSwitch,
  type AgentFormSnapshot,
} from "./EditAgentDialog.tsx";
import { AGENT_TEMPLATES } from "../agent-templates.ts";
import { RECEPTIONIST_PROFILE_KEY } from "../../shared/receptionist-profile.ts";
import type { AgentInfo, BackendModelWire } from "../../shared/types.ts";

const BASE: AgentFormSnapshot = {
  name: "Dwight",
  cwd: "~/schrute-farms",
  outfit: '{"hat":"none","color":"#D4A843"}',
  customInstructions: "Be thorough.",
  targetEngine: "claude",
  modelFamily: "opus",
  effort: "high",
  permissionMode: "auto",
  codexSandbox: "workspace-write",
  privileged: false,
  autoHandoff: false,
  autoHandoffTokens: "500",
  limitResume: true,
};

describe("agentFormDirty", () => {
  it("catches an edit in every field, not just the textareas", () => {
    const edits: Array<Partial<AgentFormSnapshot>> = [
      { name: "Dwight K." },
      { cwd: "~/beets" },
      { outfit: '{"hat":"cap","color":"#D4A843"}' },
      { customInstructions: "Be thorough. And intense." },
      { targetEngine: "codex" },
      { modelFamily: "sonnet" },
      { effort: "low" },
      { permissionMode: "default" },
      { codexSandbox: "read-only" },
      { privileged: true },
      { autoHandoff: true },
      { limitResume: false },
    ];
    for (const edit of edits) {
      expect(agentFormDirty({ ...BASE, ...edit }, BASE, false)).toBe(true);
    }
  });

  // The handoff threshold field shows only while the switch is on.
  it("counts the handoff threshold only while the automatic handoff switch is on", () => {
    const on = { ...BASE, autoHandoff: true };
    expect(agentFormDirty({ ...on, autoHandoffTokens: "300" }, on, false)).toBe(
      true,
    );
    expect(
      agentFormDirty({ ...BASE, autoHandoffTokens: "300" }, BASE, false),
    ).toBe(false);
  });

  it("counts memory edits, which live outside the form snapshot", () => {
    expect(agentFormDirty({ ...BASE }, BASE, true)).toBe(true);
  });

  // handleSave trims before diffing, so whitespace-only "edits" send nothing.
  // Prompting about them would train people to click Discard without reading.
  it("ignores whitespace-only changes to the free-text fields", () => {
    expect(
      agentFormDirty(
        {
          ...BASE,
          name: "  Dwight  ",
          cwd: "~/schrute-farms\n",
          customInstructions: " Be thorough. ",
        },
        BASE,
        false,
      ),
    ).toBe(false);
  });
});

describe("initial permission mode", () => {
  const openCodeAgent = (
    permissionMode: AgentInfo["permissionMode"],
  ): AgentInfo =>
    ({
      agentType: "opencode",
      modelFamily: "opencode/big-pickle",
      permissionMode,
    }) as AgentInfo;

  it("reopens a stored OpenCode mode as stored", () => {
    for (const mode of ["bypassPermissions", "default"] as const) {
      expect(initialPermissionModeFor(openCodeAgent(mode), "opencode")).toBe(
        mode,
      );
    }
  });

  it("uses Bypass for a new OpenCode spawn", () => {
    expect(initialPermissionModeFor(undefined, "opencode")).toBe(
      "bypassPermissions",
    );
  });
});

describe("template values on a limited Claude family", () => {
  it("gives a template on a limited family Ask instead of Auto", () => {
    const base = AGENT_TEMPLATES.find(
      (candidate) => candidate.key !== RECEPTIONIST_PROFILE_KEY,
    )!;
    const template = {
      ...base,
      recommendations: {
        ...base.recommendations,
        claude: {
          ...base.recommendations.claude,
          preferredFamilies: ["haiku"],
        },
      },
    };
    expect(
      templateValuesAfterEngineSwitch(template, "claude", null, false)
        .permissionMode,
    ).toBe("auto");
    expect(
      templateValuesAfterEngineSwitch(template, "claude", null, false, [
        "haiku",
      ]).permissionMode,
    ).toBe("default");
  });
});

describe("template values after an engine switch", () => {
  it("selects a discovered OpenCode model and uses Bypass mode", () => {
    // Not the receptionist, whose key forces Bypass on any engine.
    const template = AGENT_TEMPLATES.find(
      (candidate) => candidate.key === "side-project-builder",
    )!;
    const models: BackendModelWire[] = [
      {
        id: "gate/gate-model",
        label: "Gate - Gate model",
        supportedEfforts: [],
      },
    ];
    expect(
      templateValuesAfterEngineSwitch(template, "opencode", models, false),
    ).toEqual({
      modelFamily: "gate/gate-model",
      effort: "high",
      permissionMode: "bypassPermissions",
    });
  });

  it("resolves a template from valid target-Codex defaults", () => {
    const template = AGENT_TEMPLATES.find(
      (candidate) => candidate.key === "side-project-builder",
    )!;
    const models: BackendModelWire[] = [
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        supportedEfforts: [{ level: "high" }],
      },
    ];
    expect(
      templateValuesAfterEngineSwitch(template, "codex", models, false),
    ).toEqual({
      modelFamily: "gpt-5.6-terra",
      effort: "high",
      permissionMode: "never",
    });
  });
});
