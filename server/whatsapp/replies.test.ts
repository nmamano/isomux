// WhatsApp reply drafts (task d03a61d8, slice 2b): who may draft to a row,
// the ask a draft opens, and what each answer of the row's member does at
// Send time. A real temp STATE_ROOT, real rows, a real ask store and the real
// sent ring; the bridge is a fake send whose answers the test picks (the
// supervisor's own send is pinned in supervisor.test.ts). Who may answer the
// ask is pinned in server/routes/handlers/asks.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  WHATSAPP_DIRECT_SENDS_MAX,
  WHATSAPP_DIRECT_SENDS_WINDOW_MS,
  WHATSAPP_DONT_SEND_OPTION,
  WHATSAPP_DRAFTS_PER_ROUTE_MAX,
  WHATSAPP_REPLY_MAX_CHARS,
  WHATSAPP_SEND_OPTION,
  createWhatsAppReplies,
  isWhatsAppSendAnswer,
  type WhatsAppReplies,
} from "./replies.ts";
import { createWhatsAppRoutes } from "./routes.ts";
import { openIdRing, readRoutes } from "./routes-store.ts";
import { memberDir } from "./store.ts";
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
  // The replies' clock (the direct-send window).
  const clock = { t: 1_800_000_000_000 };
  const make = (): WhatsAppReplies =>
    createWhatsAppReplies({
      routes,
      agent: (id) => {
        const a = agents.get(id);
        return a ? { userId: a.userId } : null;
      },
      asks,
      supervisor: {
        send: async (userId, req) => {
          sends.push({ userId, ...req });
          return answers.shift() ?? { ok: true, id: `3EB0${sends.length}` };
        },
      },
      sent: (userId) => openIdRing(root, userId, "sent"),
      now: () => clock.t,
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
    clock,
    make,
    replies: make(),
    momId: mom.route.id,
    dadId: dad.route.id,
  };
}

type Harness = ReturnType<typeof harness>;

// A draft the row's agent opened, as the store holds it.
async function drafted(h: Harness, text = "see you at 5") {
  const r = await h.replies.reply("agent-a", h.momId, text);
  if (!r.ok) throw new Error(`draft refused: ${r.status} ${r.code}`);
  if (!("askId" in r)) throw new Error("sent, not drafted");
  const entry = h.asks.get(r.askId);
  if (!entry) throw new Error("no ask");
  return entry;
}

const sendAnswer = { dismissed: false, text: "Send" };

