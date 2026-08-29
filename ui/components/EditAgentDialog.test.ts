// The unsaved-changes gate on the spawn/edit agent dialog (task 5a20e3f0). What
// matters is that EVERY field counts, not just the two big textareas - someone
// who retyped a name and clicked the backdrop should get the same prompt as
// someone who rewrote the agent's memory. The dialog's own dismissal wiring
// isn't covered because the UI has no React render harness (same limitation
// noted in ContextBattery.test.ts).
import { describe, it, expect } from "bun:test";
import {
  agentFormDirty,
  codexNewEngineDefaults,
  openCodeModelSelectionReady,
  templateValuesAfterEngineSwitch,
  type AgentFormSnapshot,
} from "./EditAgentDialog.tsx";
import { partitionBackendModelsForPicker } from "../backend-model-selection.ts";
import { AGENT_TEMPLATES } from "../agent-templates.ts";
import type { BackendModelWire } from "../../shared/types.ts";

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
};

describe("agentFormDirty", () => {
  it("is clean when nothing moved", () => {
    expect(agentFormDirty({ ...BASE }, BASE, false)).toBe(false);
  });

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
    ];
    for (const edit of edits) {
      expect(agentFormDirty({ ...BASE, ...edit }, BASE, false)).toBe(true);
    }
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

  // Trimming must not swallow a real edit that merely starts or ends with a
  // space - only the padding is ignored, not the content inside it.
  it("still catches a real edit that carries padding", () => {
    expect(agentFormDirty({ ...BASE, name: "  Jim  " }, BASE, false)).toBe(
      true,
    );
  });
});

describe("Codex new-engine defaults", () => {
  it("gives spawns full access without approval prompts", () => {
    expect(codexNewEngineDefaults()).toEqual({
      permissionMode: "never",
      codexSandbox: "danger-full-access",
    });
  });

  it("gives edit-path engine switches full access without approval prompts", () => {
    expect(codexNewEngineDefaults()).toEqual({
      permissionMode: "never",
      codexSandbox: "danger-full-access",
    });
  });
});

describe("template values after an engine switch", () => {
  it("groups OpenCode connect entries after available models", () => {
    const available: BackendModelWire = {
      id: "opencode/model",
      label: "OpenCode - Model",
      supportedEfforts: [],
    };
    const connect: BackendModelWire = {
      id: "anthropic/claude-sonnet-4-6",
      label: "Anthropic",
      requiresConnection: true,
      supportedEfforts: [],
    };
    expect(partitionBackendModelsForPicker([available, connect], true)).toEqual(
      { available: [available], connect: [connect] },
    );
  });

  it("leaves Codex models in their original picker list", () => {
    const models: BackendModelWire[] = [
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        supportedEfforts: [],
      },
    ];
    expect(partitionBackendModelsForPicker(models, false)).toEqual({
      available: models,
      connect: [],
    });
  });

  it("keeps Claude on its static picker and confines connect copy to OpenCode", async () => {
    const source = await Bun.file(
      new URL("./EditAgentDialog.tsx", import.meta.url),
    ).text();
    expect(source).toContain("MODEL_FAMILIES.map((m) => (");
    expect(source).toContain('<optgroup label="Connect a provider">');
    expect(source).toContain("partitionBackendModelsForPicker(");
    expect(source).toContain("isOpenCode,");
  });

  it("keeps an existing OpenCode agent editable when discovery fails", () => {
    expect(
      openCodeModelSelectionReady("gate/gate-model", false, true, []),
    ).toBe(true);
  });

  it("requires a selection and rejects one absent from a loaded catalog", () => {
    expect(openCodeModelSelectionReady("", false, false, null)).toBe(false);
    expect(
      openCodeModelSelectionReady("old/model", false, false, [
        {
          id: "gate/gate-model",
          label: "Gate - Gate model",
          supportedEfforts: [],
        },
      ]),
    ).toBe(false);
  });

  it("fetches runtime models on engine selection without a tracer fallback", async () => {
    const source = await Bun.file(
      new URL("./EditAgentDialog.tsx", import.meta.url),
    ).text();
    expect(source).toContain("}, [usesBackendModels, targetEngine]);");
    expect(source).not.toContain("OPENCODE_TRACER_MODEL");
  });

  it("offers both OpenCode permission modes with established copy", async () => {
    const source = await Bun.file(
      new URL("./EditAgentDialog.tsx", import.meta.url),
    ).text();
    expect(source).toContain('<option value="default">Ask</option>');
    expect(source).toContain("Bypass all permissions");
  });

  it("selects a discovered OpenCode model and keeps Ask mode", () => {
    const template = AGENT_TEMPLATES[0];
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
      permissionMode: "default",
    });
  });

  it("resolves a spawn template from valid target-Codex defaults", () => {
    const template = AGENT_TEMPLATES.find(
      (candidate) => candidate.label === "Side Project Builder",
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

  it("resolves an edit template from the same target-Codex defaults", () => {
    const template = AGENT_TEMPLATES.find(
      (candidate) => candidate.label === "Side Project Builder",
    )!;
    expect(
      templateValuesAfterEngineSwitch(template, "codex", null, false),
    ).toMatchObject({ permissionMode: "never" });
  });
});
