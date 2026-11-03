// Agent tabs (task 73a9fb57): a member turns on "Agents may open tabs" in a
// paired browser, for the agents they manage ("all") or for every agent they
// can reach ("office"). An agent then opens its own tab there with the open
// action. Each opened tab belongs to the agent that opened it, and an agent
// may hold several.
//
// Task 7355640c: the extension sends one access setting instead: which agents
// ("mine", "members" for mine and the members picked, "office") may use the
// tabs the member offers ("shared") and, with openTabs, open their own.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerWebSocket } from "bun";
import {
  BrowserExtensionBridge,
  browserCredentialHash,
  type ExtensionConnection,
} from "./browser-extension-bridge";
import {
  BrowserExtensionService,
  type ExtensionWsData,
} from "./browser-extension-service";
import { BrowserExtensionStore } from "./browser-extension-store";
import { ExtensionBrowserSessions } from "./browser-extension-session";
import type {
  AgentTabsScope,
  BrowserAccess,
  BrowserGrantScope,
  Fields,
} from "../shared/browser-extension-protocol";

const OFFICE = "https://office.test";
const origin = "chrome-extension://" + "a".repeat(32);

// ann, bob and carol share room r1; only bob and dan reach r2. ann manages
// ann-agent and ann-helper; bob manages bob-agent and far-agent; carol
// manages carol-agent; dan manages dan-agent, which ann cannot reach. orphan
// has no manager.
function office() {
  const manager: Record<string, string | undefined> = {
    "ann-agent": "ann",
    "ann-helper": "ann",
    "bob-agent": "bob",
    "far-agent": "bob",
    "carol-agent": "carol",
    "dan-agent": "dan",
    orphan: undefined,
  };
  const room: Record<string, string> = {
    "ann-agent": "r1",
    "ann-helper": "r1",
    "bob-agent": "r1",
    "far-agent": "r2",
    "carol-agent": "r1",
    "dan-agent": "r2",
    orphan: "r1",
  };
  const rooms: Record<string, Set<string>> = {
    ann: new Set(["r1"]),
    bob: new Set(["r1", "r2"]),
    carol: new Set(["r1"]),
    dan: new Set(["r2"]),
  };
  const mayReach = (member: string, agent: string) =>
    agent in room && !!rooms[member]?.has(room[agent]);
  const mayUse = (member: string, agent: string) =>
    manager[agent] === member && mayReach(member, agent);
  return { manager, rooms, mayReach, mayUse };
}

type Wire = {
  messages: Fields[];
  // How the stand-in extension answers an open command: with a tab at a URL,
  // with a failure reason, or not at all ("hold").
  opens: { url: string } | { reason: string } | "hold";
  answer?: (m: Fields) => void;
  closed: boolean;
  send(m: Fields): void;
  close(): void;
};
const wire = (): Wire => ({
  messages: [],
  opens: { url: "about:blank" },
  closed: false,
  send(m) {
    this.messages.push(m);
    this.answer?.(m);
  },
  close() {
    this.closed = true;
  },
});

// The browsers: credential -> member, name and store id. ann has two
// browsers named Laptop: names are not unique.
const BROWSERS: Record<string, { member: string; name: string; id: string }> = {
  "ann-laptop": { member: "ann", name: "Laptop", id: "id-ann-laptop" },
  "ann-desk": { member: "ann", name: "Desk", id: "id-ann-desk" },
  "ann-twin": { member: "ann", name: "Laptop", id: "id-ann-twin" },
  "bob-desk": { member: "bob", name: "Desk", id: "id-bob-desk" },
  "carol-laptop": { member: "carol", name: "Carol's", id: "id-carol" },
};
const byHash = Object.fromEntries(
  Object.entries(BROWSERS).map(([credential, b]) => [
    browserCredentialHash(credential),
    b,
  ]),
);

function bridgeOffice() {
  const o = office();
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: (hash) => byHash[hash]?.member,
    browserName: (hash) => byHash[hash]?.name ?? "",
    browserId: (hash) => byHash[hash]?.id ?? "",
    mayUse: o.mayUse,
    mayReach: o.mayReach,
    managerOf: (agent) => o.manager[agent],
    agents: () => Object.keys(o.manager),
    memberDisplay: (member) => ({ id: member, name: member }),
    agentDisplay: (agent) => ({ id: agent, name: agent }),
    officeOrigins: () => [OFFICE],
  });
  const connect = (credential: string) => {
    const peer = wire();
    const connection = bridge.connect(credential, peer);
    // The stand-in extension answers each open command, once the bridge has
    // sent it, with the attach result the real one sends.
    peer.answer = (m) => {
      if (m.kind !== "command" || m.method !== "open" || peer.opens === "hold")
        return;
      const opens = peer.opens;
      queueMicrotask(() =>
        connection.receive({
          kind: "result",
          generation: connection.generation,
          id: m.id,
          ...("url" in opens
            ? {
                result: {
                  targetInfo: {
                    targetId: crypto.randomUUID(),
                    type: "page",
                    url: opens.url,
                  },
                },
              }
            : { error: "Browser command failed", reason: opens.reason }),
        }),
      );
    };
    return {
      peer,
      connection,
      // The member's agent tabs setting, as the extension sends it.
      setting: (scope: AgentTabsScope | null) =>
        connection.receive({
          kind: "agentTabs",
          generation: connection.generation,
          scope,
        }),
      // The member's access setting, as the extension sends it.
      access: (access: BrowserAccess) =>
        connection.receive({
          kind: "access",
          generation: connection.generation,
          access,
        }),
    };
  };
  return { ...o, bridge, connect };
}
type Browser = ReturnType<ReturnType<typeof bridgeOffice>["connect"]>;

const opens = (b: Browser) =>
  b.peer.messages.filter((m) => m.kind === "command" && m.method === "open");
const detached = (b: Browser, grant: string) =>
  b.peer.messages.some(
    (m) =>
      m.kind === "command" && m.method === "detach" && m.assignment === grant,
  );
// The params of the office's detach of a grant: close says whether the
// extension closes a tab an agent opened (task 9361ce1b).
const detachParams = (b: Browser, grant: string) =>
  b.peer.messages.find(
    (m) =>
      m.kind === "command" && m.method === "detach" && m.assignment === grant,
  )?.params;
// The grant behind a handle the agent sees.
const grantOf = (
  b: Browser,
  agent: string,
  target: string,
): string | undefined => b.connection.offered(agent, target);