describe("whatsapp replies: the answer and the text that goes out", () => {
  it("Send is the answer's first line alone, in any case; any other words are not", async () => {
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
});

describe("whatsapp replies: a draft", () => {
  it("the row's agent opens one ask to the row's member: the text as drafted, Send and Don't send, no recommendation", async () => {
    const h = harness();
    const text = "see *you* at 5\nbring the cake";
    const r = await h.replies.reply("agent-a", h.momId, text);
    expect(r.ok).toBe(true);
    const all = h.asks.listForAgent("agent-a");
    expect(all).toHaveLength(1);
    const [entry] = all;
    expect("askId" in r && r.askId).toBe(entry.id);
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

  it("every agent but the row's gets the same 404, and nothing opens", async () => {
    const h = harness();
    const refusals = [
      await h.replies.reply("agent-std", h.momId, "hi"),
      await h.replies.reply("agent-bob", h.momId, "hi"),
      await h.replies.reply("agent-free", h.momId, "hi"),
      await h.replies.reply("agent-gone", h.momId, "hi"),
      await h.replies.reply("agent-a", "r-none", "hi"),
    ];
    // The row's agent, passed to another manager.
    h.agents.set("agent-a", { userId: V, access: "office", name: "Helper" });
    refusals.push(await h.replies.reply("agent-a", h.momId, "hi"));
    for (const r of refusals) expect(r.ok === false && r.status).toBe(404);
    // One answer for all: the route tells no agent which rows exist.
    expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(h.asks.listAll()).toEqual([]);

    h.agents.set("agent-a", { userId: U, access: "office", name: "Helper" });
    expect((await h.replies.reply("agent-a", h.momId, "hi")).ok).toBe(true);
  });

  it("a text that is not a string, is blank or is over the cap is 400; the cap itself is fine", async () => {
    const h = harness();
    for (const text of [
      5,
      null,
      undefined,
      "",
      "  \n\t",
      "x".repeat(WHATSAPP_REPLY_MAX_CHARS + 1),
    ]) {
      const r = await h.replies.reply("agent-a", h.momId, text);
      expect([
        JSON.stringify(text)?.slice(0, 12),
        r.ok === false && r.status,
      ]).toEqual([JSON.stringify(text)?.slice(0, 12), 400]);
    }
    expect(h.asks.listAll()).toEqual([]);
    expect(
      (
        await h.replies.reply(
          "agent-a",
          h.momId,
          "x".repeat(WHATSAPP_REPLY_MAX_CHARS),
        )
      ).ok,
    ).toBe(true);
  });

  it("a row whose agent fails the check is 409, and nothing opens", async () => {
    const h = harness();
    h.agents.set("agent-a", { userId: U, access: "chat", name: "Helper" });
    const r = await h.replies.reply("agent-a", h.momId, "hi");
    expect(r.ok === false && r.status).toBe(409);
    expect(h.asks.listAll()).toEqual([]);
  });

  it("at most the cap of open drafts per row: one more is 429, another row still takes one, and an answered one frees a place", async () => {
    const h = harness();
    // A plain ask of the same agent is no draft and takes no place.
    expect(
      h.asks.create({ agentId: "agent-a", memberUserId: U, prompt: "Plain?" })
        .ok,
    ).toBe(true);
    const ids: string[] = [];
    for (let i = 0; i < WHATSAPP_DRAFTS_PER_ROUTE_MAX; i++) {
      const r = await h.replies.reply("agent-a", h.momId, `draft ${i}`);
      if (!r.ok || !("askId" in r)) throw new Error(`draft ${i} refused`);
      ids.push(r.askId);
    }
    const over = await h.replies.reply("agent-a", h.momId, "one more");
    expect(over.ok === false && over.status).toBe(429);
    expect((await h.replies.reply("agent-a", h.dadId, "for dad")).ok).toBe(
      true,
    );
    h.asks.remove(ids[0], { outcome: "dismissed" });
    expect((await h.replies.reply("agent-a", h.momId, "now it fits")).ok).toBe(
      true,
    );
    expect(
      h.asks
        .listForAgent("agent-a")
        .filter((e) => e.messaging?.routeId === h.momId),
    ).toHaveLength(WHATSAPP_DRAFTS_PER_ROUTE_MAX);
  });
});

describe("whatsapp replies: the member's answer", () => {
  it("Send: one bridge send to the row's chat under the ask id, the text as drafted with nothing before it (task a6127f22); the id goes in the sent ring on disk; the agent is told", async () => {
    const h = harness();
    const entry = await drafted(h, "see *you* at 5\nbring the cake");
    const result = await h.replies.answer(entry, {
      dismissed: false,
      text: "send\nthanks",
    });
    expect(h.sends).toEqual([
      {
        userId: U,
        requestId: entry.id,
        chat: MOM,
        text: "see *you* at 5\nbring the cake",
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
      const entry = await drafted(h);
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
      const entry = await drafted(h);
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
    const entry = await drafted(h);
    h.answers.push({ ok: false, reason: "unknown" });
    await h.replies.answer(entry, sendAnswer);
    const again = await h.replies.answer(entry, sendAnswer);
    expect(again).toMatchObject({ kind: "deliver", outcome: "replied" });
    expect(h.sends.map((s) => s.requestId)).toEqual([entry.id, entry.id]);
  });

  it("a Send after one that went out sends nothing more, after a restart too, and the agent is told again", async () => {
    const h = harness();
    const entry = await drafted(h);
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
      const entry = await drafted(h);
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
      expect((await h.replies.reply("agent-a", h.momId, `draft ${i}`)).ok).toBe(
        true,
      );
  });
});

// The Send step is optional per row (task 70fae82c): on a row with
// sendDirect the reply goes out at once, with no ask.
describe("whatsapp replies: a row that sends at once", () => {
  function direct(h: Harness, routeId = h.momId, prefix?: string) {
    const r = h.routes.update(U, routeId, {
      sendDirect: true,
      ...(prefix !== undefined ? { prefix } : {}),
    });
    if (!r.ok || r.route.sendDirect !== true)
      throw new Error("row not set to send at once");
  }
  const sentOk = { ok: true, sent: true } as const;

  it("one bridge send to the row's chat with the text as drafted and nothing before it (task a6127f22), no ask; the id goes in the sent ring on disk; each call is a new send", async () => {
    const h = harness();
    direct(h);
    expect(await h.replies.reply("agent-a", h.momId, "see *you*")).toEqual(
      sentOk,
    );
    expect(h.sends).toEqual([
      {
        userId: U,
        requestId: h.sends[0]?.requestId,
        chat: MOM,
        text: "see *you*",
      },
    ]);
    expect(typeof h.sends[0].requestId).toBe("string");
    expect(h.sends[0].requestId.length).toBeGreaterThan(0);
    expect(h.asks.listAll()).toEqual([]);
    // Read back from disk: the own-send filter of inbound.ts sees it.
    expect(openIdRing(h.root, U, "sent").has("3EB01")).toBe(true);

    // The same text again is a second message, under its own request id.
    expect(await h.replies.reply("agent-a", h.momId, "see *you*")).toEqual(
      sentOk,
    );
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1].requestId).not.toBe(h.sends[0].requestId);
    expect(openIdRing(h.root, U, "sent").has("3EB02")).toBe(true);
  });

  it("the row's prefix goes before the text, joined by one space, as the row is at send time, on both paths; a cleared prefix sends the text alone", async () => {
    const h = harness();
    // The Send path: a draft made before the prefix goes out with it.
    const entry = await drafted(h, "on my way");
    h.routes.update(U, h.momId, { prefix: "[Agent]:" });
    await h.replies.answer(entry, sendAnswer);
    expect(h.sends.map((s) => s.text)).toEqual(["[Agent]: on my way"]);

    direct(h, h.dadId, "Bot:");
    await h.replies.reply("agent-a", h.dadId, "hi dad");
    expect(h.sends.map((s) => [s.chat, s.text])).toEqual([
      [MOM, "[Agent]: on my way"],
      [DAD, "Bot: hi dad"],
    ]);

    // A prefix cleared to blank (stored as no prefix) puts nothing before
    // the text, on both paths (task a6127f22).
    const late = await drafted(h, "home at 8");
    h.routes.update(U, h.momId, { prefix: "  " });
    await h.replies.answer(late, sendAnswer);
    h.routes.update(U, h.dadId, { prefix: "" });
    await h.replies.reply("agent-a", h.dadId, "bye dad");
    expect(h.sends.slice(2).map((s) => [s.chat, s.text])).toEqual([
      [MOM, "home at 8"],
      [DAD, "bye dad"],
    ]);
  });

  it("a send that fails or is not linked is 502, an unknown result is 504; no ask opens and no id is kept", async () => {
    const h = harness();
    direct(h);
    const cases = [
      [{ ok: false, reason: "failed" }, 502, "messaging_send_failed"],
      [{ ok: false, reason: "not_linked" }, 502, "messaging_not_linked"],
      [{ ok: false, reason: "unknown" }, 504, "messaging_send_unknown"],
    ] as const;
    for (const [answer, status, code] of cases) {
      h.answers.push(answer);
      const r = await h.replies.reply("agent-a", h.momId, "hi");
      expect([answer.reason, r.ok === false && [r.status, r.code]]).toEqual([
        answer.reason,
        [status, code],
      ]);
    }
    expect(h.sends).toHaveLength(3);
    expect(h.asks.listAll()).toEqual([]);
  });

  it("the checks before a send are the draft's: another agent 404, a bad text 400, a row that fails its check 409; nothing goes out", async () => {
    const h = harness();
    direct(h);
    const notFound = await h.replies.reply("agent-std", h.momId, "hi");
    expect(notFound.ok === false && notFound.status).toBe(404);
    const blank = await h.replies.reply("agent-a", h.momId, "  ");
    expect(blank.ok === false && blank.status).toBe(400);
    const long = await h.replies.reply(
      "agent-a",
      h.momId,
      "x".repeat(WHATSAPP_REPLY_MAX_CHARS + 1),
    );
    expect(long.ok === false && long.status).toBe(400);
    h.agents.set("agent-a", { userId: U, access: "chat", name: "Helper" });
    const dead = await h.replies.reply("agent-a", h.momId, "hi");
    expect(dead.ok === false && dead.status).toBe(409);
    expect(h.sends).toEqual([]);
  });

  it("the row decides at each call: turned off, the next reply is a draft; turned on, the next goes out", async () => {
    const h = harness();
    direct(h);
    expect(await h.replies.reply("agent-a", h.momId, "one")).toEqual(sentOk);
    h.routes.update(U, h.momId, { sendDirect: false });
    const two = await h.replies.reply("agent-a", h.momId, "two");
    expect(two.ok && "askId" in two).toBe(true);
    expect(h.sends.map((s) => s.text)).toEqual(["one"]);
    direct(h);
    expect(await h.replies.reply("agent-a", h.momId, "three")).toEqual(sentOk);
    expect(h.sends).toHaveLength(2);
  });

  it("the open-draft cap does not stop a send at once", async () => {
    const h = harness();
    for (let i = 0; i < WHATSAPP_DRAFTS_PER_ROUTE_MAX; i++) await drafted(h);
    direct(h);
    expect(await h.replies.reply("agent-a", h.momId, "now")).toEqual(sentOk);
  });

  it("at most the cap of sends at once per row in the window: one more is 429 and does not go out; another row still sends; the oldest leaving the window frees a place", async () => {
    const h = harness();
    direct(h);
    direct(h, h.dadId);
    for (let i = 0; i < WHATSAPP_DIRECT_SENDS_MAX; i++) {
      const r = await h.replies.reply("agent-a", h.momId, `m${i}`);
      expect([i, r]).toEqual([i, sentOk]);
      if (i === 0) h.clock.t += 1_000;
    }
    const over = await h.replies.reply("agent-a", h.momId, "one more");
    expect(over.ok === false && [over.status, over.code]).toEqual([
      429,
      "too_many_sends",
    ]);
    expect(h.sends).toHaveLength(WHATSAPP_DIRECT_SENDS_MAX);
    expect(h.asks.listAll()).toEqual([]);
    expect(await h.replies.reply("agent-a", h.dadId, "for dad")).toEqual(
      sentOk,
    );

    // Just inside the window of the first send, then just past it: one
    // place, not more.
    h.clock.t += WHATSAPP_DIRECT_SENDS_WINDOW_MS - 1_000 - 1;
    const still = await h.replies.reply("agent-a", h.momId, "not yet");
    expect(still.ok === false && still.status).toBe(429);
    h.clock.t += 2;
    expect(await h.replies.reply("agent-a", h.momId, "now")).toEqual(sentOk);
    const again = await h.replies.reply("agent-a", h.momId, "again");
    expect(again.ok === false && again.status).toBe(429);
  });

  it("a send refused as not linked never reached WhatsApp, so it takes no place in the cap; a failed or unknown one does", async () => {
    const h = harness();
    direct(h);
    for (let i = 0; i < WHATSAPP_DIRECT_SENDS_MAX; i++)
      h.answers.push({ ok: false, reason: "not_linked" });
    for (let i = 0; i < WHATSAPP_DIRECT_SENDS_MAX; i++) {
      const r = await h.replies.reply("agent-a", h.momId, `try ${i}`);
      expect([i, r.ok === false && r.code]).toEqual([
        i,
        "messaging_not_linked",
      ]);
    }
    // Linked again: the full cap is there. A failed and an unknown send
    // may have gone out, so they take their places.
    h.answers.push(
      { ok: false, reason: "failed" },
      { ok: false, reason: "unknown" },
    );
    for (let i = 0; i < WHATSAPP_DIRECT_SENDS_MAX; i++) {
      const r = await h.replies.reply("agent-a", h.momId, `m${i}`);
      expect([i, r.ok === false && r.status === 429]).toEqual([i, false]);
    }
    const over = await h.replies.reply("agent-a", h.momId, "one more");
    expect(over.ok === false && over.status).toBe(429);
  });

  it("a row whose stored send-at-once is not exactly true never sends at once", async () => {
    const h = harness();
    const file = readRoutes(h.root, U);
    writeFileSync(
      join(memberDir(h.root, U), "routes.json"),
      JSON.stringify({
        ...file,
        routes: file.routes.map((r) => ({ ...r, sendDirect: "yes" })),
      }),
    );
    await h.replies.reply("agent-a", h.momId, "hi");
    expect(h.sends).toEqual([]);
  });
});
