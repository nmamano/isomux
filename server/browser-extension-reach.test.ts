// "All agents" offers (scope "office", task d4224f2f): a tab a member offers
// to every agent they can reach, whoever manages it. "Only my agents" (scope
// "all") and individual offers stay with the agents the member manages.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrowserExtensionBridge,
  browserCredentialHash,
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
