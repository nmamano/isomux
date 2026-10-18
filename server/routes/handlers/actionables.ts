// Actionable handlers (internal-docs/actionables-design.md).
//
// Agent routes (/api/agents/:id/actionables...): the route guard proves the
// token's agent is :id, so an agent reaches only its own list. Member routes
// (/api/actionables...): only the member the actionable is for, while that
// member can still reach the agent's room; anyone else gets the same 404 as an
// unknown id.
//
// A reply or a dismiss is a member message to the agent through the path a
// typed message takes, so it wakes or resumes the agent the same way and is
// refused only where a typed message would be. The actionable closes after the
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
import type { ActionableEntry } from "../../../shared/types.ts";
import type { ActionableAgentWire } from "../../../shared/contract-shapes.ts";
import type { UserSendAcceptance } from "../../internal-types.ts";
import {
  ActionablesUnavailableError,
  ACTIONABLE_MAX_OPEN_PER_AGENT,
  checkPrompt,
  type ActionableStore,
} from "../../actionables.ts";

// The member message text of a dismiss. The chat shows it translated from the
// entry's metadata; the agent reads these words.
export const ACTIONABLE_DISMISSED_TEXT = "Dismissed";

export interface ActionablesDeps {
  store: ActionableStore;
  // The agent as it is now, or null when it is gone.
  agent(agentId: string): { roomId: string; managerUserId: string | null } | null;
  // A member by username (case-insensitive), or null.
  memberByName(name: string): { id: string; name: string } | null;
  // A member's username, or null when the record is gone.
  memberName(userId: string): string | null;
  // Whether a member can reach a room.
  memberCanSeeRoom(userId: string, roomId: string): boolean;
  // Deliver the member's message to the agent, carrying the actionable.
  // Resolves at the acceptance decision, as a typed member message does.
  deliver(
    identity: Identity,
    entry: ActionableEntry,
    text: string,
    opts: { dismissed: boolean; device: string | undefined },
  ): Promise<UserSendAcceptance>;
}

function guarded(handler: RouteHandler): RouteHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof ActionablesUnavailableError)
        return fail(500, "actionables_unavailable", err.message);
      throw err;
    }
  };
}

export function actionableHandlers(
  deps: ActionablesDeps,
): Record<string, RouteHandler> {
  const { store } = deps;
  // Reply and dismiss in flight, so a second click (or a second browser)
  // cannot send the message twice.
  const delivering = new Set<string>();

  const wire = (entry: ActionableEntry): ActionableAgentWire => ({
    ...entry,
    member: deps.memberName(entry.memberUserId) ?? entry.memberUserId,
  });

  // The agent's own open entry, or null.
  const own = (agentId: string, id: string): ActionableEntry | null => {
    const entry = store.get(id);
    return entry && entry.agentId === agentId ? entry : null;
  };

  // The caller's open entry while it can still reach the agent, or null.
  const addressedTo = (
    identity: Identity,
    id: string,
  ): ActionableEntry | null => {
    const entry = store.get(id);
    if (!entry || !identity.userId || entry.memberUserId !== identity.userId)
      return null;
    const agent = deps.agent(entry.agentId);
    if (!agent || !deps.memberCanSeeRoom(identity.userId, agent.roomId))
      return null;
    return entry;
  };

  const notFound = () => fail(404, "not_found", "No such open actionable.");

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
      let text = ACTIONABLE_DISMISSED_TEXT;
      if (!dismissed) {
        if (typeof body.text !== "string" || body.text.trim().length === 0)
          return fail(400, "invalid_text", "text is required");
        text = body.text;
      }
      const entry = addressedTo(ctx.identity, ctx.params.actionableId);
      if (!entry) return notFound();
      if (delivering.has(entry.id))
        return fail(
          409,
          "actionable_busy",
          "An answer to this actionable is being sent.",
        );
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
            `[actionables] ${entry.id} was answered but could not be closed:`,
            err,
          );
        }
        return noContent();
      } finally {
        delivering.delete(entry.id);
      }
    };

  return {
    "agents.createActionable": guarded((ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const checked = checkPrompt(body.text);
      if (!checked.ok) return fail(400, "invalid_text", checked.message);
      if (body.member !== undefined && typeof body.member !== "string")
        return fail(422, "invalid_request", "member must be a username");
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
      });
      if (!result.ok)
        return fail(
          429,
          "too_many_actionables",
          `At most ${ACTIONABLE_MAX_OPEN_PER_AGENT} open actionables per agent. Delete one first.`,
        );
      return created(wire(result.entry));
    }),

    "agents.listActionables": guarded((ctx) =>
      ok(store.listForAgent(ctx.params.id).map(wire)),
    ),

    "agents.getActionable": guarded((ctx) => {
      const entry = own(ctx.params.id, ctx.params.actionableId);
      return entry ? ok(wire(entry)) : notFound();
    }),

    "agents.editActionable": guarded((ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const checked = checkPrompt(body.text);
      if (!checked.ok) return fail(400, "invalid_text", checked.message);
      if (!own(ctx.params.id, ctx.params.actionableId)) return notFound();
      const entry = store.edit(ctx.params.actionableId, checked.prompt);
      return entry ? ok(wire(entry)) : notFound();
    }),

    "agents.deleteActionable": guarded((ctx) => {
      if (!own(ctx.params.id, ctx.params.actionableId)) return notFound();
      return store.remove(ctx.params.actionableId) ? noContent() : notFound();
    }),

    "actionables.list": guarded((ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return ok([]);
      return ok(
        store.listForMember(userId).filter((entry) => {
          const agent = deps.agent(entry.agentId);
          return !!agent && deps.memberCanSeeRoom(userId, agent.roomId);
        }),
      );
    }),

    "actionables.reply": guarded(answer(false)),
    "actionables.dismiss": guarded(answer(true)),
  };
}
