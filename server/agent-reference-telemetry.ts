import { appendFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import {
  AGENT_ROUTE_REFERENCE_TOPICS,
  topicsPinningRoute,
} from "./agent-reference.ts";
import type { Identity } from "./identity/index.ts";

export const AGENT_REFERENCE_USAGE_LOG = join(
  STATE_ROOT,
  "agent-reference-usage.jsonl",
);

export type AgentReferenceUsageEvent =
  | {
      at: number;
      agentId: string;
      sessionId: string | null;
      kind: "reference_fetch";
      topic: string;
    }
  | {
      at: number;
      agentId: string;
      sessionId: string | null;
      kind: "feature_call";
      category: string;
      // Every topic that documents this call. Measurement counts a session's
      // first feature call as covered when an earlier fetch in the same
      // session is any of these.
      topics: string[];
      opId: string;
    };

export function agentReferenceUsageEvent(input: {
  identity: Identity;
  opId: string;
  topic?: string;
  route?: { method: string; path: string };
  // agents.sendMessage with deliverAt: the scheduled-messages feature.
  scheduled?: boolean;
  sessionId: string | null;
  now?: number;
}): AgentReferenceUsageEvent | null {
  if (input.identity.scope !== "agent" || !input.identity.agentId) return null;
  if (input.opId === "agentReference.get" && input.topic) {
    return {
      at: input.now ?? Date.now(),
      agentId: input.identity.agentId,
      sessionId: input.sessionId,
      kind: "reference_fetch",
      topic: input.topic,
    };
  }
  const mapped = AGENT_ROUTE_REFERENCE_TOPICS[input.opId];
  if (!mapped) return null;
  const category =
    input.opId === "agents.sendMessage" && input.scheduled
      ? "scheduled-messages"
      : mapped;
  const pinned = input.route
    ? topicsPinningRoute(input.route.method, input.route.path)
    : [];
  const topics = [...new Set<string>([category, ...pinned])];
  return {
    at: input.now ?? Date.now(),
    agentId: input.identity.agentId,
    sessionId: input.sessionId,
    kind: "feature_call",
    category,
    topics,
    opId: input.opId,
  };
}

export function recordAgentReferenceUsage(
  event: AgentReferenceUsageEvent | null,
): void {
  if (!event) return;
  try {
    appendFileSync(AGENT_REFERENCE_USAGE_LOG, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    // Observability must never turn a valid office call into a failure.
    console.error("[agent-reference-usage] could not append:", err);
  }
}

// Records one successful /api call. Observability must never fail or change
// a call, so every step, including reading a clone of the response to tell a
// scheduled send from a plain one, is contained here.
export async function recordApiReferenceUsage(
  match: {
    route: { opId: string; method: string; path: string };
    params: Record<string, string | undefined>;
  },
  identity: Identity,
  response: Response,
  sessionId: string | null,
): Promise<void> {
  try {
    if (identity.scope !== "agent") return;
    let scheduled = false;
    if (match.route.opId === "agents.sendMessage") {
      try {
        const body = (await response.clone().json()) as {
          scheduledId?: unknown;
        };
        scheduled = typeof body?.scheduledId === "string";
      } catch {
        // An unreadable ack still counts as a messaging call.
      }
    }
    recordAgentReferenceUsage(
      agentReferenceUsageEvent({
        identity,
        opId: match.route.opId,
        topic: match.params.topic,
        route: { method: match.route.method, path: match.route.path },
        scheduled,
        sessionId,
      }),
    );
  } catch (err) {
    console.error("[agent-reference-usage] could not record:", err);
  }
}
