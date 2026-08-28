// Server-side validation for backend-specific spawn/edit options.
//
// The wire types are permissive (e.g. AgentInfo.permissionMode unions both
// backends' enums), so we narrow per agentType here. UI shouldn't send
// mismatched values, but a stale tab or hand-crafted client could.
//
// Used by both agent-manager.ts (agent spawn/edit) and the cronjob HTTP
// handlers (cron add/update). Cron-specific narrowing lives in
// validateCronjobPermissionMode below - its allowlist is a subset of the
// agent allowlist because cron runs unattended.

import {
  CODEX_MODELS,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  MODEL_FAMILIES,
  OPENCODE_TRACER_MODEL,
  claudeFamilySupportsMaxEffort,
  isClaudeFamily,
  type AgentBackendType,
  type AgentPermissionMode,
  type CodexSandboxMode,
  type CronjobPermissionMode,
  type EffortLevel,
} from "../shared/types.ts";

export function validatePermissionMode(
  agentType: AgentBackendType,
  raw: AgentPermissionMode | undefined,
): AgentPermissionMode {
  if (agentType === "codex") {
    // "on-failure" is deprecated in codex 0.130 (warns on use); migrate
    // to "on-request" at the boundary so we never persist the legacy value.
    if (raw === "on-failure") return "on-request";
    if (raw === "untrusted" || raw === "on-request" || raw === "never")
      return raw;
    return "never";
  }
  if (agentType === "opencode") return "default";
  if (
    raw === "default" ||
    raw === "acceptEdits" ||
    raw === "bypassPermissions" ||
    raw === "auto"
  )
    return raw;
  return "auto";
}

export function validateModelFamily(
  agentType: AgentBackendType,
  raw: string | undefined,
): string {
  if (agentType === "codex") {
    // Pass-through: the picker is fed by Codex's model/list RPC which
    // returns auth-appropriate slugs that aren't necessarily in our
    // hardcoded CODEX_MODELS. We can't statically know the valid set, so
    // trust any non-empty string and let codex itself reject at thread/
    // start with a "model not supported" turn error (whose system_text
    // hint already points the user back at settings).
    if (raw && typeof raw === "string" && raw.length > 0) return raw;
    return CODEX_MODELS[0].value;
  }
  if (agentType === "opencode") {
    if (raw && typeof raw === "string" && raw.length > 0) return raw;
    return OPENCODE_TRACER_MODEL;
  }
  if (raw && isClaudeFamily(raw)) return raw;
  return MODEL_FAMILIES[0].family;
}

// Strict counterpart to validateModelFamily for INTERACTIVE spawn/edit input
// (the REST dep closures in isomux-office.ts). Where validateModelFamily silently
// coerces a mismatched value to the backend default - right for persisted-state
// canonicalization at boot/revive, wrong for a live caller whose typo would
// vanish - this returns a human-readable error string for a modelFamily that
// cannot belong to the agentType, or null when the value is acceptable.
//
// Rules:
// - absent/empty raw -> null (the caller gets the backend default; not an error)
// - claude: anything outside the static Claude family set is an error (e.g. a
//   Codex slug sent without agentType:"codex")
// - codex: a Claude family name is an error (statically known to not be a Codex
//   slug - catches agentType:"codex" paired with modelFamily:"opus"); anything
//   else passes through, because the valid Codex set is dynamic (model/list
//   RPC) and codex itself rejects unknown slugs at thread/start.
export function modelFamilyMismatchError(
  agentType: AgentBackendType,
  raw: string | undefined,
): string | null {
  // Absent means EXACTLY undefined or "" - no trimming, matching
  // validateModelFamily's codex canonicalizer (any length>0 string is a
  // provided value). A whitespace-only string is therefore a PROVIDED value
  // and fails the family checks below rather than sliding to the default.
  if (raw === undefined || raw === "") return null;
  if (agentType === "codex") {
    if (isClaudeFamily(raw)) {
      return `"${raw}" is a Claude model family, not a Codex model. Pass a Codex model slug (e.g. "${CODEX_MODELS[0].value}"), or set agentType to "claude".`;
    }
    return null;
  }
  if (agentType === "opencode") {
    if (!raw.includes("/")) {
      return `"${raw}" is not an OpenCode provider/model ID (expected provider/model).`;
    }
    return null;
  }
  if (isClaudeFamily(raw)) return null;
  const families = MODEL_FAMILIES.map((m) => m.family).join(", ");
  return `"${raw}" is not a Claude model family (valid: ${families}). For a Codex model, set agentType to "codex".`;
}

export function validateCodexSandbox(
  raw: CodexSandboxMode | undefined,
): CodexSandboxMode | undefined {
  if (
    raw === "read-only" ||
    raw === "workspace-write" ||
    raw === "danger-full-access"
  )
    return raw;
  // Cron relies on undefined to retain the adapter's workspace-write fallback;
  // agent defaults belong in resolveAgentEngineSettings below.
  return undefined;
}

export function resolveAgentEngineSettings(
  agentType: AgentBackendType,
  raw: {
    modelFamily?: string;
    effort?: EffortLevel;
    permissionMode?: AgentPermissionMode;
    codexSandbox?: CodexSandboxMode;
  },
) {
  const modelFamily = validateModelFamily(agentType, raw.modelFamily);
  return {
    modelFamily,
    effort: validateEffort(agentType, modelFamily, raw.effort),
    permissionMode: validatePermissionMode(agentType, raw.permissionMode),
    codexSandbox:
      agentType === "codex"
        ? (validateCodexSandbox(raw.codexSandbox) ?? "danger-full-access")
        : undefined,
  };
}

export function validateEffort(
  agentType: AgentBackendType,
  modelFamily: string,
  raw: EffortLevel | undefined,
): EffortLevel {
  if (agentType === "codex") {
    // Pass-through for Codex: the per-model supportedReasoningEfforts from
    // model/list is the real allow-list, and it can include values outside
    // our static EFFORT_LEVELS (e.g. "none"). Trust any non-empty string
    // and let codex reject at thread/start.
    if (raw && typeof raw === "string" && raw.length > 0) return raw;
    return DEFAULT_EFFORT;
  }
  if (agentType === "opencode") return DEFAULT_EFFORT;
  if (!raw || !EFFORT_LEVELS.some((e) => e.level === raw))
    return DEFAULT_EFFORT;
  // Claude family-level rules: "minimal" and "ultra" are Codex-only; "max"
  // is top-tier only.
  if (raw === "minimal" || raw === "ultra") return DEFAULT_EFFORT;
  if (raw === "max" && !claudeFamilySupportsMaxEffort(modelFamily))
    return DEFAULT_EFFORT;
  return raw;
}

// Cron-specific permission narrowing. The full agent permission set includes
// modes that block on human approval (Claude "default"/"acceptEdits"/"auto",
// Codex "untrusted"/"on-request"); those would hang forever in an unattended
// run because cron has no /resolve responder. Falls back to the safest
// per-backend default that runs without prompts.
//
// Claude "auto" is explicitly excluded - ClaudeSession always installs
// canUseTool, and cron's normalized consumer can't resolve approval_request
// events. A stale client sending `auto` is migrated to `bypassPermissions`.
export function validateCronjobPermissionMode(
  agentType: AgentBackendType,
  raw: string | undefined,
): CronjobPermissionMode {
  if (agentType === "codex") return "never";
  // Claude: only "bypassPermissions" is unattended-safe with the Backend
  // abstraction. Migrate legacy "auto" up to "bypassPermissions".
  if (raw === "bypassPermissions") return "bypassPermissions";
  return "bypassPermissions";
}
