import { describe, test, expect } from "bun:test";
import {
  BrowserExtensionBridge,
  browserCredentialHash,
} from "./browser-extension-bridge";
import {
  browserSocketURL,
  fields,
  type Fields,
} from "../shared/browser-extension-protocol";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";

function peer() {
  return {
    messages: [] as Fields[],
    closed: false,
    send(message: Fields) {
      this.messages.push(message);
    },
    close() {
      this.closed = true;
    },
  };
}
async function harness(retainGrant = false) {
  let authorized = true;
  const credential = "test-browser-credential";
  const extension = peer();
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: (hash) =>
      hash === browserCredentialHash(credential) && authorized
        ? "member"
        : undefined,
    mayUse: (member, agent) =>
      authorized &&
      member === "member" &&
      ["agent", "other-agent"].includes(agent),
  });
  const connection = bridge.connect(credential, extension);
  const client = peer();
  await offer(connection, extension.messages, "agent", "owned");
  const agent = connection.assign("agent", client, retainGrant);
  return {
    bridge,
    connection,
    client,
    agent,
    extension,
    credential,
    revoke: () => {
      authorized = false;
    },
  };
}
async function offer(connection: import("./browser-extension-bridge").ExtensionConnection, messages: Fields[], agent: string, targetId: string) {
  const assignment = crypto.randomUUID();
  connection.receive({ kind: "offer", durationMinutes: 0, generation: connection.generation, assignment, scope: { kind: "agent", agentId: agent } });
  const command = messages.at(-1)!;
  connection.receive({ kind: "result", generation: connection.generation, id: command.id,
    result: { targetInfo: { targetId, type: "page", url: "https://example.com/" } } });
  await Promise.resolve();
  return assignment;
}
async function create(h: Awaited<ReturnType<typeof harness>>) {
  await h.agent.receive({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
  const attached = h.client.messages.find((msg) => msg.method === "Target.attachedToTarget")!;
  return { sessionId: fields(attached.params).sessionId, assignment: h.connection.offered("agent")! };
}

describe("browser extension isolation", () => {
  test("real fixture socket requires the browser credential before assignment", async () => {
    const fixture = browserExtensionFixture();
    const ws = new WebSocket(fixture.extensionURL);
    const received: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () =>
          ws.send(
            JSON.stringify({ kind: "hello", version: 4, credential: "wrong" }),
          );
        ws.onmessage = (event) => received.push(String(event.data));
        ws.onclose = () => resolve();
        ws.onerror = () => reject(new Error("Fixture socket failed"));
      });
      expect(received).toHaveLength(0);
      expect(fixture.bridge.forMember("fixture-member")).toBeUndefined();
    } finally {
      ws.close();
      fixture.stop();
    }
  });
  test("structural transport URL checks", () => {
    for (const url of [
      "ws://127.0.0.1:123/extension",
      "ws://[::1]/extension",
      "ws://localhost/extension",
      "wss://office.example/extension",
    ])
      expect(browserSocketURL(url)).toBe(url);
    for (const url of [
      "ws://office.example/extension",
      "ws://127.0.0.1.evil.test/",
      "https://office.example/",
      "file:///tmp/x",
      "wss://user:secret@office.example/",
      "wss://office.example/?credential=x",
      "wss://office.example/#x",
    ])
      expect(() => browserSocketURL(url)).toThrow();
  });
  test("credential and member authorization gate assignment", async () => {
    const h = await harness();
    expect(() => h.bridge.connect("wrong", peer())).toThrow();
    expect(() => h.bridge.connect(h.credential, peer())).toThrow();
    expect(() => h.connection.assign("foreign-agent", peer())).toThrow();
    expect(() => h.connection.assign("agent", peer())).toThrow();
    h.connection.close();
  });
  test("target discovery filters and profile commands never leave the adapter", async () => {
    const h = await harness();
    const { sessionId } = await create(h);
    const before = h.extension.messages.length;
    await h.agent.receive({ id: 2, method: "Target.getTargets" });
    expect(fields(h.client.messages.at(-1)!.result).targetInfos).toEqual([
      { targetId: "owned", type: "page", url: "https://example.com/" },
    ]);
    const rejected = [
      { method: "Target.createTarget", params: { url: "about:blank" } },
      { method: "Target.getTargetInfo", params: { targetId: "foreign" } },
      { method: "Target.attachToTarget", params: { targetId: "foreign" } },
      { method: "Target.createBrowserContext" },
      { method: "Storage.getCookies" },
      { method: "Browser.close" },
      { method: "Runtime.evaluate", sessionId: "foreign" },
      { method: "Network.getAllCookies", sessionId },
      { method: "Storage.clearDataForOrigin", sessionId },
      { method: "Target.getTargets", sessionId },
    ];
    for (const command of rejected) {
      await h.agent.receive({ id: 3, ...command });
      expect(h.client.messages.at(-1)!.error).toBeDefined();
    }
    expect(h.extension.messages.length).toBe(before);
    h.connection.close();
  });
  test("cross-agent session and event routing stays assigned", async () => {
    const h = await harness();
    const { sessionId, assignment } = await create(h);
    const other = peer();
    await offer(h.connection, h.extension.messages, "other-agent", "other-owned");
    const otherAgent = h.connection.assign("other-agent", other);
    await otherAgent.receive({ id: 1, method: "Runtime.evaluate", sessionId });
    expect(other.messages.at(-1)!.error).toBeDefined();
    const count = h.client.messages.length;
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment: "foreign",
      method: "Runtime.consoleAPICalled",
      params: {},
    });
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment,
      sessionId: "foreign",
      method: "Runtime.consoleAPICalled",
      params: {},
    });
    expect(h.client.messages.length).toBe(count);
    h.connection.close();
  });
  test("disconnect rejects pending work and old generations cannot replay", async () => {
    const h = await harness();
    const { sessionId } = await create(h);
    const work = h.agent.receive({
      id: 5,
      method: "Runtime.evaluate",
      sessionId,
      params: { expression: "sideEffect()" },
    });
    const sent = h.extension.messages.at(-1)!;
    expect(sent.method).toBe("cdp");
    h.connection.close();
    await work;
    expect(h.client.closed).toBe(true);
    const count = h.extension.messages.length;
    await h.agent.receive({
      id: 6,
      method: "Runtime.evaluate",
      sessionId,
      params: {},
    });
    expect(h.extension.messages.length).toBe(count);
    const nextPeer = peer();
    const fresh = h.bridge.connect(h.credential, nextPeer);
    const assignment = crypto.randomUUID();
    fresh.receive({ kind: "offer", durationMinutes: 0, generation: fresh.generation, assignment, scope: { kind: "agent", agentId: "agent" } });
    const freshSent = nextPeer.messages.at(-1)!;
    fresh.receive({ kind: "result", generation: h.connection.generation, id: freshSent.id,
      result: { targetInfo: { targetId: "old", type: "page", url: "https://example.com/" } } });
    await Promise.resolve();
    expect(fresh.offered("agent")).toBeUndefined();
    expect(() => fresh.assign("agent", peer())).toThrow();
    expect(nextPeer.messages.filter((msg) => msg.method === "cdp")).toHaveLength(0);
    fresh.close();
  });
  test("authorization is rechecked before dispatch", async () => {
    const h = await harness();
    const { sessionId } = await create(h);
    h.revoke();
    await h.agent.receive({ id: 8, method: "Runtime.evaluate", sessionId });
    expect(h.client.closed).toBe(true);
    expect(h.extension.messages.at(-1)!.method).toBe("detach");
    h.connection.close();
  });
  test("release and malformed responses settle in-flight work", async () => {
    for (const action of ["release", "malformed"]) {
      const h = await harness();
      const { sessionId } = await create(h);
      const work = h.agent.receive({
        id: 5,
        method: "Runtime.evaluate",
        sessionId,
        params: {},
      });
      if (action === "release") h.agent.close();
      else
        h.connection.receive({
          kind: "result",
          generation: h.connection.generation,
          id: h.extension.messages.at(-1)!.id,
          result: null,
        });
      await work;
      expect(h.client.closed).toBe(true);
      h.connection.close();
    }
  });
  test("a child target cannot claim another assignment's target", async () => {
    const h = await harness();
    const { assignment } = await create(h);
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment,
      method: "Target.attachedToTarget",
      params: {
        sessionId: "child",
        targetInfo: { targetId: "owned", type: "iframe" },
      },
    });
    expect(h.client.closed).toBe(true);
    h.connection.close();
  });
});

