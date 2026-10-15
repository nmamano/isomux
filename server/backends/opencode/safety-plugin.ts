// Isomux's OpenCode plugin: the office safety policy on every tool call, the
// equivalent of the PreToolUse deny Claude and Codex agents get. Config
// permissions and other plugins decide whether OpenCode asks the member; this
// hook runs after them, on the arguments the tool receives, and a deny throws,
// which fails the tool call with the reason.
//
// start-server.ts bundles this file with the Isomux server's home and state
// root (OpenCode runs with the profile's), and the top config layer loads it
// after every user and project plugin. OpenCode only logs a plugin that fails
// to load, so the plugin also registers OPENCODE_SAFETY_TOOL, and the
// transport runs no prompt in a folder whose tools lack it.
import { isAbsolute, resolve } from "node:path";
import {
  evaluateProposedAction,
  type ProposedAction,
} from "../../safety-policy.ts";
import { OPENCODE_SAFETY_TOOL } from "./safety-plugin-tool.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// The policy action for one OpenCode 1.18.35 tool call and the directory it
// runs in, or null for a tool the policy has no check for.
export function openCodeToolAction(
  tool: string,
  args: unknown,
  directory: string,
): { action: ProposedAction; cwd: string } | null {
  const input = record(args);
  switch (tool) {
    case "bash": {
      const workdir = input.workdir;
      return {
        action: { kind: "shell", command: input.command },
        cwd:
          typeof workdir === "string" && workdir
            ? isAbsolute(workdir)
              ? workdir
              : resolve(directory, workdir)
            : directory,
      };
    }
    case "read":
      return {
        action: { kind: "read-files", toolName: "read", input },
        cwd: directory,
      };
    // The policy's Grep entry: the path and the file pattern are optional.
    case "grep":
      return {
        action: {
          kind: "read-files",
          toolName: "Grep",
          input: { path: input.path, glob: input.include },
        },
        cwd: directory,
      };
    // As the ask path maps OpenCode's edit permission (safety-adapter.ts).
    case "edit":
    case "write":
      return {
        action: { kind: "write-files", toolName: "write", input },
        cwd: directory,
      };
    case "apply_patch":
      return {
        action: {
          kind: "patch-files",
          toolName: tool,
          patch: input.patchText,
        },
        cwd: directory,
      };
    default:
      return null;
  }
}

export default {
  id: "isomux-safety",
  server: async ({ directory }: { directory: string }) => ({
    tool: {
      [OPENCODE_SAFETY_TOOL]: {
        description: "Isomux safety checks are active in this folder.",
        args: {},
        execute: async () => "Isomux safety checks are active.",
      },
    },
    "tool.execute.before": async (
      input: { tool: string },
      output: { args: unknown },
    ) => {
      const call = openCodeToolAction(input.tool, output.args, directory);
      if (!call) return;
      const decision = evaluateProposedAction(call.action, { cwd: call.cwd });
      if (decision.decision === "deny") throw new Error(decision.reason);
    },
  }),
};
