import {
  RECEPTIONIST_PROFILE_KEY,
  RECEPTIONIST_OUTFIT,
} from "./receptionist-profile.ts";
import type {
  AgentBackendType,
  AgentOutfit,
  AgentPermissionMode,
  BackendModelWire,
  EffortLevel,
} from "./types.ts";
import {
  DEFAULT_EFFORT,
  MODEL_FAMILIES,
  OPENCODE_DEFAULT_MODEL,
  claudeFamilySupportsAutoPermission,
  effortLevelsFor,
} from "./types.ts";
import { preferredFreeOpenCodeModel } from "./opencode-model.ts";
import { en } from "./i18n/en.ts";
import {
  translatorFor,
  type MessageKey,
  type Translator,
} from "./i18n/translate.ts";

export const FIRST_TURN_CLAUSE = en["templates.shared.firstTurn"];
export const SOFTWARE_TOOL_CLAUSE = en["templates.shared.softwareTool"];
export const PLAIN_LANGUAGE_CLAUSE = en["templates.shared.plainLanguage"];

export interface AgentTemplate {
  key: string;
  group: AgentTemplateGroup;
  /** Card text and task instructions are resolved in the member's language. */
  labelKey: Extract<MessageKey, `templates.${string}.label`>;
  descriptionKey: Extract<MessageKey, `templates.${string}.description`>;
  instructionsKey: Extract<MessageKey, `templates.${string}.instructions`>;
  sharedWorkflow: boolean;
  /** English output for callers that do not apply a member's language. */
  customInstructions: string;
  outfit: AgentOutfit;
  recommendations: {
    claude: {
      preferredFamilies: string[];
      desiredEffort: EffortLevel;
    };
    codex: {
      preferredModelIds: string[];
      desiredEffort: EffortLevel;
    };
  };
}

export type AgentTemplateGroup = "build" | "work" | "life" | "places";

const CODEX_FRONTIER = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"];
const CODEX_BALANCED = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4"];

function templateInstructions(
  i18n: Translator,
  template: Pick<AgentTemplate, "instructionsKey" | "sharedWorkflow">,
): string {
  const task = i18n.t(template.instructionsKey);
  if (!template.sharedWorkflow) return task;
  return [
    task,
    i18n.t("templates.shared.firstTurn"),
    i18n.t("templates.shared.softwareTool"),
    i18n.t("templates.shared.plainLanguage"),
  ].join("\n\n");
}

function outfit(
  color: string,
  hair: string,
  hairStyle: AgentOutfit["hairStyle"],
  skin: string,
  beard: AgentOutfit["beard"],
  accessory: AgentOutfit["accessory"],
  hat: AgentOutfit["hat"] = "none",
): AgentOutfit {
  return { color, hair, hairStyle, skin, beard, accessory, hat };
}

function recommendation(
  claudeFamilies: string[],
  claudeEffort: EffortLevel,
  codexModels: string[],
  codexEffort: EffortLevel,
): AgentTemplate["recommendations"] {
  return {
    claude: {
      preferredFamilies: claudeFamilies,
      desiredEffort: claudeEffort,
    },
    codex: {
      preferredModelIds: codexModels,
      desiredEffort: codexEffort,
    },
  };
}