test("owned popup chain is visible only to its assignment and rejects a foreign opener", async () => {
  const h = await harness();
  const { assignment } = await create(h);
  const other = peer();
  await offer(h.connection, h.extension.messages, "other-agent", "other-owned");
  const otherAssignment = h.connection.assign("other-agent", other);
  h.connection.receive({
    kind: "event",
    generation: h.connection.generation,
    assignment,
    method: "popup",
    params: {
      sessionId: "popup-session",
      targetInfo: { type: "page", targetId: "popup", openerId: "owned" },
    },
  });
  expect(
    h.client.messages.some(
      (m) =>
        m.method === "Target.attachedToTarget" &&
        fields(m.params).sessionId === "popup-session",
    ),
  ).toBe(true);
  await otherAssignment.receive({
    id: 20,
    method: "Target.getTargets",
    params: {},
  });
  expect(fields(other.messages.at(-1)!.result).targetInfos).toEqual([{ targetId: "other-owned", type: "page", url: "https://example.com/" }]);
  h.connection.receive({
    kind: "event",
    generation: h.connection.generation,
    assignment,
    method: "popupDetached",
    params: { sessionId: "popup-session" },
  });
  expect(h.client.messages.at(-1)!.method).toBe("Target.detachedFromTarget");
  h.connection.receive({
    kind: "event",
    generation: h.connection.generation,
    assignment,
    method: "popup",
    params: {
      sessionId: "foreign-session",
      targetInfo: {
        type: "page",
        targetId: "foreign-popup",
        openerId: "foreign-tab",
      },
    },
  });
  expect(h.extension.closed).toBe(true);
  expect(
    h.client.messages.some(
      (m) =>
        m.method === "Target.attachedToTarget" &&
        fields(m.params).sessionId === "foreign-session",
    ),
  ).toBe(false);
});

