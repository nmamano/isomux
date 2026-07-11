// Server-side validation for backend-specific spawn/edit options.
//
// The wire types are permissive (e.g. AgentInfo.permissionMode unions both
// backends' enums), so we narrow per agentType here. UI shouldn't send
// mismatched values, but a stale tab or hand-crafted client could.
//
// Used by both agent-manager.ts (agent spawn/edit) and the cronjob HTTP
// handlers (cron add/update). Cron-specific narrowing lives in
// validateCronjobPermissionMode below — its allowlist is a subset of the
// agent allowlist because cron runs unattended.

import {
  CODEX_MODELS,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
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
    return "on-request";
  }
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
  if (raw && isClaudeFamily(raw)) return raw;
  return "opus";
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
  return undefined;
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
// Claude "auto" is explicitly excluded — ClaudeSession always installs
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
