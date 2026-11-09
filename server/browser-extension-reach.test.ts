// "All agents" offers (scope "office", task d4224f2f): a tab a member offers
// to every agent they can reach, whoever manages it. "Only my agents" (scope
// "all") and individual offers stay with the agents the member manages.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrowserExtensionBridge,
  browserCredentialHash,
  RESUME_GRACE_MS,
  type ExtensionConnection,
} from "./browser-extension-bridge";
import { BrowserExtensionService } from "./browser-extension-service";
import { BrowserExtensionStore } from "./browser-extension-store";
import { ExtensionBrowserSessions } from "./browser-extension-session";
import type {
  BrowserGrantScope,
  Fields,
} from "../shared/browser-extension-protocol";

const origin = "chrome-extension://" + "a".repeat(32);

// ann and bob share room r1; only bob reaches r2. orphan is a legacy agent
// that no member manages.
function office() {
  const manager: Record<string, string | undefined> = {
    "ann-agent": "ann",
    "bob-agent": "bob",
    "far-agent": "bob",
    orphan: undefined,
  };
  const room: Record<string, string> = {
    "ann-agent": "r1",
    "bob-agent": "r1",
    "far-agent": "r2",
    orphan: "r1",
  };
  const rooms: Record<string, Set<string>> = {
    ann: new Set(["r1"]),
    bob: new Set(["r1", "r2"]),
    carol: new Set(["r1"]),
  };
  const mayReach = (member: string, agent: string) =>
    agent in room && !!rooms[member]?.has(room[agent]);
  const mayUse = (member: string, agent: string) =>
    manager[agent] === member && mayReach(member, agent);
  return { manager, rooms, mayReach, mayUse };
}

type Wire = { messages: Fields[]; send(m: Fields): void; close(): void };
const wire = (): Wire => ({
  messages: [],
  send(m) {
    this.messages.push(m);
  },
  close() {},
});

// Offers the tab and answers its attach; returns the grant id.
async function offer(
  connection: ExtensionConnection,
  peer: Wire,
  scope: BrowserGrantScope,
): Promise<string> {
  const assignment = crypto.randomUUID();
  const sent = peer.messages.length;
  connection.receive({
    kind: "offer",
    durationMinutes: 0,
    generation: connection.generation,
    assignment,
    scope,
  });
  const attach = peer.messages.slice(sent).find((m) => m.method === "attach");
  if (!attach) throw new Error(`offer ${scope.kind} was refused`);
  connection.receive({
    kind: "result",
    generation: connection.generation,
    id: attach.id,
    result: {
      targetInfo: {
        targetId: crypto.randomUUID(),
        type: "page",
        url: "https://example.com/",
      },
    },
  });
  await Promise.resolve();
  return assignment;
}

function bridgeOffice() {
  const o = office();
  const members: Record<string, string> = {
    [browserCredentialHash("ann-laptop")]: "ann",
    [browserCredentialHash("bob-desk")]: "bob",
    [browserCredentialHash("carol-laptop")]: "carol",
  };
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: (hash) => members[hash],
    mayUse: o.mayUse,
    mayReach: o.mayReach,
    memberDisplay: (member) => ({ id: member, name: member }),
    agentDisplay: (agent) => ({ id: agent, name: agent }),
  });
  const open = (credential: string) => {
    const peer = wire();
    return { peer, connection: bridge.connect(credential, peer) };
  };
  // The handle the agent sees for a grant.
  const targetOf = (
    manager: string | undefined,
    agent: string,
    grant: string,
  ) =>
    bridge
      .targets(manager, agent)
      .find((t) => bridge.resolve(manager, agent, t.target)?.grant === grant)
      ?.target;
  return { ...o, bridge, open, targetOf };
}