const TEMPLATE_CATALOG: Omit<AgentTemplate, "customInstructions">[] = [
  {
    key: RECEPTIONIST_PROFILE_KEY,
    group: "work",
    labelKey: "templates.receptionist.label",
    descriptionKey: "templates.receptionist.description",
    instructionsKey: "templates.receptionist.instructions",
    sharedWorkflow: false,
    outfit: RECEPTIONIST_OUTFIT,
    recommendations: recommendation(
      ["sonnet", "opus"],
      "medium",
      CODEX_BALANCED,
      "medium",
    ),
  },
  {
    key: "money-planner",
    group: "work",
    labelKey: "templates.moneyPlanner.label",
    descriptionKey: "templates.moneyPlanner.description",
    instructionsKey: "templates.moneyPlanner.instructions",
    sharedWorkflow: true,
    outfit: outfit("#D4A843", "#3a2a1a", "short", "#C68642", "none", "tie"),
    recommendations: recommendation(
      ["opus", "sonnet"],
      "high",
      CODEX_BALANCED,
      "high",
    ),
  },
  {
    key: "side-project-builder",
    group: "build",
    labelKey: "templates.sideProjectBuilder.label",
    descriptionKey: "templates.sideProjectBuilder.description",
    instructionsKey: "templates.sideProjectBuilder.instructions",
    sharedWorkflow: true,
    outfit: {
      ...outfit(
        "#4A90D9",
        "#222",
        "short",
        "#FFD5B8",
        "stubble",
        "headphones",
        "beanie",
      ),
      costume: "construction",
    },
    recommendations: recommendation(
      ["opus", "fable"],
      "high",
      CODEX_FRONTIER,
      "high",
    ),
  },
  {
    key: "health-navigator",
    group: "life",
    labelKey: "templates.healthNavigator.label",
    descriptionKey: "templates.healthNavigator.description",
    instructionsKey: "templates.healthNavigator.instructions",
    sharedWorkflow: true,
    outfit: {
      ...outfit("#50B86C", "#8a5a3a", "bun", "#FDEBD0", "none", "glasses"),
      costume: "doctor",
    },
    recommendations: recommendation(
      ["opus", "sonnet"],
      "medium",
      CODEX_BALANCED,
      "medium",
    ),
  },
  {
    key: "life-coach",
    group: "life",
    labelKey: "templates.lifeCoach.label",
    descriptionKey: "templates.lifeCoach.description",
    instructionsKey: "templates.lifeCoach.instructions",
    sharedWorkflow: true,
    outfit: outfit(
      "#9B6DFF",
      "#C4A265",
      "long",
      "#FFD5B8",
      "none",
      "earrings",
      "headband",
    ),
    recommendations: recommendation(
      ["sonnet", "opus"],
      "medium",
      CODEX_BALANCED,
      "medium",
    ),
  },
  {
    key: "research-analyst",
    group: "work",
    labelKey: "templates.researchAnalyst.label",
    descriptionKey: "templates.researchAnalyst.description",
    instructionsKey: "templates.researchAnalyst.instructions",
    sharedWorkflow: true,
    outfit: outfit("#45B7D1", "#1a1a2e", "curly", "#5C3A28", "none", "glasses"),
    recommendations: recommendation(
      ["opus", "fable"],
      "high",
      CODEX_FRONTIER,
      "high",
    ),
  },
  {
    key: "personal-site-builder",
    group: "build",
    labelKey: "templates.personalSiteBuilder.label",
    descriptionKey: "templates.personalSiteBuilder.description",
    instructionsKey: "templates.personalSiteBuilder.instructions",
    sharedWorkflow: true,
    outfit: {
      ...outfit(
        "#FF6B9D",
        "#6C5CE7",
        "pigtails",
        "#C68642",
        "none",
        "headphones",
      ),
      costume: "construction",
    },
    recommendations: recommendation(
      ["opus", "fable"],
      "high",
      CODEX_FRONTIER,
      "high",
    ),
  },
  {
    key: "city-guide",
    group: "places",
    labelKey: "templates.cityGuide.label",
    descriptionKey: "templates.cityGuide.description",
    instructionsKey: "templates.cityGuide.instructions",
    sharedWorkflow: true,
    outfit: outfit(
      "#FF8C42",
      "#8B4513",
      "ponytail",
      "#FFD5B8",
      "none",
      null,
      "cap",
    ),
    recommendations: recommendation(
      ["sonnet", "opus"],
      "medium",
      CODEX_BALANCED,
      "medium",
    ),
  },
  {
    key: "todo-list-assistant",
    group: "life",
    labelKey: "templates.todoListAssistant.label",
    descriptionKey: "templates.todoListAssistant.description",
    instructionsKey: "templates.todoListAssistant.instructions",
    sharedWorkflow: true,
    outfit: outfit(
      "#50B86C",
      "#E84393",
      "bun",
      "#5C3A28",
      "none",
      "earrings",
      "bow",
    ),
    recommendations: recommendation(
      ["sonnet", "opus"],
      "medium",
      CODEX_BALANCED,
      "medium",
    ),
  },
  {
    key: "code-reviewer",
    group: "build",
    labelKey: "templates.codeReviewer.label",
    descriptionKey: "templates.codeReviewer.description",
    instructionsKey: "templates.codeReviewer.instructions",
    sharedWorkflow: true,
    outfit: outfit("#4A90D9", "#222", "bald", "#C68642", "goatee", "glasses"),
    recommendations: recommendation(
      ["opus", "fable"],
      "high",
      CODEX_FRONTIER,
      "high",
    ),
  },
  {
    key: "relationship-advisor",
    group: "life",
    labelKey: "templates.relationshipAdvisor.label",
    descriptionKey: "templates.relationshipAdvisor.description",
    instructionsKey: "templates.relationshipAdvisor.instructions",
    sharedWorkflow: true,
    outfit: outfit("#E85D75", "#3a2a1a", "curly", "#FDEBD0", "none", "bow_tie"),
    recommendations: recommendation(
      ["opus", "sonnet"],
      "medium",
      CODEX_BALANCED,
      "medium",
    ),
  },
  {
    key: "job-search-coach",
    group: "work",
    labelKey: "templates.jobSearchCoach.label",
    descriptionKey: "templates.jobSearchCoach.description",
    instructionsKey: "templates.jobSearchCoach.instructions",
    sharedWorkflow: true,
    outfit: outfit("#9B6DFF", "#8a5a3a", "short", "#5C3A28", "mustache", "tie"),
    recommendations: recommendation(
      ["opus", "sonnet"],
      "medium",
      CODEX_BALANCED,
      "medium",
    ),
  },
  {
    key: "trip-planner",
    group: "places",
    labelKey: "templates.tripPlanner.label",
    descriptionKey: "templates.tripPlanner.description",
    instructionsKey: "templates.tripPlanner.instructions",
    sharedWorkflow: true,
    outfit: outfit(
      "#45B7D1",
      "#C4A265",
      "long",
      "#FDEBD0",
      "none",
      null,
      "beanie",
    ),
    recommendations: recommendation(
      ["sonnet", "opus"],
      "medium",
      CODEX_BALANCED,
      "medium",
    ),
  },
];

