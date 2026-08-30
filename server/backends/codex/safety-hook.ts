/** Standalone Codex PreToolUse adapter for the isomux safety policy. */

import { isAbsolute } from "path";
import {
  evaluateProposedAction,
  type PolicyDecision,
  type ProposedAction,
} from "../../safety-policy.ts";

declare const ISOMUX_SAFETY_HOOK_SOURCE_SHA256: string | undefined;

export const SAFETY_WARNING =
  "ISOMUX SAFETY WARNING: Safety checks failed for this tool call. " +
  "Isomux allowed it without guard enforcement. Tell the office owner and " +
  "check the isomux service logs.";

export const EMBEDDED_SOURCE_SHA256 =
  typeof ISOMUX_SAFETY_HOOK_SOURCE_SHA256 === "string"
    ? ISOMUX_SAFETY_HOOK_SOURCE_SHA256
    : "development-uncompiled";

export const MISSING_CWD_WARNING =
  "ISOMUX SAFETY WARNING: This Codex tool call did not include a non-empty " +
  "absolute cwd. Guard coverage for relative paths is reduced; tell the " +
  "office owner.";

interface CodexHookEnvelope {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: unknown;
}

export type CodexHookOutput =
  | Record<string, never>
  | { systemMessage: string }
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEnvelope(value: unknown): CodexHookEnvelope {
  if (!isRecord(value)) throw new Error("hook input must be a JSON object");
  if (value.hook_event_name !== "PreToolUse") {
    throw new Error("hook event must be PreToolUse");
  }
  if (typeof value.tool_name !== "string" || !value.tool_name) {
    throw new Error("hook tool_name must be a non-empty string");
  }
  if (!isRecord(value.tool_input)) {
    throw new Error("hook tool_input must be a JSON object");
  }
  return value as unknown as CodexHookEnvelope;
}

export function codexEnvelopeToAction(value: unknown): ProposedAction {
  const input = parseEnvelope(value);
  if (input.tool_name === "Bash") {
    return { kind: "shell", command: input.tool_input.command };
  }
  if (input.tool_name === "apply_patch") {
    return {
      kind: "patch-files",
      toolName: input.tool_name,
      patch: input.tool_input.command,
    };
  }
  return {
    kind: "uncovered-tool",
    toolName: input.tool_name,
    input: input.tool_input,
  };
}

export function policyDecisionToCodexOutput(
  decision: PolicyDecision,
  systemMessage?: string,
): CodexHookOutput {
  if (decision.decision === "allow") {
    return systemMessage ? { systemMessage } : {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: systemMessage
        ? `${decision.reason}\n\n${systemMessage}`
        : decision.reason,
    },
  };
}

export function evaluateCodexHookEnvelope(value: unknown): CodexHookOutput {
  const input = parseEnvelope(value);
  const cwdValid =
    typeof input.cwd === "string" &&
    input.cwd.length > 0 &&
    isAbsolute(input.cwd);
  return policyDecisionToCodexOutput(
    evaluateProposedAction(codexEnvelopeToAction(input), { cwd: input.cwd }),
    cwdValid ? undefined : MISSING_CWD_WARNING,
  );
}

export function handleCodexHookInput(input: string): CodexHookOutput {
  try {
    return evaluateCodexHookEnvelope(JSON.parse(input));
  } catch {
    return { systemMessage: SAFETY_WARNING };
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--source-hash") {
    process.stdout.write(`${EMBEDDED_SOURCE_SHA256}\n`);
  } else {
    const input = await Bun.stdin.text();
    process.stdout.write(`${JSON.stringify(handleCodexHookInput(input))}\n`);
  }
}
