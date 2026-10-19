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
  type PolicyDecision,
  type ProposedAction,
} from "./safety-policy.ts";

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
): HookCallback {
  return async (input) =>
    toClaudeDecision(
      evaluateProposedAction(toAction(input as PreToolUseHookInput), {
        cwd: (input as PreToolUseHookInput).cwd,
        codexHome,
      }),
    );
}

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

// codexHome is the session's CODEX_HOME (safety-policy.ts PolicyContext).
export function createSafetyHooks(
  codexHome?: string | null,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const shell = callbackFor(shellAction, codexHome);
  const readFiles = callbackFor(fileAction("read-files"), codexHome);
  const writeFiles = callbackFor(fileAction("write-files"), codexHome);
  const readAndWriteFiles = callbackFor(
    fileAction("read-and-write-files"),
    codexHome,
  );
  return {
    // One entry per Claude tool name. The adapter maps provider names to core
    // action kinds; the core owns which checks each action kind runs.
    PreToolUse: [
      { matcher: "Bash", hooks: [shell] },
      { matcher: "Read", hooks: [readFiles] },
      { matcher: "NotebookRead", hooks: [readFiles] },
      { matcher: "Grep", hooks: [readFiles] },
      { matcher: "Write", hooks: [writeFiles] },
      { matcher: "Edit", hooks: [writeFiles] },
      { matcher: "MultiEdit", hooks: [writeFiles] },
      { matcher: "NotebookEdit", hooks: [readAndWriteFiles] },
    ],
  };
}
