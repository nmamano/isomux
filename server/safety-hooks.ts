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

function callbackFor(
  toAction: (input: PreToolUseHookInput) => ProposedAction,
): HookCallback {
  return async (input) =>
    toClaudeDecision(
      evaluateProposedAction(toAction(input as PreToolUseHookInput), {
        cwd: (input as PreToolUseHookInput).cwd,
      }),
    );
}

const shell = callbackFor((input) => ({
  kind: "shell",
  command: (input.tool_input as { command?: unknown })?.command,
}));

function fileAction(
  kind: "read-files" | "write-files" | "read-and-write-files",
) {
  return callbackFor((input) => ({
    kind,
    toolName: input.tool_name,
    input: input.tool_input,
  }));
}

const readFiles = fileAction("read-files");
const writeFiles = fileAction("write-files");
const readAndWriteFiles = fileAction("read-and-write-files");

export function createSafetyHooks(): Partial<
  Record<HookEvent, HookCallbackMatcher[]>
> {
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
