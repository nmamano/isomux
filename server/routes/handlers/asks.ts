// Ask handlers (internal-docs/asks-design.md).
//
// Agent routes (/api/agents/:id/asks...): the route guard proves the
// token's agent is :id, so an agent reaches only its own list. App routes
// (/api/app/asks...): an app opens asks in the name of its message target
// agent, and reaches only the asks its own registration opened. Member routes
// (/api/asks...): only a member askVisibleTo admits (the member the ask is
// for, or an owner for an office secret request), while that member can
// still reach the agent's room; anyone else gets the same 404 as an unknown
// id. An office owner also reads other members' open asks
// (askShownToOwnerAsOther): the list and a file, never an answer. A secret request is answered on its own routes (secret-requests.ts),
// never with a reply, a dismiss or a filed task.
//
// A reply, a dismiss or a filed task is a member message to the agent through
// the path a typed message takes, so it wakes or resumes the agent the same
// way and is refused only where a typed message would be. The ask closes after
// the message is accepted; a refused message leaves it open.
//
// The store emits the per-recipient events on commit, so these handlers never
// emit directly. LEAF over the executor, the store and shared types.

import type { StepAsks, StepCheck } from "../../step-asks.ts";
import {
  ASK_HISTORY_LIMIT_DEFAULT,
  ASK_HISTORY_LIMIT_MAX,
  type AskHistory,
  type AskHistoryRecord,
  type AskLogRecord,
} from "../../ask-history.ts";
import {
  ok,
  created,
  fail,
  noContent,
  file,
  type RouteHandler,
} from "../executor.ts";
import { randomUUID } from "crypto";
import { basename, extname } from "path";
import { downloadHeader, mimeTypeForFilename } from "../../mime-types.ts";
import { actsForAgent, type Identity } from "../../identity/index.ts";
import {
  ASK_DISMISSED_TEXT,
  ASK_FILED_TEXT,
  ASK_SIMPLIFY_TEXT,
  ASK_SIMPLIFY_UNDO_TEXT,
  isValidPriority,
  type AskCloseInput,
  type AskEntry,
  type AskEvent,
  type AskReadFile,
  type TaskItem,
  type TaskPriority,
} from "../../../shared/types.ts";
import {
  MAX_READ_FILE_BYTES,
  TERMINAL_COMMAND_MAX_LEN,
  type CommandCheck,
  type EditFileCheck,
  type PathRefusal,
  type ReadFileCheck,
} from "../../affordance-checks.ts";
import type { AskReadFileCopy } from "../../agent-manager.ts";
import type {
  AskAgentWire,
  AskClosedWire,
  AskEventWire,
  AskLogEventWire,
} from "../../../shared/contract-shapes.ts";
import type { UserSendAcceptance } from "../../internal-types.ts";
import {
  askAgentWire,
  askMemberWire,
  askTaskFields,
  askShownToOwnerAsOther,
  askVisibleTo,
  AsksUnavailableError,
  ASK_AFFORDANCE_KEYS,
  ASK_AFFORDANCES_MAX,
  ASK_MAX_OPEN_PER_AGENT,
  type AskAffordanceEdit,
  type AskAffordances,
  checkOptions,
  checkRecommended,
  checkPromptField,
  type AskAudienceDeps,
  type AskStore,
} from "../../asks.ts";
import {
  AGENT_LINK_PREFIX,
  OFFICE_LINK_PATHS,
  askLinkFor,
} from "../../../shared/office-links.ts";

export interface AsksDeps {
  store: AskStore;
  // The closed asks (task ff590b5e): getAsk falls back to them, and the
  // history route lists them.
  history: AskHistory;
  // The agent as it is now, or null when it is gone.
  agent(agentId: string): {
    roomId: string;
    managerUserId: string | null;
    sessionId?: string | null;
  } | null;
  // The calling app as it is now: its registration time, its owner and the
  // agent its messages go to (the configured target, else its creator; null
  // when it has neither). Null when the app is gone.
  app(appName: string): {
    createdAt: number;
    ownerUserId: string | null;
    targetAgentId: string | null;
  } | null;
  // A member by username (case-insensitive), or null.
  memberByName(name: string): { id: string; name: string } | null;
  // A member's username, or null when the record is gone.
  memberName(userId: string): string | null;
  // Whether a member can reach a room.
  memberCanSeeRoom(userId: string, roomId: string): boolean;
  isOfficeOwner(userId: string): boolean;
  // Whether the caller can read the agent's logs (logSearchAccess): the reach
  // of asks.get, a read of any agent's ask by its id.
  canReadAgentLogs(identity: Identity, agentId: string): boolean;
  // Step asks (task c71cb60f): the check of a create's `step`.
  steps: Pick<StepAsks, "check">;
  // An ask's chat affordances: the chat's checks, paths against the agent's
  // cwd, and the copy of a read file. Null when the agent is gone.
  affordances: {
    checkCommand(raw: string): CommandCheck;
    probeEditFile(agentId: string, rawPath: string): EditFileCheck | null;
    probeReadFile(
      agentId: string,
      rawPath: string,
      opts?: { capped?: boolean },
    ): ReadFileCheck | null;
    copyReadFile(agentId: string, absPath: string): AskReadFileCopy | null;
  };
  // The served file's headers, as agents.getFile sends them.
  contentTypeFor(filename: string): string;
  untrustedFileHeaders(): Record<string, string>;
  // Deliver the member's message to the agent, carrying the ask (and the
  // task it was filed as). Resolves at the acceptance decision, as a typed
  // member message does.
  deliver(
    identity: Identity,
    entry: AskEntry,
    text: string,
    opts: {
      dismissed: boolean;
      // A simplify request: the ask stays open.
      simplify?: boolean;
      // The member withdrew a simplify request: the ask stays open.
      simplifyUndone?: boolean;
      taskId?: string;
      device: string | undefined;
    },
  ): Promise<UserSendAcceptance>;
  // The agent's display name, for the filed task's description.
  agentName(agentId: string): string | null;
  // File a task on the board, and take it back when the agent refuses the
  // message that names it.
  createTask(input: {
    title: string;
    description: string;
    createdBy: string;
    username: string | undefined;
    roomId: string;
    priority?: TaskPriority;
  }): TaskItem;
  deleteTask(id: string): boolean;
  // Who the caller is on the board, as tasks.create records it.
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
}

