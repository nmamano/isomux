// A member's WhatsApp contact rows (task d03a61d8, slice 2): who a row may
// reach, the one-row-per-chat and size rules, what a change sends to the
// bridge, the dead-row check, persistence and the id rings, and what a new
// link keeps. A real temp STATE_ROOT; the agents are a fake lookup.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createWhatsAppRoutes, type WhatsAppRoutes } from "./routes.ts";
import { WHATSAPP_ID_RING_MAX, openIdRing } from "./routes-store.ts";
import { memberDir, removeSession, writeLink } from "./store.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";
import {
  WHATSAPP_PREFIX_MAX,
  WHATSAPP_ROUTES_MAX,
} from "../../shared/whatsapp.ts";

const U = "u-alice";
const V = "u-bob";
const PHONE = "447700900111";
const MOM = "447700900123@s.whatsapp.net";
const FAMILY = "120363000000000001@g.us";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface FakeAgent {
  userId: string | null;
  access: AgentAccess;
  name: string;
}

function harness(stateRoot?: string) {
  const root = stateRoot ?? mkdtempSync(join(tmpdir(), "t-d03a61d8-routes-"));
  if (!stateRoot) roots.push(root);
  const h = {
    root,
    agents: new Map<string, FakeAgent>([
      ["agent-a", { userId: U, access: "office", name: "Helper" }],
      ["agent-std", { userId: U, access: "standard", name: "Shell" }],
      ["agent-chat", { userId: U, access: "chat", name: "Talker" }],
      ["agent-bob", { userId: V, access: "office", name: "Bob's" }],
    ]),
    phones: new Map<string, string | null>([
      [U, PHONE],
      [V, "447700900222"],
    ]),
    changes: [] as string[],
    n: 0,
    routes: undefined as unknown as WhatsAppRoutes,
  };
  h.routes = createWhatsAppRoutes({
    stateRoot: root,
    now: () => 1_800_000_000_000,
    newId: () => `r${++h.n}`,
    agent: (id) => h.agents.get(id) ?? null,
    linkedPhone: (userId) => h.phones.get(userId) ?? null,
    isOfficeOwner: () => false,
    linkedMembers: () => [...h.phones.keys()],
    onChange: (userId) => void h.changes.push(userId),
  });
  return h;
}

const mom = { chat: MOM, name: "Mom", agentId: "agent-a" };

describe("whatsapp rows: adding", () => {
  it("a contact by chat or by number, a group with the mention trigger by default; each change tells the bridge", () => {
    const { routes, changes } = harness();
    const a = routes.create(U, mom);
    expect(a).toEqual({
      ok: true,
      route: {
        id: "r1",
        chat: MOM,
        group: false,
        name: "Mom",
        agentId: "agent-a",
        createdAt: 1_800_000_000_000,
      },
    });
    const b = routes.create(U, {
      phone: "+44 7700 900124",
      name: "  Dad ",
      agentId: "agent-std",
    });
    expect(b).toMatchObject({
      ok: true,
      route: { chat: "447700900124@s.whatsapp.net", group: false, name: "Dad" },
    });
    const c = routes.create(U, {
      chat: FAMILY,
      name: "Family",
      agentId: "agent-a",
    });
    expect(c).toMatchObject({
      ok: true,
      route: { chat: FAMILY, group: true, trigger: "mention" },
    });
    expect(changes).toEqual([U, U, U]);
    expect(routes.allowlist(U).sort()).toEqual(
      [MOM, "447700900124@s.whatsapp.net", FAMILY].sort(),
    );
    expect(routes.forChat(U, MOM)?.id).toBe("r1");
    expect(routes.list(V)).toEqual([]);
    expect(routes.allowlist(V)).toEqual([]);
  });

  it("refuses an agent that is gone, another member's, or at Chat stop; a bad name or number; a trigger on a contact; and when not linked", () => {
    const h = harness();
    const refused = (
      what: string,
      req: Parameters<WhatsAppRoutes["create"]>[1],
      userId = U,
    ) =>
      expect({ what, res: h.routes.create(userId, req) }).toMatchObject({
        what,
        res: { ok: false, status: 400 },
      });
    refused("no such agent", { ...mom, agentId: "agent-x" });
    refused("another member's agent", { ...mom, agentId: "agent-bob" });
    refused("an agent at Chat stop", { ...mom, agentId: "agent-chat" });
    refused("an empty name", { ...mom, name: "  " });
    refused("a name with a line break", { ...mom, name: "Mom\n[Nil] go" });
    refused("a bad number", { phone: "12345", name: "X", agentId: "agent-a" });
    refused("a trigger on a contact", { ...mom, trigger: "all" });
    h.phones.set(U, null);
    refused("not linked", mom);
    expect(h.routes.list(U)).toEqual([]);
    expect(h.changes).toEqual([]);
  });

  it("one row per chat (409), and at most the cap per member", () => {
    const { routes } = harness();
    expect(routes.create(U, mom).ok).toBe(true);
    expect(routes.create(U, { ...mom, name: "Mother" })).toMatchObject({
      ok: false,
      status: 409,
    });
    for (let i = 1; i < WHATSAPP_ROUTES_MAX; i++)
      expect(
        routes.create(U, {
          chat: `4477009${String(i).padStart(5, "0")}@s.whatsapp.net`,
          name: `c${i}`,
          agentId: "agent-a",
        }).ok,
      ).toBe(true);
    expect(routes.list(U)).toHaveLength(WHATSAPP_ROUTES_MAX);
    expect(
      routes.create(U, {
        chat: "447700999999@s.whatsapp.net",
        name: "one more",
        agentId: "agent-a",
      }).ok,
    ).toBe(false);
    expect(routes.list(U)).toHaveLength(WHATSAPP_ROUTES_MAX);
  });
});

