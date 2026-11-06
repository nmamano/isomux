// The PagerEntry a compat pager route builds from a paged ask (task 74e8fc07,
// slice 3): the page id, the times and the raise count, the source as it is
// now, the text split back into title and body, the state, who acked and who
// resolved, and the target's send record. Pure: no store, no server.

import { describe, it, expect } from "bun:test";
import type { AskEntry, PagerDelivery } from "../shared/types.ts";
import {
  pagePrompt,
  pagerEntryFromAsk,
  type PagerCompatDeps,
} from "./pager-compat.ts";

const NONE: PagerDelivery = { state: "not_delivered", sends: 0 };

const deps: PagerCompatDeps = {
  agent: (id) => (id === "a1" ? { name: "Bot", roomId: "room-a" } : null),
  app: (name, createdAt) =>
    name === "uptime" && createdAt === 7
      ? { registrationGen: 3, roomId: "room-b" }
      : null,
  memberName: (id) => ({ u1: "Uma", u2: "Vic" })[id as "u1" | "u2"] ?? null,
};

// An agent's paged ask for u1, ringing.
const ASK: AskEntry = {
  id: "ab12cd34",
  agentId: "a1",
  memberUserId: "u1",
  prompt: "Disk full\n\n90% on /var\n\nand rising",
  priority: "P1",
  createdAt: 100,
  updatedAt: 100,
  page: {
    state: "ringing",
    pageId: "00112233aabbccdd",
    key: "disk",
    delivery: { u1: { state: "delivered", sends: 2, lastAttemptAt: 150 } },
  },
};

describe("a page's text as a prompt", () => {
  it("is the title, then a blank line and the body when there is one", () => {
    expect(pagePrompt("Disk full")).toBe("Disk full");
    expect(pagePrompt("Disk full", "90%")).toBe("Disk full\n\n90%");
  });
});

describe("the PagerEntry of a paged ask", () => {
  it("an agent's open page: its page id, ask, times, source now, target, text split at the first blank line, key and send record", () => {
    expect(pagerEntryFromAsk(ASK, null, deps)).toEqual({
      id: "00112233aabbccdd",
      askId: "ab12cd34",
      createdAt: 100,
      // Absent on the ask: the create, and one raise.
      lastRaisedAt: 100,
      raiseCount: 1,
      source: { kind: "agent", agentId: "a1", name: "Bot", roomId: "room-a" },
      targetUserId: "u1",
      title: "Disk full",
      body: "90% on /var\n\nand rising",
      key: "disk",
      state: "open",
      delivery: { state: "delivered", sends: 2, lastAttemptAt: 150 },
    });
  });

  it("a page that a raise came back to: its count and last raise; a prompt with no blank line is a title only", () => {
    const e = pagerEntryFromAsk(
      {
        ...ASK,
        prompt: "Disk full\n90%",
        page: { ...ASK.page!, raiseCount: 4, lastRaisedAt: 400 },
      },
      null,
      deps,
    );
    expect([e.raiseCount, e.lastRaisedAt]).toEqual([4, 400]);
    expect(e.title).toBe("Disk full\n90%");
    expect("body" in e).toBe(false);
    expect(
      "key" in
        pagerEntryFromAsk(
          { ...ASK, page: { ...ASK.page!, key: undefined } },
          null,
          deps,
        ),
    ).toBe(false);
  });

  it("the target's send record, or none sent when the target has none", () => {
    const e = pagerEntryFromAsk(
      {
        ...ASK,
        page: { ...ASK.page!, delivery: { u2: { state: "failed", sends: 1 } } },
      },
      null,
      deps,
    );
    expect(e.delivery).toEqual(NONE);
  });

  it("acked: by the acker's name now, at the ack", () => {
    const acked = (ackedByUserId: string) =>
      pagerEntryFromAsk(
        {
          ...ASK,
          page: { ...ASK.page!, state: "acked", ackedByUserId, ackedAt: 300 },
        },
        null,
        deps,
      );
    const e = acked("u2");
    expect(e.state).toBe("acked");
    expect(e.acked).toEqual({ by: "Vic", at: 300 });
    // A migrated ack by no member: no name, still acked at its time.
    const nobody = acked("");
    expect(nobody.state).toBe("acked");
    expect(nobody.acked?.at).toBe(300);
    expect(typeof nobody.acked?.by).toBe("string");
    expect(nobody.acked?.by).not.toMatch(/undefined|null|Vic|Uma/);
  });

  it("resolved: from the close, by the member who dismissed it, the app or the agent that withdrew it", () => {
    const by = (
      closure: Parameters<typeof pagerEntryFromAsk>[1],
      entry = ASK,
    ) => pagerEntryFromAsk(entry, closure, deps);
    const dismissed = by({ outcome: "dismissed", byUserId: "u2", at: 500 });
    expect(dismissed.state).toBe("resolved");
    expect(dismissed.resolved).toEqual({ by: "Vic", at: 500 });
    expect(by({ outcome: "withdrawn", at: 501 }).resolved).toEqual({
      by: "Bot",
      at: 501,
    });
    expect(
      by({ outcome: "withdrawn", app: "uptime", at: 502 }).resolved,
    ).toEqual({ by: "uptime", at: 502 });
    // An acked page keeps its ack when it is resolved.
    const ackedThenClosed = by(
      { outcome: "replied", byUserId: "u1", answer: "on it", at: 503 },
      {
        ...ASK,
        page: {
          ...ASK.page!,
          state: "acked",
          ackedByUserId: "u2",
          ackedAt: 300,
        },
      },
    );
    expect(ackedThenClosed.state).toBe("resolved");
    expect(ackedThenClosed.acked).toEqual({ by: "Vic", at: 300 });
    expect(ackedThenClosed.resolved).toEqual({ by: "Uma", at: 503 });
  });

  it("an app's page: the app and its registration now, in its creator's room now; gone, generation 0 and no room", () => {
    const app: AskEntry = { ...ASK, app: { name: "uptime", createdAt: 7 } };
    expect(pagerEntryFromAsk(app, null, deps).source).toEqual({
      kind: "app",
      appName: "uptime",
      registrationGen: 3,
      name: "uptime",
      roomId: "room-b",
    });
    const noAgent: AskEntry = {
      ...app,
      agentId: "",
      app: { name: "uptime", createdAt: 8 },
    };
    expect(pagerEntryFromAsk(noAgent, null, deps).source).toEqual({
      kind: "app",
      appName: "uptime",
      registrationGen: 0,
      name: "uptime",
      roomId: null,
    });
  });

  it("an office page: the feature, with no room", () => {
    const office: AskEntry = {
      ...ASK,
      agentId: "",
      office: { feature: "whatsapp", name: "WhatsApp" },
    };
    expect(pagerEntryFromAsk(office, null, deps).source).toEqual({
      kind: "office",
      feature: "whatsapp",
      name: "WhatsApp",
      roomId: null,
    });
  });
});