test("active authorization loss rejects pending work before a result is delivered", async () => {
  const h = await harness();
  const { sessionId } = await create(h);
  const work = h.agent.receive({
    id: 4,
    sessionId,
    method: "Runtime.evaluate",
    params: { expression: "1" },
  });
  const sent = h.extension.messages.at(-1)!;
  expect(sent.method).toBe("cdp");
  h.revoke();
  h.connection.revalidate();
  expect(h.client.closed).toBe(true);
  h.connection.receive({
    kind: "result",
    generation: h.connection.generation,
    id: sent.id,
    result: { result: { value: 1 } },
  });
  await work;
  expect(
    h.client.messages.some((message) => message.id === 4 && message.result),
  ).toBe(false);
  h.connection.close();
});

for (const outcome of ["off", "access", "error", "invalid-target", "disconnect"] as const) {
  test(`provisional offer cannot bind after ${outcome}`, async () => {
    const h = await harness();
    h.connection.revoke("agent");
    const assignment = crypto.randomUUID();
    h.connection.receive({ kind: "offer", durationMinutes: 0, generation: h.connection.generation, assignment, scope: { kind: "agent", agentId: "agent" } });
    const pending = h.extension.messages.at(-1)!;
    expect(pending.method).toBe("attach");
    expect(() => h.connection.assign("agent", peer())).toThrow();
    if (outcome === "off") h.connection.receive({ kind: "event", generation: h.connection.generation, assignment, method: "detached", params: {} });
    if (outcome === "access") h.revoke();
    if (outcome === "disconnect") h.connection.close();
    h.connection.receive({ kind: "result", generation: h.connection.generation, id: pending.id,
      ...(outcome === "error" ? { error: true } : { result: { targetInfo: { type: "page", targetId: "late", url: outcome === "invalid-target" ? "chrome://settings" : "https://example.com/" } } }) });
    await Promise.resolve(); await Promise.resolve();
    expect(h.connection.offered("agent")).toBeUndefined();
    expect(() => h.connection.assign("agent", peer())).toThrow();
    h.connection.close();
  });
}

