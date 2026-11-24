/** Claude adapter for the provider-neutral isomux safety policy. */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import {
  evaluateProposedAction,
  type FolderConfinement,
  type PolicyDecision,
  type ProposedAction,
} from "./safety-policy.ts";
import { hostForEnv } from "./member-hosts.ts";
import { isOfficeApiCall } from "./office-api-call.ts";

// The port agents reach the office API on, as server/system-prompt.ts names it.
const OFFICE_PORT = process.env.PORT || "4000";

const OFFICE_CALL_ALLOW: HookJSONOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "A call to this office's own API.",
  },
};

// GitHub #82: auto mode refused office calls such as GET /agents as
// "Undermining Oversight", and other modes prompt for them. A hook allow
// skips both; a deny rule in the member's own settings still wins. In plan
// mode only a read. Never for an agent confined to a folder.
function officeCallAllowed(
  input: PreToolUseHookInput,
  confine: FolderConfinement | undefined,
): boolean {
  if (confine) return false;
  const command = (input.tool_input as { command?: unknown })?.command;
  return (
    typeof command === "string" &&
    isOfficeApiCall(command, OFFICE_PORT, {
      readOnly: input.permission_mode === "plan",
    })
  );
}

function toClaudeDecision(decision: PolicyDecision): HookJSONOutput {
  if (decision.decision === "allow") return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  };
}

type ToAction = (input: PreToolUseHookInput) => ProposedAction;

function callbackFor(
  toAction: ToAction,
  codexHome: string | null | undefined,
  confine?: FolderConfinement,
  onDeny?: (denial: SafetyDenial) => void,
  shellHome?: string,
  officeCalls = false,
): HookCallback {
  return async (input) => {
    const hookInput = input as PreToolUseHookInput;
    const decision = evaluateProposedAction(toAction(hookInput), {
      cwd: hookInput.cwd,
      codexHome,
      ...(shellHome ? { shellHome } : {}),
      ...(confine ? { confine } : {}),
    });
    if (decision.decision === "deny" && onDeny)
      onDeny({
        toolUseId: hookInput.tool_use_id,
        toolName: hookInput.tool_name,
        reason: decision.reason,
      });
    if (
      decision.decision === "allow" &&
      officeCalls &&
      officeCallAllowed(hookInput, confine)
    )
      return OFFICE_CALL_ALLOW;
    return toClaudeDecision(decision);
  };
}

const uncoveredAction: ToAction = (input) => ({
  kind: "uncovered-tool",
  toolName: input.tool_name,
  input: input.tool_input,
});

const shellAction: ToAction = (input) => ({
  kind: "shell",
  command: (input.tool_input as { command?: unknown })?.command,
});

function fileAction(
  kind: "read-files" | "write-files" | "read-and-write-files",
): ToAction {
  return (input) => ({
    kind,
    toolName: input.tool_name,
    input: input.tool_input,
  });
}

// A refusal of the hooks (task 0faacc4e): the backend shows it as a refused
// card, as it does the SDK's own permission_denied.
export interface SafetyDenial {
  toolUseId: string;
  toolName: string;
  reason: string;
}

// codexHome is the session's CODEX_HOME (safety-policy.ts PolicyContext).
// confine: an agent below standard (safety-policy.ts FolderConfinement). Its
// Glob calls are checked too, since Glob takes a path. onDeny hears each
// refusal.
// shellHome: where `~` starts for the agent's tools; absent, the server's
// own home.
export function createSafetyHooks(
  codexHome?: string | null,
  confine?: FolderConfinement,
  onDeny?: (denial: SafetyDenial) => void,
  shellHome?: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const shell = callbackFor(
    shellAction,
    codexHome,
    confine,
    onDeny,
    shellHome,
    true,
  );
  const readFiles = callbackFor(
    fileAction("read-files"),
    codexHome,
    confine,
    onDeny,
    shellHome,
  );
  const writeFiles = callbackFor(
    fileAction("write-files"),
    codexHome,
    confine,
    onDeny,
    shellHome,
  );
  const readAndWriteFiles = callbackFor(
    fileAction("read-and-write-files"),
    codexHome,
    confine,
    onDeny,
    shellHome,
  );
  return {
    // One entry per Claude tool name. The adapter maps provider names to core
    // action kinds; the core owns which checks each action kind runs.
    PreToolUse: [
      { matcher: "Bash", hooks: [shell] },
      { matcher: "Read", hooks: [readFiles] },
      { matcher: "NotebookRead", hooks: [readFiles] },
      { matcher: "Grep", hooks: [readFiles] },
      ...(confine
        ? [
            { matcher: "Glob", hooks: [readFiles] },
            // Every other tool: the confinement denies a tool off the stop's
            // list, whatever lets it through.
            {
              hooks: [callbackFor(uncoveredAction, codexHome, confine, onDeny)],
            },
          ]
        : []),
      { matcher: "Write", hooks: [writeFiles] },
      { matcher: "Edit", hooks: [writeFiles] },
      { matcher: "MultiEdit", hooks: [writeFiles] },
      { matcher: "NotebookEdit", hooks: [readAndWriteFiles] },
    ],
  };
}

// The hooks of a session started with `env`: its CODEX_HOME, and for an
// isolated member's agent their home, so `~` in a tool call is theirs
// (internal-docs/member-os-user-design.md, slice 2d-i). An office agent's
// `~` stays the server's home.
export function createSafetyHooksForEnv(
  env: Record<string, string | undefined>,
  confine?: FolderConfinement,
  onDeny?: (denial: SafetyDenial) => void,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const host = hostForEnv(env);
  return createSafetyHooks(
    env.CODEX_HOME,
    confine,
    onDeny,
    host.member !== undefined ? host.home() : undefined,
  );
}