async function offer(
  b: Browser,
  scope: BrowserGrantScope,
  extra: Fields = {},
  url = "https://example.com/",
): Promise<{ assignment: string; answer?: Fields }> {
  const assignment = crypto.randomUUID();
  const sent = b.peer.messages.length;
  b.connection.receive({
    kind: "offer",
    durationMinutes: 0,
    generation: b.connection.generation,
    assignment,
    scope,
    ...extra,
  });
  const attach = b.peer.messages.slice(sent).find((m) => m.method === "attach");
  if (attach)
    b.connection.receive({
      kind: "result",
      generation: b.connection.generation,
      id: attach.id,
      result: {
        targetInfo: { targetId: crypto.randomUUID(), type: "page", url },
      },
    });
  await Promise.resolve();
  await Promise.resolve();
  return {
    assignment,
    answer: b.peer.messages
      .slice(sent)
      .findLast((m) => m.kind === "offered" && m.assignment === assignment),
  };
}
// An opened tab the extension sends again after a connection loss.
const resume = (
  b: Browser,
  agentId: string,
  via: AgentTabsScope,
  url = "https://example.com/",
  extra: Fields = {},
  assignment?: string,
) => {
  const sent = b.peer.messages.length;
  const id = assignment ?? crypto.randomUUID();
  b.connection.receive({
    kind: "offer",
    durationMinutes: 0,
    generation: b.connection.generation,
    assignment: id,
    scope: { kind: "opened", agentId, via },
    expiresAt: null,
    ...extra,
  });
  const attach = b.peer.messages.slice(sent).find((m) => m.method === "attach");
  if (attach)
    b.connection.receive({
      kind: "result",
      generation: b.connection.generation,
      id: attach.id,
      result: {
        targetInfo: { targetId: crypto.randomUUID(), type: "page", url },
      },
    });
  return (async () => {
    await Promise.resolve();
    await Promise.resolve();
    return {
      assignment: id,
      attached: !!attach,
      answer: b.peer.messages
        .slice(sent)
        .findLast((m) => m.kind === "offered" && m.assignment === id),
    };
  })();
};

test("ready advertises agent tabs, and each browser keeps the setting its extension last sent", () => {
  const h = bridgeOffice();
  const laptop = h.connect("ann-laptop");
  const desk = h.connect("ann-desk");
  try {
    expect(
      laptop.peer.messages.find((m) => m.kind === "ready")?.agentTabs,
    ).toBe(true);
    expect(laptop.connection.agentTabs).toBeNull();
    laptop.setting("office");
    desk.setting("all");
    expect([laptop.connection.agentTabs, desk.connection.agentTabs]).toEqual([
      "office",
      "all",
    ]);
    laptop.setting(null);
    expect(laptop.connection.agentTabs).toBeNull();
    // A message of an older generation changes nothing.
    desk.connection.receive({
      kind: "agentTabs",
      generation: "old",
      scope: null,
    });
    expect(desk.connection.agentTabs).toBe("all");
  } finally {
    laptop.connection.close();
    desk.connection.close();
  }
});

test("open asks the manager's browser for a tab and returns its handle, browser and member; the tab is the agent's own", async () => {
  const h = bridgeOffice();
  const laptop = h.connect("ann-laptop");
  try {
    laptop.setting("all");
    const result = await h.bridge.open("ann", "ann-agent");
    expect(result).toMatchObject({
      ok: true,
      connection: laptop.connection,
      browser: "Laptop",
      member: "ann",
    });
    if (!result.ok) throw new Error("open failed");
    const [command] = opens(laptop);
    expect(command.params).toMatchObject({
      agentId: "ann-agent",
      agentName: "ann-agent",
      scope: { kind: "opened", agentId: "ann-agent", via: "all" },
    });
    expect(h.bridge.targets("ann", "ann-agent")).toEqual([
      expect.objectContaining({
        target: result.target,
        scope: { kind: "opened", agentId: "ann-agent", via: "all" },
        browser: "Laptop",
        url: "about:blank",
      }),
    ]);
    expect(grantOf(laptop, "ann-agent", result.target)).toBe(
      String(command.assignment),
    );
    // The office told the extension that the open is a grant.
    expect(
      laptop.peer.messages.find(
        (m) => m.kind === "offered" && m.assignment === command.assignment,
      )?.error,
    ).toBeUndefined();
  } finally {
    laptop.connection.close();
  }
});

test("open fails without making a tab when no browser of the manager allows it, and names the browsers when several do", async () => {
  const h = bridgeOffice();
  // bob's browser is not connected: offline.
  expect(await h.bridge.open("bob", "bob-agent")).toMatchObject({
    ok: false,
    code: "browser_offline",
  });
  const laptop = h.connect("ann-laptop");
  const desk = h.connect("ann-desk");
  try {
    // Connected, setting off.
    expect(await h.bridge.open("ann", "ann-agent")).toMatchObject({
      ok: false,
      code: "agent_tabs_off",
    });
    expect([...opens(laptop), ...opens(desk)]).toEqual([]);
    laptop.setting("all");
    desk.setting("all");
    const several = await h.bridge.open("ann", "ann-agent");
    expect(several).toMatchObject({
      ok: false,
      code: "browser_target_required",
    });
    expect(
      (several.ok ? [] : (several.browsers ?? [])).map((b) => b.id).sort(),
    ).toEqual(["id-ann-desk", "id-ann-laptop"]);
    expect([...opens(laptop), ...opens(desk)]).toEqual([]);
    // A name or an id picks one.
    expect(await h.bridge.open("ann", "ann-agent", "Desk")).toMatchObject({
      ok: true,
      connection: desk.connection,
    });
    expect(
      await h.bridge.open("ann", "ann-agent", "id-ann-laptop"),
    ).toMatchObject({ ok: true, connection: laptop.connection });
    // A browser that does not allow it, or that does not exist.
    desk.setting(null);
    for (const browser of ["Desk", "id-ann-desk", "Nowhere"])
      expect({
        browser,
        result: await h.bridge.open("ann", "ann-agent", browser),
      }).toMatchObject({
        browser,
        result: { ok: false, code: "invalid_request" },
      });
    expect(opens(desk)).toHaveLength(1);
  } finally {
    laptop.connection.close();
    desk.connection.close();
  }
});

