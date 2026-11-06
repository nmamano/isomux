// Ask handlers (internal-docs/asks-design.md).
//
// Agent routes (/api/agents/:id/asks...): the route guard proves the
// token's agent is :id, so an agent reaches only its own list. App routes
// (/api/app/asks...): an app opens asks in the name of its message target
// agent, and reaches only the asks its own registration opened. Member routes
// (/api/asks...): only a member askVisibleTo admits (the member the ask is
// for, or an owner for an office secret request), while that member can
// still reach the agent's room; anyone else gets the same 404 as an unknown
// id. An office owner also reads and answers other members' open asks
// (askShownToOwnerAsOther). A secret request is answered on its own routes
// (secret-requests.ts), never with a reply, a dismiss or a filed task.
//
// A reply, a dismiss or a filed task is a member message to the agent through
// the path a typed message takes, so it wakes or resumes the agent the same
// way and is refused only where a typed message would be. The ask closes after
// the message is accepted; a refused message leaves it open.
//
// The store emits the per-recipient events on commit, so these handlers never
// emit directly. LEAF over the executor, the store and shared types.

import type {
  StepAsks,
  StepCheck,
  StepRoute,
  StepRun,
} from "../../step-asks.ts";
import type { MessagingAppReplies } from "../../messaging/replies.ts";
import type { LogMessage } from "../../../shared/i18n/log-message.ts";
import {
  askRunLine,
  askRunNotice,
  askRunReply,
  type AskRunResult,
} from "../../ask-command-runner.ts";
import { isRunnableCommand } from "../../../shared/runnable-command.ts";
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
  type HandlerErrorStatus,
  type RouteHandler,
} from "../executor.ts";
import { randomUUID } from "crypto";
import { basename, extname } from "path";
import { downloadHeader, mimeTypeForFilename } from "../../mime-types.ts";
import { actsForAgent, type Identity } from "../../identity/index.ts";
import { packSenderOf } from "../../identity/agent-fit.ts";
import {
  ASK_DISMISSED_TEXT,
  ASK_FILED_TEXT,
  ASK_SIMPLIFY_TEXT,
  ASK_SIMPLIFY_UNDO_TEXT,
  isValidPriority,
  type AskCloseInput,
  type AskClosure,
  type AskCommandRun,
  type AskEntry,
  type AskEvent,
  type AskReadFile,
  type AskStep,
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
import type { AskReadFileCopy } from "../../agent-affordances.ts";
import type {
  AskAgentWire,
  AskClosedWire,
  AskEventWire,
  AskLogEventWire,
} from "../../../shared/contract-shapes.ts";
import type { UserSendAcceptance } from "../../internal-types.ts";
import {
  askAgentWire,
  askAgentId,
  askMemberWire,
  askTaskFields,
  askAudienceFor,
  askMemberIds,
  askRoomAudience,
  askShownToOwnerAsOther,
  askVisibleTo,
  AsksUnavailableError,
  ASK_MEMBERS_MAX,
  ASK_AFFORDANCE_KEYS,
  ASK_AFFORDANCES_MAX,
  ASK_MAX_OPEN_PER_AGENT,
  ASK_PAGES_MAX_OPEN_PER_SOURCE,
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
  ASK_LINK_PREFIX,
  askLinkFor,
  outsideLinkFor,
} from "../../../shared/office-links.ts";

export interface AsksDeps {
  store: AskStore;
  // Whether a sudo run of the agent holds its sudo requests (task
  // 43a28eed): from sudo's password check to the run's end. The agent's
  // withdraw of a sudo request waits for it.
  sudoRunInProgress?(agentId: string): boolean;
  // An ask an agent opened to a member is the agent writing first: a member
  // with a permission pack may then reply to it (agentManager.recordMemberHeardFrom).
  recordMemberHeardFrom?(userId: string, agentId: string): void;
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
  // Whether a member hides a room from their view (task 9461c464).
  memberRoomHidden(userId: string, roomId: string): boolean;
  // Every member who reaches a room.
  roomMemberIds(roomId: string): string[];
  isOfficeOwner(userId: string): boolean;
  // Whether the caller can read the agent's logs (logSearchAccess): the reach
  // of asks.get, a read of any agent's ask by its id.
  canReadAgentLogs(identity: Identity, agentId: string): boolean;
  // Step asks (task c71cb60f): the check of a create's `step`.
  steps: Pick<StepAsks, "check">;
  // The action of a step the member runs from the card (task e3d1bc63): the
  // step's route now (or why it cannot run: its target is gone), null for a
  // step with a link, and its in-process run through the executor as the
  // caller. Absent in leaf tests: no step runs.
  stepRuns?: {
    // `memberUserId`: the member the ask is for, who runs it;
    // `callerSessionIdHash` their session, which a sign-out ends last.
    routeOf(
      step: AskStep,
      memberUserId: string,
      callerSessionIdHash?: string,
    ): StepRun | null;
    dispatch(
      identity: Identity,
      route: StepRoute,
      opts: { askId: string; callerSessionIdHash?: string },
    ): Promise<{ status: number; body: unknown }>;
  };
  // The member's Run of an ask's command (task c3b91695). Absent in leaf
  // tests that do not run commands: the route answers 409 not_runnable.
  commandRuns?: {
    // Why the caller may not run the agent's commands now, or null:
    // terminal_forbidden where the terminal panel would refuse the caller
    // (a member pack, an agent the caller cannot see), agent_limited for an
    // agent below Standard access.
    refusal(
      identity: Identity,
      agentId: string,
    ): "terminal_forbidden" | "agent_limited" | null;
    // Starts the command in the agent's terminal environment; rejects when
    // it cannot start.
    start(
      agentId: string,
      command: string,
    ): Promise<{ done: Promise<AskRunResult> }>;
    // An office notice to the agent from the member who ran the command, as
    // a sudo run's result is told, and `line` in the agent's chat.
    notify(
      agentId: string,
      text: string,
      from: { askId: string; memberUserId: string; line: LogMessage },
    ): void;
    now(): number;
  };
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
  // A file in the agent's files dir (an ask's copy), or null when it is
  // gone. getFilePath owns path traversal.
  filePath(agentId: string, filename: string): string | null;
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
  // Messaging reply drafts (WhatsApp, task d03a61d8; Discord, task
  // 7fd44c30): only the route's member, signed in, answers one, and a Send
  // answer sends it before the agent is told. Absent in leaf tests.
  messaging?: Pick<MessagingAppReplies, "answer">;
  // File a task on the board, and take it back when the agent refuses the
  // message that names it.
  createTask(input: {
    title: string;
    description: string;
    createdBy: string;
    username: string | undefined;
    roomId: string;
    priority?: TaskPriority;
    // An answer from a sender with a pack: the task text is data.
    limited?: true;
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
  // Asks with a command run in flight (task c3b91695): one at a time.
  const commandRunning = new Set<string>();

  const wire = (entry: AskEntry): AskAgentWire =>
    askAgentWire(entry, (userId) => deps.memberName(userId), audience);
  // A member named as they are now, null when there is none or they are gone.
  const byName = (userId: string | undefined) =>
    userId === undefined ? null : deps.memberName(userId);
  const eventWire = (event: AskEvent): AskEventWire =>
    event.kind === "simplify_requested" ||
    event.kind === "simplify_withdrawn" ||
    event.kind === "acked"
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
    roomHidden: (userId, roomId) => deps.memberRoomHidden(userId, roomId),
    roomMemberIds: (roomId) => deps.roomMemberIds(roomId),
  };
  const audienceFor = (identity: Identity) =>
    askAudienceFor(audience, identity);

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

  // An open entry the caller may read and answer: their own while they can
  // still reach the agent (askVisibleTo), or another member's for an office
  // owner (askShownToOwnerAsOther).
  const readableBy = (identity: Identity, id: string): AskEntry | null => {
    const entry = store.get(id);
    return entry &&
      (askVisibleTo(entry, identity.userId, audienceFor(identity)) ||
        askShownToOwnerAsOther(entry, identity.userId, audienceFor(identity)))
      ? entry
      : null;
  };

  // A read file the ask references in place, probed again: it can be gone or
  // replaced since the ask was made. Served as agents.getFile serves a copy.
  // Null when the probe refuses it.
  const serveReference = (
    entry: AskEntry,
    ref: AskReadFile,
    query: URLSearchParams,
  ): HandlerResult | null => {
    if (ref.path === undefined) return null;
    const probe = deps.affordances.probeReadFile(entry.agentId, ref.path, {
      capped: false,
    });
    if (!probe?.ok) return null;
    return file(probe.path, deps.contentTypeFor(ref.filename), {
      ...deps.untrustedFileHeaders(),
      ...downloadHeader(query, ref.filename),
    });
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
      `link must be one of: ${OFFICE_LINK_PATHS.join(", ")}, ${ASK_LINK_PREFIX}<askId> for one ask, ${AGENT_LINK_PREFIX}<agentId> for an agent the member can reach, or an https URL of a page outside the office`,
    );
  // An office page or agent, or an outside https page (task 0355f4b7).
  const linkValid = (link: unknown) =>
    askLinkFor(link) !== null || outsideLinkFor(link) !== null;
  // A link to an agent's chat names an agent every member of the ask can
  // reach; a page link needs no check past its form.
  const linkReachable = (link: unknown, memberUserIds: readonly string[]) => {
    const parsed = askLinkFor(link);
    if (!parsed || !("agentId" in parsed)) return true;
    const target = deps.agent(parsed.agentId);
    return (
      !!target &&
      memberUserIds.length > 0 &&
      memberUserIds.every((userId) =>
        deps.memberCanSeeRoom(userId, target.roomId),
      )
    );
  };
  const invalidMembers = (message: string) =>
    fail(422, "invalid_members", message);
  // An answer to an ask that is gone: a member it was for, whom another
  // member's answer beat, hears who answered (409 ask_closed); anyone else,
  // and the member who closed it, gets the 404 of an unknown id.
  const closedOrNotFound = (identity: Identity, askId: string) => {
    const userId = identity.userId;
    if (!userId) return notFound();
    let closure: AskClosure | null = null;
    try {
      const record = deps.history.getById(askId);
      if (record && deps.history.members(askId).includes(userId))
        closure = record.closure;
    } catch (err) {
      console.error(`[asks] ${askId}: could not read the history:`, err);
    }
    if (!closure?.byUserId || closure.byUserId === userId) return notFound();
    const by = byName(closure.byUserId);
    return by === null
      ? notFound()
      : fail(409, "ask_closed", `${by} answered this ask first.`, { by });
  };
  const invalidOptions = (message: string) =>
    fail(422, "invalid_options", message);
  const invalidPriority = () =>
    fail(422, "invalid_priority", "priority must be one of P0, P1, P2, P3, P4");
  const secretRequest = (message: string) =>
    fail(409, "secret_request", message);
  const sudoRequest = (message: string) => fail(409, "sudo_request", message);
  const tooManyPages = () =>
    fail(
      429,
      "too_many_pages",
      `At most ${ASK_PAGES_MAX_OPEN_PER_SOURCE} open paged asks per agent or app. Delete one first.`,
    );
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
    // A dismiss: the one answer an ask with no agent takes.
    dismiss = false,
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
    const entry = readableBy(ctx.identity, ctx.params.askId);
    if (!entry) return refuse(closedOrNotFound(ctx.identity, ctx.params.askId));
    // A secret request is answered with its masked form only: a reply would
    // carry what the member typed into the chat and to the agent.
    if (entry.secret)
      return refuse(
        secretRequest(
          "This ask is a secret request. Save or decline it instead.",
        ),
      );
    if (entry.sudo)
      return refuse(
        sudoRequest("This ask is a sudo request. Run or decline it instead."),
      );
    // A reply draft to a messaging contact (task d03a61d8): only the row's
    // member, from the office, answers it. No agent, owner, app, schedule or API token
    // can make the tap that sends a message from the member's phone.
    if (
      entry.messaging &&
      !(
        ctx.identity.scope === "user" &&
        ctx.identity.userId !== null &&
        ctx.identity.userId === entry.memberUserId
      )
    )
      return refuse(notFound());
    // An ask with no agent (task 74e8fc07): nobody reads an answer.
    if (askAgentId(entry) === null && !dismiss)
      return refuse(
        fail(
          409,
          "no_agent",
          "No agent reads answers to this ask. Ack or dismiss it.",
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

  const messagingDraft = (message = "Answer Send or Don't send.") =>
    fail(409, "messaging_draft", message);

  // A messaging reply draft: the replies module sends it (or not) first, and
  // the agent then gets its words. A failed send tells nobody and leaves the
  // ask open for another Send.
  const answerDraft = async (
    ctx: Parameters<RouteHandler>[0],
    entry: AskEntry,
    input: { dismissed: boolean; text: string | undefined },
    device: string | undefined,
  ): Promise<HandlerResult> => {
    if (!deps.messaging)
      return messagingDraft(
        "Replies to messaging contacts are not available in this office.",
      );
    const res = await deps.messaging.answer(entry, input);
    if (res.kind === "fail") return fail(res.status, res.code, res.error);
    const dismissed = res.outcome === "dismissed";
    const result = await deps.deliver(ctx.identity, entry, res.text, {
      dismissed,
      device,
    });
    if (!result.ok) return fail(result.status, result.code, result.message);
    close(entry, {
      outcome: res.outcome,
      ...answeredBy(ctx.identity, input.text),
    });
    return res.refusal
      ? fail(res.refusal.status, res.refusal.code, res.refusal.error)
      : noContent();
  };

  const answer =
    (dismissed: boolean): RouteHandler =>
    async (ctx) => {
      const checked = answerable(
        ctx,
        dismissed ? "note" : "required",
        dismissed,
      );
      if (!checked.ok) return checked.result;
      const { entry, device } = checked;
      // An ask with no agent closes with no message to anyone.
      if (askAgentId(entry) === null) {
        close(entry, {
          outcome: "dismissed",
          ...answeredBy(ctx.identity, checked.text),
        });
        return noContent();
      }
      if (entry.messaging) {
        delivering.add(entry.id);
        try {
          return await answerDraft(
            ctx,
            entry,
            { dismissed, text: checked.text },
            device,
          );
        } finally {
          delivering.delete(entry.id);
        }
      }
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
    if (entry.messaging) return messagingDraft();
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
        ...(packSenderOf(ctx.identity) ? { limited: true as const } : {}),
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

  // Ack a paged ask (task 74e8fc07): its alarm stops for every member it is
  // for, and it stays open. Whoever may answer it may ack it.
  const ackPage: RouteHandler = (ctx) => {
    const userId = ctx.identity.userId;
    const entry = readableBy(ctx.identity, ctx.params.askId);
    if (!entry || !userId)
      return closedOrNotFound(ctx.identity, ctx.params.askId);
    if (!entry.page) return fail(409, "not_paged", "This ask is not paged.");
    const acked = store.ack(entry.id, userId);
    if (!acked) return closedOrNotFound(ctx.identity, ctx.params.askId);
    return ok(
      askMemberWire(
        acked.entry,
        (id) => deps.memberName(id),
        audienceFor(ctx.identity),
      ),
    );
  };

  // Ask the agent to rewrite the ask in plain words; the ask stays open and
  // is marked once the agent has the message, so the card shows the rewrite
  // is coming. A refused message leaves it unmarked. One request at a time:
  // the agent's edit of the prompt clears the mark.
  const simplify: RouteHandler = async (ctx) => {
    const checked = answerable(ctx, "none");
    if (!checked.ok) return checked.result;
    const { entry, device } = checked;
    if (entry.messaging) return messagingDraft();
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
    if (entry.messaging) return messagingDraft();
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
    // The body came from the text/plain form: member and room are lists.
    fromText: boolean,
  ): Promise<HandlerResult> => {
    const checked = checkPromptField(body);
    if (!checked.ok) return fail(400, "invalid_text", checked.message);
    // Who it is for (task 9461c464): the manager, named members or the room.
    const room = body.room !== undefined;
    if (
      room &&
      (body.member !== undefined ||
        !(fromText ? body.room === "1" : body.room === true))
    )
      return invalidMembers(
        fromText
          ? "use room=1, and no member with it"
          : "room must be true, and no member with it",
      );
    let names: string[] | undefined;
    if (typeof body.member === "string") names = [body.member];
    else if (Array.isArray(body.member)) {
      const list: unknown[] = body.member;
      if (
        list.length === 0 ||
        list.length > ASK_MEMBERS_MAX ||
        !list.every((n): n is string => typeof n === "string" && n !== "")
      )
        return invalidMembers(
          `member must list 1 to ${ASK_MEMBERS_MAX} usernames`,
        );
      if (new Set(list.map((n) => n.toLowerCase())).size !== list.length)
        return invalidMembers("member names the same member twice");
      names = list;
    } else if (body.member !== undefined)
      return fail(
        422,
        "invalid_request",
        "member must be a username or a list of usernames",
      );
    const shared = room || (names !== undefined && names.length > 1);
    if (shared && body.step !== undefined)
      return invalidMembers("a step ask is for one member");
    if (body.link !== undefined && !linkValid(body.link)) return invalidLink();
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
    // A paged ask (task 74e8fc07): it rings until a member acks or answers it.
    const page = body.page !== undefined;
    if (page && !(fromText ? body.page === "1" : body.page === true))
      return fail(
        400,
        "invalid_request",
        fromText ? "use page=1 to page" : "page must be true",
      );
    const lists = affordanceLists(body, null);
    if (!lists.ok) return lists.result;
    const asker = resolve(body);
    if (!asker.ok) return asker.result;
    const { agentId, agent } = asker;
    // Everyone it is for, the stored member first.
    let memberUserIds: string[];
    if (room) {
      const everyone = askRoomAudience(agent.roomId, audience);
      if (everyone.length === 0)
        return fail(
          422,
          "no_audience",
          "Every member who can reach this room hides it. Name members with member= instead.",
        );
      // The stored member, for an older server: the manager when they are
      // in the audience, else the first by id.
      const first =
        asker.manager && everyone.includes(asker.manager)
          ? asker.manager
          : [...everyone].sort()[0];
      memberUserIds = [first, ...everyone.filter((id) => id !== first)];
    } else if (names !== undefined) {
      memberUserIds = [];
      for (const name of names) {
        const member = deps.memberByName(name);
        if (!member)
          return fail(422, "unknown_member", `No member named ${name}.`);
        if (!deps.memberCanSeeRoom(member.id, agent.roomId))
          return fail(
            422,
            "member_no_access",
            `${member.name} cannot reach this agent's room.`,
          );
        memberUserIds.push(member.id);
      }
    } else {
      if (!asker.manager)
        return fail(
          409,
          "no_manager",
          "This agent has no manager. Name a member with member=<username>.",
        );
      if (!deps.memberCanSeeRoom(asker.manager, agent.roomId))
        return fail(
          422,
          "member_no_access",
          "That member cannot reach this agent's room.",
        );
      memberUserIds = [asker.manager];
    }
    const memberUserId = memberUserIds[0];
    if (body.link !== undefined && !linkReachable(body.link, memberUserIds))
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
        agentId,
        roomId: agent.roomId,
        managerUserId: agent.managerUserId,
        memberUserId,
        memberNamed: names !== undefined,
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
      ...(room ? { room: true as const } : {}),
      ...(!room && memberUserIds.length > 1
        ? { otherMemberUserIds: memberUserIds.slice(1) }
        : {}),
      prompt: checked.prompt,
      ...(body.link !== undefined ? { link: body.link as string } : {}),
      ...(step?.link !== undefined ? { link: step.link } : {}),
      ...(step ? { step: step.step } : {}),
      ...(options ? { options } : {}),
      ...(recommended !== undefined ? { recommended } : {}),
      ...(body.priority !== undefined
        ? { priority: body.priority }
        : page
          ? { priority: "P1" as const }
          : {}),
      ...(page ? { page: { recipients: memberUserIds } } : {}),
      // On a create every sent list is non-empty, so none is null.
      affordances: resolved.affordances as AskAffordances,
      // An app's ask has no opening session: the agent did not ask it.
      ...(asker.app
        ? { app: asker.app }
        : agent.sessionId
          ? { sessionId: agent.sessionId }
          : {}),
    });
    if (!result.ok)
      return result.code === "too_many_pages" ? tooManyPages() : tooManyAsks();
    for (const userId of memberUserIds)
      deps.recordMemberHeardFrom?.(userId, agentId);
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
    // An absent or empty prompt keeps it: an empty text/plain body is "".
    const sent = body.text !== undefined ? body.text : body.prompt;
    let prompt: string | undefined;
    if (
      (body.text !== undefined && body.prompt !== undefined) ||
      (sent !== undefined && sent !== "")
    ) {
      const checked = checkPromptField(body);
      if (!checked.ok) return fail(400, "invalid_text", checked.message);
      prompt = checked.prompt;
    }
    // Absent keeps the link and "" removes it.
    if (body.link !== undefined && body.link !== "" && !linkValid(body.link))
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
    // Who it is for is fixed at create (task 9461c464).
    if (body.member !== undefined || body.room !== undefined)
      return invalidMembers("an ask's members cannot be edited");
    // So is the alarm (task 74e8fc07).
    if (body.page !== undefined)
      return fail(
        400,
        "invalid_request",
        "page is set at create only. Delete the ask and open a new one.",
      );
    const prev = find();
    if (!prev) return notFound();
    // A reply draft is fixed once the member can see it.
    if (prev.messaging)
      return messagingDraft(
        "A reply draft cannot be edited. Delete it and draft a new one.",
      );
    if (prev.secret)
      return secretRequest(
        "A secret request cannot be edited. Delete it to withdraw it.",
      );
    if (prev.sudo)
      return sudoRequest(
        "A sudo request cannot be edited. Delete it to withdraw it.",
      );
    // A step and its link are fixed after create (task c71cb60f).
    if (body.step !== undefined)
      return fail(400, "invalid_request", "an ask's step cannot be edited");
    if (prev.step && body.link !== undefined)
      return fail(400, "invalid_request", "a step ask's link cannot be edited");
    if (
      body.link !== undefined &&
      body.link !== "" &&
      !linkReachable(body.link, askMemberIds(prev, audience))
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
      prompt ?? prev.prompt,
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

  // Action steps in flight, so a second Apply (or a second browser) cannot
  // run the change twice.
  const running = new Set<string>();

  // The member the ask is for runs its action step (task e3d1bc63): the
  // step's own route, dispatched as the caller, answers. The run does not
  // close the ask; the change does, through reconcile.
  const runAction: RouteHandler = async (ctx) => {
    const id = ctx.params.askId;
    const entry = store.get(id);
    if (
      !entry?.memberUserId ||
      !askVisibleTo(entry, ctx.identity.userId, audienceFor(ctx.identity))
    )
      return notFound();
    const runs = deps.stepRuns;
    const run =
      entry.step && runs
        ? runs.routeOf(entry.step, entry.memberUserId, ctx.callerSessionIdHash)
        : null;
    if (!runs || !run)
      return fail(409, "not_runnable", "This ask has no action to run.");
    if (!run.ok) return fail(run.status, run.code, run.message);
    // Claimed before the first await.
    if (running.has(id))
      return fail(409, "action_in_flight", "This action is running.");
    running.add(id);
    try {
      // The routes in order, to the end of the list even when the change
      // closes the ask on the way; the first refusal stops the run and
      // answers. The last route's answer is the run's.
      let res: { status: number; body: unknown } = { status: 204, body: null };
      for (const route of run.routes) {
        res = await runs.dispatch(ctx.identity, route, {
          askId: id,
          callerSessionIdHash: ctx.callerSessionIdHash,
        });
        if (res.status >= 400) break;
      }
      if (res.status < 400)
        return res.status === 204 ? noContent() : ok(res.body, res.status);
      const error =
        (res.body as { error?: Record<string, unknown> } | null)?.error ?? {};
      const { code, message, ...detail } = error;
      return fail(
        res.status as HandlerErrorStatus,
        typeof code === "string" ? code : "action_failed",
        typeof message === "string" ? message : undefined,
        Object.keys(detail).length > 0 ? detail : undefined,
      );
    } finally {
      running.delete(id);
    }
  };

  // The member's Run of one of the ask's commands (task c3b91695). The run
  // starts here and ends in finishRun; the route answers at the start.
  const runCommand: RouteHandler = async (ctx) => {
    const runs = deps.commandRuns;
    const entry = readableBy(ctx.identity, ctx.params.askId);
    if (!entry || !deps.agent(entry.agentId) || !ctx.identity.userId)
      return notFound();
    if (!runs || entry.secret || entry.sudo || entry.messaging)
      return fail(409, "not_runnable", "This ask has no command to run.");
    const refusal = runs.refusal(ctx.identity, entry.agentId);
    if (refusal === "terminal_forbidden")
      return fail(
        403,
        refusal,
        "You cannot use this agent's terminal, so you cannot run its commands.",
      );
    if (refusal === "agent_limited")
      return fail(403, refusal, "Run is off for agents below Standard access.");
    const command = (ctx.body as { command?: unknown } | null)?.command;
    if (typeof command !== "string" || !entry.commands?.includes(command))
      return fail(
        409,
        "command_changed",
        "The ask no longer has this command. Read it again.",
      );
    if (!isRunnableCommand(command))
      return fail(
        409,
        "command_not_runnable",
        "This command has characters that do not show, so it has no Run.",
      );
    // Claimed before the first await, until the run's end is handled.
    if (commandRunning.has(entry.id))
      return fail(409, "run_in_progress", "A command of this ask is running.");
    commandRunning.add(entry.id);
    const run: AskCommandRun = {
      command,
      by: ctx.identity.userId,
      startedAt: runs.now(),
      state: "running",
    };
    let started: { done: Promise<AskRunResult> };
    try {
      store.setRun(entry.id, command, run);
      started = await runs.start(entry.agentId, command);
    } catch (err) {
      commandRunning.delete(entry.id);
      try {
        store.setRun(entry.id, command, null);
      } catch (cleanup) {
        console.error(
          `[asks] ${entry.id}: a failed run stays running:`,
          cleanup,
        );
      }
      if (err instanceof AsksUnavailableError) throw err;
      console.error(`[asks] ${entry.id}: the command could not start:`, err);
      return fail(500, "run_failed", "The command could not start.");
    }
    const identity = ctx.identity;
    void started.done
      .then(
        (result) => finishRun(entry.id, entry.agentId, identity, run, result),
        (err: unknown) =>
          finishRun(entry.id, entry.agentId, identity, run, {
            exitCode: null,
            signal: null,
            timedOut: false,
            durationMs: runs.now() - run.startedAt,
            output: `The run failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
      )
      .catch((err: unknown) =>
        console.error(`[asks] ${entry.id}: the end of a run failed:`, err),
      )
      .finally(() => commandRunning.delete(entry.id));
    return ok(run, 202);
  };

  // The end of a run. The store is read again: the ask can have closed, or
  // the agent can have dropped the command, while it ran. Then the agent
  // hears it: the ask's answer when every command of the ask has now
  // succeeded, else a notice.
  const finishRun = async (
    askId: string,
    agentId: string,
    identity: Identity,
    run: AskCommandRun,
    result: AskRunResult,
  ) => {
    const runs = deps.commandRuns!;
    const done: AskCommandRun = {
      ...run,
      state: "done",
      exitCode: result.exitCode,
      signal: result.signal,
      ...(result.timedOut ? { timedOut: true as const } : {}),
      durationMs: result.durationMs,
      output: result.output,
    };
    const member = deps.memberName(identity.userId ?? "") ?? "A member";
    const notice = () =>
      runs.notify(agentId, askRunNotice(askId, member, done), {
        askId,
        memberUserId: run.by,
        line: askRunLine(done),
      });
    const entry = store.get(askId);
    const written =
      entry && entry.commands?.includes(run.command)
        ? store.setRun(askId, run.command, done)
        : null;
    if (!written) return notice();
    const allSucceeded = (written.commands ?? []).every((command) =>
      written.runs?.some(
        (r) => r.command === command && r.state === "done" && r.exitCode === 0,
      ),
    );
    if (!allSucceeded || delivering.has(askId) || !readableBy(identity, askId))
      return notice();
    const text = askRunReply(written);
    delivering.add(askId);
    try {
      const accepted = await deps.deliver(identity, written, text, {
        dismissed: false,
        device: undefined,
      });
      if (!accepted.ok) {
        console.warn(
          `[asks] ${askId}: the run's answer was refused (${accepted.code}); the ask stays open`,
        );
        return;
      }
      close(written, { outcome: "replied", ...answeredBy(identity, text) });
    } finally {
      delivering.delete(askId);
    }
  };

  return {
    "asks.runAction": guarded(runAction),
    "asks.runCommand": guarded(runCommand),
    "agents.createAsk": guarded((ctx) =>
      create(
        (ctx.body ?? {}) as Record<string, unknown>,
        () => {
          const agent = deps.agent(ctx.params.id);
          return agent
            ? {
                ok: true,
                agentId: ctx.params.id,
                agent,
                manager: agent.managerUserId,
              }
            : { ok: false, result: fail(404, "not_found", "No such agent.") };
        },
        ctx.form === "text",
      ),
    ),

    "agents.listAsks": guarded((ctx) =>
      ok(store.listForAgent(ctx.params.id).map(wire)),
    ),

    "agents.getAsk": guarded((ctx) => {
      const ask = read(ctx.params.askId, ctx.params.id);
      return ask ? ok(ask) : notFound();
    }),

    // A read file of the agent's own ask, open or closed (task a5fb19fa):
    // only a filename the ask lists. A copy is served from the agent's files
    // dir, a reference as asks.getFile serves it. The prune does not keep a
    // closed ask's copies, so they can be gone.
    "agents.getAskFile": guarded((ctx) => {
      const { id: agentId, askId, filename } = ctx.params;
      const entry =
        own(agentId, askId) ?? deps.history.get(agentId, askId)?.entry ?? null;
      const ref = entry?.readFiles?.find((f) => f.filename === filename);
      const noFile = () => fail(404, "not_found", "No such file in this ask.");
      if (!entry || !ref) return noFile();
      if (ref.path !== undefined)
        return serveReference(entry, ref, ctx.query) ?? noFile();
      const path = deps.filePath(agentId, filename);
      if (!path) return noFile();
      return file(path, deps.contentTypeFor(filename), {
        ...deps.untrustedFileHeaders(),
        ...downloadHeader(ctx.query, filename),
      });
    }),

    // Any agent's ask by its id, open or closed, for a caller with the reach
    // of that agent's logs.
    "asks.get": guarded((ctx) => {
      const ask = read(ctx.params.askId);
      if (!ask) return notFound();
      // An ask with no agent has no logs: whoever may answer it reads it,
      // open or closed.
      if (askAgentId(ask) === null) {
        const entry =
          store.get(ask.id) ?? deps.history.getById(ask.id)?.entry ?? null;
        const seen = audienceFor(ctx.identity);
        return entry &&
          (askVisibleTo(entry, ctx.identity.userId, seen) ||
            askShownToOwnerAsOther(entry, ctx.identity.userId, seen))
          ? ok(ask)
          : notFound();
      }
      return deps.canReadAgentLogs(ctx.identity, ask.agentId)
        ? ok(ask)
        : notFound();
    }),

    "agents.editAsk": guarded((ctx) =>
      edit((ctx.body ?? {}) as Record<string, unknown>, ctx.params.askId, () =>
        own(ctx.params.id, ctx.params.askId),
      ),
    ),

    "agents.deleteAsk": guarded((ctx) => {
      const entry = own(ctx.params.id, ctx.params.askId);
      if (!entry) return notFound();
      if (entry.sudo && deps.sudoRunInProgress?.(entry.agentId))
        return fail(
          409,
          "run_in_progress",
          "A sudo command of this agent is running. Try again when it ends.",
        );
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
      return create(
        (ctx.body ?? {}) as Record<string, unknown>,
        (body) => {
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
          if (
            (body.member !== undefined || body.room !== undefined) &&
            !actsForAgent(ctx.identity)
          )
            return {
              ok: false,
              result: fail(
                403,
                "forbidden",
                "this app has no live owner agent, so its asks go to its owner only",
              ),
            };
          if (
            body.member === undefined &&
            body.room === undefined &&
            !app.ownerUserId
          )
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
        },
        ctx.form === "text",
      );
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
      const seen = audienceFor(ctx.identity);
      return ok(
        store
          .listAll()
          .filter((entry) => askVisibleTo(entry, userId, seen))
          .map((entry) =>
            askMemberWire(entry, (id) => deps.memberName(id), seen),
          ),
      );
    }),

    "asks.listOthers": guarded((ctx) => {
      const userId = ctx.identity.userId;
      const seen = audienceFor(ctx.identity);
      if (!userId || !seen.isOfficeOwner(userId))
        return fail(
          403,
          "forbidden",
          "Only an office owner can list other members' asks.",
        );
      return ok(
        store
          .listAll()
          .filter((entry) => askShownToOwnerAsOther(entry, userId, seen))
          .map(wire),
      );
    }),

    "asks.reply": guarded(answer(false)),
    "asks.dismiss": guarded(answer(true)),
    "asks.fileTask": guarded(fileTask),
    "asks.simplify": guarded(simplify),
    "asks.ack": guarded(ackPage),
    "asks.simplifyUndo": guarded(simplifyUndo),
    // A file the ask references where it is, for the ask's member. An office
    // owner gets the file of another member's ask too.
    "asks.getFile": guarded((ctx) => {
      const entry = readableBy(ctx.identity, ctx.params.askId);
      const ref = entry?.readFiles?.find(
        (f) => f.filename === ctx.params.filename && f.path !== undefined,
      );
      return (
        (entry && ref && serveReference(entry, ref, ctx.query)) ??
        fail(404, "not_found", "No such file in an open ask.")
      );
    }),
  };
}
