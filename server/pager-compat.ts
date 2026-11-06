// The compat pager routes over paged asks (task 74e8fc07): a page is a paged
// ask, and POST /api/pager, POST /api/app/pager and the list, get, ack and
// resolve routes read and write paged asks by their page id. This module
// builds the PagerEntry those routes return.
//
// It also holds the raise body's bounds and its check, for the compat
// routes and the agent manager's own page.
//
// LEAF: imports only shared types and the ask store's types.

import type { AskPageSource, AskStore } from "./asks.ts";
import type {
  AskClosure,
  AskEntry,
  PagerEntry,
  PagerSource,
} from "../shared/types.ts";

// Sanity bounds only. BODY_MAX is not the whole outbound message budget: the
// delivery slice adds the room, the source and a link around it.
export const PAGER_TITLE_MAX = 200;
export const PAGER_BODY_MAX = 2000;
export const PAGER_KEY_MAX = 200;
// The raise body, after validation. Title is trimmed; an omitted body or key
// stays absent.
export interface PagerRaiseFields {
  title: string;
  body?: string;
  key?: string;
}

// Validate a raise body. Returns the fields, or the message for a 400.
export function parseRaiseFields(
  raw: unknown,
): { ok: true; fields: PagerRaiseFields } | { ok: false; message: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "body must be a JSON object" };
  }
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return { ok: false, message: "title is required" };
  }
  const title = body.title.trim();
  if (/[\r\n\u2028\u2029]/.test(title)) {
    return { ok: false, message: "title must be one line" };
  }
  if (title.length > PAGER_TITLE_MAX) {
    return {
      ok: false,
      message: `title is longer than ${PAGER_TITLE_MAX} characters`,
    };
  }
  const fields: PagerRaiseFields = { title };
  if (body.body !== undefined) {
    if (typeof body.body !== "string") {
      return { ok: false, message: "body must be a string" };
    }
    if (body.body.length > PAGER_BODY_MAX) {
      return {
        ok: false,
        message: `body is longer than ${PAGER_BODY_MAX} characters`,
      };
    }
    if (body.body.length > 0) fields.body = body.body;
  }
  if (body.key !== undefined) {
    if (typeof body.key !== "string" || body.key.length === 0) {
      return { ok: false, message: "key must be a non-empty string" };
    }
    if (body.key.length > PAGER_KEY_MAX) {
      return {
        ok: false,
        message: `key is longer than ${PAGER_KEY_MAX} characters`,
      };
    }
    fields.key = body.key;
  }
  return { ok: true, fields };
}

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