test("two browsers with one name need the id", async () => {
  const h = bridgeOffice();
  const laptop = h.connect("ann-laptop");
  const twin = h.connect("ann-twin");
  try {
    laptop.setting("all");
    twin.setting("all");
    const listed = h.bridge.agentTabBrowsers("ann", "ann-agent");
    expect(listed.map((b) => [b.id, b.browser, b.member]).sort()).toEqual([
      ["id-ann-laptop", "Laptop", "ann"],
      ["id-ann-twin", "Laptop", "ann"],
    ]);
    expect(await h.bridge.open("ann", "ann-agent", "Laptop")).toMatchObject({
      ok: false,
      code: "browser_target_required",
    });
    expect(
      await h.bridge.open("ann", "ann-agent", "id-ann-twin"),
    ).toMatchObject({ ok: true, connection: twin.connection });
    expect(opens(laptop)).toEqual([]);
  } finally {
    laptop.connection.close();
    twin.connection.close();
  }
});

test("another member's browser opens a tab for an agent only when that member allows All agents and the agent names the browser", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  const bob = h.connect("bob-desk");
  try {
    // ann allows only her own agents: nothing for bob's agent.
    ann.setting("all");
    expect(h.bridge.agentTabBrowsers("bob", "bob-agent")).toEqual([]);
    expect(
      await h.bridge.open("bob", "bob-agent", "id-ann-laptop"),
    ).toMatchObject({ ok: false, code: "invalid_request" });
    ann.setting("office");
    // bob's own browser comes first; ann's is listed after it once bob's
    // allows it too.
    expect(h.bridge.agentTabBrowsers("bob", "bob-agent")).toEqual([
      { id: "id-ann-laptop", browser: "Laptop", member: "ann" },
    ]);
    bob.setting("all");
    expect(
      h.bridge.agentTabBrowsers("bob", "bob-agent").map((b) => b.member),
    ).toEqual(["bob", "ann"]);
    bob.setting(null);
    // Without a browser, open uses only the manager's browsers.
    expect(await h.bridge.open("bob", "bob-agent")).toMatchObject({
      ok: false,
      code: "agent_tabs_off",
    });
    expect(opens(ann)).toEqual([]);
    // Named: ann's browser opens it, via All agents.
    const named = await h.bridge.open("bob", "bob-agent", "id-ann-laptop");
    expect(named).toMatchObject({
      ok: true,
      connection: ann.connection,
      member: "ann",
    });
    expect(opens(ann)[0].params).toMatchObject({
      scope: { kind: "opened", agentId: "bob-agent", via: "office" },
    });
    // An agent ann cannot reach gets nothing from her browser.
    expect(h.bridge.agentTabBrowsers("bob", "far-agent")).toEqual([]);
    expect(
      await h.bridge.open("bob", "far-agent", "id-ann-laptop"),
    ).toMatchObject({ ok: false, code: "invalid_request" });
    // ann's own agent in her All agents browser opens via "all".
    await h.bridge.open("ann", "ann-agent");
    expect(opens(ann).at(-1)!.params).toMatchObject({
      scope: { kind: "opened", agentId: "ann-agent", via: "all" },
    });
  } finally {
    ann.connection.close();
    bob.connection.close();
  }
});

test("an open the extension refuses, or answers with a page that is not http(s) or about:blank, leaves no grant", async () => {
  const h = bridgeOffice();
  const laptop = h.connect("ann-laptop");
  try {
    laptop.setting("all");
    laptop.peer.opens = { reason: "agent_tabs_off" };
    expect(await h.bridge.open("ann", "ann-agent")).toMatchObject({
      ok: false,
      code: "agent_tabs_off",
    });
    for (const url of ["chrome://newtab/", "file:///etc/passwd", "data:,x"]) {
      laptop.peer.opens = { url };
      const result = await h.bridge.open("ann", "ann-agent");
      expect({ url, ok: result.ok }).toEqual({ url, ok: false });
      const grant = String(opens(laptop).at(-1)!.assignment);
      // The extension is told to end it, so it closes the tab it made.
      expect({ url, detached: detached(laptop, grant) }).toEqual({
        url,
        detached: true,
      });
    }
    expect(h.bridge.targets("ann", "ann-agent")).toEqual([]);
    // The enabling case: the same browser opens an http(s) answer.
    laptop.peer.opens = { url: "https://example.com/" };
    expect(await h.bridge.open("ann", "ann-agent")).toMatchObject({ ok: true });
  } finally {
    laptop.connection.close();
  }
});

test("a setting turned off while an open waits ends that open, and a late answer makes no grant", async () => {
  const h = bridgeOffice();
  const laptop = h.connect("ann-laptop");
  try {
    laptop.setting("all");
    laptop.peer.opens = "hold";
    const pending = h.bridge.open("ann", "ann-agent");
    await Promise.resolve();
    const [command] = opens(laptop);
    expect(command).toBeDefined();
    laptop.setting(null);
    expect(await pending).toMatchObject({ ok: false });
    expect(detached(laptop, String(command.assignment))).toBe(true);
    // The extension answers after all.
    laptop.connection.receive({
      kind: "result",
      generation: laptop.connection.generation,
      id: command.id,
      result: {
        targetInfo: {
          targetId: crypto.randomUUID(),
          type: "page",
          url: "about:blank",
        },
      },
    });
    await Promise.resolve();
    expect(h.bridge.targets("ann", "ann-agent")).toEqual([]);
    expect(laptop.peer.closed).toBe(false);
  } finally {
    laptop.connection.close();
  }
});

test("without a target, the agent's tabs come first: one opened tab is the default, and a second tab of its own needs a target", async () => {
  const h = bridgeOffice();
  const laptop = h.connect("ann-laptop");
  const desk = h.connect("ann-desk");
  try {
    // A shared offer alone is the default today.
    const shared = await offer(laptop, { kind: "all" });
    expect(h.bridge.resolve("ann", "ann-agent")?.grant).toBe(shared.assignment);
    desk.setting("all");
    const first = await h.bridge.open("ann", "ann-agent");
    if (!first.ok) throw new Error("open failed");
    // The opened tab outranks the shared offer.
    expect(h.bridge.ambiguous("ann", "ann-agent")).toBe(false);
    expect(h.bridge.resolve("ann", "ann-agent")).toMatchObject({
      connection: desk.connection,
      target: first.target,
    });
    // Its own individual offer beside the opened tab: two tabs of its own.
    const own = await offer(laptop, { kind: "agent", agentId: "ann-agent" });
    expect(own.answer?.error).toBeUndefined();
    expect(h.bridge.ambiguous("ann", "ann-agent")).toBe(true);
    expect(h.bridge.resolve("ann", "ann-agent")).toBeUndefined();
    // Each one by its target.
    expect(h.bridge.resolve("ann", "ann-agent", first.target)?.connection).toBe(
      desk.connection,
    );
    // Without the individual offer, a second opened tab is the same tie.
    laptop.connection.revoke(
      "ann-agent",
      h.bridge
        .targets("ann", "ann-agent")
        .find((t) => t.scope.kind === "agent")!.target,
    );
    expect(h.bridge.resolve("ann", "ann-agent")?.target).toBe(first.target);
    const second = await h.bridge.open("ann", "ann-agent", "Desk");
    if (!second.ok) throw new Error("open failed");
    expect(second.target).not.toBe(first.target);
    expect(h.bridge.ambiguous("ann", "ann-agent")).toBe(true);
    expect(h.bridge.resolve("ann", "ann-agent")).toBeUndefined();
    expect(h.bridge.resolve("ann", "ann-agent", second.target)?.target).toBe(
      second.target,
    );
  } finally {
    laptop.connection.close();
    desk.connection.close();
  }
});

