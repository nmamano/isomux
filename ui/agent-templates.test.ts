import { describe, expect, it } from "bun:test";
import type { BackendModelWire, EffortLevel } from "../shared/types.ts";
import {
  ACCESSORIES,
  BEARDS,
  HAIR_COLORS,
  HAIR_STYLES,
  HATS,
  SHIRT_COLORS,
  SKIN_COLORS,
} from "../shared/outfit-options.ts";
import {
  CODEX_MODELS,
  MODEL_FAMILIES,
  effortLevelsFor,
} from "../shared/types.ts";
import {
  agentFormDirty,
  type AgentFormSnapshot,
} from "./components/EditAgentDialog.tsx";
import {
  AGENT_TEMPLATES,
  FIRST_TURN_CLAUSE,
  PLAIN_LANGUAGE_CLAUSE,
  SOFTWARE_TOOL_CLAUSE,
  blankRestoreValues,
  resolveTemplateModel,
  resolveTemplatePermission,
  templateFormValues,
  templateEngineValues,
  type AgentTemplateGroup,
} from "./agent-templates.ts";

const EXPECTED_LABELS = [
  "Side Project Builder",
  "Personal Site Builder",
  "Code Reviewer",
  "Money Planner",
  "Job Search Coach",
  "Research Analyst",
  "Health Navigator",
  "Life Coach",
  "Relationship Advisor",
  "Todo List Assistant",
  "City Guide",
  "Trip Planner",
];

const EXPECTED_TEMPLATE_SETTINGS: Record<
  string,
  [AgentTemplateGroup, EffortLevel, EffortLevel]
> = {
  "Side Project Builder": ["build", "high", "high"],
  "Personal Site Builder": ["build", "high", "high"],
  "Code Reviewer": ["build", "high", "high"],
  "Money Planner": ["work", "high", "high"],
  "Job Search Coach": ["work", "medium", "medium"],
  "Research Analyst": ["work", "high", "high"],
  "Health Navigator": ["life", "medium", "medium"],
  "Life Coach": ["life", "medium", "medium"],
  "Relationship Advisor": ["life", "medium", "medium"],
  "Todo List Assistant": ["life", "medium", "medium"],
  "City Guide": ["places", "medium", "medium"],
  "Trip Planner": ["places", "medium", "medium"],
};

function model(
  id: string,
  efforts: EffortLevel[],
  options: Partial<BackendModelWire> = {},
): BackendModelWire {
  return {
    id,
    label: id,
    supportedEfforts: efforts.map((level) => ({ level })),
    ...options,
  };
}

describe("agent template catalog", () => {
  it("contains Nil's exact 12 templates in the approved order", () => {
    expect(AGENT_TEMPLATES.map((template) => template.label)).toEqual(
      EXPECTED_LABELS,
    );
    expect(new Set(AGENT_TEMPLATES.map((template) => template.key)).size).toBe(
      12,
    );
  });

  it("pins every template's group and both engine effort recommendations", () => {
    expect(
      Object.fromEntries(
        AGENT_TEMPLATES.map((template) => [
          template.label,
          [
            template.group,
            template.recommendations.claude.desiredEffort,
            template.recommendations.codex.desiredEffort,
          ],
        ]),
      ),
    ).toEqual(EXPECTED_TEMPLATE_SETTINGS);
  });

  it("composes every prompt from the shared software workflow clauses", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.customInstructions).toContain(FIRST_TURN_CLAUSE);
      expect(template.customInstructions).toContain(SOFTWARE_TOOL_CLAUSE);
      expect(template.customInstructions).toContain(PLAIN_LANGUAGE_CLAUSE);
    }
  });

  it("uses only valid fixed outfit values", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(SHIRT_COLORS).toContain(template.outfit.color);
      expect(HAIR_COLORS).toContain(template.outfit.hair);
      expect(HAIR_STYLES).toContain(template.outfit.hairStyle);
      expect(SKIN_COLORS).toContain(template.outfit.skin);
      expect(BEARDS).toContain(template.outfit.beard);
      expect(HATS).toContain(template.outfit.hat);
      expect(ACCESSORIES).toContain(template.outfit.accessory);
    }
  });

  it("keeps each Claude recommendation valid through the product helper", () => {
    const claudeFamilies = new Set<string>(
      MODEL_FAMILIES.map((modelFamily) => modelFamily.family),
    );
    const knownCodexModels = new Set(CODEX_MODELS.map((model) => model.value));
    for (const template of AGENT_TEMPLATES) {
      const family = template.recommendations.claude.preferredFamilies[0];
      for (const preferred of template.recommendations.claude
        .preferredFamilies) {
        expect(claudeFamilies).toContain(preferred);
      }
      // Sanity-check bundled preferences; the live model list remains the
      // authority for which Codex models this user can select.
      for (const preferred of template.recommendations.codex
        .preferredModelIds) {
        expect(knownCodexModels).toContain(preferred);
      }
      expect(
        effortLevelsFor("claude", family).map((option) => option.level),
      ).toContain(template.recommendations.claude.desiredEffort);
    }
  });
});