type HandlerResult = Awaited<ReturnType<RouteHandler>>;

const COMMAND_REFUSALS: Record<
  Exclude<CommandCheck, { ok: true }>["kind"],
  string
> = {
  empty: "a command must not be empty",
  too_long: `a command must be at most ${TERMINAL_COMMAND_MAX_LEN} characters`,
  multi_line: "a command must be one line; join steps with && or ;",
};

// A video or audio file in an ask is referenced where it is, not copied, and
// has no size cap; any other read file is copied.
const referencedInPlace = (path: string) =>
  /^(video|audio)\//.test(mimeTypeForFilename(basename(path)));

// An ask's refused path as an HTTP error: a credential store is forbidden,
// anything else is the affordance's own 422.
function pathRefused(
  refusal: Pick<PathRefusal, "kind" | "path" | "size" | "message">,
  code: "invalid_edit_file" | "invalid_read_file",
): HandlerResult {
  const { path } = refusal;
  switch (refusal.kind) {
    case "credential":
      return fail(
        403,
        "forbidden_path",
        `${path} is a credential store. An ask cannot show it.`,
      );
    case "bad_path":
      return fail(422, code, "a path must not be empty");
    case "not_found":
      return fail(422, code, `${path} does not exist`);
    case "not_file":
      return fail(422, code, `${path} is not a file`);
    case "binary":
      return fail(422, code, `${path} is binary; the editor opens text only`);
    case "too_large":
      return fail(
        422,
        code,
        code === "invalid_read_file"
          ? `${path} is ${refusal.size} bytes, over ${MAX_READ_FILE_BYTES}`
          : `${path} is ${refusal.size} bytes, too large for the editor`,
      );
    case "io_error":
      return fail(422, code, `cannot read ${path}: ${refusal.message ?? ""}`);
  }
}

// The query of the history route (filter `member`) or the log route (filter
// `askId`), or null when it is refused: only that filter, before and limit,
// the numbers as whole numbers, limit 1 to ASK_HISTORY_LIMIT_MAX.
function parsePageQuery(
  query: URLSearchParams,
  filterKey: "member" | "askId",
): { filter?: string; before?: number; limit: number } | null {
  const out: { filter?: string; before?: number; limit: number } = {
    limit: ASK_HISTORY_LIMIT_DEFAULT,
  };
  for (const key of query.keys())
    if (key !== filterKey && key !== "before" && key !== "limit") return null;
  const filter = query.get(filterKey);
  if (filter !== null) out.filter = filter;
  for (const key of ["before", "limit"] as const) {
    const value = query.get(key);
    if (value === null) continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      return null;
    out[key] = Number(value);
  }
  if (out.limit < 1 || out.limit > ASK_HISTORY_LIMIT_MAX) return null;
  return out;
}

function guarded(handler: RouteHandler): RouteHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof AsksUnavailableError)
        return fail(500, "asks_unavailable", err.message);
      throw err;
    }
  };
}

