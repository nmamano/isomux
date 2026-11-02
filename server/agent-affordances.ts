// The office MCP servers of each agent and the chat affordances agents
// call (edit request, terminal command, read file, preview URL, browser,
// diff, ask outcomes). Moved out of createAgentManager
// (server/agent-manager.ts), which wires it.
import { readFileSync } from "fs";
import { basename } from "path";
import {
  stopHasFolder,
  stopHasPack,
  type AgentAccess,
} from "../shared/agent-access.ts";
import { errMessage } from "../shared/errors.ts";
import {
  msg,
  renderLogText,
  type LogMessage,
  type LogText,
} from "../shared/i18n/log-message.ts";
import type { AgentInfo, Attachment, LogEntry } from "../shared/types.ts";
import {
  checkTerminalCommand,
  probeEditFile,
  probeReadFile,
  MAX_READ_FILE_BYTES,
  TERMINAL_COMMAND_MAX_LEN,
  type CommandCheck,
  type PathRefusal,
} from "./affordance-checks.ts";
import { getAgentHost } from "./agent-host.ts";
import type { ManagerDeps } from "./agent-manager.ts";
import { loopbackPort } from "./auth.ts";
import { CREDENTIAL_PATH_MESSAGE } from "./credential-store-paths.ts";
import {
  FOLDER_FILES_MCP_PATH,
  FOLDER_FILES_MCP_SERVER,
} from "./folder-files.ts";
import { english } from "./i18n.ts";
import { getAgentTokenRaw, resolveToken } from "./identity/tokens.ts";
import type { ManagedAgent } from "./internal-types.ts";
import { officeMcpToolNames } from "./mcp-endpoint.ts";
import {
  createMcpServerSources,
  mcpServersForUserId,
  type AgentMcpServer,
} from "./mcp-servers.ts";
import type { createMessageQueue } from "./message-queue.ts";
import { mimeTypeForFilename } from "./mime-types.ts";
import { saveFile as savePersistedFile } from "./persistence.ts";
import { capturePreview, type PreviewCaptureDeps } from "./preview-capture.ts";
import { getUserById } from "./users.ts";

// The chat's terminal-command answer for each refusal (an HTTP 400 body).
const TERMINAL_COMMAND_ERRORS: Record<
  Exclude<CommandCheck, { ok: true }>["kind"],
  string
> = {
  empty: "empty command",
  too_long: `command too long (max ${TERMINAL_COMMAND_MAX_LEN} chars)`,
  multi_line: "command must be single-line; join steps with && or ;",
};

export type AskReadFileCopy =
  | { ok: true; attachment: Attachment }
  | { ok: false; kind: "io_error"; path: string; message: string }
  | { ok: false; kind: "save_failed"; path: string };

export interface AgentAffordancesDeps {
  agents: Map<string, ManagedAgent>;
  addLogEntry: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
    extra?: Partial<
      Pick<LogEntry, "diff" | "file" | "terminal" | "secretRequest">
    >,
    opts?: { durable?: boolean; open?: boolean },
  ) => unknown;
  prepareEnqueue: (agentId: string) => Promise<void>;
  enqueueMessage: ReturnType<typeof createMessageQueue>["enqueueMessage"];
  // The manager's browser action, with its default when none is paired.
  runBrowserAction: NonNullable<ManagerDeps["runBrowserAction"]>;
}