test("offer rechecks access and reserves one agent before attachment completes", async () => {
  const h = await harness();
  h.connection.revoke("agent");
  const send = (agent: string) => h.connection.receive({ kind: "offer", durationMinutes: 0, generation: h.connection.generation, assignment: crypto.randomUUID(), scope: { kind: "agent", agentId: agent } });
  send("foreign-agent");
  expect(h.extension.messages.at(-1)!.error).toBe(true);
  send("agent");
  const count = h.extension.messages.filter(m => m.method === "attach").length;
  send("agent");
  expect(h.extension.messages.at(-1)!.error).toBe(true);
  expect(h.extension.messages.filter(m => m.method === "attach")).toHaveLength(count);
  h.connection.close();
});

function expiryHarness() {
  let now = 1_800_000_000_000;
  const timers: Array<{ callback: () => void; at: number; cancelled: boolean }> = [];
  const extension = peer();
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: () => "member", mayUse: () => true,
    memberDisplay: () => ({ id: "member", name: "Member" }),
    agentDisplay: id => ({ id, name: id }), agents: () => ["agent"],
  }, {
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer = { callback, at: now + delayMs, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  const connection = bridge.connect("credential", extension);
  const start = (durationMinutes: unknown, assignment = crypto.randomUUID()) => {
    connection.receive({ kind: "offer", generation: connection.generation, assignment, scope: { kind: "agent", agentId: "agent" }, durationMinutes });
    return assignment;
  };
  const accept = async () => {
    const attach = extension.messages.findLast(m => m.method === "attach")!;
    connection.receive({ kind: "result", generation: connection.generation, id: attach.id,
      result: { targetInfo: { targetId: crypto.randomUUID(), type: "page", url: "https://example.com/" } } });
    await Promise.resolve();
    return extension.messages.findLast(m => m.kind === "offered")!;
  };
  return { connection, extension, timers, start, accept, now: () => now,
    advance: (ms: number, fire = true) => {
      now += ms;
      if (fire) for (const timer of [...timers]) if (!timer.cancelled && timer.at <= now) timer.callback();
    } };
}

test("grant deadline starts after attachment, expires before any action and cannot revoke a replacement", async () => {
  const h = expiryHarness();
  try {
    const original = h.start(15);
    h.advance(5 * 60_000);
    expect(h.timers).toHaveLength(0);
    const ack = await h.accept();
    expect(ack).toMatchObject({ assignment: original, durationMinutes: 15, expiresAt: h.now() + 15 * 60_000 });
    expect(h.connection.offered("agent")).toBe(original);
    expect(h.timers).toHaveLength(1);
    const oldTimer = h.timers[0];
    h.advance(15 * 60_000);
    expect(h.connection.offered("agent")).toBeUndefined();
    expect(h.extension.messages).toContainEqual(expect.objectContaining({ method: "detach", assignment: original }));
    expect(oldTimer.cancelled).toBe(true);
    const replacement = h.start(0);
    await h.accept();
    expect(replacement).not.toBe(original);
    expect(h.connection.offered("agent")).toBe(replacement);
    oldTimer.callback();
    h.advance(4 * 60 * 60_000);
    expect(h.connection.offered("agent")).toBe(replacement);
    expect(h.timers).toHaveLength(1);
    expect(h.extension.messages.findLast(m => m.kind === "metadata")?.assignments).toMatchObject([
      { id: replacement, durationMinutes: 0, expiresAt: null },
    ]);
  } finally { h.connection.close(); }
});

test("actions do not extend a grant; deadline interrupts held commands without replay", async () => {
  const h = expiryHarness();
  try {
    const id = h.start(60);
    const ack = await h.accept();
    const client = peer();
    const agent = h.connection.assign("agent", client);
    await agent.receive({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    const sessionId = fields(client.messages.find(m => m.method === "Target.attachedToTarget")!.params).sessionId;
    h.advance(30 * 60_000);
    const pending = agent.receive({ id: 2, sessionId, method: "Runtime.evaluate", params: { expression: "1" } });
    const command = h.extension.messages.findLast(m => m.method === "cdp")!;
    expect(fields(command.params).method).toBe("Runtime.evaluate");
    expect(command.assignment).toBe(id);
    expect(h.connection.offered("agent")).toBe(id);
    h.connection.sendMetadata();
    expect(h.extension.messages.findLast(m => m.kind === "metadata")?.assignments).toMatchObject([{ expiresAt: ack.expiresAt }]);
    expect(h.timers).toHaveLength(1);
    h.advance(30 * 60_000);
    await pending;
    expect(client.closed).toBe(true);
    expect(client.messages.find(m => m.id === 2)).toBeUndefined();
    expect(h.connection.offered("agent")).toBeUndefined();
    const replacement = h.start(15);
    await h.accept();
    expect(replacement).not.toBe(id);
    h.connection.receive({ kind: "result", generation: h.connection.generation, id: command.id, result: {} });
    expect(h.connection.offered("agent")).toBe(replacement);
    expect(h.extension.messages.filter(m => m.method === "cdp")).toHaveLength(1);
  } finally { h.connection.close(); }
});

test("ownership checks enforce elapsed deadlines even before the timer callback runs", async () => {
  for (const boundary of ["offered", "assign", "command", "revalidate"] as const) {
    const h = expiryHarness();
    try {
      h.start(15); await h.accept();
      const client = peer();
      const agent = boundary === "command" ? h.connection.assign("agent", client) : undefined;
      h.advance(15 * 60_000, false);
      if (boundary === "assign") expect(() => h.connection.assign("agent", client)).toThrow();
      else if (boundary === "command") await agent!.receive({ id: 1, method: "Browser.getVersion" });
      else if (boundary === "revalidate") h.connection.revalidate();
      else expect(h.connection.offered("agent")).toBeUndefined();
      expect(h.timers[0].cancelled).toBe(true);
      expect(h.connection.offered("agent")).toBeUndefined();
    } finally { h.connection.close(); }
  }
});

test("offer rejects missing or non-member durations without attaching", () => {
  for (const value of [undefined, null, "15", -1, 1, 15.5, Infinity, NaN]) {
    const h = expiryHarness();
    try {
      h.start(value);
      expect(h.extension.closed).toBe(true);
      expect(h.extension.messages.some(m => m.method === "attach")).toBe(false);
    } finally { h.connection.close(); }
  }
});

test("a result arriving after expiry releases only its grant when the timer is delayed", async () => {
  const h = expiryHarness();
  try {
    h.start(15); await h.accept();
    const client = peer();
    const agent = h.connection.assign("agent", client);
    await agent.receive({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    const sessionId = fields(client.messages.find(m => m.method === "Target.attachedToTarget")!.params).sessionId;
    const pending = agent.receive({ id: 2, sessionId, method: "Runtime.evaluate", params: { expression: "1" } });
    const command = h.extension.messages.findLast(m => m.method === "cdp")!;
    expect(command).toBeDefined();
    const other = crypto.randomUUID();
    h.connection.receive({ kind: "offer", generation: h.connection.generation, assignment: other, scope: { kind: "agent", agentId: "other" }, durationMinutes: 0 });
    await h.accept();
    expect(h.connection.offered("other")).toBe(other);
    h.advance(15 * 60_000, false);
    h.connection.receive({ kind: "result", generation: h.connection.generation, id: command.id, result: {} });
    await pending;
    expect(client.closed).toBe(true);
    expect(client.messages.find(m => m.id === 2)).toBeUndefined();
    expect(h.extension.closed).toBe(false);
    expect(h.connection.offered("other")).toBe(other);
  } finally { h.connection.close(); }
});

test("timed-out CDP keeps a settlement tombstone and the offered grant", async () => {
  const h = await harness();
  const { sessionId, assignment } = await create(h);
  const native = globalThis.setTimeout;
  let expire!: () => void;
  // Only accelerate the real bridge command timeout, not a separate test clock.
  const spy = (await import("bun:test")).spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    if (ms === 30_000) expire = callback;
    return native(callback, ms);
  }) as typeof setTimeout);
  try {
    const action = h.agent.receive({ id: 9, sessionId, method: "Input.insertText", params: { text: "fixture" } });
    const command = h.extension.messages.at(-1)!;
    expect(command.method).toBe("cdp");
    expect(h.connection.pendingCount(assignment)).toBe(1);
    expire(); await action;
    expect(h.connection.pendingTimedOut(assignment)).toBe(true);
    expect(h.connection.offered("agent")).toBe(assignment);
    expect(h.extension.closed).toBe(false);
    let settled = false;
    const drained = h.connection.drain(assignment).then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    const replies = h.client.messages.filter(m => m.id === 9).length;
    h.connection.receive({ kind: "result", generation: h.connection.generation, id: command.id, result: {} });
    await drained;
    expect(h.connection.pendingCount(assignment)).toBe(0);
    expect(h.client.messages.filter(m => m.id === 9)).toHaveLength(replies);
    expect(h.extension.messages.filter(m => m.method === "cdp")).toHaveLength(1);
  } finally { spy.mockRestore(); h.connection.close(); }
});

test("navigation stop is assignment-scoped and foreign page sessions remain refused", async () => {
  const h = await harness();
  const { assignment } = await create(h);
  try {
    const before = h.extension.messages.length;
    await h.agent.receive({ id: 8, sessionId: "foreign", method: "Page.stopLoading", params: {} });
    expect(h.extension.messages).toHaveLength(before);
    expect(h.client.messages.at(-1)?.error).toBeDefined();
    expect(await h.connection.stopLoading("foreign").then(() => false, () => true)).toBe(true);
    const stopped = h.connection.stopLoading(assignment);
    const command = h.extension.messages.at(-1)!;
    expect(command).toMatchObject({ assignment, method: "cdp", params: { method: "Page.stopLoading" } });
    h.connection.receive({ kind: "result", generation: h.connection.generation, id: command.id, result: {} });
    await stopped;
    expect(h.connection.offered("agent")).toBe(assignment);
  } finally { h.connection.close(); }
});

test("retired client cannot release a replacement client or deliver its old reply", async () => {
  const h = await harness(true);
  const { sessionId, assignment } = await create(h);
  try {
    const action = h.agent.receive({ id: 9, sessionId, method: "Runtime.evaluate", params: { expression: "1" } });
    const command = h.extension.messages.at(-1)!;
    h.agent.close();
    expect(h.connection.offered("agent")).toBe(assignment);
    const nextPeer = peer();
    expect(() => h.connection.assign("agent", nextPeer, true)).toThrow();
    h.connection.receive({ kind: "result", generation: h.connection.generation, id: command.id, result: {} });
    const next = h.connection.assign("agent", nextPeer, true);
    await action;
    expect(nextPeer.messages.some(m => m.id === 9)).toBe(false);
    h.agent.close();
    await next.receive({ id: 10, method: "Target.setAutoAttach", params: { autoAttach: true } });
    expect(nextPeer.messages.some(m => m.method === "Target.attachedToTarget")).toBe(true);
    expect(h.connection.offered("agent")).toBe(assignment);
    expect(h.extension.messages.some(m => m.method === "detach")).toBe(false);
  } finally { h.connection.close(); }
});

test("All discovery and explicit targets preserve precedence, access and grant identity", async () => {
  const allowed = new Set(["a", "b"]);
  const wire = peer();
  const bridge = new BrowserExtensionBridge({ memberForCredentialHash: () => "m", mayUse: (_m, agent) => allowed.has(agent) });
  const c = bridge.connect("fixture", wire);
  const add = async (scope: { kind: "all" } | { kind: "agent"; agentId: string }) => {
    const id = crypto.randomUUID();
    c.receive({ kind: "offer", generation: c.generation, assignment: id, scope, durationMinutes: 0 });
    const attach = wire.messages.at(-1)!;
    expect(attach.method).toBe("attach");
    c.receive({ kind: "result", generation: c.generation, id: attach.id,
      result: { targetInfo: { type: "page", targetId: crypto.randomUUID(), url: "https://example.com/", title: "Fixture" } } });
    await Promise.resolve(); return id;
  };
  try {
    const one = await add({ kind: "all" });
    expect(c.offered("a")).toBe(one); expect(c.offered("b")).toBe(one);
    const first = c.targets("a")[0].target;
    expect(first).not.toBe(one);
    await add({ kind: "all" });
    expect(c.ambiguous("a")).toBe(true); expect(c.offered("a")).toBeUndefined();
    expect(c.offered("a", first)).toBe(one);
    const individual = await add({ kind: "agent", agentId: "a" });
    expect(c.offered("a")).toBe(individual); expect(c.ambiguous("a")).toBe(false);
    expect(c.targets("a")).toHaveLength(3); expect(c.targets("b")).toHaveLength(2);
    const own = c.targets("a").find(t => t.scope.kind === "agent")!.target;
    expect(c.offered("b", own)).toBeUndefined();
    c.revoke("a");
    expect(c.ambiguous("a")).toBe(true);
    expect(c.offered("a", own)).toBeUndefined();
    const replacement = await add({ kind: "agent", agentId: "a" });
    expect(c.offered("a")).toBe(replacement);
    expect(c.offered("a", own)).toBeUndefined();
    allowed.delete("a"); c.revalidate();
    expect(c.targets("a")).toEqual([]); expect(c.targets("foreign")).toEqual([]);
    expect(c.offered("b", first)).toBe(one);
    c.revoke("b", first); expect(c.offered("b", first)).toBeUndefined();
  } finally { c.close(); }
});

test("All client epochs bind each command to its actor and ignore retired peer traffic", async () => {
  const allowed = new Set(["a", "b"]), checks: string[] = [];
  const wire = peer();
  const bridge = new BrowserExtensionBridge({ memberForCredentialHash: () => "m", mayUse: (_m, actor) => { checks.push(actor); return allowed.has(actor); } });
  const c = bridge.connect("fixture", wire);
  const id = crypto.randomUUID();
  c.receive({ kind: "offer", generation: c.generation, assignment: id, scope: { kind: "all" }, durationMinutes: 0 });
  c.receive({ kind: "result", generation: c.generation, id: wire.messages.at(-1)!.id, result: { targetInfo: { type: "page", targetId: "root", url: "https://example.com/" } } });
  await Promise.resolve();
  try {
    const handle = c.targets("a")[0].target;
    c.receive({ kind: "event", generation: c.generation, assignment: id, method: "popup", params: {
      sessionId: "popup-session", targetInfo: { type: "page", targetId: "popup", openerId: "root", title: "Popup", url: "https://example.com/popup" } } });
    expect(c.targets("b")).toEqual([{ target: handle, scope: { kind: "all" }, title: "Popup", url: "https://example.com/popup" }]);
    c.receive({ kind: "event", generation: c.generation, assignment: id, method: "popupDetached", params: { sessionId: "popup-session" } });
    expect(c.targets("b")[0].target).toBe(handle);
    expect(c.targets("b")).toHaveLength(1);
    const a = peer(), b = peer();
    const old = c.assign("a", a, true);
    await old.receive({ id: 1, method: "Target.setAutoAttach", params: {} });
    const sessionId = fields(a.messages.find(m => m.method === "Target.attachedToTarget")!.params).sessionId;
    checks.length = 0;
    const pending = old.receive({ id: 2, method: "Input.insertText", sessionId, params: { text: "fixture" } });
    const command = wire.messages.at(-1)!;
    expect(command.method).toBe("cdp"); expect(checks).toEqual(["a"]);
    allowed.delete("a");
    c.receive({ kind: "result", generation: c.generation, id: command.id, result: {} });
    await pending;
    expect(checks).toEqual(["a", "a"]);
    expect(a.messages.at(-1)).toHaveProperty("error");
    expect(c.offered("b")).toBe(id);
    old.close();
    const current = c.assign("b", b, true);
    await current.receive({ id: 3, method: "Target.setAutoAttach", params: {} });
    const count = wire.messages.length, responses = b.messages.length;
    checks.length = 0;
    allowed.add("a"); // Authorization alone cannot reject a retired peer.
    const late = old.receive({ id: 4, method: "Input.insertText", sessionId, params: { text: "stale" } });
    await Promise.resolve();
    const afterLate = wire.messages.length;
    // Settle even a wrong implementation before asserting, avoiding a timeout.
    if (afterLate > count) c.receive({ kind: "result", generation: c.generation, id: wire.messages.at(-1)!.id, result: {} });
    await late;
    expect(afterLate).toBe(count);
    old.close();
    c.receive({ kind: "result", generation: c.generation, id: command.id, result: {} });
    expect(wire.messages).toHaveLength(count); expect(b.messages).toHaveLength(responses); expect(checks).toEqual([]);
    const next = current.receive({ id: 5, method: "Runtime.evaluate", sessionId, params: { expression: "1" } });
    expect(checks).toEqual(["b"]);
    c.receive({ kind: "result", generation: c.generation, id: wire.messages.at(-1)!.id, result: {} });
    await next;
    expect(checks).toEqual(["b", "b"]);
    expect(b.messages.at(-1)).toMatchObject({ id: 5, result: {} });
    expect(wire.messages.filter(m => m.method === "cdp")).toHaveLength(2);
  } finally { c.close(); }
});

test("All timed expiry releases every caller before first action and Never has no timer", async () => {
  let now = 1_800_000_000_000;
  const timers: (() => void)[] = [];
  const wire = peer();
  const bridge = new BrowserExtensionBridge({ memberForCredentialHash: () => "m", mayUse: () => true },
    { now: () => now, schedule: callback => { timers.push(callback); return () => {}; } });
  const c = bridge.connect("fixture", wire);
  const add = async (durationMinutes: number) => {
    const assignment = crypto.randomUUID();
    c.receive({ kind: "offer", generation: c.generation, assignment, durationMinutes, scope: { kind: "all" } });
    c.receive({ kind: "result", generation: c.generation, id: wire.messages.at(-1)!.id,
      result: { targetInfo: { targetId: crypto.randomUUID(), type: "page", url: "https://example.com/" } } });
    await Promise.resolve(); return assignment;
  };
  try {
    const timed = await add(15);
    expect(c.offered("a")).toBe(timed); expect(c.offered("b")).toBe(timed);
    expect(timers).toHaveLength(1);
    now += 15 * 60_000; timers[0]();
    expect(c.offered("a")).toBeUndefined(); expect(c.offered("b")).toBeUndefined();
    expect(wire.messages.filter(m => m.method === "detach")).toHaveLength(1);
    const never = await add(0); now += 24 * 60 * 60_000;
    expect(timers).toHaveLength(1); timers[0]();
    expect(c.offered("a")).toBe(never); expect(c.offered("b")).toBe(never);
  } finally { c.close(); }
});