describe("resolveTemplateModel", () => {
  const template = AGENT_TEMPLATES.find(
    (candidate) => candidate.label === "Side Project Builder",
  )!;

  it("uses the first offered non-hidden Codex preference", () => {
    const result = resolveTemplateModel(
      template,
      "codex",
      { modelFamily: "fallback", effort: "medium" },
      [
        model("gpt-5.6-sol", ["high", "max"], { hidden: true }),
        model("gpt-5.6-terra", ["high", "max"]),
        model("fallback", ["medium"]),
      ],
      false,
    );
    expect(result).toEqual({ modelFamily: "gpt-5.6-terra", effort: "high" });
  });

  it("keeps the current live default when no preference is offered", () => {
    const result = resolveTemplateModel(
      template,
      "codex",
      { modelFamily: "account-default", effort: "high" },
      [model("account-default", ["medium", "high"])],
      false,
    );
    expect(result).toEqual({
      modelFamily: "account-default",
      effort: "high",
    });
  });

  it("falls back to the reported default and clamps its effort", () => {
    const result = resolveTemplateModel(
      template,
      "codex",
      { modelFamily: "missing", effort: "max" },
      [
        model("first", ["low"]),
        model("reported", ["low", "medium"], {
          isDefault: true,
          defaultEffort: "medium",
        }),
      ],
      false,
    );
    expect(result).toEqual({ modelFamily: "reported", effort: "medium" });
  });

  it("preserves model and effort when live model loading failed", () => {
    const current = { modelFamily: "gpt-fallback", effort: "xhigh" } as const;
    expect(
      resolveTemplateModel(template, "codex", current, null, true),
    ).toEqual(current);
  });

  it("uses connected OpenCode models without Codex preferences or effort", () => {
    const result = resolveTemplateModel(
      template,
      "opencode",
      { modelFamily: "missing/model", effort: "low" },
      [
        model("hidden/model", [], { hidden: true }),
        model("gate/gate-model", []),
      ],
      false,
    );
    expect(result).toEqual({
      modelFamily: "gate/gate-model",
      effort: "high",
    });
  });

  it("prefers Muse Spark for an OpenCode template and falls back when absent", () => {
    const current = { modelFamily: "missing/model", effort: "low" } as const;
    const first = model("first/model", []);
    const reported = model("reported/model", [], { isDefault: true });
    const muse = model("opencode/muse-spark-1.2-contributor-free", [], {
      isFree: true,
    });
    expect(
      resolveTemplateModel(
        template,
        "opencode",
        current,
        [first, reported, muse],
        false,
      ).modelFamily,
    ).toBe(muse.id);
    expect(
      resolveTemplateModel(
        template,
        "opencode",
        current,
        [first, reported],
        false,
      ).modelFamily,
    ).toBe(reported.id);
    expect(
      resolveTemplateModel(template, "opencode", current, [first], false)
        .modelFamily,
    ).toBe(first.id);
  });

  it("keeps a visible current paid OpenCode model when applying a template", () => {
    const paid = model("provider/paid", []);
    const free = model("opencode/muse-spark-1.2-contributor-free", [], {
      isFree: true,
    });
    expect(
      resolveTemplateModel(
        template,
        "opencode",
        { modelFamily: paid.id, effort: "high" },
        [free, paid],
        false,
      ).modelFamily,
    ).toBe(paid.id);
  });

  it("clamps a Claude max recommendation through effortLevelsFor", () => {
    const changed = {
      ...template,
      recommendations: {
        ...template.recommendations,
        claude: {
          preferredFamilies: ["sonnet"],
          desiredEffort: "max" as const,
        },
      },
    };
    const result = resolveTemplateModel(
      changed,
      "claude",
      { modelFamily: "opus", effort: "high" },
      null,
      false,
    );
    expect(result).toEqual({ modelFamily: "sonnet", effort: "high" });
  });
});