const TEMPLATE_ORDER = [
  RECEPTIONIST_PROFILE_KEY,
  "side-project-builder",
  "personal-site-builder",
  "code-reviewer",
  "money-planner",
  "job-search-coach",
  "research-analyst",
  "health-navigator",
  "life-coach",
  "relationship-advisor",
  "todo-list-assistant",
  "city-guide",
  "trip-planner",
] as const;

export const AGENT_TEMPLATES: AgentTemplate[] = TEMPLATE_ORDER.map((key) => {
  const template = TEMPLATE_CATALOG.find((entry) => entry.key === key)!;
  return {
    ...template,
    customInstructions: templateInstructions(translatorFor("en"), template),
  };
});

export interface TemplateModelResolution {
  modelFamily: string;
  effort: EffortLevel;
}

export interface TemplateFormBaseline extends TemplateModelResolution {
  permissionMode: AgentPermissionMode;
}

export interface InitialBlankValues {
  name: string;
  customInstructions: string;
  outfit: AgentOutfit;
}

export interface TemplateFormValues extends TemplateFormBaseline {
  name: string;
  customInstructions: string;
  outfit: AgentOutfit;
}

export function blankRestoreValues(
  initialBlank: InitialBlankValues,
  baseline: TemplateFormBaseline,
): TemplateFormValues {
  return {
    name: initialBlank.name,
    customInstructions: initialBlank.customInstructions,
    outfit: { ...initialBlank.outfit },
    modelFamily: baseline.modelFamily,
    effort: baseline.effort,
    permissionMode: baseline.permissionMode,
  };
}

