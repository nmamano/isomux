/** Standalone Codex PreToolUse adapter for the isomux safety policy. */

import { isAbsolute } from "path";
import {
  evaluateProposedAction,
  type PolicyDecision,
  type ProposedAction,
} from "../../safety-policy.ts";
import { readCodexConfine, type CodexConfine } from "./confine-env.ts";

declare const ISOMUX_SAFETY_HOOK_SOURCE_SHA256: string | undefined;

export const SAFETY_WARNING =
  "Isomux safety check skipped: Isomux could not run its safety check on " +
  "this tool call, so the call ran unchecked. Tell the office owner and " +
  "check the Isomux service logs.";

const EMBEDDED_SOURCE_SHA256 =
  typeof ISOMUX_SAFETY_HOOK_SOURCE_SHA256 === "string"
    ? ISOMUX_SAFETY_HOOK_SOURCE_SHA256
    : "development-uncompiled";

export const MISSING_CWD_WARNING =
  "Isomux safety check reduced: this Codex tool call arrived without an " +
  "absolute working directory, so relative paths were checked less " +
  "thoroughly. Tell the office owner.";

// A refusal's report to the Isomux session (task fcfffe51): the deny output's
// systemMessage, which Codex shows as a warning entry of the hook run's
// hook/completed and never sends to the model. The prefix, then the JSON of a
// CodexRefusal.
export const CODEX_REFUSAL_PREFIX = "isomux-refusal:";

// What the hook reports of a refused call: its id, its tool name and input as
// the hook received them, and the folder the call runs in (the envelope cwd).
export interface CodexRefusal {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
}

// The refusal in a warning entry's text, or null when the text is no
// refusal report or does not parse.
export function parseCodexRefusal(text: string): CodexRefusal | null {
  if (!text.startsWith(CODEX_REFUSAL_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(CODEX_REFUSAL_PREFIX.length));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { toolUseId, toolName, toolInput, cwd } = value;
  if (typeof toolUseId !== "string" || !toolUseId) return null;
  if (typeof toolName !== "string" || !isRecord(toolInput)) return null;
  if (cwd !== undefined && typeof cwd !== "string") return null;
  return { toolUseId, toolName, toolInput, ...(cwd ? { cwd } : {}) };
}

// The report of a refused call, or undefined when the call has no id.
function refusalReport(input: CodexHookEnvelope): string | undefined {
  if (typeof input.tool_use_id !== "string" || !input.tool_use_id) return;
  const refusal: CodexRefusal = {
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    ...(typeof input.cwd === "string" && input.cwd ? { cwd: input.cwd } : {}),
  };
  return `${CODEX_REFUSAL_PREFIX}${JSON.stringify(refusal)}`;
}

interface CodexHookEnvelope {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: unknown;
  tool_use_id?: unknown;
}

export type CodexHookOutput =
  | Record<string, never>
  | { systemMessage: string }
  | {
      // The refusal's report (refusalReport), never sent to the model.
      systemMessage?: string;
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

function codexEnvelopeToAction(value: unknown): ProposedAction {
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

// `report`: the refusal's report, sent with a deny only.
function policyDecisionToCodexOutput(
  decision: PolicyDecision,
  systemMessage?: string,
  report?: string,
): CodexHookOutput {
  if (decision.decision === "allow") {
    return systemMessage ? { systemMessage } : {};
  }
  return {
    ...(report ? { systemMessage: report } : {}),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: systemMessage
        ? `${decision.reason}\n\n${systemMessage}`
        : decision.reason,
    },
  };
}

// codexHome defaults to the hook's own environment: Codex runs the hook with
// the app-server's env, so CODEX_HOME there is the agent's.
// `confine`: the folder confinement of a session at the folder or web stop
// (confine-env.ts), null otherwise.
export function evaluateCodexHookEnvelope(
  value: unknown,
  codexHome: string | undefined = process.env.CODEX_HOME,
  confine: CodexConfine | null = null,
): CodexHookOutput {
  const input = parseEnvelope(value);
  const cwdValid =
    typeof input.cwd === "string" &&
    input.cwd.length > 0 &&
    isAbsolute(input.cwd);
  return policyDecisionToCodexOutput(
    evaluateProposedAction(codexEnvelopeToAction(input), {
      cwd: input.cwd,
      codexHome,
      ...(confine ? { confine } : {}),
    }),
    cwdValid ? undefined : MISSING_CWD_WARNING,
    refusalReport(input),
  );
}

export const CONFINED_CHECK_FAILED =
  "Isomux could not check this tool call, so it did not run.";

// Under a confinement (CODEX_CONFINE_ENV set in `env`), any error denies the
// call. Without one, an error lets the call run with a warning.
export function handleCodexHookInput(
  input: string,
  env: Record<string, string | undefined> = process.env,
): CodexHookOutput {
  let confine: CodexConfine | null;
  try {
    confine = readCodexConfine(env);
  } catch {
    return policyDecisionToCodexOutput({
      decision: "deny",
      reason: CONFINED_CHECK_FAILED,
    });
  }
  try {
    return evaluateCodexHookEnvelope(
      JSON.parse(input),
      env.CODEX_HOME,
      confine,
    );
  } catch {
    return confine
      ? policyDecisionToCodexOutput({
          decision: "deny",
          reason: CONFINED_CHECK_FAILED,
        })
      : { systemMessage: SAFETY_WARNING };
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