describe("resolveTemplatePermission", () => {
  it("mirrors the Claude model select's auto-permission coercion", () => {
    expect(resolveTemplatePermission("claude", "sonnet", "auto")).toBe(
      "bypassPermissions",
    );
    expect(resolveTemplatePermission("claude", "opus", "auto")).toBe("auto");
    expect(
      resolveTemplatePermission("codex", "gpt-5.6-sol", "on-request"),
    ).toBe("on-request");
    expect(
      resolveTemplatePermission(
        "opencode",
        "gate/gate-model",
        "bypassPermissions",
      ),
    ).toBe("bypassPermissions");
  });
});

describe("template engine switch", () => {
  it("re-resolves a selected template after the Codex model list arrives", () => {
    const template = AGENT_TEMPLATES.find(
      (candidate) => candidate.label === "Side Project Builder",
    )!;
    const result = templateEngineValues(
      template,
      "codex",
      {
        modelFamily: "provisional-model",
        effort: "medium",
        permissionMode: "never",
      },
      [
        model("account-default", ["medium"], { isDefault: true }),
        model("gpt-5.6-terra", ["high", "max"]),
      ],
      false,
    );
    expect(result).toEqual({
      modelFamily: "gpt-5.6-terra",
      effort: "high",
      permissionMode: "never",
    });
  });
});

describe("Blank template dirty state", () => {
  const initialBlank = {
    name: "",
    customInstructions: "",
    outfit: {
      hat: "cap",
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: null,
    },
  } as const;
  const baseline: AgentFormSnapshot = {
    name: "",
    cwd: "~",
    outfit:
      '{"hat":"cap","color":"#4A90D9","hair":"#222","hairStyle":"short","skin":"#FFD5B8","beard":"none","accessory":null}',
    customInstructions: "",
    targetEngine: "codex",
    modelFamily: "live-account-default",
    effort: "medium",
    permissionMode: "on-request",
    codexSandbox: "workspace-write",
    privileged: false,
  };

  it("counts an applied template as a user edit", () => {
    const applied = templateFormValues(
      AGENT_TEMPLATES[1],
      "codex",
      baseline,
      [model("gpt-5.6-sol", ["high", "max"])],
      false,
    );
    expect(
      agentFormDirty(
        {
          ...baseline,
          ...applied,
          outfit: JSON.stringify(applied.outfit),
        },
        baseline,
        false,
      ),
    ).toBe(true);
  });

  it("is clean after Blank restores the machine-refined Codex baseline", () => {
    const restoredValues = blankRestoreValues(initialBlank, baseline);
    expect(restoredValues).toMatchObject({
      name: initialBlank.name,
      customInstructions: initialBlank.customInstructions,
      modelFamily: baseline.modelFamily,
      effort: baseline.effort,
      permissionMode: baseline.permissionMode,
    });
    expect(restoredValues.outfit).toEqual(initialBlank.outfit);
    expect(restoredValues.outfit).not.toBe(initialBlank.outfit);
    const restored: AgentFormSnapshot = {
      ...baseline,
      ...restoredValues,
      outfit: JSON.stringify(restoredValues.outfit),
    };
    expect(agentFormDirty(restored, baseline, false)).toBe(false);
  });
});