test("an All agents offer reaches every agent its member can reach; Only my agents and individual offers stay with the member's agents", async () => {
  const h = bridgeOffice();
  const ann = h.open("ann-laptop");
  const carol = h.open("carol-laptop");
  try {
    expect(ann.peer.messages.find((m) => m.kind === "ready")?.officeScope).toBe(
      true,
    );
    const everyone = await offer(ann.connection, ann.peer, { kind: "office" });
    const mine = await offer(ann.connection, ann.peer, { kind: "all" });
    // An All agents offer does not take the agent's individual slot.
    const own = await offer(ann.connection, ann.peer, {
      kind: "agent",
      agentId: "ann-agent",
    });
    const kinds = (manager: string | undefined, agent: string) =>
      h.bridge
        .targets(manager, agent)
        .map((t) => t.scope.kind)
        .sort();
    expect(kinds("ann", "ann-agent")).toEqual(["agent", "all", "office"]);
    // Another member's agent and an unmanaged agent in a room ann can access.
    expect(kinds("bob", "bob-agent")).toEqual(["office"]);
    expect(kinds(undefined, "orphan")).toEqual(["office"]);
    // Bob's agent in a room ann cannot access.
    expect(kinds("bob", "far-agent")).toEqual([]);

    expect(h.bridge.resolve("bob", "bob-agent")).toMatchObject({
      connection: ann.connection,
      grant: everyone,
    });
    const anns = h.targetOf("bob", "bob-agent", everyone)!;
    expect(anns).toBeString();
    // The handles of ann's other offers do not resolve for bob's agent.
    for (const grant of [mine, own]) {
      const handle = h.targetOf("ann", "ann-agent", grant)!;
      expect(handle).toBeString();
      expect(h.bridge.resolve("bob", "bob-agent", handle)).toBeUndefined();
    }

    // A member who manages no agent can still offer to All agents.
    const carols = await offer(carol.connection, carol.peer, {
      kind: "office",
    });
    const metadata = carol.peer.messages.findLast((m) => m.kind === "metadata");
    expect(
      (metadata?.assignments as Fields[] | undefined)?.map((a) => a.id),
    ).toEqual([carols]);
    expect(kinds("bob", "bob-agent")).toEqual(["office", "office"]);

    // Reach is live: ann leaves r1, and bob's agent loses ann's tab while
    // carol's stays; the offer itself survives a revalidation.
    h.rooms.ann.delete("r1");
    ann.connection.revalidate();
    expect(h.bridge.targets("bob", "bob-agent").map((t) => t.target)).toEqual([
      h.targetOf("bob", "bob-agent", carols)!,
    ]);
    expect(h.bridge.resolve("bob", "bob-agent", anns)).toBeUndefined();
    h.rooms.ann.add("r1");
    expect(kinds("bob", "bob-agent")).toEqual(["office", "office"]);
  } finally {
    ann.connection.close();
    carol.connection.close();
  }
});

test("without a target, the agent's own offer wins, then a sole offer from its manager's browsers, then a sole All agents offer of another member", async () => {
  const h = bridgeOffice();
  const ann = h.open("ann-laptop");
  const bob = h.open("bob-desk");
  try {
    const first = await offer(ann.connection, ann.peer, { kind: "office" });
    expect(h.bridge.ambiguous("bob", "bob-agent")).toBe(false);
    expect(h.bridge.resolve("bob", "bob-agent")?.grant).toBe(first);

    const second = await offer(ann.connection, ann.peer, { kind: "office" });
    expect(h.bridge.ambiguous("bob", "bob-agent")).toBe(true);
    expect(h.bridge.resolve("bob", "bob-agent")).toBeUndefined();

    // One offer from bob's own browsers outranks two of ann's.
    const mine = await offer(bob.connection, bob.peer, { kind: "all" });
    expect(h.bridge.ambiguous("bob", "bob-agent")).toBe(false);
    expect(h.bridge.resolve("bob", "bob-agent")).toMatchObject({
      connection: bob.connection,
      grant: mine,
    });
    // An explicit target still reaches ann's tab.
    const handle = h.targetOf("bob", "bob-agent", second)!;
    expect(h.bridge.resolve("bob", "bob-agent", handle)).toMatchObject({
      connection: ann.connection,
      grant: second,
    });

    // Two offers from bob's browsers are ambiguous; the tier below does not
    // break the tie.
    const everyone = await offer(bob.connection, bob.peer, { kind: "office" });
    expect(h.bridge.ambiguous("bob", "bob-agent")).toBe(true);
    expect(h.bridge.resolve("bob", "bob-agent")).toBeUndefined();

    const own = await offer(bob.connection, bob.peer, {
      kind: "agent",
      agentId: "bob-agent",
    });
    expect(h.bridge.ambiguous("bob", "bob-agent")).toBe(false);
    expect(h.bridge.resolve("bob", "bob-agent")?.grant).toBe(own);

    // An unmanaged agent has only the All agents tier: three offers, then one.
    expect(h.bridge.ambiguous(undefined, "orphan")).toBe(true);
    expect(h.bridge.resolve(undefined, "orphan")).toBeUndefined();
    ann.connection.close();
    expect(h.bridge.ambiguous(undefined, "orphan")).toBe(false);
    expect(h.bridge.resolve(undefined, "orphan")).toMatchObject({
      connection: bob.connection,
      grant: everyone,
    });
    // Ann's agent sees only bob's All agents offer.
    expect(
      h.bridge.targets("ann", "ann-agent").map((t) => t.scope.kind),
    ).toEqual(["office"]);
    expect(h.bridge.resolve("ann", "ann-agent")?.grant).toBe(everyone);
  } finally {
    ann.connection.close();
    bob.connection.close();
  }
});

