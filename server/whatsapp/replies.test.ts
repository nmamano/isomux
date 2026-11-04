// WhatsApp reply drafts (task d03a61d8, slice 2b): who may draft to a row,
// the ask a draft opens, and what each answer of the row's member does at
// Send time. A real temp STATE_ROOT, real rows, a real ask store and the real
// sent ring; the bridge is a fake send whose answers the test picks (the
// supervisor's own send is pinned in supervisor.test.ts). Who may answer the
// ask is pinned in server/routes/handlers/asks.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  WHATSAPP_DONT_SEND_OPTION,
  WHATSAPP_DRAFTS_PER_ROUTE_MAX,
  WHATSAPP_REPLY_MAX_CHARS,
  WHATSAPP_SEND_OPTION,
  createWhatsAppReplies,
  isWhatsAppSendAnswer,
  whatsappOutgoingText,
  type WhatsAppReplies,
} from "./replies.ts";
import { createWhatsAppRoutes } from "./routes.ts";
import { openIdRing } from "./routes-store.ts";
import type { WhatsAppSendResult } from "./supervisor.ts";
import { createAskStore } from "../asks.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";

const U = "u-alice";
const V = "u-bob";
const MOM = "447700900123@s.whatsapp.net";
const DAD = "447700900124@s.whatsapp.net";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface FakeAgent {
  userId: string | null;
  access: AgentAccess;
  name: string;
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "t-d03a61d8-replies-"));
  roots.push(root);
  const agents = new Map<string, FakeAgent>([
    ["agent-a", { userId: U, access: "office", name: "Helper" }],
    ["agent-std", { userId: U, access: "standard", name: "Shell" }],
    ["agent-bob", { userId: V, access: "office", name: "Bob's" }],
    ["agent-free", { userId: null, access: "office", name: "Nobody's" }],
  ]);
  let n = 0;
  const routes = createWhatsAppRoutes({
    stateRoot: root,
    now: () => 1_800_000_000_000,
    newId: () => `r${++n}`,
    agent: (id) => agents.get(id) ?? null,
    linkedPhone: (userId) => (userId === U ? "447700900111" : null),
    onChange: () => {},
  });
  const asks = createAskStore({
    persistence: {
      load: () => ({ kind: "missing" }),
      save: () => {},
      quarantine: () => true,
    },
  });
  // What reached the bridge, and its answers in order (default: sent).
  const sends: {
    userId: string;
    requestId: string;
    chat: string;
    text: string;
  }[] = [];
  const answers: WhatsAppSendResult[] = [];
  const make = (): WhatsAppReplies =>
    createWhatsAppReplies({
      routes,
      agent: (id) => {
        const a = agents.get(id);
        return a ? { userId: a.userId, name: a.name } : null;
      },
      asks,
      supervisor: {
        send: async (userId, req) => {
          sends.push({ userId, ...req });
          return answers.shift() ?? { ok: true, id: `3EB0${sends.length}` };
        },
      },
      sent: (userId) => openIdRing(root, userId, "sent"),
    });
  const mom = routes.create(U, { chat: MOM, name: "Mom", agentId: "agent-a" });
  const dad = routes.create(U, { chat: DAD, name: "Dad", agentId: "agent-a" });
  if (!mom.ok || !dad.ok) throw new Error("rows not made");
  return {
    root,
    agents,
    routes,
    asks,
    sends,
    answers,
    make,
    replies: make(),
    momId: mom.route.id,
    dadId: dad.route.id,
  };
}

type Harness = ReturnType<typeof harness>;

// A draft the row's agent opened, as the store holds it.
function drafted(h: Harness, text = "see you at 5") {
  const r = h.replies.draft("agent-a", h.momId, text);
  if (!r.ok) throw new Error(`draft refused: ${r.status} ${r.code}`);
  const entry = h.asks.get(r.askId);
  if (!entry) throw new Error("no ask");
  return entry;
}

const sendAnswer = { dismissed: false, text: "Send" };

