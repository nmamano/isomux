// Conversation-log read surface - GET /api/agents/:id/logs (opId agents.logs).
// Tasks da7b2899 (search your history) and b6d07978 (cleaned-up conversation
// retrieval), which is the tier ladder below.
//
// AUTH is `log:read` + the logSearchAccess guard: a human reaches any agent in
// a room they can access, and an AGENT token reaches ITSELF plus any agent in a
// room its boss can access. See server/identity/guards.ts for why a bare room
// check is the right shape for this READ, unlike the mutating routes next to it.
//
// The target need not be ALIVE. A killed agent keeps its transcripts, and the
// whole read path below is disk-backed (nothing here consults the roster), so
// the only thing that had to change for task ffb90761 was the guard, which
// answers for a dead agent on its own rule: the boss that spawned it, or an
// office owner.
//
// Read-only: nothing lands in chat, so the route emits nothing.
//
// One route, three modes, resolved from the query by parseLogQuery:
//   ?q=...        SEARCH    - decoded-content matching, newest hits first
//   ?session=...  RETRIEVE  - a whole session at a tier, or a window via around=
//   (neither)     INDEX     - the agent's sessions, newest first
//
// Shallow, like its neighbours: parsing and bounds live in log-search.ts, the
// process isolation in log-search-runner.ts. What the handler owns is the order
// of checks - notably that a caller-supplied session id is validated against
// THIS agent's own session list before anything is opened with it.

import {
  ok,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import {
  isSafeId,
  parseLogQuery,
  type LogQuery,
  type RetrieveResult,
  type SearchResult,
  type SessionIndexEntry,
} from "../../log-search.ts";
import type { PendingPromptKind } from "../../../shared/types.ts";
import type { LogInFlightTurn } from "../../../shared/contract-shapes.ts";

export type SearchOutcome =
  | { ok: true; result: SearchResult }
  | { ok: false; status: 429 | 500 | 504; code: string; message: string };

export interface LogsDeps {
  // Session ids with a log file on disk. The authority a caller-supplied
  // `session=` is checked against.
  listSessionIds(agentId: string): Promise<readonly string[]>;
  sessionIndex(
    agentId: string,
  ): Promise<{ agentId: string; sessions: SessionIndexEntry[] }>;
  retrieveSession(
    agentId: string,
    sessionId: string,
    query: LogQuery,
  ): Promise<RetrieveResult>;
  // Runs in a killable child process; `callerKey` keys the concurrency cap.
  search(
    callerKey: string,
    agentId: string,
    query: LogQuery,
  ): Promise<SearchOutcome>;
  // Which two-step prompt the agent is parked on RIGHT NOW, or null when it is
  // not parked (task 29daebe2). Null for a killed agent, which cannot be
  // waiting for anything.
  pendingPrompt(agentId: string): PendingPromptKind | null;
  // Live turn state for this agent. Null for killed/idle agents.
  inFlightTurn(agentId: string): LogInFlightTurn | null;
}

export function logsHandlers(deps: LogsDeps): Record<string, RouteHandler> {
  return {
    "agents.logs": async (ctx) => {
      const agentId = ctx.params.id;
      // The guard has already resolved this agent (live roster or killed list),
      // so this is defense in depth rather than the real check - but it is the
      // last point before an id becomes part of a filesystem path.
      if (!isSafeId(agentId)) {
        return fail(403, "forbidden");
      }

      const parsed = parseLogQuery(ctx.query);
      if ("code" in parsed) {
        return fail(400, parsed.code, parsed.message);
      }
      const query = parsed;

      // Validate the session against the TARGET agent's own sessions before it
      // is used to build a path. An unknown id is a 404 with the same wording
      // whether it never existed or belongs to a different agent.
      if (query.session !== undefined) {
        const known = await deps.listSessionIds(agentId);
        if (!known.includes(query.session)) {
          return fail(404, "unknown_session", "no such session for this agent");
        }
      }

      // LIVE AGENT STATE, NOT SESSION HISTORY (task 29daebe2). Attached to the
      // two transcript-reading modes because that is where its absence misled
      // people: a permission prompt is written as an ephemeral log entry, so it
      // never reaches disk, and a reader sees a turn that simply stops and
      // concludes the backend died. It describes the agent at the moment of
      // THIS request and says nothing about the session being read - a
      // transcript fetched for an old session still reports the agent's current
      // prompt, and re-reading the same session later can return a different
      // value. Search results deliberately omit it: a hit list is not a reading
      // of the agent's present state.
      //
      // The route's existing auth (log:read + the logSearchAccess guard) is the
      // whole boundary: a caller who cannot read this agent's logs never
      // reaches the handler, so the field discloses nothing the response body
      // did not already.
      const pendingPrompt = deps.pendingPrompt(agentId);
      const inFlightTurn = deps.inFlightTurn(agentId);

      switch (query.mode) {
        case "index":
          return ok({
            ...(await deps.sessionIndex(agentId)),
            pendingPrompt,
            inFlightTurn,
          });
        case "retrieve":
          // `session` is non-undefined here by construction: parseLogQuery only
          // returns "retrieve" when it is present.
          return ok({
            ...(await deps.retrieveSession(
              agentId,
              query.session as string,
              query,
            )),
            pendingPrompt,
            inFlightTurn,
          });
        case "search": {
          // The concurrency admission inside deps.search runs HERE, which is
          // after the route's authorize() stage - so a caller who cannot reach
          // this agent is turned away before occupying any capacity, and a 429
          // never becomes a way to probe office load against a target the
          // caller is not allowed to see.
          const outcome = await deps.search(
            callerKeyFor(ctx.identity),
            agentId,
            query,
          );
          return outcome.ok
            ? ok(outcome.result)
            : fail(
                outcome.status as HandlerErrorStatus,
                outcome.code,
                outcome.message,
              );
        }
      }
    },
  };
}

// What the per-caller concurrency cap is keyed on. An AGENT token keys on its
// own agent id, a human on their user id. Falling back to a shared bucket for
// an identity with neither is the conservative choice: it can only make the cap
// tighter, never looser.
function callerKeyFor(identity: {
  agentId?: string;
  userId: string | null;
}): string {
  if (identity.agentId) return `agent:${identity.agentId}`;
  if (identity.userId) return `user:${identity.userId}`;
  return "anonymous";
}