export function resolveTemplatePermission(
  engine: AgentBackendType,
  modelFamily: string,
  current: AgentPermissionMode,
): AgentPermissionMode {
  if (
    engine === "claude" &&
    current === "auto" &&
    !claudeFamilySupportsAutoPermission(modelFamily)
  )
    return "bypassPermissions";
  return current;
}

function clampEffort(
  desired: EffortLevel,
  current: EffortLevel,
  supported: EffortLevel[],
  reportedDefault?: string,
): EffortLevel {
  if (supported.includes(desired)) return desired;
  if (supported.includes(current)) return current;
  if (
    reportedDefault !== undefined &&
    supported.includes(reportedDefault as EffortLevel)
  )
    return reportedDefault as EffortLevel;
  return supported[0] ?? DEFAULT_EFFORT;
}

export function resolveTemplateModel(
  template: AgentTemplate,
  engine: AgentBackendType,
  current: TemplateModelResolution,
  backendModels: BackendModelWire[] | null,
  modelsFailed: boolean,
): TemplateModelResolution {
  if (engine === "claude") {
    const available = new Set<string>(MODEL_FAMILIES.map((m) => m.family));
    const modelFamily =
      template.recommendations.claude.preferredFamilies.find((family) =>
        available.has(family),
      ) ??
      (available.has(current.modelFamily)
        ? current.modelFamily
        : MODEL_FAMILIES[0].family);
    const supported = effortLevelsFor("claude", modelFamily).map(
      (option) => option.level,
    );
    return {
      modelFamily,
      effort: clampEffort(
        template.recommendations.claude.desiredEffort,
        current.effort,
        supported,
      ),
    };
  }

  if (engine === "opencode") {
    if (modelsFailed || backendModels === null) return current;
    const visible = backendModels.filter((model) => !model.hidden);
    if (visible.length === 0) return current;
    const chosen =
      visible.find((model) => model.id === current.modelFamily) ??
      preferredFreeOpenCodeModel(visible, OPENCODE_DEFAULT_MODEL) ??
      visible.find((model) => model.isDefault) ??
      visible[0];
    return {
      modelFamily: chosen.id,
      effort: DEFAULT_EFFORT,
    };
  }

  if (modelsFailed || backendModels === null) return current;
  const visible = backendModels.filter((model) => !model.hidden);
  if (visible.length === 0) return current;
  const preferred = template.recommendations.codex.preferredModelIds
    .map((id) => visible.find((model) => model.id === id))
    .find((model) => model !== undefined);
  const chosen =
    preferred ??
    visible.find((model) => model.id === current.modelFamily) ??
    visible.find((model) => model.isDefault) ??
    visible[0];
  const supported = chosen.supportedEfforts.map(
    (option) => option.level as EffortLevel,
  );
  return {
    modelFamily: chosen.id,
    effort: clampEffort(
      template.recommendations.codex.desiredEffort,
      current.effort,
      supported,
      chosen.defaultEffort,
    ),
  };
}

export function templateFormValues(
  i18n: Translator,
  template: AgentTemplate,
  engine: AgentBackendType,
  current: TemplateFormBaseline,
  backendModels: BackendModelWire[] | null,
  modelsFailed: boolean,
): TemplateFormValues {
  return {
    // Resolve at pick time; stored instructions are not retranslated.
    name: i18n.t(template.labelKey),
    customInstructions: templateInstructions(i18n, template),
    outfit: { ...template.outfit },
    ...templateEngineValues(
      template,
      engine,
      current,
      backendModels,
      modelsFailed,
    ),
  };
}

export function templateEngineValues(
  template: AgentTemplate,
  engine: AgentBackendType,
  current: TemplateFormBaseline,
  backendModels: BackendModelWire[] | null,
  modelsFailed: boolean,
): Pick<TemplateFormValues, "modelFamily" | "effort" | "permissionMode"> {
  const model = resolveTemplateModel(
    template,
    engine,
    current,
    backendModels,
    modelsFailed,
  );
  return {
    ...model,
    permissionMode:
      template.key === RECEPTIONIST_PROFILE_KEY
        ? "bypassPermissions"
        : resolveTemplatePermission(
            engine,
            model.modelFamily,
            current.permissionMode,
          ),
  };
}