describe("whatsapp replies: the answer and the text that goes out", () => {
  it("Send is the answer's first line alone, in any case; any other words are not", () => {
    for (const text of [
      "Send",
      "send",
      "SEND",
      "  Send  ",
      "Send\nthanks",
      "send\r\nok",
    ])
      expect([text, isWhatsAppSendAnswer(text)]).toEqual([text, true]);
    for (const text of [
      "",
      "Sending",
      "Send it",
      "Send.",
      "Don't send",
      "do not send",
      "ok\nSend",
      "\nSend",
    ])
      expect([text, isWhatsAppSendAnswer(text)]).toEqual([text, false]);
  });

  it("the agent's name in bold on its own line, without the marks or breaks that would end the bold; the text as drafted", () => {
    expect(whatsappOutgoingText("Helper", "see *you*\nat _5_")).toBe(
      "*Helper*\nsee *you*\nat _5_",
    );
    expect(whatsappOutgoingText("*Bo_l~d*\r\nX", "hi")).toBe("*BoldX*\nhi");
  });
});

describe("whatsapp replies: a draft", () => {
  it("the row's agent opens one ask to the row's member: the text as drafted, Send and Don't send, no recommendation", () => {
    const h = harness();
    const text = "see *you* at 5\nbring the cake";
    const r = h.replies.draft("agent-a", h.momId, text);
    expect(r.ok).toBe(true);
    const all = h.asks.listForAgent("agent-a");
    expect(all).toHaveLength(1);
    const [entry] = all;
    expect(r.ok && r.askId).toBe(entry.id);
    expect(entry.memberUserId).toBe(U);
    expect(entry.messaging).toEqual({
      app: "whatsapp",
      routeId: h.momId,
      text,
    });
    expect(entry.options).toEqual([
      WHATSAPP_SEND_OPTION,
      WHATSAPP_DONT_SEND_OPTION,
    ]);
    expect(entry.recommended).toBeUndefined();
    // The member approves what they can read: the text and the row.
    expect(entry.prompt).toContain(text);
    expect(entry.prompt).toContain("Mom");
  });

  it("every agent but the row's gets the same 404, and nothing opens", () => {
    const h = harness();
    const refusals = [
      h.replies.draft("agent-std", h.momId, "hi"),
      h.replies.draft("agent-bob", h.momId, "hi"),
      h.replies.draft("agent-free", h.momId, "hi"),
      h.replies.draft("agent-gone", h.momId, "hi"),
      h.replies.draft("agent-a", "r-none", "hi"),
    ];
    // The row's agent, passed to another manager.
    h.agents.set("agent-a", { userId: V, access: "office", name: "Helper" });
    refusals.push(h.replies.draft("agent-a", h.momId, "hi"));
    for (const r of refusals) expect(r.ok === false && r.status).toBe(404);
    // One answer for all: the route tells no agent which rows exist.
    expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(h.asks.listAll()).toEqual([]);

    h.agents.set("agent-a", { userId: U, access: "office", name: "Helper" });
    expect(h.replies.draft("agent-a", h.momId, "hi").ok).toBe(true);
  });

  it("a text that is not a string, is blank or is over the cap is 400; the cap itself is fine", () => {
    const h = harness();
    for (const text of [
      5,
      null,
      undefined,
      "",
      "  \n\t",
      "x".repeat(WHATSAPP_REPLY_MAX_CHARS + 1),
    ]) {
      const r = h.replies.draft("agent-a", h.momId, text);
      expect([
        JSON.stringify(text)?.slice(0, 12),
        r.ok === false && r.status,
      ]).toEqual([JSON.stringify(text)?.slice(0, 12), 400]);
    }
    expect(h.asks.listAll()).toEqual([]);
    expect(
      h.replies.draft("agent-a", h.momId, "x".repeat(WHATSAPP_REPLY_MAX_CHARS))
        .ok,
    ).toBe(true);
  });

  it("a row whose agent fails the check is 409, and nothing opens", () => {
    const h = harness();
    h.agents.set("agent-a", { userId: U, access: "chat", name: "Helper" });
    const r = h.replies.draft("agent-a", h.momId, "hi");
    expect(r.ok === false && r.status).toBe(409);
    expect(h.asks.listAll()).toEqual([]);
  });

  it("at most the cap of open drafts per row: one more is 429, another row still takes one, and an answered one frees a place", () => {
    const h = harness();
    // A plain ask of the same agent is no draft and takes no place.
    expect(
      h.asks.create({ agentId: "agent-a", memberUserId: U, prompt: "Plain?" })
        .ok,
    ).toBe(true);
    const ids: string[] = [];
    for (let i = 0; i < WHATSAPP_DRAFTS_PER_ROUTE_MAX; i++) {
      const r = h.replies.draft("agent-a", h.momId, `draft ${i}`);
      if (!r.ok) throw new Error(`draft ${i} refused`);
      ids.push(r.askId);
    }
    const over = h.replies.draft("agent-a", h.momId, "one more");
    expect(over.ok === false && over.status).toBe(429);
    expect(h.replies.draft("agent-a", h.dadId, "for dad").ok).toBe(true);
    h.asks.remove(ids[0], { outcome: "dismissed" });
    expect(h.replies.draft("agent-a", h.momId, "now it fits").ok).toBe(true);
    expect(
      h.asks
        .listForAgent("agent-a")
        .filter((e) => e.messaging?.routeId === h.momId),
    ).toHaveLength(WHATSAPP_DRAFTS_PER_ROUTE_MAX);
  });
});

