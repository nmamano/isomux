// Isomux's OpenCode plugin: the office safety policy on every tool call, the
// equivalent of the PreToolUse deny Claude and Codex agents get. Config
// permissions and other plugins decide whether OpenCode asks the member; this
// hook runs after them, on the arguments the tool receives, and a deny throws,
// which fails that tool call alone with the reason (2.1.4 makes every throw of
// execute.before a Tool.Error).
//
// start-server.ts bundles this file with the Isomux server's home and state
// root (OpenCode runs with the profile's), into a folder the top config layer
// lists after every user and project plugin. OpenCode loads plugins
// fail-open, so the transport runs no prompt in a folder whose plugin list
// does not show this plugin active (S2).
import { isAbsolute, resolve } from "node:path";
import { stopHasFolder } from "../../../shared/agent-access.ts";
import {
  evaluateProposedAction,
  type FolderConfinement,
  type ProposedAction,
} from "../../safety-policy.ts";
import { openCodeAgentStop, openCodeAllowedTools } from "./stop-rules.ts";
import {
  OPENCODE_SAFETY_PLUGIN_ID,
  OPENCODE_SERVER_ONLY_VARIABLES,
  OPENCODE_SHELL_VARIABLES,
} from "./safety-plugin-tool.ts";
import type { OpenCodeSafetyShell } from "./safety-plugin-build.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// The policy action for one OpenCode 2.1.4 tool call and the directory it
// runs in, or null for a tool the policy has no check for. The names are the
// built-in tools' (core/src/tool/plugin/*.ts). A member's MCP tool keeps its
// own name, and Code Mode's "execute" runs each tool it calls through this
// hook by that tool's name, so neither has a check here.
export function openCodeToolAction(
  tool: string,
  args: unknown,
  directory: string,
): { action: ProposedAction; cwd: string } | null {
  const input = record(args);
  switch (tool) {
    case "shell": {
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
    case "patch":
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

// The shell variables, baked in by safety-plugin-build.ts. Unset when this
// file runs unbundled, as in tests.
declare const ISOMUX_SAFETY_SHELL: OpenCodeSafetyShell | undefined;
const SHELL =
  typeof ISOMUX_SAFETY_SHELL === "object" ? ISOMUX_SAFETY_SHELL : undefined;

// Gives a shell the agents' OS user's value of each shell variable that
// still holds the server's profile value (a shell that started from the
// server's environment), and deletes it where the user has none.
export function restoreOpenCodeShellVariables(
  env: Record<string, string | undefined>,
  shell: OpenCodeSafetyShell,
): void {
  for (const name of OPENCODE_SHELL_VARIABLES) {
    if (env[name] !== shell.profile[name]) continue;
    const value = shell.user[name];
    if (value === null) delete env[name];
    else env[name] = value;
  }
}

interface ToolEvent {
  tool: string;
  input: unknown;
  sessionID?: string;
  agent?: string;
}

interface ShellEvent {
  env: Record<string, string | undefined>;
}

interface Registration {
  dispose(): Promise<void>;
}

// The parts of the @opencode/plugin 2.1.4 promise context this plugin uses.
interface PluginContext {
  location: { directory: string };
  // The session, with the rule list Isomux sent (probe, 2026-11-01).
  session?: {
    get(input: { sessionID: string }): Promise<unknown>;
  };
  tool: {
    hook(
      name: "execute.before",
      callback: (event: ToolEvent) => void | Promise<void>,
    ): Promise<Registration>;
  };
  shell: {
    hook(
      name: "create.before",
      callback: (event: ShellEvent) => void,
    ): Promise<Registration>;
  };
}

// A tool call of a stop agent below standard: the policy with the folder
// confinement, whose tool list is the session's exact allows (P5: a member
// plugin's tool can name any permission, so a wildcard allow lets it in). A
// session it cannot read refuses the call. A tool with no policy entry (an
// office tool, webfetch) is checked against the list only; glob is checked
// as a read of its root and pattern.
async function confinedCall(
  ctx: PluginContext,
  directory: string,
  stop: NonNullable<ReturnType<typeof openCodeAgentStop>>,
  event: ToolEvent,
): Promise<void> {
  const session = event.sessionID
    ? await ctx.session?.get({ sessionID: event.sessionID })
    : undefined;
  const rules = (session as { permissions?: unknown } | null | undefined)
    ?.permissions;
  if (!Array.isArray(rules))
    throw new Error(
      "Isomux could not read this session's tools, so the call did not run.",
    );
  const confine: FolderConfinement = {
    access: stop,
    folder: stopHasFolder(stop) ? directory : null,
    tools: openCodeAllowedTools(rules),
  };
  const call =
    event.tool === "glob"
      ? {
          action: {
            kind: "read-files" as const,
            toolName: "Glob",
            input: record(event.input),
          },
          cwd: directory,
        }
      : (openCodeToolAction(event.tool, event.input, directory) ?? {
          action: {
            kind: "uncovered-tool" as const,
            toolName: event.tool,
            input: event.input,
          },
          cwd: directory,
        });
  const decision = evaluateProposedAction(call.action, {
    cwd: call.cwd,
    codexHome: process.env.CODEX_HOME,
    shellHome: SHELL?.user.HOME,
    shellTmpDir: SHELL?.user.TMPDIR,
    confine,
  });
  if (decision.decision === "deny") throw new Error(decision.reason);
}

export default {
  id: OPENCODE_SAFETY_PLUGIN_ID,
  // OpenCode reports the plugin active once setup resolves, and the
  // transport sends prompts from then on: setup waits for both hooks.
  async setup(ctx: PluginContext): Promise<void> {
    const directory = ctx.location.directory;
    await Promise.all([
      // No catch: a mapping or policy error throws too, and OpenCode fails
      // the call. A hook that caught and allowed would fail open.
      ctx.tool.hook("execute.before", (event): void | Promise<void> => {
        // A stop agent below standard (task e77304b1): the session's own
        // rules name its tools; anything else is refused.
        const stop = event.agent ? openCodeAgentStop(event.agent) : null;
        if (stop) return confinedCall(ctx, directory, stop, event);
        const call = openCodeToolAction(event.tool, event.input, directory);
        if (!call) return;
        const decision = evaluateProposedAction(call.action, {
          cwd: call.cwd,
          codexHome: process.env.CODEX_HOME,
          shellHome: SHELL?.user.HOME,
          shellTmpDir: SHELL?.user.TMPDIR,
        });
        if (decision.decision === "deny") throw new Error(decision.reason);
      }),
      // E2: a shell of a session whose environment Isomux did not set (a
      // subagent's, before its PUT lands) starts from the server's, which
      // holds the server password and the profile's HOME and XDG folders.
      // OpenCode spawns with this object's env.
      ctx.shell.hook("create.before", (event) => {
        for (const name of OPENCODE_SERVER_ONLY_VARIABLES)
          delete event.env[name];
        if (SHELL) restoreOpenCodeShellVariables(event.env, SHELL);
      }),
    ]);
  },
};