test("an opened tab is seen and used only by the agent that opened it, also in an All agents browser", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  try {
    ann.setting("office");
    const mine = await h.bridge.open("ann", "ann-agent");
    const bobs = await h.bridge.open("bob", "bob-agent", "Laptop");
    if (!mine.ok || !bobs.ok) throw new Error("open failed");
    const handles = (manager: string | undefined, agent: string) =>
      h.bridge.targets(manager, agent).map((t) => t.target);
    expect(handles("ann", "ann-agent")).toEqual([mine.target]);
    expect(handles("bob", "bob-agent")).toEqual([bobs.target]);
    // Agents of the same manager, another member's agent, and an agent
    // with no manager see neither tab and cannot reach one by its handle.
    for (const [manager, agent] of [
      ["ann", "ann-helper"],
      [undefined, "orphan"],
      ["bob", "bob-agent"],
      ["ann", "ann-agent"],
    ] as const) {
      const foreign = agent === "ann-agent" ? bobs.target : mine.target;
      expect({
        agent,
        seen: handles(manager, agent).includes(foreign),
      }).toEqual({ agent, seen: false });
      expect({
        agent,
        resolved: h.bridge.resolve(manager, agent, foreign),
      }).toEqual({ agent, resolved: undefined });
      expect({ agent, grant: grantOf(ann, agent, foreign) }).toEqual({
        agent,
        grant: undefined,
      });
    }
    // An All agents offer of ann's is still shared beside them.
    const shared = await offer(ann, { kind: "office" });
    expect(handles(undefined, "orphan")).toHaveLength(1);
    expect(h.bridge.resolve(undefined, "orphan")?.grant).toBe(
      shared.assignment,
    );
  } finally {
    ann.connection.close();
  }
});

test("turning the setting off ends every opened tab; narrowing it ends the tabs opened via All agents; the member's offers stay", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  try {
    ann.setting("office");
    const own = await offer(ann, { kind: "agent", agentId: "ann-agent" });
    const mine = await h.bridge.open("ann", "ann-agent");
    const bobs = await h.bridge.open("bob", "bob-agent", "Laptop");
    if (!mine.ok || !bobs.ok) throw new Error("open failed");
    const mineGrant = grantOf(ann, "ann-agent", mine.target)!;
    const bobsGrant = grantOf(ann, "bob-agent", bobs.target)!;
    expect([mineGrant, bobsGrant].every(Boolean)).toBe(true);

    ann.setting("all");
    expect(detached(ann, bobsGrant)).toBe(true);
    expect(detached(ann, mineGrant)).toBe(false);
    expect(h.bridge.targets("bob", "bob-agent")).toEqual([]);

    ann.setting(null);
    expect(detached(ann, mineGrant)).toBe(true);
    // The member's setting ends the access only: the tabs stay open.
    expect([bobsGrant, mineGrant].map((g) => detachParams(ann, g))).toEqual([
      { close: false },
      { close: false },
    ]);
    expect(detached(ann, own.assignment)).toBe(false);
    expect(
      h.bridge.targets("ann", "ann-agent").map((t) => t.scope.kind),
    ).toEqual(["agent"]);
  } finally {
    ann.connection.close();
  }
});

test("an opened tab ends when its agent leaves the setting's audience, though an All agents offer survives the same revalidation", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  try {
    ann.setting("all");
    const mine = await h.bridge.open("ann", "ann-agent");
    if (!mine.ok) throw new Error("open failed");
    const mineGrant = grantOf(ann, "ann-agent", mine.target)!;
    // ann no longer manages ann-agent: under Only my agents its tab ends.
    h.manager["ann-agent"] = "bob";
    ann.connection.revalidate();
    expect(detached(ann, mineGrant)).toBe(true);
    expect(detachParams(ann, mineGrant)).toEqual({ close: false });
    h.manager["ann-agent"] = "ann";

    ann.setting("office");
    const bobs = await h.bridge.open("bob", "bob-agent", "Laptop");
    const shared = await offer(ann, { kind: "office" });
    if (!bobs.ok) throw new Error("open failed");
    const bobsGrant = grantOf(ann, "bob-agent", bobs.target)!;
    ann.connection.revalidate();
    expect(detached(ann, bobsGrant)).toBe(false);
    // ann leaves r1: bob's agent's tab ends; the shared offer stays for
    // when she comes back.
    h.rooms.ann.delete("r1");
    ann.connection.revalidate();
    expect(detached(ann, bobsGrant)).toBe(true);
    expect(detached(ann, shared.assignment)).toBe(false);
  } finally {
    ann.connection.close();
  }
});