export function askHandlers(deps: AsksDeps): Record<string, RouteHandler> {
  const { store } = deps;
  // Reply and dismiss in flight, so a second click (or a second browser)
  // cannot send the message twice.
  const delivering = new Set<string>();

  const wire = (entry: AskEntry): AskAgentWire =>
    askAgentWire(entry, (userId) => deps.memberName(userId));
  // A member named as they are now, null when there is none or they are gone.
  const byName = (userId: string | undefined) =>
    userId === undefined ? null : deps.memberName(userId);
  const eventWire = (event: AskEvent): AskEventWire =>
    event.kind === "simplify_requested" || event.kind === "simplify_withdrawn"
      ? { kind: event.kind, at: event.at, by: byName(event.byUserId) }
      : event;
  // A closed ask: who answered is named as they are now, null when gone.
  const closedWire = ({
    entry,
    closure,
    events,
  }: AskHistoryRecord): AskClosedWire => {
    const { byUserId, ...rest } = closure;
    return {
      ...wire(entry),
      closed: { ...rest, by: byName(byUserId) },
      events: events.map(eventWire),
    };
  };
  // An entry of the agent's ask log, its members named as closedWire does.
  const logWire = ({ seq, askId, event }: AskLogRecord): AskLogEventWire => {
    if (event.kind !== "closed") return { seq, askId, ...eventWire(event) };
    const { byUserId, ...rest } = event;
    return { seq, askId, ...rest, by: byName(byUserId) };
  };

  const audience: AskAudienceDeps = {
    isOfficeOwner: (userId) => deps.isOfficeOwner(userId),
    agentRoomId: (agentId) => deps.agent(agentId)?.roomId ?? null,
    canSeeRoom: (userId, roomId) => deps.memberCanSeeRoom(userId, roomId),
  };

  // The agent's own open entry, or null.
  const own = (agentId: string, id: string): AskEntry | null => {
    const entry = store.get(id);
    return entry && entry.agentId === agentId ? entry : null;
  };

  // An ask by its id, open or else closed (task ff590b5e), as agents.getAsk
  // and asks.get return it. With agentId, only that agent's.
  const read = (
    id: string,
    agentId?: string,
  ): AskAgentWire | AskClosedWire | null => {
    const entry = agentId === undefined ? store.get(id) : own(agentId, id);
    if (entry) return wire(entry);
    const closed =
      agentId === undefined
        ? deps.history.getById(id)
        : deps.history.get(agentId, id);
    return closed ? closedWire(closed) : null;
  };

  // The caller's open entry while it can still reach the agent, or null.
  const addressedTo = (identity: Identity, id: string): AskEntry | null => {
    const entry = store.get(id);
    return entry && askVisibleTo(entry, identity.userId, audience)
      ? entry
      : null;
  };

  // An open entry the caller may read: their own (addressedTo), or another
  // member's for an office owner (askShownToOwnerAsOther).
  const readableBy = (identity: Identity, id: string): AskEntry | null => {
    const entry = store.get(id);
    return entry &&
      (askVisibleTo(entry, identity.userId, audience) ||
        askShownToOwnerAsOther(entry, identity.userId, audience))
      ? entry
      : null;
  };

  // Who answered and their words, for the closed ask's record. A bare
  // dismiss or filed task has no words.
  const answeredBy = (identity: Identity, text: string | undefined) => ({
    ...(identity.userId ? { byUserId: identity.userId } : {}),
    ...(text !== undefined ? { answer: text } : {}),
  });

  const notFound = () => fail(404, "not_found", "No such open ask.");
  const invalidLink = () =>
    fail(
      422,
      "invalid_link",
      `link must be one of: ${OFFICE_LINK_PATHS.join(", ")}, or ${AGENT_LINK_PREFIX}<agentId> for an agent the member can reach`,
    );
  // A link to an agent's chat names an agent the member can reach; a page
  // link needs no check past its form.
  const linkReachable = (link: unknown, memberUserId: string | undefined) => {
    const parsed = askLinkFor(link);
    if (!parsed || !("agentId" in parsed)) return true;
    const target = deps.agent(parsed.agentId);
    return (
      !!target &&
      !!memberUserId &&
      deps.memberCanSeeRoom(memberUserId, target.roomId)
    );
  };
  const invalidOptions = (message: string) =>
    fail(422, "invalid_options", message);
  const invalidPriority = () =>
    fail(422, "invalid_priority", "priority must be one of P0, P1, P2, P3, P4");
  const secretRequest = (message: string) =>
    fail(409, "secret_request", message);
  const tooManyAsks = () =>
    fail(
      429,
      "too_many_asks",
      `At most ${ASK_MAX_OPEN_PER_AGENT} open asks per agent. Delete one first.`,
    );

  const invalidAffordances = (message: string) =>
    fail(422, "invalid_affordances", message);

  // The lists a create or edit sends, before any path is looked at: each a
  // list of strings, an empty list only on an edit (it removes the list), and
  // at most ASK_AFFORDANCES_MAX in total with the lists an edit keeps.
  function affordanceLists(
    body: Record<string, unknown>,
    prev: AskEntry | null,
  ):
    | { ok: true; lists: { [K in keyof AskAffordances]?: string[] } }
    | { ok: false; result: HandlerResult } {
    const lists: { [K in keyof AskAffordances]?: string[] } = {};
    let total = 0;
    for (const key of ASK_AFFORDANCE_KEYS) {
      const value = body[key];
      if (value === undefined) {
        total += prev?.[key]?.length ?? 0;
        continue;
      }
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
        return {
          ok: false,
          result: invalidAffordances(`${key} must be a list of strings`),
        };
      if (value.length === 0 && !prev)
        return {
          ok: false,
          result: invalidAffordances(`${key} must not be empty`),
        };
      lists[key] = value;
      total += value.length;
    }
    if (total > ASK_AFFORDANCES_MAX)
      return {
        ok: false,
        result: invalidAffordances(
          `an ask takes at most ${ASK_AFFORDANCES_MAX} commands and files in total`,
        ),
      };
    return { ok: true, lists };
  }

  // The chat's checks on every sent item, then the copies of the read
  // files and the references: a refusal before the copies leaves the files
  // dir as it was. A sent empty list becomes null (remove).
  function resolveAffordances(
    agentId: string,
    lists: { [K in keyof AskAffordances]?: string[] },
  ):
    | { ok: true; affordances: AskAffordanceEdit }
    | { ok: false; result: HandlerResult } {
    const gone = {
      ok: false as const,
      result: fail(404, "not_found", "No such agent."),
    };
    const out: AskAffordanceEdit = {};
    const commands: string[] = [];
    for (const raw of lists.commands ?? []) {
      const checked = deps.affordances.checkCommand(raw);
      if (!checked.ok)
        return {
          ok: false,
          result: fail(422, "invalid_command", COMMAND_REFUSALS[checked.kind]),
        };
      commands.push(checked.command);
    }
    const editFiles = [];
    for (const raw of lists.editFiles ?? []) {
      const probe = deps.affordances.probeEditFile(agentId, raw);
      if (!probe) return gone;
      if (!probe.ok)
        return { ok: false, result: pathRefused(probe, "invalid_edit_file") };
      editFiles.push(probe.file);
    }
    const readPaths: { path: string; size: number }[] = [];
    for (const raw of lists.readFiles ?? []) {
      const probe = deps.affordances.probeReadFile(agentId, raw, {
        capped: false,
      });
      if (!probe) return gone;
      if (!probe.ok)
        return { ok: false, result: pathRefused(probe, "invalid_read_file") };
      if (!referencedInPlace(probe.path) && probe.size > MAX_READ_FILE_BYTES)
        return {
          ok: false,
          result: pathRefused(
            { kind: "too_large", path: probe.path, size: probe.size },
            "invalid_read_file",
          ),
        };
      readPaths.push(probe);
    }
    const readFiles: AskReadFile[] = [];
    for (const { path, size } of readPaths) {
      if (referencedInPlace(path)) {
        const originalName = basename(path);
        readFiles.push({
          // A fresh name: an edit that sends the file again gets a new URL.
          filename: `${randomUUID()}${extname(path)}`,
          originalName,
          mediaType: mimeTypeForFilename(originalName),
          size,
          path,
        });
        continue;
      }
      const copied = deps.affordances.copyReadFile(agentId, path);
      if (!copied) return gone;
      if (!copied.ok)
        return {
          ok: false,
          result:
            copied.kind === "save_failed"
              ? fail(
                  422,
                  "invalid_read_file",
                  `could not save a copy of ${path}`,
                )
              : pathRefused(copied, "invalid_read_file"),
        };
      readFiles.push(copied.attachment);
    }
    if (lists.commands) out.commands = commands.length > 0 ? commands : null;
    if (lists.editFiles)
      out.editFiles = editFiles.length > 0 ? editFiles : null;
    if (lists.readFiles)
      out.readFiles = readFiles.length > 0 ? readFiles : null;
    return { ok: true, affordances: out };
  }

  // The checks every answer shares: the body's device and text, the open
  // ask the caller may answer, not a secret request, not already being
  // answered. A reply needs text; a dismiss or a filed task may carry the
  // member's note, and a blank one counts as none; a simplify request takes
  // none.
  const answerable = (
    ctx: Parameters<RouteHandler>[0],
    textRule: "required" | "note" | "none",
  ):
    | { ok: true; entry: AskEntry; text?: string; device?: string }
    | { ok: false; result: HandlerResult } => {
    const refuse = (result: HandlerResult) => ({ ok: false as const, result });
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    if (body.device !== undefined && typeof body.device !== "string")
      return refuse(fail(422, "invalid_request", "device must be a string"));
    if (body.device !== undefined && ctx.identity.scope !== "user")
      return refuse(
        fail(
          400,
          "api_attribution_not_supported",
          "device is supported only for browser senders.",
        ),
      );
    let text: string | undefined;
    if (textRule === "none") {
      if (body.text !== undefined)
        return refuse(fail(400, "invalid_text", "simplify takes no text"));
    } else if (textRule === "required") {
      if (typeof body.text !== "string" || body.text.trim().length === 0)
        return refuse(fail(400, "invalid_text", "text is required"));
      text = body.text;
    } else if (body.text !== undefined) {
      if (typeof body.text !== "string")
        return refuse(fail(400, "invalid_text", "text must be a string"));
      if (body.text.trim().length > 0) text = body.text;
    }
    const entry = addressedTo(ctx.identity, ctx.params.askId);
    if (!entry) return refuse(notFound());
    // A secret request is answered with its masked form only: a reply would
    // carry what the member typed into the chat and to the agent.
    if (entry.secret)
      return refuse(
        secretRequest(
          "This ask is a secret request. Save or decline it instead.",
        ),
      );
    if (delivering.has(entry.id))
      return refuse(
        fail(409, "ask_busy", "An answer to this ask is being sent."),
      );
    return { ok: true, entry, text, device: body.device };
  };

  // Close an answered ask. The agent has the message; a retry would send it
  // twice, so a failed write is logged and the entry stays open until the
  // store can write again.
  const close = (entry: AskEntry, how: AskCloseInput) => {
    try {
      store.remove(entry.id, how);
    } catch (err) {
      console.error(
        `[asks] ${entry.id} was answered but could not be closed:`,
        err,
      );
    }
  };

  const answer =
    (dismissed: boolean): RouteHandler =>
    async (ctx) => {
      const checked = answerable(ctx, dismissed ? "note" : "required");
      if (!checked.ok) return checked.result;
      const { entry, device } = checked;
      const text = checked.text ?? ASK_DISMISSED_TEXT;
      delivering.add(entry.id);
      try {
        const result = await deps.deliver(ctx.identity, entry, text, {
          dismissed,
          device,
        });
        if (!result.ok) return fail(result.status, result.code, result.message);
        close(entry, {
          outcome: dismissed ? "dismissed" : "replied",
          ...answeredBy(ctx.identity, checked.text),
        });
        return noContent();
      } finally {
        delivering.delete(entry.id);
      }
    };

  // File the ask as a task in the agent's room, then tell the agent the task
  // id in place of an answer. The task goes first so the message can name
  // it; a refused or failed message takes it back and leaves the ask open,
  // so a retry files one task, not two.
  const fileTask: RouteHandler = async (ctx) => {
    const checked = answerable(ctx, "note");
    if (!checked.ok) return checked.result;
    const { entry, text: note, device } = checked;
    const agent = deps.agent(entry.agentId);
    if (!agent) return notFound();
    const { title, description } = askTaskFields(
      entry,
      deps.agentName(entry.agentId) ?? entry.agentId,
      note,
    );
    const { createdBy, username } = deps.attributionFor(ctx.identity);
    delivering.add(entry.id);
    try {
      const task = deps.createTask({
        title,
        description,
        createdBy,
        username,
        roomId: agent.roomId,
        ...(entry.priority ? { priority: entry.priority } : {}),
      });
      let result: UserSendAcceptance;
      try {
        result = await deps.deliver(
          ctx.identity,
          entry,
          note ?? ASK_FILED_TEXT,
          { dismissed: false, taskId: task.id, device },
        );
      } catch (err) {
        deps.deleteTask(task.id);
        throw err;
      }
      if (!result.ok) {
        deps.deleteTask(task.id);
        return fail(result.status, result.code, result.message);
      }
      close(entry, {
        outcome: "filed",
        taskId: task.id,
        ...answeredBy(ctx.identity, note),
      });
      return created(task);
    } finally {
      delivering.delete(entry.id);
    }
  };

  // Ask the agent to rewrite the ask in plain words; the ask stays open and
  // is marked once the agent has the message, so the card shows the rewrite
  // is coming. A refused message leaves it unmarked. One request at a time:
  // the agent's edit of the prompt clears the mark.
  const simplify: RouteHandler = async (ctx) => {
    const checked = answerable(ctx, "none");
    if (!checked.ok) return checked.result;
    const { entry, device } = checked;
    if (entry.simplifyRequestedAt !== undefined)
      return fail(
        409,
        "simplify_pending",
        "The agent has not rewritten this ask yet.",
      );
    delivering.add(entry.id);
    try {
      const result = await deps.deliver(
        ctx.identity,
        entry,
        ASK_SIMPLIFY_TEXT,
        { dismissed: false, simplify: true, device },
      );
      if (!result.ok) return fail(result.status, result.code, result.message);
      // The agent has the message; a retry would send it twice, so a failed
      // write is logged, as in close. An ask withdrawn meanwhile stays gone.
      try {
        store.requestSimplify(entry.id, ctx.identity.userId ?? undefined);
      } catch (err) {
        console.error(
          `[asks] ${entry.id} was sent for a rewrite but could not be marked:`,
          err,
        );
      }
      return noContent();
    } finally {
      delivering.delete(entry.id);
    }
  };

  // Withdraw a simplify request the agent has not acted on yet: the agent is
  // told, and the mark goes once it has the message.
  // The agent's rewrite can land while the message is on its way: then the
  // store leaves the entry as the rewrite made it.
  const simplifyUndo: RouteHandler = async (ctx) => {
    const checked = answerable(ctx, "none");
    if (!checked.ok) return checked.result;
    const { entry, device } = checked;
    if (entry.simplifyRequestedAt === undefined)
      return fail(
        409,
        "simplify_not_pending",
        "No rewrite of this ask is waiting.",
      );
    delivering.add(entry.id);
    try {
      const result = await deps.deliver(
        ctx.identity,
        entry,
        ASK_SIMPLIFY_UNDO_TEXT,
        { dismissed: false, simplifyUndone: true, device },
      );
      if (!result.ok) return fail(result.status, result.code, result.message);
      // The agent has the message; a retry would send it twice, so a failed
      // write is logged, as in simplify.
      try {
        store.cancelSimplify(entry.id, ctx.identity.userId ?? undefined);
      } catch (err) {
        console.error(
          `[asks] ${entry.id} had its rewrite withdrawn but the mark could not be cleared:`,
          err,
        );
      }
      return noContent();
    } finally {
      delivering.delete(entry.id);
    }
  };

  type Asker =
    | {
        ok: true;
        agentId: string;
        agent: NonNullable<ReturnType<AsksDeps["agent"]>>;
        // The default member: the agent's manager, or the app's owner.
        manager: string | null;
        app?: { name: string; createdAt: number };
      }
    | { ok: false; result: HandlerResult };

  // A create, from an agent or an app: the body's own checks, then the agent
  // the ask is for (resolve), then the checks that need that agent.
  const create = async (
    body: Record<string, unknown>,
    resolve: (body: Record<string, unknown>) => Asker,
  ): Promise<HandlerResult> => {
    const checked = checkPromptField(body);
    if (!checked.ok) return fail(400, "invalid_text", checked.message);
    if (body.member !== undefined && typeof body.member !== "string")
      return fail(422, "invalid_request", "member must be a username");
    if (body.link !== undefined && !askLinkFor(body.link)) return invalidLink();
    let options: string[] | undefined;
    if (body.options !== undefined) {
      const checkedOptions = checkOptions(body.options);
      if (!checkedOptions.ok) return invalidOptions(checkedOptions.message);
      options = checkedOptions.options;
    }
    let recommended: string | undefined;
    if (body.recommended !== undefined) {
      const checkedMark = checkRecommended(body.recommended, options);
      if (!checkedMark.ok) return invalidOptions(checkedMark.message);
      recommended = checkedMark.recommended;
    }
    if (body.priority !== undefined && !isValidPriority(body.priority))
      return invalidPriority();
    const lists = affordanceLists(body, null);
    if (!lists.ok) return lists.result;
    const asker = resolve(body);
    if (!asker.ok) return asker.result;
    const { agentId, agent } = asker;
    let memberUserId: string;
    if (body.member !== undefined) {
      const member = deps.memberByName(body.member);
      if (!member)
        return fail(422, "unknown_member", `No member named ${body.member}.`);
      memberUserId = member.id;
    } else {
      if (!asker.manager)
        return fail(
          409,
          "no_manager",
          "This agent has no manager. Name a member with member=<username>.",
        );
      memberUserId = asker.manager;
    }
    if (!deps.memberCanSeeRoom(memberUserId, agent.roomId))
      return fail(
        422,
        "member_no_access",
        "That member cannot reach this agent's room.",
      );
    if (body.link !== undefined && !linkReachable(body.link, memberUserId))
      return invalidLink();
    // A step ask's link is the step's tab, set here.
    let step: Extract<StepCheck, { ok: true }> | undefined;
    if (body.step !== undefined) {
      if (body.link !== undefined)
        return fail(
          400,
          "invalid_request",
          "a step ask takes no link: Isomux sets it",
        );
      const checkedStep = await deps.steps.check({
        step: body.step,
        roomId: agent.roomId,
        managerUserId: agent.managerUserId,
        memberUserId,
        memberNamed: body.member !== undefined,
      });
      if (!checkedStep.ok)
        return fail(checkedStep.status, checkedStep.code, checkedStep.message);
      step = checkedStep;
    }
    if (store.listForAgent(agentId).length >= ASK_MAX_OPEN_PER_AGENT)
      return tooManyAsks();
    const resolved = resolveAffordances(agentId, lists.lists);
    if (!resolved.ok) return resolved.result;
    const result = store.create({
      agentId,
      memberUserId,
      prompt: checked.prompt,
      ...(body.link !== undefined ? { link: body.link as string } : {}),
      ...(step ? { link: step.link, step: step.step } : {}),
      ...(options ? { options } : {}),
      ...(recommended !== undefined ? { recommended } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      // On a create every sent list is non-empty, so none is null.
      affordances: resolved.affordances as AskAffordances,
      // An app's ask has no opening session: the agent did not ask it.
      ...(asker.app
        ? { app: asker.app }
        : agent.sessionId
          ? { sessionId: agent.sessionId }
          : {}),
    });
    if (!result.ok) return tooManyAsks();
    return created(wire(result.entry));
  };

  // An edit, from an agent or an app: find gives the caller's own entry.
  const edit = (
    body: Record<string, unknown>,
    askId: string,
    find: () => AskEntry | null,
    // The editing app, for the edit's event; absent when the agent edits.
    actor?: { app: string },
  ): HandlerResult => {
    const checked = checkPromptField(body);
    if (!checked.ok) return fail(400, "invalid_text", checked.message);
    // Absent keeps the link and "" removes it.
    if (body.link !== undefined && body.link !== "" && !askLinkFor(body.link))
      return invalidLink();
    // Absent keeps the options and [] removes them.
    let options: string[] | null | undefined;
    if (Array.isArray(body.options) && body.options.length === 0)
      options = null;
    else if (body.options !== undefined) {
      const checkedOptions = checkOptions(body.options);
      if (!checkedOptions.ok) return invalidOptions(checkedOptions.message);
      options = checkedOptions.options;
    }
    // Absent keeps the priority; null and "" remove it.
    let priority: TaskPriority | null | undefined;
    if (body.priority === null || body.priority === "") priority = null;
    else if (body.priority !== undefined) {
      if (!isValidPriority(body.priority)) return invalidPriority();
      priority = body.priority;
    }
    const prev = find();
    if (!prev) return notFound();
    if (prev.secret)
      return secretRequest(
        "A secret request cannot be edited. Delete it to withdraw it.",
      );
    // A step and its link are fixed after create (task c71cb60f).
    if (body.step !== undefined)
      return fail(400, "invalid_request", "an ask's step cannot be edited");
    if (prev.step && body.link !== undefined)
      return fail(400, "invalid_request", "a step ask's link cannot be edited");
    if (
      body.link !== undefined &&
      body.link !== "" &&
      !linkReachable(body.link, prev.memberUserId)
    )
      return invalidLink();
    // The mark goes with the options: sent options without one clear it,
    // and "" removes it.
    let recommended: string | null | undefined;
    if (body.recommended === undefined)
      recommended = options === undefined ? undefined : null;
    else if (body.recommended === "") recommended = null;
    else {
      const checkedMark = checkRecommended(
        body.recommended,
        options === undefined ? prev.options : (options ?? undefined),
      );
      if (!checkedMark.ok) return invalidOptions(checkedMark.message);
      recommended = checkedMark.recommended;
    }
    const lists = affordanceLists(body, prev);
    if (!lists.ok) return lists.result;
    // Paths resolve for the agent that holds the ask.
    const resolved = resolveAffordances(prev.agentId, lists.lists);
    if (!resolved.ok) return resolved.result;
    const entry = store.edit(
      askId,
      checked.prompt,
      body.link === "" ? null : (body.link as string | undefined),
      options,
      resolved.affordances,
      recommended,
      priority,
      actor,
    );
    return entry ? ok(wire(entry)) : notFound();
  };

  // The calling app as it is now, or null when it is gone (the token outlived
  // the record by a moment).
  const callerApp = (identity: Identity) => {
    const appName = identity.appName;
    if (identity.scope !== "app" || !appName) return null;
    const app = deps.app(appName);
    return app ? { appName, ...app } : null;
  };
  const appGone = () =>
    fail(404, "not_found", "this app is no longer registered");
  // The name AND the registration: a later app with a reused name never
  // reaches an earlier one's asks, which stay open on their agent.
  const openedBy = (
    entry: AskEntry,
    app: { appName: string; createdAt: number },
  ): boolean =>
    entry.app?.name === app.appName && entry.app.createdAt === app.createdAt;
  const appOwn = (
    app: { appName: string; createdAt: number },
    id: string,
  ): AskEntry | null => {
    const entry = store.get(id);
    return entry && openedBy(entry, app) ? entry : null;
  };

  return {
    "agents.createAsk": guarded((ctx) =>
      create((ctx.body ?? {}) as Record<string, unknown>, () => {
        const agent = deps.agent(ctx.params.id);
        return agent
          ? {
              ok: true,
              agentId: ctx.params.id,
              agent,
              manager: agent.managerUserId,
            }
          : { ok: false, result: fail(404, "not_found", "No such agent.") };
      }),
    ),

    "agents.listAsks": guarded((ctx) =>
      ok(store.listForAgent(ctx.params.id).map(wire)),
    ),

    "agents.getAsk": guarded((ctx) => {
      const ask = read(ctx.params.askId, ctx.params.id);
      return ask ? ok(ask) : notFound();
    }),

    // Any agent's ask by its id, open or closed, for a caller with the reach
    // of that agent's logs.
    "asks.get": guarded((ctx) => {
      const ask = read(ctx.params.askId);
      return ask && deps.canReadAgentLogs(ctx.identity, ask.agentId)
        ? ok(ask)
        : notFound();
    }),

    "agents.editAsk": guarded((ctx) =>
      edit((ctx.body ?? {}) as Record<string, unknown>, ctx.params.askId, () =>
        own(ctx.params.id, ctx.params.askId),
      ),
    ),

    "agents.deleteAsk": guarded((ctx) => {
      if (!own(ctx.params.id, ctx.params.askId)) return notFound();
      return store.remove(ctx.params.askId, { outcome: "withdrawn" })
        ? noContent()
        : notFound();
    }),

    // The agent's closed asks, for any caller with the reach of its logs
    // (task ff590b5e). The agent may be killed: no live agent is required.
    "agents.askHistory": guarded((ctx) => {
      const query = parsePageQuery(ctx.query, "member");
      if (!query)
        return fail(
          400,
          "invalid_query",
          `the query takes member, before (a nextBefore) and limit (1 to ${ASK_HISTORY_LIMIT_MAX})`,
        );
      let memberUserId: string | undefined;
      if (query.filter !== undefined) {
        const member = deps.memberByName(query.filter);
        if (!member)
          return fail(
            422,
            "unknown_member",
            `No member named ${query.filter}.`,
          );
        memberUserId = member.id;
      }
      const page = deps.history.list(ctx.params.id, {
        limit: query.limit,
        ...(memberUserId !== undefined ? { memberUserId } : {}),
        ...(query.before !== undefined ? { before: query.before } : {}),
      });
      return ok({
        asks: page.items.map(closedWire),
        nextBefore: page.nextBefore,
      });
    }),

    // The agent's ask log (task 302e7ea4), with the history's reach: every
    // event of its asks, open or closed, newest first.
    "agents.askEvents": guarded((ctx) => {
      const query = parsePageQuery(ctx.query, "askId");
      if (!query)
        return fail(
          400,
          "invalid_query",
          `the query takes askId, before (a nextBefore) and limit (1 to ${ASK_HISTORY_LIMIT_MAX})`,
        );
      const page = deps.history.listEvents(ctx.params.id, {
        limit: query.limit,
        ...(query.filter !== undefined ? { askId: query.filter } : {}),
        ...(query.before !== undefined ? { before: query.before } : {}),
      });
      return ok({
        events: page.items.map(logWire),
        nextBefore: page.nextBefore,
      });
    }),

    "asks.appCreate": guarded((ctx) => {
      const app = callerApp(ctx.identity);
      if (!app) return appGone();
      return create((ctx.body ?? {}) as Record<string, unknown>, (body) => {
        // A step is an agent's flow: the agent completes it.
        if (body.step !== undefined)
          return {
            ok: false,
            result: fail(
              400,
              "invalid_request",
              "an app cannot open a step ask",
            ),
          };
        if (!app.targetAgentId)
          return {
            ok: false,
            result: fail(
              409,
              "no_target",
              "this app was not registered by an agent, so no agent can receive the answer",
            ),
          };
        const agent = deps.agent(app.targetAgentId);
        if (!agent)
          return {
            ok: false,
            result: fail(
              404,
              "target_gone",
              "this app's message target no longer exists; its owner must point it at a live agent",
            ),
          };
        // As a chosen message target: only with a live owner agent.
        if (body.member !== undefined && !actsForAgent(ctx.identity))
          return {
            ok: false,
            result: fail(
              403,
              "forbidden",
              "this app has no live owner agent, so its asks go to its owner only",
            ),
          };
        if (body.member === undefined && !app.ownerUserId)
          return {
            ok: false,
            result: fail(
              409,
              "no_owner",
              "this app has no owner to receive the ask",
            ),
          };
        return {
          ok: true,
          agentId: app.targetAgentId,
          agent,
          manager: app.ownerUserId,
          app: { name: app.appName, createdAt: app.createdAt },
        };
      });
    }),

    "asks.appList": guarded((ctx) => {
      const app = callerApp(ctx.identity);
      if (!app) return appGone();
      return ok(
        store
          .listAll()
          .filter((entry) => openedBy(entry, app))
          .map(wire),
      );
    }),

    "asks.appGet": guarded((ctx) => {
      const app = callerApp(ctx.identity);
      if (!app) return appGone();
      const entry = appOwn(app, ctx.params.askId);
      return entry ? ok(wire(entry)) : notFound();
    }),

    "asks.appEdit": guarded((ctx) => {
      const app = callerApp(ctx.identity);
      if (!app) return appGone();
      return edit(
        (ctx.body ?? {}) as Record<string, unknown>,
        ctx.params.askId,
        () => appOwn(app, ctx.params.askId),
        { app: app.appName },
      );
    }),

    "asks.appDelete": guarded((ctx) => {
      const app = callerApp(ctx.identity);
      if (!app) return appGone();
      if (!appOwn(app, ctx.params.askId)) return notFound();
      return store.remove(ctx.params.askId, {
        outcome: "withdrawn",
        app: app.appName,
      })
        ? noContent()
        : notFound();
    }),

    "asks.list": guarded((ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return ok([]);
      return ok(
        store
          .listAll()
          .filter((entry) => askVisibleTo(entry, userId, audience))
          .map(askMemberWire),
      );
    }),

    "asks.listOthers": guarded((ctx) => {
      const userId = ctx.identity.userId;
      if (!userId || !deps.isOfficeOwner(userId))
        return fail(
          403,
          "forbidden",
          "Only an office owner can list other members' asks.",
        );
      return ok(
        store
          .listAll()
          .filter((entry) => askShownToOwnerAsOther(entry, userId, audience))
          .map(wire),
      );
    }),

    "asks.reply": guarded(answer(false)),
    "asks.dismiss": guarded(answer(true)),
    "asks.fileTask": guarded(fileTask),
    "asks.simplify": guarded(simplify),
    "asks.simplifyUndo": guarded(simplifyUndo),
    // A file the ask references where it is. The path is probed again on
    // every request: the file can be gone or replaced since the ask was
    // made. Served as agents.getFile serves a copy. A read: an office owner
    // gets the file of another member's ask too.
    "asks.getFile": guarded((ctx) => {
      const entry = readableBy(ctx.identity, ctx.params.askId);
      const ref = entry?.readFiles?.find(
        (f) => f.filename === ctx.params.filename && f.path !== undefined,
      );
      const noFile = () =>
        fail(404, "not_found", "No such file in an open ask.");
      if (!entry || !ref?.path) return noFile();
      const probe = deps.affordances.probeReadFile(entry.agentId, ref.path, {
        capped: false,
      });
      if (!probe?.ok) return noFile();
      return file(probe.path, deps.contentTypeFor(ref.filename), {
        ...deps.untrustedFileHeaders(),
        ...downloadHeader(ctx.query, ref.filename),
      });
    }),
  };
}