// The agent's side: bob has no browser paired, ann offers her tab to All
// agents. No Playwright runs: tabs, the ambiguity check and close all resolve
// before a client attaches.
async function sessionOffice() {
  const o = office();
  const dir = mkdtempSync(join(tmpdir(), "browser-reach-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: o.mayUse,
    mayReach: o.mayReach,
    memberName: (member) => member[0].toUpperCase() + member.slice(1),
    agentName: (agent) => agent,
  });
  const sessions = new ExtensionBrowserSessions(
    service,
    (agent) => o.manager[agent],
    o.mayUse,
    () => 500,
  );
  const { code } = store.pair("ann", "Laptop");
  const { credential } = store.redeem(code, origin, () => true);
  const peer = wire();
  const connection = service.bridge.connect(credential, peer);
  return {
    ...o,
    store,
    credential,
    service,
    sessions,
    connection,
    peer,
    stop: () => {
      sessions.stop();
      service.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("an agent whose manager has no browser lists and closes another member's All agents tab, and only that tab", async () => {
  const h = await sessionOffice();
  try {
    const everyone = await offer(h.connection, h.peer, { kind: "office" });
    await offer(h.connection, h.peer, { kind: "all" });
    await offer(h.connection, h.peer, { kind: "agent", agentId: "ann-agent" });
    const tabs = await h.sessions.run("bob-agent", { action: "tabs" });
    expect(tabs).toMatchObject({
      ok: true,
      tabs: [{ scope: { kind: "office" }, browser: "Laptop", member: "Ann" }],
    });
    const [tab] = (tabs as unknown as { tabs: { target: string }[] }).tabs;
    expect(h.connection.offered("bob-agent", tab.target)).toBe(everyone);

    const commands = h.peer.messages.length;
    expect(await h.sessions.run("bob-agent", { action: "close" })).toEqual({
      ok: true,
      url: "",
      title: "",
      closed: true,
    });
    expect(h.peer.messages.length).toBeGreaterThan(commands);
    expect(h.connection.offered("bob-agent")).toBeUndefined();
    // Ann's other offers stay, for her own agent.
    expect(
      h.connection
        .targets("ann-agent")
        .map((t) => t.scope.kind)
        .sort(),
    ).toEqual(["agent", "all"]);
    // Nothing reachable is left: bob's own state answers.
    expect(await h.sessions.run("bob-agent", { action: "tabs" })).toMatchObject(
      { ok: false, code: "browser_not_paired" },
    );
  } finally {
    h.stop();
  }
});

test("an unmanaged agent uses an All agents tab, and loses it with the offering member's room access", async () => {
  const h = await sessionOffice();
  try {
    const everyone = await offer(h.connection, h.peer, { kind: "office" });
    expect(await h.sessions.run("orphan", { action: "tabs" })).toMatchObject({
      ok: true,
      tabs: [{ scope: { kind: "office" } }],
    });
    h.rooms.ann.delete("r1");
    expect(await h.sessions.run("orphan", { action: "tabs" })).toMatchObject({
      ok: false,
      code: "browser_not_paired",
    });
    expect(await h.sessions.run("orphan", { action: "close" })).toMatchObject({
      ok: true,
      closed: true,
    });
    // The close found nothing it could reach, so ann's offer stays.
    h.rooms.ann.add("r1");
    expect(h.connection.offered("orphan")).toBe(everyone);
    expect(await h.sessions.run("orphan", { action: "close" })).toMatchObject({
      ok: true,
      closed: true,
    });
    expect(h.connection.offered("orphan")).toBeUndefined();
    expect(h.connection.targets("ann-agent")).toEqual([]);
  } finally {
    h.stop();
  }
});

test("two All agents tabs of other members need a target, and an offer from the manager's browser does not", async () => {
  const h = await sessionOffice();
  try {
    await offer(h.connection, h.peer, { kind: "office" });
    await offer(h.connection, h.peer, { kind: "office" });
    const sent = h.peer.messages.length;
    expect(await h.sessions.run("bob-agent", { action: "text" })).toMatchObject(
      { ok: false, code: "browser_target_required" },
    );
    expect(h.peer.messages.length).toBe(sent);
    // Ann's own agent sees the same two tabs in its manager's tier.
    expect(await h.sessions.run("ann-agent", { action: "text" })).toMatchObject(
      { ok: false, code: "browser_target_required" },
    );
    // The agent's own offer wins without a target: close ends that one.
    await offer(h.connection, h.peer, { kind: "agent", agentId: "ann-agent" });
    expect(
      await h.sessions.run("ann-agent", { action: "close" }),
    ).toMatchObject({ ok: true, closed: true });
    expect(h.connection.targets("ann-agent").map((t) => t.scope.kind)).toEqual([
      "office",
      "office",
    ]);
  } finally {
    h.stop();
  }
});

// A connection loss and the reconnect gap (task 79c264b7): a tab whose
// browser dropped its socket comes back with the same target about a second
// later. A call in that gap is told the browser is offline, never that no
// browser is paired, whoever manages the agent.

type OfferAnswer = "page" | "none" | "error";
// Sends an offer (or a resume, with extra) and answers its attach as asked:
// "none" leaves it attaching.
async function sendOffer(
  connection: ExtensionConnection,
  peer: Wire,
  assignment: string,
  scope: BrowserGrantScope,
  {
    durationMinutes = 0,
    extra = {},
    answer = "page",
  }: { durationMinutes?: number; extra?: Fields; answer?: OfferAnswer } = {},
): Promise<{ attach?: Fields }> {
  const sent = peer.messages.length;
  connection.receive({
    kind: "offer",
    durationMinutes,
    generation: connection.generation,
    assignment,
    scope,
    ...extra,
  });
  const attach = peer.messages.slice(sent).find((m) => m.method === "attach");
  if (attach && answer !== "none") answerAttach(connection, attach, answer);
  await Promise.resolve();
  await Promise.resolve();
  return { attach };
}
function answerAttach(
  connection: ExtensionConnection,
  attach: Fields,
  answer: OfferAnswer = "page",
) {
  connection.receive({
    kind: "result",
    generation: connection.generation,
    id: attach.id,
    ...(answer === "error"
      ? { error: "Browser command failed" }
      : {
          result: {
            targetInfo: {
              targetId: crypto.randomUUID(),
              type: "page",
              url: "https://example.com/",
            },
          },
        }),
  });
}
// What the extension sends back for an offer of https://example.com/.
const RESUME = { expiresAt: null, offerOrigin: "https://example.com" };
const OPENED_RESUME = { expiresAt: null };
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const ALL_AGENTS_ACCESS = { agents: "office", members: [], openTabs: true };

// The answer names the browser and the member that hold the tab.
function expectOffline(result: unknown, browser: string, member: string) {
  expect(result).toMatchObject({ ok: false, code: "browser_offline" });
  const error = (result as { error: string }).error;
  expect(error).toContain(browser);
  expect(error).toContain(member);
}

describe("a tab whose browser is reconnecting (task 79c264b7)", () => {
  test("a targeted call to another member's tab answers browser_offline through the gap, until the tab is offered again with the same target", async () => {
    const h = await sessionOffice();
    try {
      const assignment = crypto.randomUUID();
      await sendOffer(h.connection, h.peer, assignment, { kind: "office" });
      const listed = await h.sessions.run("bob-agent", { action: "tabs" });
      const [{ target }] = (listed as unknown as { tabs: { target: string }[] })
        .tabs;
      // bob has no browser paired: the condition the wrong answer came from.
      expect(h.store.paired("bob")).toBe(false);

      h.connection.close();
      const goto = { action: "goto", url: "https://example.com/x", target };
      expectOffline(await h.sessions.run("bob-agent", goto), "Laptop", "Ann");
      // A close in the gap closes nothing, so it does not say it did.
      expectOffline(
        await h.sessions.run("bob-agent", { action: "close", target }),
        "Laptop",
        "Ann",
      );
      // An agent with no manager that reaches the tab gets the same answer.
      expectOffline(await h.sessions.run("orphan", goto), "Laptop", "Ann");

      // Reconnected, the resume not yet sent.
      const peer = wire();
      const again = h.service.bridge.connect(h.credential, peer);
      expectOffline(await h.sessions.run("bob-agent", goto), "Laptop", "Ann");
      // The resume arrived and is attaching.
      const { attach } = await sendOffer(
        again,
        peer,
        assignment,
        { kind: "office" },
        { extra: RESUME, answer: "none" },
      );
      expect(attach).toBeDefined();
      expectOffline(await h.sessions.run("bob-agent", goto), "Laptop", "Ann");

      answerAttach(again, attach!);
      await settle();
      expect(again.offered("bob-agent", target)).toBe(assignment);
      expect(
        await h.sessions.run("bob-agent", { action: "close", target }),
      ).toMatchObject({ ok: true, closed: true });
      expect(again.offered("bob-agent", target)).toBeUndefined();
      again.close();
    } finally {
      h.stop();
    }
  });

  test("a target that no browser offers answers browser_control_ended, never browser_not_paired", async () => {
    const h = await sessionOffice();
    try {
      const target = crypto.randomUUID();
      const goto = { action: "goto", url: "https://example.com/", target };
      for (const agent of ["bob-agent", "orphan", "ann-agent"])
        expect(await h.sessions.run(agent, goto)).toMatchObject({
          ok: false,
          code: "browser_control_ended",
        });
      // The same once the only paired browser is gone.
      h.connection.close();
      for (const agent of ["bob-agent", "orphan"])
        expect(await h.sessions.run(agent, goto)).toMatchObject({
          ok: false,
          code: "browser_control_ended",
        });
    } finally {
      h.stop();
    }
  });

  test("an agent's own tab in another member's browser: an action without a target and tabs answer browser_offline, for that agent only", async () => {
    const h = await sessionOffice();
    try {
      h.connection.receive({
        kind: "access",
        generation: h.connection.generation,
        access: ALL_AGENTS_ACCESS,
      });
      await sendOffer(
        h.connection,
        h.peer,
        crypto.randomUUID(),
        { kind: "opened", agentId: "bob-agent", via: "office" },
        { extra: OPENED_RESUME },
      );
      expect(
        await h.sessions.run("bob-agent", { action: "tabs" }),
      ).toMatchObject({
        ok: true,
        tabs: [{ scope: { kind: "opened", agentId: "bob-agent" } }],
      });

      h.connection.close();
      expectOffline(
        await h.sessions.run("bob-agent", {
          action: "goto",
          url: "https://example.com/x",
        }),
        "Laptop",
        "Ann",
      );
      expectOffline(
        await h.sessions.run("bob-agent", { action: "tabs" }),
        "Laptop",
        "Ann",
      );
      // Another agent of the same manager has no tab there: bob's state.
      expect(
        await h.sessions.run("far-agent", { action: "tabs" }),
      ).toMatchObject({ ok: false, code: "browser_not_paired" });
    } finally {
      h.stop();
    }
  });

  test("the manager's other browser online: the agent's tab in the offline one answers browser_offline naming that browser", async () => {
    const h = await sessionOffice();
    const { code } = h.store.pair("ann", "Desk");
    const { credential } = h.store.redeem(code, origin, () => true);
    const desk = h.service.bridge.connect(credential, wire());
    try {
      const assignment = crypto.randomUUID();
      await sendOffer(h.connection, h.peer, assignment, {
        kind: "agent",
        agentId: "ann-agent",
      });
      const [{ target }] = h.service.bridge.targets("ann", "ann-agent");

      h.connection.close();
      expect(h.service.bridge.connections("ann")).toEqual([desk]);
      const goto = { action: "goto", url: "https://example.com/x" };
      expectOffline(await h.sessions.run("ann-agent", goto), "Laptop", "Ann");
      expectOffline(
        await h.sessions.run("ann-agent", { ...goto, target }),
        "Laptop",
        "Ann",
      );
    } finally {
      desk.close();
      h.stop();
    }
  });
});

describe("routing without a target while one of the agent's own tabs is offline (task 79c264b7)", () => {
  // ann's Laptop holds ann-agent's own tab; her Desk stays online. With the
  // Laptop online, an action without a target picks only among the agent's
  // own tabs. In the gap it must not pick a tab it would not have picked.
  async function twoBrowsers() {
    const h = await sessionOffice();
    const { code } = h.store.pair("ann", "Desk");
    const { credential } = h.store.redeem(code, origin, () => true);
    const deskPeer = wire();
    const desk = h.service.bridge.connect(credential, deskPeer);
    await sendOffer(h.connection, h.peer, crypto.randomUUID(), {
      kind: "agent",
      agentId: "ann-agent",
    });
    return { ...h, desk, deskPeer };
  }

  test("a shared tab online does not take the action: browser_offline, and the shared tab is untouched", async () => {
    const h = await twoBrowsers();
    try {
      const shared = crypto.randomUUID();
      await sendOffer(h.desk, h.deskPeer, shared, { kind: "all" });
      // The Desk offers the shared tab to ann-agent.
      expect(h.desk.offered("ann-agent")).toBe(shared);
      h.connection.close();
      expectOffline(
        await h.sessions.run("ann-agent", { action: "close" }),
        "Laptop",
        "Ann",
      );
      expect(h.desk.offered("ann-agent")).toBe(shared);
    } finally {
      h.desk.close();
      h.stop();
    }
  });

  test("another own tab online is not the default either: the agent must name a target", async () => {
    const h = await twoBrowsers();
    try {
      // A tab ann-agent opened in the Desk.
      h.desk.receive({
        kind: "access",
        generation: h.desk.generation,
        access: ALL_AGENTS_ACCESS,
      });
      const other = crypto.randomUUID();
      await sendOffer(
        h.desk,
        h.deskPeer,
        other,
        { kind: "opened", agentId: "ann-agent", via: "all" },
        { extra: OPENED_RESUME },
      );
      expect(h.desk.offered("ann-agent")).toBe(other);
      // Online, two own tabs need a target.
      expect(
        await h.sessions.run("ann-agent", { action: "close" }),
      ).toMatchObject({ ok: false, code: "browser_target_required" });
      h.connection.close();
      expect(
        await h.sessions.run("ann-agent", { action: "close" }),
      ).toMatchObject({ ok: false, code: "browser_target_required" });
      expect(h.desk.offered("ann-agent")).toBe(other);
    } finally {
      h.desk.close();
      h.stop();
    }
  });
});

// The bridge's record, on a clock the test moves.
describe("bridge.offline (task 79c264b7)", () => {
  function clock() {
    let now = 1_000_000;
    const timers: { at: number; callback: () => void; done: boolean }[] = [];
    return {
      now: () => now,
      schedule(callback: () => void, delayMs: number) {
        const timer = { at: now + delayMs, callback, done: false };
        timers.push(timer);
        return () => {
          timer.done = true;
        };
      },
      advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const next = timers
            .filter((t) => !t.done && t.at <= end)
            .sort((a, b) => a.at - b.at)[0];
          if (!next) break;
          now = next.at;
          next.done = true;
          next.callback();
        }
        now = end;
      },
    };
  }
  function office2() {
    const o = office();
    const time = clock();
    const members: Record<string, string> = {
      [browserCredentialHash("ann-laptop")]: "ann",
    };
    const bridge = new BrowserExtensionBridge(
      {
        memberForCredentialHash: (hash) => members[hash],
        browserName: () => "Laptop",
        mayUse: o.mayUse,
        mayReach: o.mayReach,
        memberDisplay: (member) => ({ id: member, name: member }),
        agentDisplay: (agent) => ({ id: agent, name: agent }),
      },
      time,
    );
    const open = () => {
      const peer = wire();
      return { peer, connection: bridge.connect("ann-laptop", peer) };
    };
    const unpair = () => {
      delete members[browserCredentialHash("ann-laptop")];
    };
    return { ...o, time, bridge, open, unpair };
  }
  // Offers a tab on a fresh connection and returns its target and assignment.
  async function offered(
    h: ReturnType<typeof office2>,
    scope: BrowserGrantScope,
    durationMinutes = 0,
  ) {
    const browser = h.open();
    const assignment = crypto.randomUUID();
    await sendOffer(browser.connection, browser.peer, assignment, scope, {
      durationMinutes,
    });
    const agent =
      scope.kind === "agent" || scope.kind === "opened"
        ? scope.agentId
        : "ann-agent";
    const tab = h.bridge
      .targets("ann", agent)
      .find((t) => browser.connection.offered(agent, t.target) === assignment);
    if (!tab) throw new Error("offer not listed");
    return { ...browser, assignment, target: tab.target };
  }
  const LAPTOP = { browser: "Laptop", member: "ann" };

  test("no connection: offline however long it lasts; a new connection that has not resumed it: offline for the grace, then gone", async () => {
    const h = office2();
    const tab = await offered(h, { kind: "office" });
    expect(h.bridge.offline(tab.target, "bob-agent")).toBeUndefined();
    tab.connection.close();
    expect(h.bridge.offline(tab.target, "bob-agent")).toEqual(LAPTOP);
    h.time.advance(RESUME_GRACE_MS * 10);
    expect(h.bridge.offline(tab.target, "bob-agent")).toEqual(LAPTOP);

    const again = h.open();
    h.time.advance(RESUME_GRACE_MS - 1);
    expect(h.bridge.offline(tab.target, "bob-agent")).toEqual(LAPTOP);
    h.time.advance(1);
    expect(h.bridge.offline(tab.target, "bob-agent")).toBeUndefined();
    // Gone for good: a later loss of that connection does not bring it back.
    again.connection.close();
    expect(h.bridge.offline(tab.target, "bob-agent")).toBeUndefined();
  });

  test("a resume that is still attaching past the grace keeps the tab offline; its attach ends the record", async () => {
    const h = office2();
    const tab = await offered(h, { kind: "office" });
    tab.connection.close();
    const again = h.open();
    const { attach } = await sendOffer(
      again.connection,
      again.peer,
      tab.assignment,
      { kind: "office" },
      { extra: RESUME, answer: "none" },
    );
    expect(attach).toBeDefined();
    h.time.advance(RESUME_GRACE_MS * 2);
    expect(h.bridge.offline(tab.target, "bob-agent")).toEqual(LAPTOP);
    answerAttach(again.connection, attach!);
    await settle();
    expect(h.bridge.resolve("bob", "bob-agent", tab.target)?.grant).toBe(
      tab.assignment,
    );
    expect(h.bridge.offline(tab.target, "bob-agent")).toBeUndefined();
    // Lost again: offline again.
    again.connection.close();
    expect(h.bridge.offline(tab.target, "bob-agent")).toEqual(LAPTOP);
  });

  test("a resume the office refuses ends the record within the grace", async () => {
    const h = office2();
    const tab = await offered(h, { kind: "office" });
    tab.connection.close();
    const again = h.open();
    await sendOffer(
      again.connection,
      again.peer,
      tab.assignment,
      { kind: "office" },
      { extra: RESUME, answer: "error" },
    );
    expect(h.bridge.offline(tab.target, "bob-agent")).toBeUndefined();
  });

  test("an offer that ended for another reason than the connection loss is not offline", async () => {
    const h = office2();
    const tab = await offered(h, { kind: "agent", agentId: "ann-agent" });
    tab.connection.revoke("ann-agent", tab.target);
    expect(tab.connection.offered("ann-agent", tab.target)).toBeUndefined();
    tab.connection.close();
    expect(h.bridge.offline(tab.target, "ann-agent")).toBeUndefined();
    expect(h.bridge.offlineOwn("ann-agent")).toEqual([]);
  });

  test("an offer whose deadline passes while the browser is away is not offline", async () => {
    const h = office2();
    const tab = await offered(h, { kind: "agent", agentId: "ann-agent" }, 15);
    tab.connection.close();
    h.time.advance(15 * 60_000 - 1);
    expect(h.bridge.offline(tab.target, "ann-agent")).toEqual(LAPTOP);
    expect(h.bridge.offlineOwn("ann-agent")).toEqual([LAPTOP]);
    h.time.advance(1);
    expect(h.bridge.offline(tab.target, "ann-agent")).toBeUndefined();
    expect(h.bridge.offlineOwn("ann-agent")).toEqual([]);
  });

  test("a resume lost again while attaching keeps the first offer's deadline", async () => {
    const h = office2();
    const tab = await offered(h, { kind: "agent", agentId: "ann-agent" }, 15);
    const deadline = h.time.now() + 15 * 60_000;
    tab.connection.close();
    h.time.advance(60_000);
    const again = h.open();
    const { attach } = await sendOffer(
      again.connection,
      again.peer,
      tab.assignment,
      { kind: "agent", agentId: "ann-agent" },
      {
        durationMinutes: 15,
        extra: { expiresAt: deadline, offerOrigin: "https://example.com" },
        answer: "none",
      },
    );
    expect(attach).toBeDefined();
    again.connection.close();
    h.time.advance(deadline - 1 - h.time.now());
    expect(h.bridge.offline(tab.target, "ann-agent")).toEqual(LAPTOP);
    h.time.advance(1);
    expect(h.bridge.offline(tab.target, "ann-agent")).toBeUndefined();
  });

  test("a browser unpaired while away is not offline", async () => {
    const h = office2();
    const tab = await offered(h, { kind: "agent", agentId: "ann-agent" });
    tab.connection.close();
    expect(h.bridge.offlineOwn("ann-agent")).toEqual([LAPTOP]);
    h.unpair();
    expect(h.bridge.offline(tab.target, "ann-agent")).toBeUndefined();
    expect(h.bridge.offlineOwn("ann-agent")).toEqual([]);
  });

  test("only an agent the offer was for learns of it: per scope, and offlineOwn holds only the agent's own tabs", async () => {
    const h = office2();
    const own = await offered(h, { kind: "agent", agentId: "ann-agent" });
    own.connection.close();
    const mine = await offered(h, { kind: "all" });
    mine.connection.close();
    const everyone = await offered(h, { kind: "office" });
    everyone.connection.close();
    const cases: [string, string, boolean][] = [
      [own.target, "ann-agent", true],
      [own.target, "bob-agent", false],
      [mine.target, "ann-agent", true],
      [mine.target, "bob-agent", false],
      [everyone.target, "bob-agent", true],
      [everyone.target, "orphan", true],
      // ann does not reach far-agent's room.
      [everyone.target, "far-agent", false],
    ];
    const scopeOf = (target: string) =>
      target === own.target
        ? "agent"
        : target === mine.target
          ? "all"
          : "office";
    // The scope and agent label each row, so a red names the case.
    expect(
      cases.map(([target, agent]) => [
        scopeOf(target),
        agent,
        h.bridge.offline(target, agent),
      ]),
    ).toEqual(
      cases.map(([target, agent, known]) => [
        scopeOf(target),
        agent,
        known ? LAPTOP : undefined,
      ]),
    );
    expect(h.bridge.offlineOwn("ann-agent")).toEqual([LAPTOP]);
    expect(h.bridge.offlineOwn("bob-agent")).toEqual([]);
    expect(h.bridge.offline(crypto.randomUUID(), "ann-agent")).toBeUndefined();
  });

  test("an opened tab is the opening agent's own while its browser is away", async () => {
    const h = office2();
    const browser = h.open();
    browser.connection.receive({
      kind: "access",
      generation: browser.connection.generation,
      access: ALL_AGENTS_ACCESS,
    });
    await sendOffer(
      browser.connection,
      browser.peer,
      crypto.randomUUID(),
      { kind: "opened", agentId: "bob-agent", via: "office" },
      { extra: OPENED_RESUME },
    );
    const [tab] = h.bridge.targets("bob", "bob-agent");
    expect(tab.scope.kind).toBe("opened");
    browser.connection.close();
    expect(h.bridge.offlineOwn("bob-agent")).toEqual([LAPTOP]);
    expect(h.bridge.offline(tab.target, "bob-agent")).toEqual(LAPTOP);
    expect(h.bridge.offline(tab.target, "far-agent")).toBeUndefined();
    expect(h.bridge.offlineOwn("far-agent")).toEqual([]);
  });
});