test("an opened tab resumes after a connection loss only while the setting covers it, with no origin and no deadline", async () => {
  const h = bridgeOffice();
  const first = h.connect("ann-laptop");
  first.setting("all");
  const opened = await h.bridge.open("ann", "ann-agent");
  if (!opened.ok) throw new Error("open failed");
  const grant = grantOf(first, "ann-agent", opened.target)!;
  first.connection.close();

  // [name, setting, agent, via, extra offer fields]
  const refused: Array<
    [string, AgentTabsScope | null, string, AgentTabsScope, Fields]
  > = [
    ["setting off", null, "ann-agent", "all", {}],
    [
      "another member's agent, setting Only my agents",
      "all",
      "bob-agent",
      "office",
      {},
    ],
    [
      "with an origin",
      "all",
      "ann-agent",
      "all",
      { offerOrigin: "https://example.com" },
    ],
    [
      "a fresh opened offer",
      "all",
      "ann-agent",
      "all",
      { expiresAt: undefined },
    ],
    [
      "with a deadline",
      "all",
      "ann-agent",
      "all",
      { expiresAt: Date.now() + 60_000 },
    ],
  ];
  for (const [name, setting, agent, via, extra] of refused) {
    const b = h.connect("ann-laptop");
    try {
      b.setting(setting);
      const fresh = "expiresAt" in extra && extra.expiresAt === undefined;
      const r = fresh
        ? await offer(b, { kind: "opened", agentId: agent, via })
        : await resume(b, agent, via, undefined, extra);
      expect({ name, error: r.answer?.error }).toEqual({ name, error: true });
      expect({ name, closed: b.peer.closed }).toEqual({ name, closed: false });
      expect({ name, tabs: h.bridge.targets(h.manager[agent], agent) }).toEqual(
        {
          name,
          tabs: [],
        },
      );
    } finally {
      b.connection.close();
    }
  }
  // A resumed tab on a page that is not http(s) or about:blank ends.
  for (const url of ["chrome://settings/", "file:///etc/passwd"]) {
    const b = h.connect("ann-laptop");
    try {
      b.setting("all");
      const r = await resume(b, "ann-agent", "all", url);
      expect({ url, granted: h.bridge.targets("ann", "ann-agent") }).toEqual({
        url,
        granted: [],
      });
      expect({ url, detached: detached(b, r.assignment) }).toEqual({
        url,
        detached: true,
      });
    } finally {
      b.connection.close();
    }
  }
  // The enabling case: covered, with the same id, keeps its handle.
  const b = h.connect("ann-laptop");
  try {
    b.setting("all");
    const r = await resume(b, "ann-agent", "all", "about:blank", {}, grant);
    expect(r.answer?.error).toBeUndefined();
    expect(h.bridge.targets("ann", "ann-agent").map((t) => t.target)).toEqual([
      opened.target,
    ]);
  } finally {
    b.connection.close();
  }
});

test("an opened tab has no pinned origin: on an office page it is gated", async () => {
  const h = bridgeOffice();
  const b = h.connect("ann-laptop");
  try {
    b.setting("all");
    const r = await resume(b, "ann-agent", "all", `${OFFICE}/tasks`);
    expect(r.answer?.error).toBeUndefined();
    expect(b.connection.offerOrigin(r.assignment)).toBeUndefined();
    expect(b.connection.officeGated(r.assignment)).toBe(true);
    expect(h.bridge.targets("ann", "ann-agent")).toEqual([
      expect.objectContaining({ officePageRefused: true, url: "" }),
    ]);
    // A tab the member offers on the same page keeps its own office.
    const own = await offer(
      b,
      { kind: "agent", agentId: "ann-helper" },
      {},
      `${OFFICE}/tasks`,
    );
    expect(b.connection.officeGated(own.assignment)).toBe(false);
  } finally {
    b.connection.close();
  }
});

// Task 7355640c: one access setting per browser. Who sees the member's shared
// offer, and who may open a tab, for each value. A row lists the agents
// (with their managers) that see the offer and that may open a tab.
test("the access setting decides which agents see a shared offer and may open tabs; before any setting only the member's own agents see it", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  try {
    expect(ann.peer.messages.find((m) => m.kind === "ready")?.access).toBe(
      true,
    );
    const shared = await offer(ann, { kind: "shared" });
    expect(shared.answer).toBeDefined();
    expect(shared.answer?.error).toBeUndefined();
    const agents = [
      "ann-agent",
      "bob-agent",
      "far-agent",
      "carol-agent",
      "dan-agent",
      "orphan",
    ];
    const audience = () => ({
      see: agents.filter((agent) =>
        h.bridge
          .targets(h.manager[agent], agent)
          .some((t) => grantOf(ann, agent, t.target) === shared.assignment),
      ),
      open: agents.filter(
        (agent) =>
          h.bridge.agentTabBrowsers(h.manager[agent], agent).length > 0,
      ),
    });
    // No access message yet: the member's own agents, no opened tabs.
    expect(audience()).toEqual({ see: ["ann-agent"], open: [] });
    const rows: Array<[BrowserAccess, string[]]> = [
      // Picks stored under "mine" admit nobody else.
      [{ agents: "mine", members: ["bob"], openTabs: true }, ["ann-agent"]],
      [{ agents: "members", members: [], openTabs: true }, ["ann-agent"]],
      // bob's agent in ann's rooms; far-agent is bob's but out of her reach.
      [
        { agents: "members", members: ["bob"], openTabs: true },
        ["ann-agent", "bob-agent"],
      ],
      // dan's agent is out of reach: picking dan admits nothing.
      [
        { agents: "members", members: ["carol", "dan"], openTabs: true },
        ["ann-agent", "carol-agent"],
      ],
      [
        { agents: "office", members: [], openTabs: true },
        ["ann-agent", "bob-agent", "carol-agent", "orphan"],
      ],
    ];
    for (const [access, admitted] of rows) {
      ann.access(access);
      expect({ access, ...audience() }).toEqual({
        access,
        see: admitted,
        open: admitted,
      });
    }
    // openTabs off: nobody opens a tab; the shared offer keeps its audience.
    for (const [access, admitted] of rows) {
      ann.access({ ...access, openTabs: false });
      expect({ access, ...audience() }).toEqual({
        access,
        see: admitted,
        open: [],
      });
    }
  } finally {
    ann.connection.close();
  }
});

test("an agent of a picked member opens its own tab in the member's browser, and only it sees that tab", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  try {
    ann.access({ agents: "members", members: ["bob"], openTabs: true });
    const opened = await h.bridge.open("bob", "bob-agent", "Laptop");
    expect(opened).toMatchObject({ ok: true, connection: ann.connection });
    if (!opened.ok) throw new Error("open failed");
    expect(h.bridge.targets("bob", "bob-agent")).toEqual([
      expect.objectContaining({
        target: opened.target,
        scope: expect.objectContaining({
          kind: "opened",
          agentId: "bob-agent",
        }),
      }),
    ]);
    expect(h.bridge.targets("ann", "ann-agent")).toEqual([]);
    // carol is not picked.
    expect(await h.bridge.open("carol", "carol-agent", "Laptop")).toMatchObject(
      { ok: false },
    );
  } finally {
    ann.connection.close();
  }
});

