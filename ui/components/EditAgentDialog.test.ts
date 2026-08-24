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
  type AgentFormSnapshot,
} from "./EditAgentDialog.tsx";

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
    expect(codexNewEngineDefaults(true)).toEqual({
      permissionMode: "never",
      codexSandbox: "danger-full-access",
    });
  });

  it("preserves the existing edit-path engine-switch defaults", () => {
    expect(codexNewEngineDefaults(false)).toEqual({
      permissionMode: "on-request",
      codexSandbox: "workspace-write",
    });
  });
});