describe("whatsapp replies: the member's answer", () => {
  it("Send: one bridge send to the row's chat under the ask id, with the agent's name as it is now; the id goes in the sent ring on disk; the agent is told", async () => {
    const h = harness();
    const entry = drafted(h, "see *you* at 5");
    h.agents.set("agent-a", {
      userId: U,
      access: "office",
      name: "Helper Two",
    });
    const result = await h.replies.answer(entry, {
      dismissed: false,
      text: "send\nthanks",
    });
    expect(h.sends).toEqual([
      {
        userId: U,
        requestId: entry.id,
        chat: MOM,
        text: "*Helper Two*\nsee *you* at 5",
      },
    ]);
    expect(result).toMatchObject({ kind: "deliver", outcome: "replied" });
    expect(result.kind === "deliver" && result.refusal).toBeUndefined();
    expect(result.kind === "deliver" && result.text.length > 0).toBe(true);
    // Read back from disk: the own-send filter of inbound.ts sees it.
    expect(openIdRing(h.root, U, "sent").has("3EB01")).toBe(true);
  });

  it("Don't send, other words or a dismiss: nothing goes out, and the agent gets the member's words", async () => {
    const h = harness();
    const cases = [
      [{ dismissed: false, text: "Don't send" }, "replied", "Don't send"],
      [
        { dismissed: false, text: "Send it after lunch" },
        "replied",
        "Send it after lunch",
      ],
      [{ dismissed: true, text: "not now" }, "dismissed", "not now"],
      [{ dismissed: true, text: undefined }, "dismissed", null],
    ] as const;
    for (const [input, outcome, words] of cases) {
      const entry = drafted(h);
      const result = await h.replies.answer(entry, input);
      expect([input.text, result.kind === "deliver" && result.outcome]).toEqual(
        [input.text, outcome],
      );
      if (words !== null)
        expect(result.kind === "deliver" && result.text).toContain(words);
    }
    expect(h.sends).toEqual([]);
  });

  it("a send that fails is 502, not linked is 502, an unknown result is 504; Send again tries again", async () => {
    const h = harness();
    const cases = [
      [{ ok: false, reason: "failed" }, 502],
      [{ ok: false, reason: "not_linked" }, 502],
      [{ ok: false, reason: "unknown" }, 504],
    ] as const;
    for (const [answer, status] of cases) {
      const entry = drafted(h);
      h.answers.push(answer);
      const result = await h.replies.answer(entry, sendAnswer);
      expect([answer.reason, result.kind === "fail" && result.status]).toEqual([
        answer.reason,
        status,
      ]);
      // A failure is not a send: the next Send goes to the bridge.
      const before = h.sends.length;
      expect(await h.replies.answer(entry, sendAnswer)).toMatchObject({
        kind: "deliver",
      });
      expect([answer.reason, h.sends.length]).toEqual([
        answer.reason,
        before + 1,
      ]);
    }
  });

  it("after an unknown result, Send again goes under the same request id, so the bridge can send it once", async () => {
    const h = harness();
    const entry = drafted(h);
    h.answers.push({ ok: false, reason: "unknown" });
    await h.replies.answer(entry, sendAnswer);
    const again = await h.replies.answer(entry, sendAnswer);
    expect(again).toMatchObject({ kind: "deliver", outcome: "replied" });
    expect(h.sends.map((s) => s.requestId)).toEqual([entry.id, entry.id]);
  });

  it("a Send after one that went out sends nothing more, after a restart too, and the agent is told again", async () => {
    const h = harness();
    const entry = drafted(h);
    // The first went out; say the agent's notice was then refused and the
    // ask stayed open.
    await h.replies.answer(entry, sendAnswer);
    expect(h.sends).toHaveLength(1);
    const again = await h.replies.answer(entry, sendAnswer);
    const restarted = await h.make().answer(entry, sendAnswer);
    expect(h.sends).toHaveLength(1);
    for (const r of [again, restarted])
      expect(r).toMatchObject({ kind: "deliver", outcome: "replied" });
  });

  it("the row at Send time decides: gone, dead, another agent's, or its agent passed on or gone: nothing goes out, the agent is told and the member gets 409", async () => {
    const changes: [string, (h: Harness) => void][] = [
      ["row deleted", (h) => void h.routes.remove(U, h.momId)],
      [
        "agent at Chat stop",
        (h) =>
          h.agents.set("agent-a", {
            userId: U,
            access: "chat",
            name: "Helper",
          }),
      ],
      [
        "row re-pointed",
        (h) => void h.routes.update(U, h.momId, { agentId: "agent-std" }),
      ],
      [
        "agent passed on",
        (h) =>
          h.agents.set("agent-a", {
            userId: V,
            access: "office",
            name: "Helper",
          }),
      ],
      ["agent gone", (h) => void h.agents.delete("agent-a")],
    ];
    for (const [label, change] of changes) {
      const h = harness();
      const entry = drafted(h);
      change(h);
      const result = await h.replies.answer(entry, sendAnswer);
      expect([label, h.sends.length]).toEqual([label, 0]);
      expect([
        label,
        result.kind === "deliver" && result.refusal?.status,
      ]).toEqual([label, 409]);
      expect(result.kind === "deliver" && result.text.length > 0).toBe(true);
    }
  });

  it("a draft for an app this release does not know never sends on WhatsApp, even with a WhatsApp row's id: Send is 409, Don't send still answers", async () => {
    const h = harness();
    // A later release made it; its route id happens to name the Mom row.
    const made = h.asks.create({
      agentId: "agent-a",
      memberUserId: U,
      prompt: "Send to Mom?",
      options: [WHATSAPP_SEND_OPTION, WHATSAPP_DONT_SEND_OPTION],
      messaging: { app: "telegram", routeId: h.momId, text: "hi" },
    });
    if (!made.ok) throw new Error(made.code);
    const send = await h.replies.answer(made.entry, sendAnswer);
    expect(send.kind === "fail" && [send.status, send.code]).toEqual([
      409,
      "messaging_app_unknown",
    ]);
    expect(h.sends).toEqual([]);
    const no = await h.replies.answer(made.entry, {
      dismissed: false,
      text: "Don't send",
    });
    expect(no).toMatchObject({ kind: "deliver", outcome: "replied" });
    expect(h.sends).toEqual([]);
    // Its drafts take no place in the WhatsApp row's cap.
    for (let i = 0; i < WHATSAPP_DRAFTS_PER_ROUTE_MAX; i++)
      expect(h.replies.draft("agent-a", h.momId, `draft ${i}`).ok).toBe(true);
  });
});