// An action without a target: the agent's own opened tab comes before a
// shared offer, as before an All agents offer.
test("without a target, an agent's opened tab comes before a shared offer, and two shared offers need a target", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  try {
    ann.access({ agents: "mine", members: [], openTabs: true });
    const first = await offer(ann, { kind: "shared" });
    expect(h.bridge.resolve("ann", "ann-agent")?.grant).toBe(first.assignment);
    const opened = await h.bridge.open("ann", "ann-agent");
    if (!opened.ok) throw new Error("open failed");
    expect(h.bridge.resolve("ann", "ann-agent")?.grant).toBe(
      grantOf(ann, "ann-agent", opened.target),
    );
    // ann-helper has no tab of its own: two shared offers are ambiguous.
    await offer(ann, { kind: "shared" });
    expect(h.bridge.ambiguous("ann", "ann-helper")).toBe(true);
    expect(h.bridge.resolve("ann", "ann-helper")).toBeUndefined();
  } finally {
    ann.connection.close();
  }
});

// A page event of the tab, as the extension sends it.
const pageEvent = (b: Browser, assignment: string, method: string) =>
  b.connection.receive({
    kind: "event",
    generation: b.connection.generation,
    assignment,
    method,
    params: {},
  });
const got = (client: Wire, method: string) =>
  client.messages.some((m) => m.method === method);
// agent's live client on the shared offer, as an action holds it.
const attachClient = (b: Browser, agent: string, assignment: string) => {
  const client = wire();
  const target = b.connection
    .targets(agent)
    .find((t) => grantOf(b, agent, t.target) === assignment)?.target;
  expect({ agent, target: typeof target }).toEqual({
    agent,
    target: "string",
  });
  b.connection.assign(agent, client, true, target);
  return client;
};

test("narrowing the access ends the opened tabs and cuts the live clients of the agents it no longer admits; widening admits them again at once", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  try {
    ann.access({ agents: "members", members: ["bob"], openTabs: true });
    const sharedA = await offer(ann, { kind: "shared" });
    const sharedB = await offer(ann, { kind: "shared" });
    const mine = await h.bridge.open("ann", "ann-agent");
    const bobs = await h.bridge.open("bob", "bob-agent", "Laptop");
    if (!mine.ok || !bobs.ok) throw new Error("open failed");
    const mineGrant = grantOf(ann, "ann-agent", mine.target)!;
    const bobsGrant = grantOf(ann, "bob-agent", bobs.target)!;
    const bobClient = attachClient(ann, "bob-agent", sharedA.assignment);
    const annClient = attachClient(ann, "ann-agent", sharedB.assignment);
    // Both clients get their tab's events while the access admits them.
    pageEvent(ann, sharedA.assignment, "Page.loadEventFired");
    pageEvent(ann, sharedB.assignment, "Page.loadEventFired");
    expect([
      got(bobClient, "Page.loadEventFired"),
      got(annClient, "Page.loadEventFired"),
    ]).toEqual([true, true]);

    ann.access({ agents: "mine", members: ["bob"], openTabs: true });
    // bob's agent: its opened tab ends, its client is cut and gets no more
    // events; the shared offers stay.
    expect(detached(ann, bobsGrant)).toBe(true);
    expect(bobClient.closed).toBe(true);
    pageEvent(ann, sharedA.assignment, "Network.responseReceived");
    expect(got(bobClient, "Network.responseReceived")).toBe(false);
    expect(h.bridge.targets("bob", "bob-agent")).toEqual([]);
    // ann's agent: nothing changes.
    expect(detached(ann, mineGrant)).toBe(false);
    expect(annClient.closed).toBe(false);
    pageEvent(ann, sharedB.assignment, "Network.responseReceived");
    expect(got(annClient, "Network.responseReceived")).toBe(true);
    expect([sharedA, sharedB].map((s) => detached(ann, s.assignment))).toEqual([
      false,
      false,
    ]);

    // Widening again: bob's agent sees both shared offers at once.
    ann.access({ agents: "members", members: ["bob"], openTabs: true });
    expect(
      h.bridge
        .targets("bob", "bob-agent")
        .map((t) => grantOf(ann, "bob-agent", t.target))
        .sort(),
    ).toEqual([sharedA.assignment, sharedB.assignment].sort());

    // openTabs off ends ann's opened tab too; the shared offers stay.
    ann.access({ agents: "members", members: ["bob"], openTabs: false });
    expect(detached(ann, mineGrant)).toBe(true);
    expect([sharedA, sharedB].map((s) => detached(ann, s.assignment))).toEqual([
      false,
      false,
    ]);
  } finally {
    ann.connection.close();
  }
});

test("at revalidation, a live client on a shared or All agents offer is cut when its agent leaves the offer's audience; the offer stays", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  try {
    ann.access({ agents: "members", members: ["bob"], openTabs: false });
    const shared = await offer(ann, { kind: "shared" });
    const office = await offer(ann, { kind: "office" });
    const bobClient = attachClient(ann, "bob-agent", shared.assignment);
    const orphanClient = attachClient(ann, "orphan", office.assignment);
    // bob-agent moves to carol, who is not picked.
    h.manager["bob-agent"] = "carol";
    ann.connection.revalidate();
    expect([bobClient.closed, orphanClient.closed]).toEqual([true, false]);
    pageEvent(ann, shared.assignment, "Page.loadEventFired");
    expect(got(bobClient, "Page.loadEventFired")).toBe(false);
    // ann leaves r1, where orphan is.
    h.rooms.ann.delete("r1");
    ann.connection.revalidate();
    expect(orphanClient.closed).toBe(true);
    pageEvent(ann, office.assignment, "Page.loadEventFired");
    expect(got(orphanClient, "Page.loadEventFired")).toBe(false);
    expect([shared, office].map((s) => detached(ann, s.assignment))).toEqual([
      false,
      false,
    ]);
  } finally {
    ann.connection.close();
  }
});

test("the extension learns which members it may pick: those with an agent the member reaches, and every member already picked", () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  try {
    const members = () =>
      (
        (ann.peer.messages.findLast((m) => m.kind === "metadata")?.members ??
          []) as { id: string; name: string }[]
      )
        .map((m) => `${m.id}:${m.name}`)
        .sort();
    expect(members()).toEqual(["bob:bob", "carol:carol"]);
    // dan's only agent is out of ann's reach; the pick keeps him listed.
    ann.access({ agents: "members", members: ["dan"], openTabs: false });
    expect(members()).toEqual(["bob:bob", "carol:carol", "dan:dan"]);
    // Picks stored under "mine" stay listed too.
    ann.access({ agents: "mine", members: ["dan"], openTabs: false });
    expect(members()).toEqual(["bob:bob", "carol:carol", "dan:dan"]);
  } finally {
    ann.connection.close();
  }
});

