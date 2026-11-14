// "Changed for you" (opId integrationChanges.list, task 7a3b4114): the
// Integrations changes someone else made for the caller - an office owner, by
// cookie, API token or privileged agent - read from the audit log. Nil,
// 2026-11-01: owners set a member's integrations, and the member sees what
// was changed for them.
//
// `by` is always a human: the member who acted, or the manager of the agent,
// token, cronjob or app that did. An agent's name never shows: the agent may
// be in a room the member cannot see. Names come from the live user records,
// so a rename shows the new name. Values never enter an audit row, so none
// can reach this answer.
//
// LEAF over the executor and the injected deps.

import { ok, fail, type RouteHandler } from "../executor.ts";
import type {
  IntegrationChange,
  IntegrationChangeKind,
  IntegrationChangesRes,
} from "../../../shared/contract-shapes.ts";
import type { AuditEntry } from "../../../shared/audit.ts";

const DAY = 24 * 60 * 60 * 1000;
export const INTEGRATION_CHANGE_DAYS = 30;
export const INTEGRATION_CHANGE_LIMIT = 20;

// Each write that changes a member's integration, and how it reads. A Test,
// a sign-in start and every read change nothing and stay out.
export const INTEGRATION_CHANGE_OPS: Record<
  string,
  { kind: IntegrationChangeKind; action: IntegrationChange["action"] }
> = {
  "userEnv.set": { kind: "variable", action: "set" },
  "userEnv.remove": { kind: "variable", action: "removed" },
  "secrets.create": { kind: "secret", action: "set" },
  "secrets.rotate": { kind: "secret", action: "set" },
  "secrets.update": { kind: "secret", action: "set" },
  "secrets.reissue": { kind: "secret", action: "set" },
  "secrets.delete": { kind: "secret", action: "removed" },
  "mcpServers.create": { kind: "mcp", action: "set" },
  "mcpServers.update": { kind: "mcp", action: "set" },
  "mcpServers.delete": { kind: "mcp", action: "removed" },
  "memberVoice.update": { kind: "voice", action: "set" },
  "pagerSettings.update": { kind: "pager", action: "set" },
  // An owner's sign-out stops the member's agents. A sign-in start may never
  // finish, and a finished one shows on the member's card as the account.
  "memberProviderAccounts.disconnect": { kind: "provider", action: "removed" },
};

export interface IntegrationChangesDeps {
  memberChanges(query: {
    userId: string;
    operations: readonly string[];
    since: number;
    limit: number;
  }): AuditEntry[];
  userName(userId: string): string | null;
  now?(): number;
}

export function integrationChangesHandlers(
  deps: IntegrationChangesDeps,
): Record<string, RouteHandler> {
  const byOf = (entry: AuditEntry): string | null => {
    const { actor } = entry;
    if (actor.kind === "member") return deps.userName(actor.id) ?? actor.name;
    return actor.ownerId ? deps.userName(actor.ownerId) : null;
  };
  return {
    "integrationChanges.list": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      const now = deps.now?.() ?? Date.now();
      const entries = deps.memberChanges({
        userId,
        operations: Object.keys(INTEGRATION_CHANGE_OPS),
        since: now - INTEGRATION_CHANGE_DAYS * DAY,
        limit: INTEGRATION_CHANGE_LIMIT,
      });
      const items: IntegrationChange[] = [];
      for (const entry of entries) {
        const op = INTEGRATION_CHANGE_OPS[entry.operation];
        // The member target alone does not say whose row it is: the row
        // must name this member as the one changed.
        if (!op || entry.member?.userId !== userId) continue;
        const item = entry.member.item;
        items.push({
          time: entry.time,
          by: byOf(entry),
          kind: op.kind,
          action: op.action,
          ...(item ? { name: item } : {}),
        });
      }
      const res: IntegrationChangesRes = { items };
      return ok(res);
    },
  };
}
