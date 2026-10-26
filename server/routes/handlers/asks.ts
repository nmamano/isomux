// Ask handlers (internal-docs/asks-design.md).
//
// Agent routes (/api/agents/:id/asks...): the route guard proves the
// token's agent is :id, so an agent reaches only its own list. Member routes
// (/api/asks...): only a member askVisibleTo admits (the member the ask is
// for, or an owner for an office secret request), while that member can
// still reach the agent's room; anyone else gets the same 404 as an unknown
// id. An app the member let in (app:inbox) answers as the member and never
// sees a secret request. A secret request is answered on its own routes (secret-requests.ts),
// never with a reply, a dismiss or a filed task.
//
// A reply, a dismiss or a filed task is a member message to the agent through
// the path a typed message takes, so it wakes or resumes the agent the same
// way and is refused only where a typed message would be. The ask closes after
// the message is accepted; a refused message leaves it open.
//
// The store emits the per-recipient events on commit, so these handlers never
// emit directly. LEAF over the executor, the store and shared types.

import {
  ok,
  created,
  fail,
  noContent,
  type RouteHandler,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import {
  ASK_DISMISSED_TEXT,
  ASK_FILED_TEXT,
  type AskEntry,
  type TaskItem,
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
import type { AskAgentWire } from "../../../shared/contract-shapes.ts";
import type { UserSendAcceptance } from "../../internal-types.ts";
import {
  askMemberWire,
  askTaskFields,
  askVisibleTo,
  AsksUnavailableError,
  ASK_AFFORDANCE_KEYS,
  ASK_AFFORDANCES_MAX,
  ASK_MAX_OPEN_PER_AGENT,
  type AskAffordanceEdit,
  type AskAffordances,
  checkOptions,
  checkRecommended,
  checkPrompt,
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
  // The agent as it is now, or null when it is gone.
  agent(agentId: string): {
    roomId: string;
    managerUserId: string | null;
    sessionId?: string | null;
  } | null;
  // A member by username (case-insensitive), or null.
  memberByName(name: string): { id: string; name: string } | null;
  // A member's username, or null when the record is gone.
  memberName(userId: string): string | null;
  // Whether a member can reach a room.
  memberCanSeeRoom(userId: string, roomId: string): boolean;
  isOfficeOwner(userId: string): boolean;
  // An ask's chat affordances: the chat's checks, paths against the agent's
  // cwd, and the copy of a read file. Null when the agent is gone.
  affordances: {
    checkCommand(raw: string): CommandCheck;
    probeEditFile(agentId: string, rawPath: string): EditFileCheck | null;
    probeReadFile(agentId: string, rawPath: string): ReadFileCheck | null;
    copyReadFile(agentId: string, absPath: string): AskReadFileCopy | null;
  };
  // Deliver the member's message to the agent, carrying the ask (and the
  // task it was filed as). Resolves at the acceptance decision, as a typed
  // member message does.
  deliver(
    identity: Identity,
    entry: AskEntry,
    text: string,
    opts: {
      dismissed: boolean;
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

  const wire = (entry: AskEntry): AskAgentWire => ({
    ...askMemberWire(entry),
    // An office secret request is for every owner and names no member.
    member:
      entry.memberUserId === undefined
        ? null
        : (deps.memberName(entry.memberUserId) ?? entry.memberUserId),
  });

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

  // The caller's open entry while it can still reach the agent, or null.
  const addressedTo = (identity: Identity, id: string): AskEntry | null => {
    const entry = store.get(id);
    return entry && askVisibleTo(entry, identity.userId, audience)
      ? entry
      : null;
  };

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
  // files: a refusal before the copies leaves the files dir as it was. A
  // sent empty list becomes null (remove).
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
    const readPaths: string[] = [];
    for (const raw of lists.readFiles ?? []) {
      const probe = deps.affordances.probeReadFile(agentId, raw);
      if (!probe) return gone;
      if (!probe.ok)
        return { ok: false, result: pathRefused(probe, "invalid_read_file") };
      readPaths.push(probe.path);
    }
    const readFiles = [];
    for (const path of readPaths) {
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
  // member's note, and a blank one counts as none.
  const answerable = (
    ctx: Parameters<RouteHandler>[0],
    textRequired: boolean,
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
    if (textRequired) {
      if (typeof body.text !== "string" || body.text.trim().length === 0)
        return refuse(fail(400, "invalid_text", "text is required"));
      text = body.text;
    } else if (body.text !== undefined) {
      if (typeof body.text !== "string")
        return refuse(fail(400, "invalid_text", "text must be a string"));
      if (body.text.trim().length > 0) text = body.text;
    }
    const entry = addressedTo(ctx.identity, ctx.params.askId);
    // An app never sees a secret request: the same 404 as an unknown id.
    if (!entry || (entry.secret && ctx.identity.scope === "app"))
      return refuse(notFound());
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
  const close = (entry: AskEntry) => {
    try {
      store.remove(entry.id);
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
      const checked = answerable(ctx, !dismissed);
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
        close(entry);
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
    const checked = answerable(ctx, false);
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
      close(entry);
      return created(task);
    } finally {
      delivering.delete(entry.id);
    }
  };

  return {
    "agents.createAsk": guarded((ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const checked = checkPrompt(body.text);
      if (!checked.ok) return fail(400, "invalid_text", checked.message);
      if (body.member !== undefined && typeof body.member !== "string")
        return fail(422, "invalid_request", "member must be a username");
      if (body.link !== undefined && !askLinkFor(body.link))
        return invalidLink();
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
      const lists = affordanceLists(body, null);
      if (!lists.ok) return lists.result;
      const agent = deps.agent(ctx.params.id);
      if (!agent) return fail(404, "not_found", "No such agent.");
      let memberUserId: string;
      if (body.member !== undefined) {
        const member = deps.memberByName(body.member);
        if (!member)
          return fail(422, "unknown_member", `No member named ${body.member}.`);
        memberUserId = member.id;
      } else {
        if (!agent.managerUserId)
          return fail(
            409,
            "no_manager",
            "This agent has no manager. Name a member with member=<username>.",
          );
        memberUserId = agent.managerUserId;
      }
      if (!deps.memberCanSeeRoom(memberUserId, agent.roomId))
        return fail(
          422,
          "member_no_access",
          "That member cannot reach this agent's room.",
        );
      if (body.link !== undefined && !linkReachable(body.link, memberUserId))
        return invalidLink();
      if (store.listForAgent(ctx.params.id).length >= ASK_MAX_OPEN_PER_AGENT)
        return tooManyAsks();
      const resolved = resolveAffordances(ctx.params.id, lists.lists);
      if (!resolved.ok) return resolved.result;
      const result = store.create({
        agentId: ctx.params.id,
        memberUserId,
        prompt: checked.prompt,
        ...(body.link !== undefined ? { link: body.link as string } : {}),
        ...(options ? { options } : {}),
        ...(recommended !== undefined ? { recommended } : {}),
        // On a create every sent list is non-empty, so none is null.
        affordances: resolved.affordances as AskAffordances,
        ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
      });
      if (!result.ok) return tooManyAsks();
      return created(wire(result.entry));
    }),

    "agents.listAsks": guarded((ctx) =>
      ok(store.listForAgent(ctx.params.id).map(wire)),
    ),

    "agents.getAsk": guarded((ctx) => {
      const entry = own(ctx.params.id, ctx.params.askId);
      return entry ? ok(wire(entry)) : notFound();
    }),

    "agents.editAsk": guarded((ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const checked = checkPrompt(body.text);
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
      const prev = own(ctx.params.id, ctx.params.askId);
      if (!prev) return notFound();
      if (prev.secret)
        return secretRequest(
          "A secret request cannot be edited. Delete it to withdraw it.",
        );
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
      const resolved = resolveAffordances(ctx.params.id, lists.lists);
      if (!resolved.ok) return resolved.result;
      const entry = store.edit(
        ctx.params.askId,
        checked.prompt,
        body.link === "" ? null : (body.link as string | undefined),
        options,
        resolved.affordances,
        recommended,
      );
      return entry ? ok(wire(entry)) : notFound();
    }),

    "agents.deleteAsk": guarded((ctx) => {
      if (!own(ctx.params.id, ctx.params.askId)) return notFound();
      return store.remove(ctx.params.askId) ? noContent() : notFound();
    }),

    "asks.list": guarded((ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return ok([]);
      const isApp = ctx.identity.scope === "app";
      return ok(
        store
          .listAll()
          .filter(
            (entry) =>
              !(isApp && entry.secret) && askVisibleTo(entry, userId, audience),
          )
          .map(askMemberWire),
      );
    }),

    "asks.reply": guarded(answer(false)),
    "asks.dismiss": guarded(answer(true)),
    "asks.fileTask": guarded(fileTask),
  };
}