test("an invalid access message closes the connection; one of an older generation changes nothing", async () => {
  const h = bridgeOffice();
  const ann = h.connect("ann-laptop");
  ann.access({ agents: "mine", members: [], openTabs: false });
  const shared = await offer(ann, { kind: "shared" });
  ann.connection.receive({
    kind: "access",
    generation: "old",
    access: { agents: "office", members: [], openTabs: true },
  });
  expect(h.bridge.targets(undefined, "orphan")).toEqual([]);
  expect(h.bridge.agentTabBrowsers("ann", "ann-agent")).toEqual([]);
  expect(ann.peer.closed).toBe(false);
  expect(detached(ann, shared.assignment)).toBe(false);
  ann.connection.receive({
    kind: "access",
    generation: ann.connection.generation,
    access: { agents: "everyone", members: [], openTabs: true },
  });
  expect(ann.peer.closed).toBe(true);
});

// The agent's side, through the service as the office runs it. Each browser
// connects with its hello, as a real extension does; the stand-in answers
// open commands with an about:blank tab.
function sessionOffice() {
  const o = office();
  const dir = mkdtempSync(join(tmpdir(), "browser-agent-tabs-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: o.mayUse,
    mayReach: o.mayReach,
    managerOf: (agent) => o.manager[agent],
    agents: () => Object.keys(o.manager),
    memberName: (member) => member[0].toUpperCase() + member.slice(1),
    agentName: (agent) => agent,
    officeOrigins: () => [OFFICE],
  });
  const sessions = new ExtensionBrowserSessions(
    service,
    (agent) => o.manager[agent],
    o.mayUse,
    () => 500,
  );
  const sockets: ServerWebSocket<ExtensionWsData>[] = [];
  const connect = (member: string, name: string, extra: Fields = {}) => {
    const messages: Fields[] = [];
    const ws = {
      data: { kind: "extension", origin } as ExtensionWsData,
      send(data: string) {
        const m = JSON.parse(data) as Fields;
        messages.push(m);
        // A mute answers with the state the extension set (task ded3ae49).
        if (m.kind === "command" && m.method === "mute")
          queueMicrotask(() =>
            service.message(
              typed,
              JSON.stringify({
                kind: "result",
                generation: typed.data.connection!.generation,
                id: m.id,
                result: { muted: (m.params as Fields).muted },
              }),
            ),
          );
        if (m.kind === "command" && m.method === "open")
          queueMicrotask(() =>
            service.message(
              typed,
              JSON.stringify({
                kind: "result",
                generation: typed.data.connection!.generation,
                id: m.id,
                result: {
                  targetInfo: {
                    targetId: crypto.randomUUID(),
                    type: "page",
                    url: "about:blank",
                  },
                },
              }),
            ),
          );
      },
      close: () => service.close(typed),
    };
    const typed = ws as unknown as ServerWebSocket<ExtensionWsData>;
    sockets.push(typed);
    service.open(typed);
    service.message(
      typed,
      JSON.stringify({
        kind: "hello",
        version: 4,
        code: store.pair(member, name).code,
        package: service.status(member).version,
        ...extra,
      }),
    );
    const connection = typed.data.connection as ExtensionConnection;
    expect(connection).toBeDefined();
    return {
      messages,
      connection,
      setting: (scope: AgentTabsScope | null) =>
        service.message(
          typed,
          JSON.stringify({
            kind: "agentTabs",
            generation: connection.generation,
            scope,
          }),
        ),
      access: (access: BrowserAccess) =>
        service.message(
          typed,
          JSON.stringify({
            kind: "access",
            generation: connection.generation,
            access,
          }),
        ),
      close: () => service.close(typed),
    };
  };
  type Answer = {
    ok: boolean;
    status?: number;
    code?: string;
    error: string;
    target?: string;
    browser?: string;
    member?: string;
    muted?: boolean;
    agentTabBrowsers?: { id: string; browser: string; member: string }[];
  };
  const run = async (agent: string, body: object) =>
    (await sessions.run(agent, body)) as unknown as Answer;
  return {
    ...o,
    store,
    service,
    sessions,
    connect,
    run,
    stop: () => {
      sessions.stop();
      service.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the office lists each online browser's agent tabs setting", () => {
  const h = sessionOffice();
  try {
    const laptop = h.connect("ann", "Laptop");
    h.connect("ann", "Desk");
    laptop.setting("office");
    const byName = () =>
      Object.fromEntries(
        h.service.status("ann").browsers.map((b) => [b.name, b.agentTabs]),
      );
    expect(byName()).toEqual({ Laptop: "office", Desk: null });
    laptop.close();
    expect(byName()).toEqual({ Laptop: null, Desk: null });
  } finally {
    h.stop();
  }
});

test("the office lists each online browser's access: whose agents may open tabs, and the members picked", () => {
  const h = sessionOffice();
  try {
    const laptop = h.connect("ann", "Laptop");
    const status = () => {
      const browser = h.service.status("ann").browsers[0];
      return { agentTabs: browser.agentTabs, members: browser.members };
    };
    const rows: Array<[BrowserAccess, ReturnType<typeof status>]> = [
      [
        { agents: "members", members: ["bob"], openTabs: true },
        { agentTabs: "members", members: [{ id: "bob", name: "Bob" }] },
      ],
      [
        { agents: "members", members: ["bob"], openTabs: false },
        { agentTabs: null, members: undefined },
      ],
      [
        { agents: "mine", members: ["bob"], openTabs: true },
        { agentTabs: "all", members: undefined },
      ],
      [
        { agents: "office", members: ["bob"], openTabs: true },
        { agentTabs: "office", members: undefined },
      ],
    ];
    for (const [access, expected] of rows) {
      laptop.access(access);
      expect({ access, status: status() }).toEqual({
        access,
        status: expected,
      });
    }
  } finally {
    h.stop();
  }
});

test("an agent with no tab learns where it may open one: tabs lists the browsers, also another member's", async () => {
  const h = sessionOffice();
  try {
    const ann = h.connect("ann", "Laptop");
    ann.setting("office");
    // bob has no browser: tabs still answers, with ann's browser to open in.
    const tabs = await h.run("bob-agent", { action: "tabs" });
    expect(tabs).toMatchObject({ ok: true, tabs: [] });
    expect(tabs.agentTabBrowsers).toEqual([
      { id: expect.any(String), browser: "Laptop", member: "Ann" },
    ]);
    expect(h.service.status("ann").browsers[0].id).toBe(
      tabs.agentTabBrowsers![0].id,
    );
    // ann narrows: nothing is left for bob's agent.
    ann.setting("all");
    expect(await h.run("bob-agent", { action: "tabs" })).toMatchObject({
      ok: false,
    });
  } finally {
    h.stop();
  }
});

test("open errors point the agent to the next step", async () => {
  const h = sessionOffice();
  try {
    const bobDesk = h.connect("bob", "Desk");
    const ann = h.connect("ann", "Laptop");
    // bob's browser is on, its setting off: agent_tabs_off, 409, no pointer
    // while no other browser allows it.
    const off = await h.run("bob-agent", {
      action: "open",
      url: "https://example.com/",
    });
    expect(off).toMatchObject({
      ok: false,
      status: 409,
      code: "agent_tabs_off",
    });
    expect(off.error).not.toContain("agentTabBrowsers");
    // ann allows All agents: the error points to agentTabBrowsers.
    ann.setting("office");
    const pointed = await h.run("bob-agent", {
      action: "open",
      url: "https://example.com/",
    });
    expect(pointed).toMatchObject({ ok: false, code: "agent_tabs_off" });
    expect(pointed.error).toContain("agentTabBrowsers");
    // bob's browser goes offline: browser_offline, with the same pointer.
    bobDesk.close();
    const offline = await h.run("bob-agent", {
      action: "open",
      url: "https://example.com/",
    });
    expect(offline).toMatchObject({ ok: false, code: "browser_offline" });
    expect(offline.error).toContain("agentTabBrowsers");
    // No open command went anywhere.
    expect(
      ann.messages.filter((m) => m.kind === "command" && m.method === "open"),
    ).toEqual([]);
  } finally {
    h.stop();
  }
});

test("agent_tabs_off on a browser whose extension is out of date names that browser", async () => {
  const h = sessionOffice();
  try {
    // A hello without a package: an extension older than 0.4.5.
    h.connect("ann", "Laptop", { package: undefined });
    const outdated = await h.run("ann-agent", {
      action: "open",
      url: "https://example.com/",
    });
    expect(outdated).toMatchObject({ ok: false, code: "agent_tabs_off" });
    expect(outdated.error).toContain("Laptop");
    const h2 = sessionOffice();
    try {
      h2.connect("ann", "Laptop");
      const current = await h2.run("ann-agent", {
        action: "open",
        url: "https://example.com/",
      });
      expect(current).toMatchObject({ ok: false, code: "agent_tabs_off" });
      expect(current.error).not.toBe(outdated.error);
    } finally {
      h2.stop();
    }
  } finally {
    h.stop();
  }
});

test("open to an office page is refused before a tab is made", async () => {
  const h = sessionOffice();
  try {
    const ann = h.connect("ann", "Laptop");
    ann.setting("all");
    expect(
      await h.run("ann-agent", { action: "open", url: `${OFFICE}/settings` }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "office_page_refused",
      error: expect.any(String),
    });
    expect(
      ann.messages.filter((m) => m.kind === "command" && m.method === "open"),
    ).toEqual([]);
  } finally {
    h.stop();
  }
});

test("the agent's close on an opened tab ends it and closes the tab", async () => {
  const h = sessionOffice();
  try {
    const ann = h.connect("ann", "Laptop");
    ann.setting("all");
    const opened = await h.service.bridge.open("ann", "ann-agent");
    if (!opened.ok) throw new Error("open failed");
    const grant = ann.connection.offered("ann-agent", opened.target)!;
    expect(grant).toBeString();
    expect(await h.run("ann-agent", { action: "close" })).toMatchObject({
      ok: true,
      closed: true,
    });
    expect(
      ann.messages.find(
        (m) =>
          m.kind === "command" &&
          m.method === "detach" &&
          m.assignment === grant,
      )?.params,
    ).toEqual({ close: true });
    expect(h.service.bridge.targets("ann", "ann-agent")).toEqual([]);
  } finally {
    h.stop();
  }
});

// Task ded3ae49: the agent mutes or unmutes its tab. An extension from before
// mute (0.7.3 and older) gets no mute command: it would end the grant's
// command with an unknown method.
const muteCommands = (messages: Fields[]) =>
  messages
    .filter((m) => m.kind === "command" && m.method === "mute")
    .map((m) => [m.assignment, m.params]);

test("mute asks the extension to mute or unmute the agent's tab, muted when left out, and answers the state", async () => {
  const h = sessionOffice();
  try {
    const ann = h.connect("ann", "Laptop");
    ann.setting("all");
    const opened = await h.service.bridge.open("ann", "ann-agent");
    if (!opened.ok) throw new Error("open failed");
    const grant = ann.connection.offered("ann-agent", opened.target)!;
    expect(grant).toBeString();
    expect(await h.run("ann-agent", { action: "mute" })).toMatchObject({
      ok: true,
      muted: true,
      target: opened.target,
    });
    expect(
      await h.run("ann-agent", {
        action: "mute",
        muted: false,
        target: opened.target,
      }),
    ).toMatchObject({ ok: true, muted: false, target: opened.target });
    expect(muteCommands(ann.messages)).toEqual([
      [grant, { muted: true }],
      [grant, { muted: false }],
    ]);
    // The tab stays the agent's.
    expect(h.service.bridge.targets("ann", "ann-agent")).toHaveLength(1);
  } finally {
    h.stop();
  }
});

test("mute on a browser whose extension is from before mute fails, names that browser, and sends no command", async () => {
  const h = sessionOffice();
  try {
    const ann = h.connect("ann", "Laptop", { package: "0.7.3" });
    ann.setting("all");
    const opened = await h.service.bridge.open("ann", "ann-agent");
    if (!opened.ok) throw new Error("open failed");
    // The enabling state: the agent holds the tab.
    expect(h.service.bridge.targets("ann", "ann-agent")).toHaveLength(1);
    const answer = await h.run("ann-agent", { action: "mute" });
    expect(answer).toMatchObject({ ok: false, code: "action_failed" });
    expect(answer.error).toContain("Laptop");
    expect(muteCommands(ann.messages)).toEqual([]);
    // The tab stays the agent's.
    expect(h.service.bridge.targets("ann", "ann-agent")).toHaveLength(1);
  } finally {
    h.stop();
  }
});
