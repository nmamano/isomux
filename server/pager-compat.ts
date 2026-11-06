// The compat pager routes over paged asks (task 74e8fc07): a page is a paged
// ask, and POST /api/pager, POST /api/app/pager and the list, get, ack and
// resolve routes read and write paged asks by their page id. This module
// builds the PagerEntry those routes return.
//
// LEAF: imports only shared types and the ask store's types.

import type { AskPageSource, AskStore } from "./asks.ts";
import type {
  AskClosure,
  AskEntry,
  PagerEntry,
  PagerSource,
} from "../shared/types.ts";

export interface PagerCompatDeps {
  // The agent as it is now, or null when it is gone.
  agent(agentId: string): { name: string; roomId: string } | null;
  // The app with this name and registration (createdAt) as it is now: its
  // registration generation and the room of the agent that registered it
  // (null when that agent is gone). Null when the app is gone.
  app(
    name: string,
    createdAt: number,
  ): { registrationGen: number; roomId: string | null } | null;
  // The member's name now, or null when they are gone.
  memberName(userId: string): string | null;
}

// A page's text as an ask's prompt: the title, then a blank line and the
// body when there is one.
export function pagePrompt(title: string, body?: string): string {
  return body ? `${title}\n\n${body}` : title;
}

// The page a paged ask is: open or acked from the ask, resolved with the
// close of its history record (`closure`). The text splits back at the
// first blank line: a compat title is one line.
export function pagerEntryFromAsk(
  entry: AskEntry,
  closure: AskClosure | null,
  deps: PagerCompatDeps,
): PagerEntry {
  const page = entry.page;
  if (!page) throw new Error(`ask ${entry.id} is not paged`);
  const name = (userId: string) =>
    userId === "" ? "" : (deps.memberName(userId) ?? "");
  const agentName = () => deps.agent(entry.agentId)?.name ?? "";
  const split = entry.prompt.indexOf("\n\n");
  const target = entry.memberUserId ?? "";
  return {
    id: page.pageId ?? "",
    askId: entry.id,
    createdAt: entry.createdAt,
    lastRaisedAt: page.lastRaisedAt ?? entry.createdAt,
    raiseCount: page.raiseCount ?? 1,
    source: pageSource(entry, deps),
    targetUserId: target,
    title: split < 0 ? entry.prompt : entry.prompt.slice(0, split),
    ...(split < 0 ? {} : { body: entry.prompt.slice(split + 2) }),
    ...(page.key !== undefined ? { key: page.key } : {}),
    state: closure ? "resolved" : page.state === "acked" ? "acked" : "open",
    ...(page.state === "acked"
      ? {
          acked: {
            by: name(page.ackedByUserId ?? ""),
            at: page.ackedAt ?? 0,
          },
        }
      : {}),
    ...(closure
      ? {
          resolved: {
            by:
              closure.byUserId !== undefined
                ? name(closure.byUserId)
                : (closure.app ??
                  (closure.outcome === "dismissed" ? "" : agentName())),
            at: closure.at,
          },
        }
      : {}),
    delivery: { ...(page.delivery[target] ?? NOT_SENT) },
  };
}

const NOT_SENT = { state: "not_delivered", sends: 0 } as const;

// Where a page comes from, as it is now: an app by its live registration
// (generation 0 and no room when it is gone), an office feature, or the
// agent in its room (no room when it is gone).
function pageSource(entry: AskEntry, deps: PagerCompatDeps): PagerSource {
  if (entry.app) {
    const app = deps.app(entry.app.name, entry.app.createdAt);
    return {
      kind: "app",
      appName: entry.app.name,
      registrationGen: app?.registrationGen ?? 0,
      name: entry.app.name,
      roomId: app?.roomId ?? null,
    };
  }
  if (entry.office)
    return {
      kind: "office",
      feature: entry.office.feature as "whatsapp" | "discord",
      name: entry.office.name,
      roomId: null,
    };
  const agent = deps.agent(entry.agentId);
  return {
    kind: "agent",
    agentId: entry.agentId,
    name: agent?.name ?? "",
    roomId: agent?.roomId ?? "",
  };
}

// A raise through a compat route or the office's own code: into the open
// page of this source with this key (an agent's: only the one for this
// member), else a new P1 paged ask.
export function raisePage(
  store: Pick<AskStore, "openPaged" | "reraise" | "create">,
  input: {
    source: AskPageSource;
    // "" for an app page whose message target is gone.
    agentId: string;
    memberUserId: string;
    app?: { name: string; createdAt: number };
    sessionId?: string;
    fields: { title: string; body?: string; key?: string };
  },
):
  | { outcome: "created" | "updated"; entry: AskEntry }
  | { outcome: "too_many" | "too_many_pages" } {
  const { source, fields } = input;
  const prompt = pagePrompt(fields.title, fields.body);
  if (fields.key !== undefined) {
    const open = store.openPaged(
      source,
      fields.key,
      source.kind === "agent" ? input.memberUserId : undefined,
    );
    const raised = open
      ? store.reraise(
          open.id,
          prompt,
          input.app ? { app: input.app.name } : undefined,
        )
      : null;
    if (raised) return { outcome: "updated", entry: raised.entry };
  }
  const made = store.create({
    agentId: input.agentId,
    memberUserId: input.memberUserId,
    prompt,
    priority: "P1",
    ...(input.app ? { app: input.app } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    page: {
      recipients: [input.memberUserId],
      ...(fields.key !== undefined ? { key: fields.key } : {}),
    },
  });
  if (!made.ok) return { outcome: made.code };
  return { outcome: "created", entry: made.entry };
}
