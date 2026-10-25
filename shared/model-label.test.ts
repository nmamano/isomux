// Engine cues identify the harness when the model label alone cannot.
import { describe, it, expect } from "bun:test";
import {
  CODEX_MODELS,
  MODEL_FAMILIES,
  familyDisplayLabel,
  familyPickerLabel,
  showEngineCue,
} from "./types.ts";

// On Bedrock and Vertex a family can run another model than FAMILY_TO_MODEL
// (ClaudeFamilyModels); its labels read the version from that model id.
describe("Claude labels with ClaudeFamilyModels", () => {
  it("names the version of the model the family runs", () => {
    const cases: [string, string][] = [
      ["claude-haiku-4-5", "Haiku 4.5"],
      ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "Haiku 4.5"],
      ["claude-haiku-4-5@20251001", "Haiku 4.5"],
      ["CLAUDE-HAIKU-5-5@20261001", "Haiku 5.5"],
      ["claude-haiku-5", "Haiku 5"],
      ["claude-haiku-4-20250514", "Haiku 4"],
      ["arn:aws:bedrock:us-east-1:1:application-inference-profile/x", "Haiku"],
    ];
    for (const [model, label] of cases) {
      expect(familyDisplayLabel("haiku", { haiku: model })).toBe(label);
    }
  });

  it("keeps FAMILY_TO_MODEL for a family the map leaves out", () => {
    const models = { sonnet: "claude-sonnet-4-5" };
    expect(familyDisplayLabel("opus", models)).toBe(familyDisplayLabel("opus"));
    expect(familyDisplayLabel("sonnet", models)).toBe("Sonnet 4.5");
    expect(familyDisplayLabel("gpt-5.6-sol", models)).toBe("GPT-5.6 Sol");
  });

  it("gives the pickers the version in parentheses, or the family alone", () => {
    expect(familyPickerLabel("sonnet", { sonnet: "claude-sonnet-4-6" })).toBe(
      "Sonnet (4.6)",
    );
    expect(familyPickerLabel("sonnet", { sonnet: "arn:aws:bedrock:x" })).toBe(
      "Sonnet",
    );
  });
});

describe("showEngineCue", () => {
  it("covers every known Codex model, so none renders the redundant badge", () => {
    for (const m of CODEX_MODELS) {
      for (const surface of ["header", "listing"] as const) {
        expect(showEngineCue("codex", m.value, surface)).toBe(false);
      }
    }
  });

  it("covers every Claude family", () => {
    for (const m of MODEL_FAMILIES) {
      for (const surface of ["header", "listing"] as const) {
        expect(showEngineCue("claude", m.family, surface)).toBe(false);
      }
    }
  });

  it("pretty-prints a Codex slug the table doesn't carry", () => {
    expect(showEngineCue("codex", "gpt-6-nova", "header")).toBe(false);
    expect(familyDisplayLabel("gpt-6-nova")).toBe("GPT-6 Nova");
  });

  it("pretty-prints a composite provider/model id", () => {
    expect(showEngineCue("opencode", "gate/gate-model", "header")).toBe(true);
    expect(familyDisplayLabel("gate/gate-model")).toBe("Gate Model");
    expect(familyDisplayLabel("opencode/mimo-v2.5-free")).toBe(
      "MiMo V2.5 Free",
    );
    expect(familyDisplayLabel("opencode/muse-spark-1.2-contributor-free")).toBe(
      "Muse Spark 1.2 Free",
    );
  });

  it("keeps the OpenCode badge for models from recognizable providers", () => {
    for (const model of [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
      "github-copilot/gpt-4.1",
      "opencode/mimo-v2.5-free",
    ]) {
      for (const surface of ["header", "listing"] as const) {
        expect(showEngineCue("opencode", model, surface)).toBe(true);
      }
    }
  });

  it("keeps both cues for OpenCode ids with engine-like provider prefixes", () => {
    for (const model of [
      "gpt-provider/model",
      "claude-provider/model",
      "opus",
    ]) {
      for (const surface of ["header", "listing"] as const) {
        expect(showEngineCue("opencode", model, surface)).toBe(true);
      }
    }
  });

  it("omits both cues for a Claude composite model", () => {
    for (const surface of ["header", "listing"] as const) {
      expect(
        showEngineCue("claude", "anthropic/claude-sonnet-4-6", surface),
      ).toBe(false);
    }
  });

  it("preserves the Codex surface difference for a custom model id", () => {
    expect(showEngineCue("codex", "custom/model", "header")).toBe(true);
    expect(showEngineCue("codex", "custom/model", "listing")).toBe(false);
    expect(showEngineCue("codex", "opus", "header")).toBe(false);
  });
});
