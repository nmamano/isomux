// Ask handlers (internal-docs/asks-design.md).
//
// Agent routes (/api/agents/:id/asks...): the route guard proves the
// token's agent is :id, so an agent reaches only its own list. Member routes
// (/api/asks...): only a member askVisibleTo admits (the member the ask is
// for, or an owner for an office secret request), while that member can
// still reach the agent's room; anyone else gets the same 404 as an unknown
// id. A secret request is answered on its own routes (secret-requests.ts),
// never with a reply or a dismiss.
//
// A reply or a dismiss is a member message to the agent through the path a
// typed message takes, so it wakes or resumes the agent the same way and is
// refused only where a typed message would be. The ask closes after the
// message is accepted; a refused message leaves it open.
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
import { ASK_DISMISSED_TEXT, type AskEntry } from "../../../shared/types.ts";
import type { AskAgentWire } from "../../../shared/contract-shapes.ts";
import type { UserSendAcceptance } from "../../internal-types.ts";
import {
  askVisibleTo,
  AsksUnavailableError,
  ASK_MAX_OPEN_PER_AGENT,
  checkOptions,
  checkPrompt,
  type AskAudienceDeps,
  type AskStore,
} from "../../asks.ts";
import {
  OFFICE_LINK_PATHS,
  officeLinkFor,
} from "../../../shared/office-links.ts";

export { ASK_DISMISSED_TEXT };

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
  // Deliver the member's message to the agent, carrying the ask.
  // Resolves at the acceptance decision, as a typed member message does.
  deliver(
    identity: Identity,
    entry: AskEntry,
    text: string,
    opts: { dismissed: boolean; device: string | undefined },
  ): Promise<UserSendAcceptance>;
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

  // The opening session stays server-side: it is for the reply note only.
  const wire = ({ sessionId: _session, ...entry }: AskEntry): AskAgentWire => ({
    ...entry,
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
      `link must be one of: ${OFFICE_LINK_PATHS.join(", ")}`,
    );
  const invalidOptions = (message: string) =>
    fail(422, "invalid_options", message);
  const secretRequest = (message: string) =>
    fail(409, "secret_request", message);

  const answer =
    (dismissed: boolean): RouteHandler =>
    async (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (body.device !== undefined && typeof body.device !== "string")
        return fail(422, "invalid_request", "device must be a string");
      if (body.device !== undefined && ctx.identity.scope !== "user")
        return fail(
          400,
          "api_attribution_not_supported",
          "device is not supported for API token senders.",
        );
      let text = ASK_DISMISSED_TEXT;
      if (!dismissed) {
        if (typeof body.text !== "string" || body.text.trim().length === 0)
          return fail(400, "invalid_text", "text is required");
        text = body.text;
      } else if (body.text !== undefined) {
        // A dismiss can carry the member's reason; a blank one is a bare
        // dismiss.
        if (typeof body.text !== "string")
          return fail(400, "invalid_text", "text must be a string");
        if (body.text.trim().length > 0) text = body.text;
      }
      const entry = addressedTo(ctx.identity, ctx.params.askId);
      if (!entry) return notFound();
      // A secret request is answered with its masked form only: a reply would
      // carry what the member typed into the chat and to the agent.
      if (entry.secret)
        return secretRequest(
          "This ask is a secret request. Save or decline it instead.",
        );
      if (delivering.has(entry.id))
        return fail(409, "ask_busy", "An answer to this ask is being sent.");
      delivering.add(entry.id);
      try {
        const result = await deps.deliver(ctx.identity, entry, text, {
          dismissed,
          device: body.device,
        });
        if (!result.ok) return fail(result.status, result.code, result.message);
        try {
          store.remove(entry.id);
        } catch (err) {
          // The agent has the message; a retry would send it twice. The entry
          // stays open until the store can write again.
          console.error(
            `[asks] ${entry.id} was answered but could not be closed:`,
            err,
          );
        }
        return noContent();
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
      if (body.link !== undefined && !officeLinkFor(body.link))
        return invalidLink();
      let options: string[] | undefined;
      if (body.options !== undefined) {
        const checkedOptions = checkOptions(body.options);
        if (!checkedOptions.ok) return invalidOptions(checkedOptions.message);
        options = checkedOptions.options;
      }
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
      const result = store.create({
        agentId: ctx.params.id,
        memberUserId,
        prompt: checked.prompt,
        ...(body.link !== undefined ? { link: body.link as string } : {}),
        ...(options ? { options } : {}),
        ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
      });
      if (!result.ok)
        return fail(
          429,
          "too_many_asks",
          `At most ${ASK_MAX_OPEN_PER_AGENT} open asks per agent. Delete one first.`,
        );
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
      if (
        body.link !== undefined &&
        body.link !== "" &&
        !officeLinkFor(body.link)
      )
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
      const entry = store.edit(
        ctx.params.askId,
        checked.prompt,
        body.link === "" ? null : (body.link as string | undefined),
        options,
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
      return ok(
        store
          .listAll()
          .filter((entry) => askVisibleTo(entry, userId, audience)),
      );
    }),

    "asks.reply": guarded(answer(false)),
    "asks.dismiss": guarded(answer(true)),
  };
}