export function createAgentAffordances(deps: AgentAffordancesDeps) {
  const {
    agents,
    addLogEntry,
    prepareEnqueue,
    enqueueMessage,
    runBrowserAction,
  } = deps;

  // The remote MCP servers a member's agents get (server/mcp-servers.ts).
  // Never throws: a problem leaves servers out.
  const mcpSources = createMcpServerSources();
  // The one MCP server of an agent below standard: the office's own /mcp,
  // with the agent's token (none at chat). The member's and the office's
  // connections are off.
  function officeMcpServerFor(
    agentId: string,
    access: AgentAccess,
  ): AgentMcpServer[] {
    const token = getAgentTokenRaw(agentId);
    if (!stopHasPack(access) || !token) return [];
    return [
      {
        name: "isomux",
        url: `http://127.0.0.1:${loopbackPort()}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    ];
  }

  // The file tools of a Codex agent at folder or web: Isomux's isomux_files
  // server (folder-mcp-endpoint.ts) on the agent's token. Codex has no file
  // reading tool without its shell; Claude and OpenCode have their own.
  function folderFilesServerFor(
    agentId: string,
    agentType: string,
    access: AgentAccess,
  ): AgentMcpServer[] {
    const token = getAgentTokenRaw(agentId);
    if (agentType !== "codex" || !stopHasFolder(access) || !token) return [];
    return [
      {
        name: FOLDER_FILES_MCP_SERVER,
        url: `http://127.0.0.1:${loopbackPort()}${FOLDER_FILES_MCP_PATH}`,
        headers: { Authorization: `Bearer ${token}` },
      },
    ];
  }

  // The office MCP server's tool names for the agent's token: an OpenCode
  // agent below standard allows exactly these (task e77304b1). None at chat.
  function officeToolsFor(agentId: string, access: AgentAccess): string[] {
    const token = getAgentTokenRaw(agentId);
    if (!stopHasPack(access) || !token) return [];
    const identity = resolveToken(token);
    return identity ? officeMcpToolNames(identity) : [];
  }

  function agentMcpServers(userId: string | null | undefined) {
    return mcpServersForUserId(mcpSources, userId);
  }

  function tokenUserIdFor(info: AgentInfo): string | null {
    return info.userId;
  }

  /**
   * The two "too large" system entries. The size is a value each reader
   * words in their number format (ruling 12); the sentences are the ones
   * /isomux-edit and the read-file path already showed.
   */
  function editorTooLargeText(path: string, bytes: number): LogMessage {
    return msg("systemEntries.pathRefusal.tooLarge", {
      path,
      size: { bytes },
    });
  }

  function readTooLargeText(path: string, bytes: number): LogMessage {
    return msg("systemEntries.fileTooLargeToDisplay", {
      path,
      size: { bytes },
      limit: { number: MAX_READ_FILE_BYTES / (1024 * 1024), digits: 0 },
    });
  }

  // The system line for a path an affordance refused. bad_path never gets
  // here: the chat ops answer it with a 400.
  function pathRefusalText(
    refusal: Pick<PathRefusal, "kind" | "path" | "size" | "message">,
    opening: "edit" | "read",
  ): LogMessage {
    const path = refusal.path;
    switch (refusal.kind) {
      case "not_found":
        return msg("systemEntries.pathRefusal.notFound", { path });
      case "not_file":
        return msg("systemEntries.pathRefusal.notFile", { path });
      case "binary":
        return msg("systemEntries.pathRefusal.binary", { path });
      case "credential":
        return msg("systemEntries.pathRefusal.credential", { path });
      case "too_large":
        return opening === "edit"
          ? editorTooLargeText(path, refusal.size ?? 0)
          : readTooLargeText(path, refusal.size ?? 0);
      default:
        return msg(
          opening === "edit"
            ? "systemEntries.fileOpenFailed"
            : "systemEntries.fileReadFailed",
          { path, message: refusal.message ?? "" },
        );
    }
  }

  // Run the same path-resolution as /isomux-edit and emit an `edit-request` log
  // entry so the member can open the file in the editor side panel. Mirrors
  // emitAgentDiff. The card shows an [Open in editor] button. With `open`, the
  // live event also asks each client that has this chat on screen to open the
  // file once (task 043bf145); the server never opens a panel itself. The
  // probe makes a typo'd path a system message instead of a dead card.
  function emitAgentEditRequest(
    agentId: string,
    rawPath: string,
    opts?: { open?: boolean },
  ): { ok: true } | { ok: false; status: number; error: string } {
    const managed = agents.get(agentId);
    if (!managed) return { ok: false, status: 404, error: "agent not found" };
    const probe = probeEditFile(rawPath, managed.info.cwd);
    if (!probe.ok) {
      if (probe.kind === "bad_path")
        return { ok: false, status: 400, error: "missing or empty path" };
      addLogEntry(agentId, "system", pathRefusalText(probe, "edit"));
      return { ok: true };
    }
    addLogEntry(
      agentId,
      "edit-request",
      probe.file.path,
      undefined,
      undefined,
      { file: probe.file },
      { open: opts?.open },
    );
    return { ok: true };
  }

  // Validate a command string and emit a `terminal-command` log entry so the
  // member sees a [Copy to terminal] card. Mirrors emitAgentEditRequest,
  // including `open`; the command is never run.
  function emitAgentTerminalCommand(
    agentId: string,
    rawCommand: string,
    opts?: { open?: boolean },
  ): { ok: true } | { ok: false; status: number; error: string } {
    const managed = agents.get(agentId);
    if (!managed) return { ok: false, status: 404, error: "agent not found" };
    if (typeof rawCommand !== "string")
      return { ok: false, status: 400, error: "command must be a string" };
    const checked = checkTerminalCommand(rawCommand);
    if (!checked.ok)
      return {
        ok: false,
        status: 400,
        error: TERMINAL_COMMAND_ERRORS[checked.kind],
      };
    addLogEntry(
      agentId,
      "terminal-command",
      checked.command,
      undefined,
      undefined,
      { terminal: { command: checked.command } },
      { open: opts?.open },
    );
    return { ok: true };
  }

  // A secret request's outcome: the system entry that records it (it also
  // settles a card from a server before secret requests were asks), and the
  // same line to the agent as an office notice from the member who answered.
  function emitAgentSecretRequestSettled(
    agentId: string,
    requestId: string,
    outcome: "saved" | "declined",
    line: LogMessage,
    answeredBy: string,
  ): void {
    emitAgentAskOutcome(
      agentId,
      line,
      { secretRequestSettled: requestId, outcome },
      answeredBy,
    );
  }

  // A step ask closed itself (task c71cb60f): its step is done.
  function emitAgentStepAskDone(
    agentId: string,
    askId: string,
    line: LogMessage,
    memberUserId: string,
  ): void {
    emitAgentAskOutcome(agentId, line, { stepAskDone: askId }, memberUserId);
  }

  // An ask's outcome the agent did not see happen: a system line in its
  // chat (with `metadata`), and the same line to the agent as an office
  // notice from `member`, whose turn and usage cap it is.
  function emitAgentAskOutcome(
    agentId: string,
    line: LogMessage,
    metadata: Record<string, unknown>,
    member: string,
  ): void {
    if (!agents.has(agentId)) return;
    addLogEntry(agentId, "system", line, metadata);
    const username = getUserById(member)?.name;
    void prepareEnqueue(agentId)
      .then(() => {
        const result = enqueueMessage(agentId, {
          sender: { kind: "user", ...(username ? { username } : {}) },
          text: `[Isomux: ${renderLogText(english, line)}]`,
          notice: true,
        });
        if (!result.ok)
          console.error(
            `[asks] the agent was not told an outcome: ${result.status} ${result.error}`,
          );
      })
      .catch(() => console.error("[asks] the agent was not told an outcome"));
  }

  // Copy a path that passed probeReadFile into the agent's files dir
  // (hash-deduped via saveFile). The read-file chip and an ask's read file
  // both show this copy, so the member sees the bytes of the moment the agent
  // sent it. Null when the agent is gone.
  function copyAskReadFile(
    agentId: string,
    absPath: string,
  ): AskReadFileCopy | null {
    if (!agents.has(agentId)) return null;
    let data: Buffer;
    try {
      data = readFileSync(absPath);
    } catch (err) {
      return {
        ok: false,
        kind: "io_error",
        path: absPath,
        message: errMessage(err),
      };
    }
    const originalName = basename(absPath);
    const mediaType = mimeTypeForFilename(originalName);
    const attachment = savePersistedFile(
      agentId,
      data,
      mediaType,
      originalName,
    );
    return attachment
      ? { ok: true, attachment }
      : { ok: false, kind: "save_failed", path: absPath };
  }

  // Resolve a path against the agent's cwd, copy it into the agent's files dir,
  // and emit a `file-view` log entry so the UI renders the attachment inline.
  // Replaces the older convention of asking agents to Read an image so the
  // Claude SDK's tool_result image extraction would surface it. Mirrors
  // emitAgentEditRequest's error-surface pattern: path/size/io failures become
  // system messages, not HTTP errors.
  function emitAgentReadFile(
    agentId: string,
    rawPath: string,
  ):
    | { ok: true }
    | { ok: false; status: number; code?: string; error: string } {
    const managed = agents.get(agentId);
    if (!managed) return { ok: false, status: 404, error: "agent not found" };
    const probe = probeReadFile(rawPath, managed.info.cwd);
    if (!probe.ok) {
      if (probe.kind === "bad_path")
        return { ok: false, status: 400, error: "missing or empty path" };
      if (probe.kind === "credential")
        return {
          ok: false,
          status: 403,
          code: "credential_path",
          error: CREDENTIAL_PATH_MESSAGE,
        };
      addLogEntry(agentId, "system", pathRefusalText(probe, "read"));
      return { ok: true };
    }
    const copied = copyAskReadFile(agentId, probe.path);
    if (!copied) return { ok: false, status: 404, error: "agent not found" };
    if (!copied.ok) {
      addLogEntry(
        agentId,
        "system",
        copied.kind === "save_failed"
          ? msg("systemEntries.fileSaveFailed", {
              path: probe.path,
            })
          : pathRefusalText(copied, "read"),
      );
      return { ok: true };
    }
    addLogEntry(
      agentId,
      "file-view",
      copied.attachment.originalName,
      undefined,
      [copied.attachment],
    );
    return { ok: true };
  }

  // Screenshot a URL (headless Chrome CLI via preview-capture.ts)
  // and emit a `file-view` card, reusing read-file's attachment path. Used by
  // POST /api/agents/:id/preview-url. Unlike the sync
  // affordances this is async, and failures return structured HTTP errors
  // (status + code) instead of system chat messages: a failed screenshot has
  // no member-facing value, and the calling agent is the one who must react
  // (start the dev server, fix the URL, retry). The entry's `content` is the
  // sanitized origin+pathname; the UI renders it as a visible caption.
  async function emitAgentPreviewUrl(
    agentId: string,
    body: unknown,
    appGrant?: PreviewCaptureDeps["appGrant"],
  ): Promise<
    { ok: true } | { ok: false; status: number; code: string; error: string }
  > {
    const managed = agents.get(agentId);
    if (!managed)
      return {
        ok: false,
        status: 404,
        code: "not_found",
        error: "agent not found",
      };
    const result = await capturePreview(body, { appGrant });
    if (!result.ok) return result;
    const att = savePersistedFile(
      agentId,
      result.png,
      "image/png",
      result.filename,
    );
    if (!att) {
      return {
        ok: false,
        status: 500,
        code: "save_failed",
        error: "failed to persist the screenshot",
      };
    }
    // metadata.preview marks the caption as renderable: the UI shows
    // `content` under the image ONLY for entries carrying this marker, so
    // read-file cards (content = the attachment's own filename) and any other
    // file-view producer stay caption-free by explicit contract, not
    // inference.
    addLogEntry(agentId, "file-view", result.caption, { preview: true }, [att]);
    return { ok: true };
  }

  // Drive a page in the paired Chrome browser (server/browser-extension-session.ts) for
  // POST /api/agents/:id/browser. Unlike the other affordances this answers
  // with DATA - the agent reads the page out of the response - so the payload
  // travels back to the handler instead of into the chat. The one exception is
  // the screenshot action: its PNG becomes the same `file-view` preview card
  // preview-url emits, and the bytes are dropped from the response, because a
  // base64 image in a curl result is worth nothing to the agent and costs it a
  // large part of a context window.
  async function runAgentBrowserAction(
    agentId: string,
    body: unknown,
  ): Promise<
    | {
        ok: true;
        url: string;
        title: string;
        snapshot?: string;
        text?: string;
        closed?: boolean;
      }
    | {
        ok: false;
        status: number;
        code: string;
        error: string;
        dialogs?: { type: string; message: string; accepted: boolean }[];
      }
  > {
    const managed = agents.get(agentId);
    if (!managed)
      return {
        ok: false,
        status: 404,
        code: "not_found",
        error: "agent not found",
      };
    const result = await runBrowserAction(
      agentId,
      body,
      managed.info.userId ?? null,
    );
    if (!result.ok) return result;
    const { png, filename, caption, ...payload } = result;
    if (png && filename && caption) {
      const att = savePersistedFile(agentId, png, "image/png", filename);
      if (!att) {
        return {
          ok: false,
          status: 500,
          code: "save_failed",
          error: "failed to persist the screenshot",
        };
      }
      addLogEntry(agentId, "file-view", caption, { preview: true }, [att]);
    }
    return payload;
  }

  // Run the same diff machinery as /isomux-diff and emit the result into the
  // agent's chat stream. Used by POST /api/agents/:id/diff so an agent can show
  // the member a styled diff card without the member invoking the slash command.
  async function emitAgentDiff(
    agentId: string,
    dir?: string,
    commit?: string,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const managed = agents.get(agentId);
    if (!managed) return { ok: false, status: 404, error: "agent not found" };
    const result = await getAgentHost().isomuxDiff({
      dir,
      agentCwd: managed.info.cwd,
      commit,
    });
    switch (result.kind) {
      case "bad_dir":
        return {
          ok: false,
          status: 400,
          error: `\`${result.attempted}\` is not a directory`,
        };
      case "not_repo":
        addLogEntry(
          agentId,
          "system",
          msg("systemEntries.diffNotRepo", {
            path: result.cwd,
          }),
        );
        break;
      case "git_error":
        addLogEntry(agentId, "system", [
          msg("systemEntries.diffFailed", { path: result.cwd }),
          `\n\n\`\`\`\n${result.message}\n\`\`\``,
        ]);
        break;
      case "bad_commit":
        addLogEntry(
          agentId,
          "system",
          msg("systemEntries.diffBadDir", {
            path: result.attempted,
            message: result.message,
          }),
        );
        break;
      case "clean":
        addLogEntry(
          agentId,
          "system",
          commit
            ? msg("systemEntries.diffEmptyCommit", { commit })
            : msg("systemEntries.diffClean", {
                path: result.cwd,
              }),
        );
        break;
      case "ok":
        addLogEntry(agentId, "diff", result.summary, undefined, undefined, {
          diff: result.payload,
        });
        break;
    }
    return { ok: true };
  }

  return {
    officeMcpServerFor,
    folderFilesServerFor,
    officeToolsFor,
    agentMcpServers,
    tokenUserIdFor,
    emitAgentEditRequest,
    emitAgentTerminalCommand,
    emitAgentSecretRequestSettled,
    emitAgentStepAskDone,
    copyAskReadFile,
    emitAgentReadFile,
    emitAgentPreviewUrl,
    runAgentBrowserAction,
    emitAgentDiff,
  };
}