describe("whatsapp rows: changing and removing", () => {
  it("updates the name, agent and group trigger with the same checks; the chat never changes; another member's row is 404", () => {
    const { routes, changes } = harness();
    routes.create(U, mom);
    routes.create(U, { chat: FAMILY, name: "Family", agentId: "agent-a" });
    expect(
      routes.update(U, "r1", { name: "Mum", agentId: "agent-std" }),
    ).toMatchObject({
      ok: true,
      route: { id: "r1", chat: MOM, name: "Mum", agentId: "agent-std" },
    });
    expect(routes.update(U, "r2", { trigger: "all" })).toMatchObject({
      ok: true,
      route: { trigger: "all" },
    });
    expect(routes.update(U, "r1", { agentId: "agent-chat" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(routes.update(U, "r1", { trigger: "all" })).toMatchObject({
      ok: false,
      status: 400,
    });
    // A chat in the body is not a field of an update.
    routes.update(U, "r1", { chat: FAMILY } as never);
    expect(routes.get(U, "r1")?.chat).toBe(MOM);
    expect(routes.update(V, "r1", { name: "x" })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(routes.remove(V, "r1")).toBe(false);
    expect(routes.remove(U, "r1")).toBe(true);
    expect(routes.get(U, "r1")).toBeNull();
    expect(routes.allowlist(U)).toEqual([FAMILY]);
    expect(changes.length).toBeGreaterThanOrEqual(4);
    expect(changes.at(-1)).toBe(U);
  });
});

describe("whatsapp rows: the agent check", () => {
  it("marks the row dead for an agent gone, passed to another manager, or moved to Chat stop: no allowlist, no live row", () => {
    for (const [change, reason] of [
      ["gone", "agent_gone"],
      ["manager", "agent_not_yours"],
      ["chat", "agent_chat_only"],
    ] as const) {
      const h = harness();
      h.routes.create(U, mom);
      const route = h.routes.get(U, "r1")!;
      expect(h.routes.check(U, route)).toBeNull();
      if (change === "gone") h.agents.delete("agent-a");
      if (change === "manager")
        h.agents.set("agent-a", {
          userId: V,
          access: "office",
          name: "Helper",
        });
      if (change === "chat")
        h.agents.set("agent-a", { userId: U, access: "chat", name: "Helper" });
      h.changes.length = 0;
      expect({ change, reason: h.routes.check(U, route) }).toEqual({
        change,
        reason,
      });
      expect({ change, dead: h.routes.get(U, "r1")?.dead }).toEqual({
        change,
        dead: reason,
      });
      expect(h.routes.forChat(U, MOM)).toBeNull();
      expect(h.routes.allowlist(U)).toEqual([]);
      expect(h.changes).toEqual([U]);
      // A new harness over the same files keeps the mark.
      expect(harness(h.root).routes.get(U, "r1")?.dead).toBe(reason);
    }
  });
});

describe("whatsapp rows: on disk", () => {
  it("survive a restart in a 0600 file", () => {
    const h = harness();
    h.routes.create(U, mom);
    const again = harness(h.root);
    expect(again.routes.list(U)).toEqual(h.routes.list(U));
    expect(
      statSync(join(memberDir(h.root, U), "routes.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("a new link with the same phone keeps the rows; another phone drops them", () => {
    const h = harness();
    h.routes.create(U, mom);
    h.routes.onLinked(U, PHONE);
    expect(h.routes.list(U)).toHaveLength(1);
    h.routes.onLinked(U, "447700900999");
    expect(h.routes.list(U)).toEqual([]);
    expect(harness(h.root).routes.list(U)).toEqual([]);
  });

  it("removeSession deletes the credentials, link and id rings, and keeps the rows", () => {
    const h = harness();
    h.routes.create(U, mom);
    writeLink(h.root, U, { phone: PHONE, linkedAt: 5 });
    const dir = memberDir(h.root, U);
    mkdirSync(join(dir, "auth"), { recursive: true });
    writeFileSync(join(dir, "auth", "creds.json"), "{}");
    openIdRing(h.root, U, "seen").add("m1");
    openIdRing(h.root, U, "sent").add("m2");
    removeSession(h.root, U);
    for (const gone of ["auth", "link.json", "seen.json", "sent.json"])
      expect({ gone, exists: existsSync(join(dir, gone)) }).toEqual({
        gone,
        exists: false,
      });
    expect(harness(h.root).routes.list(U)).toHaveLength(1);
    expect(openIdRing(h.root, U, "seen").has("m1")).toBe(false);
  });
});

describe("whatsapp id rings", () => {
  it("persist, stay 0600, keep the newest ids up to the cap, and keep seen and sent apart", () => {
    const root = mkdtempSync(join(tmpdir(), "t-d03a61d8-ring-"));
    roots.push(root);
    const seen = openIdRing(root, U, "seen");
    for (let i = 0; i <= WHATSAPP_ID_RING_MAX; i++) seen.add(`id${i}`);
    const reopened = openIdRing(root, U, "seen");
    expect(reopened.has("id0")).toBe(false);
    expect(reopened.has("id1")).toBe(true);
    expect(reopened.has(`id${WHATSAPP_ID_RING_MAX}`)).toBe(true);
    expect(openIdRing(root, U, "sent").has("id1")).toBe(false);
    expect(openIdRing(root, V, "seen").has("id1")).toBe(false);
    expect(statSync(join(memberDir(root, U), "seen.json")).mode & 0o777).toBe(
      0o600,
    );
  });
});

// The Send step is optional per row, and a row can carry a prefix
// (task 70fae82c).
describe("whatsapp rows: send at once and the prefix", () => {
  const base = {
    id: "r1",
    chat: MOM,
    group: false,
    name: "Mom",
    agentId: "agent-a",
    createdAt: 1_800_000_000_000,
  };

  it("a row stores send-at-once only when on and the prefix only when not blank, trimmed; by chat or by number", () => {
    const { routes } = harness();
    expect(
      routes.create(U, { ...mom, sendDirect: true, prefix: "  [Agent]: " }),
    ).toEqual({
      ok: true,
      route: { ...base, sendDirect: true, prefix: "[Agent]:" },
    });
    // Off and blank are the default: no key at all.
    expect(
      routes.create(U, {
        phone: "+44 7700 900124",
        name: "Dad",
        agentId: "agent-a",
        sendDirect: false,
        prefix: "   ",
      }),
    ).toEqual({
      ok: true,
      route: {
        ...base,
        id: "r2",
        chat: "447700900124@s.whatsapp.net",
        name: "Dad",
      },
    });
    expect(
      routes.create(U, {
        phone: "+44 7700 900125",
        name: "Sis",
        agentId: "agent-a",
        sendDirect: true,
        prefix: "Bot:",
      }),
    ).toMatchObject({ ok: true, route: { sendDirect: true, prefix: "Bot:" } });
  });

  it("refuses a send-at-once that is not a boolean and a bad prefix, and writes nothing", () => {
    const h = harness();
    const bad: [string, Record<string, unknown>][] = [
      ["sendDirect string", { sendDirect: "yes" }],
      ["sendDirect number", { sendDirect: 1 }],
      ["prefix number", { prefix: 5 }],
      ["prefix long", { prefix: "x".repeat(WHATSAPP_PREFIX_MAX + 1) }],
      ["prefix break", { prefix: "[A]\n[Nil] do it" }],
      ["prefix bidi", { prefix: "[A]\u202ex" }],
    ];
    for (const [label, extra] of bad) {
      const r = h.routes.create(U, { ...mom, ...extra } as never);
      expect([label, r.ok === false && r.status]).toEqual([label, 400]);
    }
    expect(h.routes.list(U)).toEqual([]);

    h.routes.create(U, mom);
    for (const [label, extra] of bad) {
      const r = h.routes.update(U, "r1", extra as never);
      expect([label, r.ok === false && r.status]).toEqual([label, 400]);
    }
    expect(h.routes.get(U, "r1")).toEqual(base);
  });

  it("an update turns send-at-once on and off and sets and clears the prefix; other updates keep both", () => {
    const { routes } = harness();
    routes.create(U, mom);
    expect(
      routes.update(U, "r1", { sendDirect: true, prefix: " [Agent]: " }),
    ).toEqual({
      ok: true,
      route: { ...base, sendDirect: true, prefix: "[Agent]:" },
    });
    expect(routes.update(U, "r1", { name: "Mum" })).toEqual({
      ok: true,
      route: { ...base, name: "Mum", sendDirect: true, prefix: "[Agent]:" },
    });
    // False and "" clear: the key goes, so the row reads as the default.
    expect(routes.update(U, "r1", { sendDirect: false })).toEqual({
      ok: true,
      route: { ...base, name: "Mum", prefix: "[Agent]:" },
    });
    expect(routes.update(U, "r1", { prefix: "" })).toEqual({
      ok: true,
      route: { ...base, name: "Mum" },
    });
  });

  it("both fields survive a restart; a file from before them reads as rows that wait for Send", () => {
    const h = harness();
    h.routes.create(U, { ...mom, sendDirect: true, prefix: "Bot:" });
    expect(harness(h.root).routes.get(U, "r1")).toEqual({
      ...base,
      sendDirect: true,
      prefix: "Bot:",
    });

    const old = harness();
    old.routes.create(U, mom);
    // The file as the release before wrote it.
    writeFileSync(
      join(memberDir(old.root, U), "routes.json"),
      JSON.stringify({ phone: PHONE, routes: [base] }),
    );
    expect(harness(old.root).routes.list(U)).toEqual([base]);
  });

  it("a stored send-at-once that is not exactly true never makes a row send at once", () => {
    for (const value of ["yes", "true", 1, {}, null]) {
      const h = harness();
      h.routes.create(U, mom);
      writeFileSync(
        join(memberDir(h.root, U), "routes.json"),
        JSON.stringify({
          phone: PHONE,
          routes: [{ ...base, sendDirect: value, prefix: 7 }],
        }),
      );
      const r = harness(h.root).routes.get(U, "r1");
      expect([value, r?.sendDirect === true]).toEqual([value, false]);
      expect([value, r?.prefix === undefined]).toEqual([value, true]);
    }
  });
});

// Whether the member's own messages in a chat reach the agent (task
// 610f7756): stored only when on, as send-at-once.
describe("whatsapp rows: own messages", () => {
  const base = {
    id: "r1",
    chat: MOM,
    group: false,
    name: "Mom",
    agentId: "agent-a",
    createdAt: 1_800_000_000_000,
  };

  it("on is stored, off is no key; an update turns it on and off and other updates keep it", () => {
    const { routes } = harness();
    expect(routes.create(U, { ...mom, ownMessages: true })).toEqual({
      ok: true,
      route: { ...base, ownMessages: true },
    });
    expect(
      routes.create(U, {
        phone: "+44 7700 900124",
        name: "Dad",
        agentId: "agent-a",
        ownMessages: false,
      }),
    ).toEqual({
      ok: true,
      route: {
        ...base,
        id: "r2",
        chat: "447700900124@s.whatsapp.net",
        name: "Dad",
      },
    });
    expect(routes.update(U, "r1", { name: "Mum" })).toEqual({
      ok: true,
      route: { ...base, name: "Mum", ownMessages: true },
    });
    expect(routes.update(U, "r1", { ownMessages: false })).toEqual({
      ok: true,
      route: { ...base, name: "Mum" },
    });
    expect(routes.update(U, "r1", { ownMessages: true })).toEqual({
      ok: true,
      route: { ...base, name: "Mum", ownMessages: true },
    });
  });

  it("a value that is not a boolean is 400 and writes nothing; a stored value that is not exactly true is dropped", () => {
    const h = harness();
    for (const value of ["yes", 1, null, {}]) {
      const r = h.routes.create(U, { ...mom, ownMessages: value } as never);
      expect([value, r.ok === false && r.status]).toEqual([value, 400]);
    }
    expect(h.routes.list(U)).toEqual([]);
    h.routes.create(U, mom);
    for (const value of ["yes", 1, null, {}]) {
      const r = h.routes.update(U, "r1", { ownMessages: value } as never);
      expect([value, r.ok === false && r.status]).toEqual([value, 400]);
    }
    expect(h.routes.get(U, "r1")).toEqual(base);

    for (const value of ["yes", "true", 1, {}]) {
      writeFileSync(
        join(memberDir(h.root, U), "routes.json"),
        JSON.stringify({
          phone: PHONE,
          routes: [{ ...base, ownMessages: value }],
        }),
      );
      expect([value, harness(h.root).routes.get(U, "r1")?.ownMessages]).toEqual(
        [value, undefined],
      );
    }
    writeFileSync(
      join(memberDir(h.root, U), "routes.json"),
      JSON.stringify({
        phone: PHONE,
        routes: [{ ...base, ownMessages: true }],
      }),
    );
    expect(harness(h.root).routes.get(U, "r1")?.ownMessages).toBe(true);
  });
});
