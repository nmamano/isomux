import { describe, test, expect, spyOn } from "bun:test";
import {
  BrowserExtensionBridge,
  browserCredentialHash,
  captureKickDelay,
} from "./browser-extension-bridge";
import {
  BROWSER_REATTACH_MS,
  browserSocketURL,
  fields,
  type Fields,
} from "../shared/browser-extension-protocol";

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
async function harness(
  retainGrant = false,
  clock?: ConstructorParameters<typeof BrowserExtensionBridge>[1],
) {
  let authorized = true;
  const credential = "test-browser-credential";
  const extension = peer();
  const bridge = new BrowserExtensionBridge(
    {
      memberForCredentialHash: (hash) =>
        hash === browserCredentialHash(credential) && authorized
          ? "member"
          : undefined,
      mayUse: (member, agent) =>
        authorized &&
        member === "member" &&
        ["agent", "other-agent"].includes(agent),
    },
    clock,
  );
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
async function offer(
  connection: import("./browser-extension-bridge").ExtensionConnection,
  messages: Fields[],
  agent: string,
  targetId: string,
  url = "https://example.com/",
) {
  const assignment = crypto.randomUUID();
  connection.receive({
    kind: "offer",
    durationMinutes: 0,
    generation: connection.generation,
    assignment,
    scope: { kind: "agent", agentId: agent },
  });
  const command = messages.at(-1)!;
  connection.receive({
    kind: "result",
    generation: connection.generation,
    id: command.id,
    result: {
      targetInfo: { targetId, type: "page", url },
    },
  });
  await Promise.resolve();
  return assignment;
}
async function create(h: Awaited<ReturnType<typeof harness>>) {
  await h.agent.receive({
    id: 1,
    method: "Target.setAutoAttach",
    params: { autoAttach: true },
  });
  const attached = h.client.messages.find(
    (msg) => msg.method === "Target.attachedToTarget",
  )!;
  return {
    sessionId: fields(attached.params).sessionId,
    assignment: h.connection.offered("agent")!,
  };
}

describe("browser extension isolation", () => {
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
    await offer(
      h.connection,
      h.extension.messages,
      "other-agent",
      "other-owned",
    );
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
  test("frame owner lookup uses only the authorized page session", async () => {
    const h = await harness();
    try {
      const { sessionId } = await create(h);
      const before = h.extension.messages.length;
      for (const command of [
        { sessionId: "foreign", params: { frameId: "child" } },
        { sessionId, params: { frameId: "child", targetId: "foreign" } },
        { sessionId, params: { frameId: "" } },
        { sessionId, params: {} },
      ]) {
        await h.agent.receive({
          id: 41,
          method: "DOM.getFrameOwner",
          ...command,
        });
        expect(h.client.messages.at(-1)!.error).toBeDefined();
      }
      expect(h.extension.messages).toHaveLength(before);
      h.connection.receive({
        kind: "event",
        generation: h.connection.generation,
        assignment: h.connection.offered("agent"),
        method: "Target.attachedToTarget",
        params: {
          sessionId: "child-session",
          targetInfo: { targetId: "child-target", type: "iframe" },
        },
      });
      for (const ownedSession of [sessionId, "child-session"]) {
        const work = h.agent.receive({
          id: 42,
          method: "DOM.getFrameOwner",
          sessionId: ownedSession,
          params: { frameId: "child" },
        });
        const command = h.extension.messages.at(-1)!;
        expect(command.method).toBe("cdp");
        h.connection.receive({
          kind: "result",
          generation: h.connection.generation,
          id: command.id,
          result: { backendNodeId: 7 },
        });
        await work;
        expect(h.client.messages.at(-1)!.result).toEqual({ backendNodeId: 7 });
      }
      h.revoke();
      await h.agent.receive({
        id: 43,
        method: "DOM.getFrameOwner",
        sessionId,
        params: { frameId: "child" },
      });
      expect(h.client.closed).toBe(true);
      expect(
        h.extension.messages.filter((m) => m.method === "cdp"),
      ).toHaveLength(2);
    } finally {
      h.connection.close();
    }
  });
  test("frame lookup cannot admit a non-iframe target as a child", async () => {
    const h = await harness();
    try {
      const { assignment } = await create(h);
      h.connection.receive({
        kind: "event",
        generation: h.connection.generation,
        assignment,
        method: "Target.attachedToTarget",
        params: {
          sessionId: "fake-child",
          targetInfo: { targetId: "foreign-page", type: "page" },
        },
      });
      expect(h.client.closed).toBe(true);
      expect(h.connection.offered("agent")).toBeUndefined();
    } finally {
      h.connection.close();
    }
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
    fresh.receive({
      kind: "offer",
      durationMinutes: 0,
      generation: fresh.generation,
      assignment,
      scope: { kind: "agent", agentId: "agent" },
    });
    const freshSent = nextPeer.messages.at(-1)!;
    fresh.receive({
      kind: "result",
      generation: h.connection.generation,
      id: freshSent.id,
      result: {
        targetInfo: {
          targetId: "old",
          type: "page",
          url: "https://example.com/",
        },
      },
    });
    await Promise.resolve();
    expect(fresh.offered("agent")).toBeUndefined();
    expect(() => fresh.assign("agent", peer())).toThrow();
    expect(
      nextPeer.messages.filter((msg) => msg.method === "cdp"),
    ).toHaveLength(0);
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
  expect(fields(other.messages.at(-1)!.result).targetInfos).toEqual([
    { targetId: "other-owned", type: "page", url: "https://example.com/" },
  ]);
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

for (const outcome of [
  "off",
  "access",
  "error",
  "invalid-target",
  "disconnect",
] as const) {
  test(`provisional offer cannot bind after ${outcome}`, async () => {
    const h = await harness();
    h.connection.revoke("agent");
    const assignment = crypto.randomUUID();
    h.connection.receive({
      kind: "offer",
      durationMinutes: 0,
      generation: h.connection.generation,
      assignment,
      scope: { kind: "agent", agentId: "agent" },
    });
    const pending = h.extension.messages.at(-1)!;
    expect(pending.method).toBe("attach");
    expect(() => h.connection.assign("agent", peer())).toThrow();
    if (outcome === "off")
      h.connection.receive({
        kind: "event",
        generation: h.connection.generation,
        assignment,
        method: "detached",
        params: {},
      });
    if (outcome === "access") h.revoke();
    if (outcome === "disconnect") h.connection.close();
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: pending.id,
      ...(outcome === "error"
        ? { error: true }
        : {
            result: {
              targetInfo: {
                type: "page",
                targetId: "late",
                url:
                  outcome === "invalid-target"
                    ? "chrome://settings"
                    : "https://example.com/",
              },
            },
          }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.connection.offered("agent")).toBeUndefined();
    expect(() => h.connection.assign("agent", peer())).toThrow();
    h.connection.close();
  });
}

test("offer rechecks access and reserves one agent before attachment completes", async () => {
  const h = await harness();
  h.connection.revoke("agent");
  const send = (agent: string) =>
    h.connection.receive({
      kind: "offer",
      durationMinutes: 0,
      generation: h.connection.generation,
      assignment: crypto.randomUUID(),
      scope: { kind: "agent", agentId: agent },
    });
  send("foreign-agent");
  expect(h.extension.messages.at(-1)!.error).toBe(true);
  send("agent");
  const count = h.extension.messages.filter(
    (m) => m.method === "attach",
  ).length;
  send("agent");
  expect(h.extension.messages.at(-1)!.error).toBe(true);
  expect(
    h.extension.messages.filter((m) => m.method === "attach"),
  ).toHaveLength(count);
  h.connection.close();
});

function expiryHarness() {
  let now = 1_800_000_000_000;
  const timers: Array<{
    callback: () => void;
    at: number;
    cancelled: boolean;
  }> = [];
  const extension = peer();
  const bridge = new BrowserExtensionBridge(
    {
      memberForCredentialHash: () => "member",
      mayUse: () => true,
      memberDisplay: () => ({ id: "member", name: "Member" }),
      agentDisplay: (id) => ({ id, name: id }),
      agents: () => ["agent"],
    },
    {
      now: () => now,
      schedule: (callback, delayMs) => {
        const timer = { callback, at: now + delayMs, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  );
  const connection = bridge.connect("credential", extension);
  const start = (
    durationMinutes: unknown,
    assignment = crypto.randomUUID(),
  ) => {
    connection.receive({
      kind: "offer",
      generation: connection.generation,
      assignment,
      scope: { kind: "agent", agentId: "agent" },
      durationMinutes,
    });
    return assignment;
  };
  const accept = async () => {
    const attach = extension.messages.findLast((m) => m.method === "attach")!;
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
    return extension.messages.findLast((m) => m.kind === "offered")!;
  };
  return {
    connection,
    extension,
    timers,
    start,
    accept,
    now: () => now,
    advance: (ms: number, fire = true) => {
      now += ms;
      if (fire)
        for (const timer of [...timers])
          if (!timer.cancelled && timer.at <= now) timer.callback();
    },
  };
}

test("grant deadline starts after attachment, expires before any action and cannot revoke a replacement", async () => {
  const h = expiryHarness();
  try {
    const original = h.start(15);
    h.advance(5 * 60_000);
    expect(h.timers).toHaveLength(0);
    const ack = await h.accept();
    expect(ack).toMatchObject({
      assignment: original,
      durationMinutes: 15,
      expiresAt: h.now() + 15 * 60_000,
    });
    expect(h.connection.offered("agent")).toBe(original);
    expect(h.timers).toHaveLength(1);
    const oldTimer = h.timers[0];
    h.advance(15 * 60_000);
    expect(h.connection.offered("agent")).toBeUndefined();
    expect(h.extension.messages).toContainEqual(
      expect.objectContaining({ method: "detach", assignment: original }),
    );
    expect(oldTimer.cancelled).toBe(true);
    const replacement = h.start(0);
    await h.accept();
    expect(replacement).not.toBe(original);
    expect(h.connection.offered("agent")).toBe(replacement);
    oldTimer.callback();
    h.advance(4 * 60 * 60_000);
    expect(h.connection.offered("agent")).toBe(replacement);
    expect(h.timers).toHaveLength(1);
    expect(
      h.extension.messages.findLast((m) => m.kind === "metadata")?.assignments,
    ).toMatchObject([{ id: replacement, durationMinutes: 0, expiresAt: null }]);
  } finally {
    h.connection.close();
  }
});

test("actions do not extend a grant; deadline interrupts held commands without replay", async () => {
  const h = expiryHarness();
  try {
    const id = h.start(60);
    const ack = await h.accept();
    const client = peer();
    const agent = h.connection.assign("agent", client);
    await agent.receive({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true },
    });
    const sessionId = fields(
      client.messages.find((m) => m.method === "Target.attachedToTarget")!
        .params,
    ).sessionId;
    h.advance(30 * 60_000);
    const pending = agent.receive({
      id: 2,
      sessionId,
      method: "Runtime.evaluate",
      params: { expression: "1" },
    });
    const command = h.extension.messages.findLast((m) => m.method === "cdp")!;
    expect(fields(command.params).method).toBe("Runtime.evaluate");
    expect(command.assignment).toBe(id);
    expect(h.connection.offered("agent")).toBe(id);
    h.connection.sendMetadata();
    expect(
      h.extension.messages.findLast((m) => m.kind === "metadata")?.assignments,
    ).toMatchObject([{ expiresAt: ack.expiresAt }]);
    expect(h.timers).toHaveLength(1);
    h.advance(30 * 60_000);
    await pending;
    expect(client.closed).toBe(true);
    expect(client.messages.find((m) => m.id === 2)).toBeUndefined();
    expect(h.connection.offered("agent")).toBeUndefined();
    const replacement = h.start(15);
    await h.accept();
    expect(replacement).not.toBe(id);
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      result: {},
    });
    expect(h.connection.offered("agent")).toBe(replacement);
    expect(h.extension.messages.filter((m) => m.method === "cdp")).toHaveLength(
      1,
    );
  } finally {
    h.connection.close();
  }
});

test("ownership checks enforce elapsed deadlines even before the timer callback runs", async () => {
  for (const boundary of [
    "offered",
    "assign",
    "command",
    "revalidate",
  ] as const) {
    const h = expiryHarness();
    try {
      h.start(15);
      await h.accept();
      const client = peer();
      const agent =
        boundary === "command"
          ? h.connection.assign("agent", client)
          : undefined;
      h.advance(15 * 60_000, false);
      if (boundary === "assign")
        expect(() => h.connection.assign("agent", client)).toThrow();
      else if (boundary === "command")
        await agent!.receive({ id: 1, method: "Browser.getVersion" });
      else if (boundary === "revalidate") h.connection.revalidate();
      else expect(h.connection.offered("agent")).toBeUndefined();
      expect(h.timers[0].cancelled).toBe(true);
      expect(h.connection.offered("agent")).toBeUndefined();
    } finally {
      h.connection.close();
    }
  }
});

test("offer rejects missing or non-member durations without attaching", () => {
  for (const value of [undefined, null, "15", -1, 1, 15.5, Infinity, NaN]) {
    const h = expiryHarness();
    try {
      h.start(value);
      expect(h.extension.closed).toBe(true);
      expect(h.extension.messages.some((m) => m.method === "attach")).toBe(
        false,
      );
    } finally {
      h.connection.close();
    }
  }
});

test("a result arriving after expiry releases only its grant when the timer is delayed", async () => {
  const h = expiryHarness();
  try {
    h.start(15);
    await h.accept();
    const client = peer();
    const agent = h.connection.assign("agent", client);
    await agent.receive({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true },
    });
    const sessionId = fields(
      client.messages.find((m) => m.method === "Target.attachedToTarget")!
        .params,
    ).sessionId;
    const pending = agent.receive({
      id: 2,
      sessionId,
      method: "Runtime.evaluate",
      params: { expression: "1" },
    });
    const command = h.extension.messages.findLast((m) => m.method === "cdp")!;
    expect(command).toBeDefined();
    const other = crypto.randomUUID();
    h.connection.receive({
      kind: "offer",
      generation: h.connection.generation,
      assignment: other,
      scope: { kind: "agent", agentId: "other" },
      durationMinutes: 0,
    });
    await h.accept();
    expect(h.connection.offered("other")).toBe(other);
    h.advance(15 * 60_000, false);
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      result: {},
    });
    await pending;
    expect(client.closed).toBe(true);
    expect(client.messages.find((m) => m.id === 2)).toBeUndefined();
    expect(h.extension.closed).toBe(false);
    expect(h.connection.offered("other")).toBe(other);
  } finally {
    h.connection.close();
  }
});

test("timed-out CDP keeps a settlement tombstone and the offered grant", async () => {
  const h = await harness();
  const { sessionId, assignment } = await create(h);
  const native = globalThis.setTimeout;
  let expire!: () => void;
  // Only accelerate the real bridge command timeout, not a separate test clock.
  const spy = (await import("bun:test"))
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 30_000) expire = callback;
      return native(callback, ms);
    }) as typeof setTimeout);
  try {
    const action = h.agent.receive({
      id: 9,
      sessionId,
      method: "Input.insertText",
      params: { text: "fixture" },
    });
    const command = h.extension.messages.at(-1)!;
    expect(command.method).toBe("cdp");
    expect(h.connection.pendingCount(assignment)).toBe(1);
    expire();
    await action;
    expect(h.connection.pendingTimedOut(assignment)).toBe(true);
    expect(h.connection.offered("agent")).toBe(assignment);
    expect(h.extension.closed).toBe(false);
    let settled = false;
    const drained = h.connection.drain(assignment).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const replies = h.client.messages.filter((m) => m.id === 9).length;
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      result: {},
    });
    await drained;
    expect(h.connection.pendingCount(assignment)).toBe(0);
    expect(h.client.messages.filter((m) => m.id === 9)).toHaveLength(replies);
    expect(h.extension.messages.filter((m) => m.method === "cdp")).toHaveLength(
      1,
    );
  } finally {
    spy.mockRestore();
    h.connection.close();
  }
});

test("navigation stop is assignment-scoped and foreign page sessions remain refused", async () => {
  const h = await harness();
  const { assignment } = await create(h);
  try {
    const before = h.extension.messages.length;
    await h.agent.receive({
      id: 8,
      sessionId: "foreign",
      method: "Page.stopLoading",
      params: {},
    });
    expect(h.extension.messages).toHaveLength(before);
    expect(h.client.messages.at(-1)?.error).toBeDefined();
    expect(
      await h.connection.stopLoading("foreign").then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    const stopped = h.connection.stopLoading(assignment);
    const command = h.extension.messages.at(-1)!;
    expect(command).toMatchObject({
      assignment,
      method: "cdp",
      params: { method: "Page.stopLoading" },
    });
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      result: {},
    });
    await stopped;
    expect(h.connection.offered("agent")).toBe(assignment);
  } finally {
    h.connection.close();
  }
});

test("retired client cannot release a replacement client or deliver its old reply", async () => {
  const h = await harness(true);
  const { sessionId, assignment } = await create(h);
  try {
    const action = h.agent.receive({
      id: 9,
      sessionId,
      method: "Runtime.evaluate",
      params: { expression: "1" },
    });
    const command = h.extension.messages.at(-1)!;
    h.agent.close();
    expect(h.connection.offered("agent")).toBe(assignment);
    const nextPeer = peer();
    expect(() => h.connection.assign("agent", nextPeer, true)).toThrow();
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      result: {},
    });
    const next = h.connection.assign("agent", nextPeer, true);
    await action;
    expect(nextPeer.messages.some((m) => m.id === 9)).toBe(false);
    h.agent.close();
    await next.receive({
      id: 10,
      method: "Target.setAutoAttach",
      params: { autoAttach: true },
    });
    expect(
      nextPeer.messages.some((m) => m.method === "Target.attachedToTarget"),
    ).toBe(true);
    expect(h.connection.offered("agent")).toBe(assignment);
    expect(h.extension.messages.some((m) => m.method === "detach")).toBe(false);
  } finally {
    h.connection.close();
  }
});

test("All discovery and explicit targets preserve precedence, access and grant identity", async () => {
  const allowed = new Set(["a", "b"]);
  const wire = peer();
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: () => "m",
    mayUse: (_m, agent) => allowed.has(agent),
  });
  const c = bridge.connect("fixture", wire);
  const add = async (
    scope: { kind: "all" } | { kind: "agent"; agentId: string },
  ) => {
    const id = crypto.randomUUID();
    c.receive({
      kind: "offer",
      generation: c.generation,
      assignment: id,
      scope,
      durationMinutes: 0,
    });
    const attach = wire.messages.at(-1)!;
    expect(attach.method).toBe("attach");
    c.receive({
      kind: "result",
      generation: c.generation,
      id: attach.id,
      result: {
        targetInfo: {
          type: "page",
          targetId: crypto.randomUUID(),
          url: "https://example.com/",
          title: "Fixture",
        },
      },
    });
    await Promise.resolve();
    return id;
  };
  try {
    const one = await add({ kind: "all" });
    expect(c.offered("a")).toBe(one);
    expect(c.offered("b")).toBe(one);
    const first = c.targets("a")[0].target;
    expect(first).not.toBe(one);
    await add({ kind: "all" });
    expect(c.ambiguous("a")).toBe(true);
    expect(c.offered("a")).toBeUndefined();
    expect(c.offered("a", first)).toBe(one);
    const individual = await add({ kind: "agent", agentId: "a" });
    expect(c.offered("a")).toBe(individual);
    expect(c.ambiguous("a")).toBe(false);
    expect(c.targets("a")).toHaveLength(3);
    expect(c.targets("b")).toHaveLength(2);
    const own = c.targets("a").find((t) => t.scope.kind === "agent")!.target;
    expect(c.offered("b", own)).toBeUndefined();
    c.revoke("a");
    expect(c.ambiguous("a")).toBe(true);
    expect(c.offered("a", own)).toBeUndefined();
    const replacement = await add({ kind: "agent", agentId: "a" });
    expect(c.offered("a")).toBe(replacement);
    expect(c.offered("a", own)).toBeUndefined();
    allowed.delete("a");
    c.revalidate();
    expect(c.targets("a")).toEqual([]);
    expect(c.targets("foreign")).toEqual([]);
    expect(c.offered("b", first)).toBe(one);
    c.revoke("b", first);
    expect(c.offered("b", first)).toBeUndefined();
  } finally {
    c.close();
  }
});

test("All client epochs bind each command to its actor and ignore retired peer traffic", async () => {
  const allowed = new Set(["a", "b"]),
    checks: string[] = [];
  const wire = peer();
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: () => "m",
    mayUse: (_m, actor) => {
      checks.push(actor);
      return allowed.has(actor);
    },
  });
  const c = bridge.connect("fixture", wire);
  const id = crypto.randomUUID();
  c.receive({
    kind: "offer",
    generation: c.generation,
    assignment: id,
    scope: { kind: "all" },
    durationMinutes: 0,
  });
  c.receive({
    kind: "result",
    generation: c.generation,
    id: wire.messages.at(-1)!.id,
    result: {
      targetInfo: {
        type: "page",
        targetId: "root",
        url: "https://example.com/",
      },
    },
  });
  await Promise.resolve();
  try {
    const handle = c.targets("a")[0].target;
    c.receive({
      kind: "event",
      generation: c.generation,
      assignment: id,
      method: "popup",
      params: {
        sessionId: "popup-session",
        targetInfo: {
          type: "page",
          targetId: "popup",
          openerId: "root",
          title: "Popup",
          url: "https://example.com/popup",
        },
      },
    });
    expect(c.targets("b")).toEqual([
      {
        target: handle,
        scope: { kind: "all" },
        title: "Popup",
        url: "https://example.com/popup",
      },
    ]);
    c.receive({
      kind: "event",
      generation: c.generation,
      assignment: id,
      method: "popupDetached",
      params: { sessionId: "popup-session" },
    });
    expect(c.targets("b")[0].target).toBe(handle);
    expect(c.targets("b")).toHaveLength(1);
    const a = peer(),
      b = peer();
    const old = c.assign("a", a, true);
    await old.receive({ id: 1, method: "Target.setAutoAttach", params: {} });
    const sessionId = fields(
      a.messages.find((m) => m.method === "Target.attachedToTarget")!.params,
    ).sessionId;
    checks.length = 0;
    const pending = old.receive({
      id: 2,
      method: "Input.insertText",
      sessionId,
      params: { text: "fixture" },
    });
    const command = wire.messages.at(-1)!;
    expect(command.method).toBe("cdp");
    expect(checks).toEqual(["a"]);
    allowed.delete("a");
    c.receive({
      kind: "result",
      generation: c.generation,
      id: command.id,
      result: {},
    });
    await pending;
    expect(checks).toEqual(["a", "a"]);
    expect(a.messages.at(-1)).toHaveProperty("error");
    expect(c.offered("b")).toBe(id);
    old.close();
    const current = c.assign("b", b, true);
    await current.receive({
      id: 3,
      method: "Target.setAutoAttach",
      params: {},
    });
    const count = wire.messages.length,
      responses = b.messages.length;
    checks.length = 0;
    allowed.add("a"); // Authorization alone cannot reject a retired peer.
    const late = old.receive({
      id: 4,
      method: "Input.insertText",
      sessionId,
      params: { text: "stale" },
    });
    await Promise.resolve();
    const afterLate = wire.messages.length;
    // Settle even a wrong implementation before asserting, avoiding a timeout.
    if (afterLate > count)
      c.receive({
        kind: "result",
        generation: c.generation,
        id: wire.messages.at(-1)!.id,
        result: {},
      });
    await late;
    expect(afterLate).toBe(count);
    old.close();
    c.receive({
      kind: "result",
      generation: c.generation,
      id: command.id,
      result: {},
    });
    expect(wire.messages).toHaveLength(count);
    expect(b.messages).toHaveLength(responses);
    expect(checks).toEqual([]);
    const next = current.receive({
      id: 5,
      method: "Runtime.evaluate",
      sessionId,
      params: { expression: "1" },
    });
    expect(checks).toEqual(["b"]);
    c.receive({
      kind: "result",
      generation: c.generation,
      id: wire.messages.at(-1)!.id,
      result: {},
    });
    await next;
    expect(checks).toEqual(["b", "b"]);
    expect(b.messages.at(-1)).toMatchObject({ id: 5, result: {} });
    expect(wire.messages.filter((m) => m.method === "cdp")).toHaveLength(2);
  } finally {
    c.close();
  }
});

test("All timed expiry releases every caller before first action and Never has no timer", async () => {
  let now = 1_800_000_000_000;
  const timers: (() => void)[] = [];
  const wire = peer();
  const bridge = new BrowserExtensionBridge(
    { memberForCredentialHash: () => "m", mayUse: () => true },
    {
      now: () => now,
      schedule: (callback) => {
        timers.push(callback);
        return () => {};
      },
    },
  );
  const c = bridge.connect("fixture", wire);
  const add = async (durationMinutes: number) => {
    const assignment = crypto.randomUUID();
    c.receive({
      kind: "offer",
      generation: c.generation,
      assignment,
      durationMinutes,
      scope: { kind: "all" },
    });
    c.receive({
      kind: "result",
      generation: c.generation,
      id: wire.messages.at(-1)!.id,
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
  };
  try {
    const timed = await add(15);
    expect(c.offered("a")).toBe(timed);
    expect(c.offered("b")).toBe(timed);
    expect(timers).toHaveLength(1);
    now += 15 * 60_000;
    timers[0]();
    expect(c.offered("a")).toBeUndefined();
    expect(c.offered("b")).toBeUndefined();
    expect(wire.messages.filter((m) => m.method === "detach")).toHaveLength(1);
    const never = await add(0);
    now += 24 * 60 * 60_000;
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(c.offered("a")).toBe(never);
    expect(c.offered("b")).toBe(never);
  } finally {
    c.close();
  }
});

test("offers from several browsers of one member resolve as one set", async () => {
  const names: Record<string, string> = {
    [browserCredentialHash("laptop")]: "Laptop",
    [browserCredentialHash("desk")]: "Desk",
  };
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: (hash) => (hash in names ? "member" : undefined),
    browserName: (hash) => names[hash],
    mayUse: () => true,
  });
  const laptopWire = peer(),
    deskWire = peer();
  const laptop = bridge.connect("laptop", laptopWire);
  const desk = bridge.connect("desk", deskWire);
  const offer = (
    connection: typeof laptop,
    wire: typeof laptopWire,
    scope: { kind: "all" } | { kind: "agent"; agentId: string },
    targetId?: string,
  ) => {
    const assignment = crypto.randomUUID();
    connection.receive({
      kind: "offer",
      durationMinutes: 0,
      generation: connection.generation,
      assignment,
      scope,
    });
    const attach = wire.messages.at(-1)!;
    if (targetId && attach.method === "attach")
      connection.receive({
        kind: "result",
        generation: connection.generation,
        id: attach.id,
        result: {
          targetInfo: { targetId, type: "page", url: "https://example.com/" },
        },
      });
    return assignment;
  };
  try {
    expect(bridge.connections("member")).toEqual([laptop, desk]);
    expect(() => bridge.connect("laptop", peer())).toThrow();
    offer(laptop, laptopWire, { kind: "all" }, "laptop-all");
    await Promise.resolve();
    const sole = bridge.resolve("member", "agent")!;
    expect(sole.connection).toBe(laptop);
    expect(sole.grant).toBe(laptop.offered("agent")!);
    offer(desk, deskWire, { kind: "all" }, "desk-all");
    await Promise.resolve();
    expect(bridge.ambiguous("member", "agent")).toBe(true);
    expect(bridge.resolve("member", "agent")).toBeUndefined();
    const tabs = bridge.targets("member", "agent");
    expect(tabs.map((t) => [t.browser, t.scope.kind])).toEqual([
      ["Laptop", "all"],
      ["Desk", "all"],
    ]);
    expect(bridge.resolve("member", "agent", tabs[1].target)).toMatchObject({
      connection: desk,
      target: tabs[1].target,
    });
    const own = offer(
      desk,
      deskWire,
      { kind: "agent", agentId: "agent" },
      "desk-own",
    );
    await Promise.resolve();
    expect(bridge.ambiguous("member", "agent")).toBe(false);
    expect(bridge.resolve("member", "agent")).toMatchObject({
      connection: desk,
      grant: own,
    });
    // One individual offer per agent across browsers, also while the first
    // one is still attaching.
    const sent = laptopWire.messages.length;
    offer(laptop, laptopWire, { kind: "agent", agentId: "agent" });
    expect(laptopWire.messages.slice(sent)).toEqual([
      expect.objectContaining({ kind: "offered", error: true }),
    ]);
    offer(desk, deskWire, { kind: "agent", agentId: "other" });
    const refused = laptopWire.messages.length;
    offer(laptop, laptopWire, { kind: "agent", agentId: "other" });
    expect(laptopWire.messages.slice(refused)).toEqual([
      expect.objectContaining({ kind: "offered", error: true }),
    ]);
    // Closing one browser leaves the other's offers in place.
    desk.close();
    expect(bridge.connections("member")).toEqual([laptop]);
    expect(bridge.resolve("member", "agent")?.connection).toBe(laptop);
  } finally {
    laptop.close();
    desk.close();
  }
});

test("recovery retires pending commands and the client while keeping the grant", async () => {
  const h = await harness(true);
  try {
    const { assignment, sessionId } = await create(h);
    expect(
      h.extension.messages.find((m) => m.kind === "ready")?.debuggerRecovery,
    ).toBe(true);
    const work = h.agent.receive({
      id: 2,
      sessionId,
      method: "Runtime.evaluate",
      params: { expression: "1" },
    });
    expect(h.connection.pendingCount(assignment)).toBe(1);
    const command = h.extension.messages.at(-1)!;
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment,
      method: "recovering",
      params: {},
    });
    await work;
    expect(h.client.closed).toBe(true);
    expect(h.connection.pendingCount(assignment)).toBe(0);
    expect(h.connection.offered("agent")).toBe(assignment);
    expect(h.client.messages.some((m) => m.id === 2 && m.result)).toBe(false);
    expect(() => h.connection.assign("agent", peer(), true)).toThrow();
    let ready = false;
    const waiting = h.connection
      .waitForRecovery(assignment, 3000)
      .then((value) => {
        ready = value;
      });
    await Promise.resolve();
    expect(ready).toBe(false);
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment,
      method: "recovered",
      params: {},
    });
    await waiting;
    expect(ready).toBe(true);
    const fresh = peer();
    h.connection.assign("agent", fresh, true);
    // The old client's close and its late result cannot revoke or reach fresh.
    h.agent.close();
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      result: {},
    });
    expect(fresh.messages).toHaveLength(0);
    expect(h.connection.offered("agent")).toBe(assignment);
  } finally {
    h.connection.close();
  }
});

test("an old extension detached event releases immediately without waiting for recovery", async () => {
  const h = await harness(true);
  const assignment = h.connection.offered("agent")!;
  // Old extensions send only detached, never recovering/recovered.
  h.connection.receive({
    kind: "event",
    generation: h.connection.generation,
    assignment,
    method: "detached",
    params: {},
  });
  expect(h.connection.offered("agent")).toBeUndefined();
  expect(h.connection.isRecovering(assignment)).toBe(false);
  expect(await h.connection.waitForRecovery(assignment, 3000)).toBe(false);
  expect(h.client.closed).toBe(true);
  h.connection.close();
});

test("a missing recovery completion releases the grant and bounded waiters", async () => {
  const h = await harness(true);
  const native = globalThis.setTimeout;
  let expire!: () => void;
  const spy = (await import("bun:test"))
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((callback: () => void, ms: number) => {
      if (ms === BROWSER_REATTACH_MS) expire = callback;
      return native(callback, ms);
    }) as typeof setTimeout);
  try {
    const assignment = h.connection.offered("agent")!;
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment,
      method: "recovering",
      params: {},
    });
    const waiting = h.connection.waitForRecovery(assignment, 4000);
    expect(typeof expire).toBe("function");
    expire();
    expect(await waiting).toBe(false);
    expect(h.connection.offered("agent")).toBeUndefined();
  } finally {
    spy.mockRestore();
    h.connection.close();
  }
});

// One fake timeline for the bridge clock (the kicks) and the bridge's bare
// 30 s command timeout, so a test can run both in order.
function fakeTimeline() {
  const native = globalThis.setTimeout;
  let now = 0;
  const timers: { at: number; callback: () => void; done: boolean }[] = [];
  const add = (callback: () => void, ms: number) => {
    const timer = { at: now + ms, callback, done: false };
    timers.push(timer);
    return timer;
  };
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    // The timeout callback is a no-op once its command settled.
    if (ms === 30_000) add(callback, ms);
    return native(ms === 30_000 ? () => {} : callback, ms);
  }) as typeof setTimeout);
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    clock: {
      now: () => now,
      schedule: (callback: () => void, ms: number) => {
        const timer = add(callback, ms);
        return () => {
          timer.done = true;
        };
      },
    },
    flush,
    async advanceTo(end: number) {
      for (;;) {
        const next = timers
          .filter((t) => !t.done && t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.done = true;
        next.callback();
        await flush();
      }
      now = end;
    },
    restore: () => spy.mockRestore(),
  };
}

describe("screenshot kicks", () => {
  const captures = (h: Awaited<ReturnType<typeof harness>>) =>
    h.extension.messages.filter(
      (m) =>
        m.method === "cdp" &&
        fields(m.params).method === "Page.captureScreenshot",
    );
  const answer = (
    h: Awaited<ReturnType<typeof harness>>,
    command: Fields,
    reply: { result: Fields } | { error: Fields },
  ) =>
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      ...reply,
    });
  const reply = (h: Awaited<ReturnType<typeof harness>>, id: number) =>
    h.client.messages.find((m) => m.id === id);

  test("a viewport capture is kicked outside the fence with its own parameters until it settles", async () => {
    const time = fakeTimeline();
    const h = await harness(false, time.clock);
    try {
      const { assignment } = await create(h);
      h.connection.receive({
        kind: "event",
        generation: h.connection.generation,
        assignment,
        method: "Target.attachedToTarget",
        params: {
          sessionId: "child-session",
          targetInfo: { targetId: "child-target", type: "iframe" },
        },
      });
      // Another page command gets no kicks.
      void h.agent.receive({
        id: 3,
        sessionId: "child-session",
        method: "Runtime.evaluate",
        params: { expression: "1" },
      });
      const evaluate = h.extension.messages.at(-1)!;
      await time.advanceTo(5_000);
      expect(h.extension.messages.at(-1)).toBe(evaluate);
      answer(h, evaluate, { result: {} });
      await time.flush();

      const params = { format: "jpeg", quality: 40 };
      const shot = h.agent.receive({
        id: 4,
        sessionId: "child-session",
        method: "Page.captureScreenshot",
        params,
      });
      const [capture] = captures(h);
      await time.advanceTo(5_000 + captureKickDelay(0) - 1);
      expect(captures(h)).toHaveLength(1);
      await time.advanceTo(5_000 + captureKickDelay(0) + captureKickDelay(1));
      const kicks = captures(h).slice(1);
      expect(kicks).toHaveLength(2);
      for (const kick of kicks)
        expect(kick.params).toEqual(capture.params as Fields);
      expect(fields(capture.params)).toEqual({
        method: "Page.captureScreenshot",
        params,
        sessionId: "child-session",
      });
      expect(h.connection.pendingCount(assignment)).toBe(1);

      answer(h, capture, { result: { data: "capture" } });
      await shot;
      expect(reply(h, 4)?.result).toEqual({ data: "capture" });
      // Unanswered kicks do not hold the next action.
      expect(h.connection.pendingCount(assignment)).toBe(0);
      await time.advanceTo(60_000);
      expect(captures(h)).toHaveLength(3);
      // A late kick result is dropped, and the client hears nothing more.
      const sent = h.client.messages.length;
      answer(h, kicks[0], { result: { data: "kick" } });
      await time.flush();
      expect(h.client.messages).toHaveLength(sent);
      expect(h.extension.closed).toBe(false);
    } finally {
      time.restore();
      h.connection.close();
    }
  });

  test("viewport kicks stop at the capture timeout and at release", async () => {
    const time = fakeTimeline();
    const h = await harness(false, time.clock);
    try {
      const { assignment, sessionId } = await create(h);
      const shot = h.agent.receive({
        id: 5,
        sessionId,
        method: "Page.captureScreenshot",
        params: { format: "png" },
      });
      await time.advanceTo(30_000);
      await shot;
      expect(reply(h, 5)?.error).toBeDefined();
      expect(h.connection.pendingTimedOut(assignment)).toBe(true);
      const atTimeout = captures(h).length;
      expect(atTimeout).toBeGreaterThan(1);
      await time.advanceTo(120_000);
      expect(captures(h)).toHaveLength(atTimeout);
    } finally {
      time.restore();
      h.connection.close();
    }

    const later = fakeTimeline();
    const g = await harness(false, later.clock);
    try {
      const { sessionId } = await create(g);
      const shot = g.agent.receive({
        id: 6,
        sessionId,
        method: "Page.captureScreenshot",
        params: { format: "png" },
      });
      await later.advanceTo(captureKickDelay(0));
      expect(captures(g)).toHaveLength(2);
      g.agent.close();
      await shot;
      expect(g.connection.offered("agent")).toBeUndefined();
      await later.advanceTo(120_000);
      expect(captures(g)).toHaveLength(2);
    } finally {
      later.restore();
      g.connection.close();
    }
  });

  test("a full-page capture answers only after it and its fenced kicks settle, with its own result", async () => {
    const time = fakeTimeline();
    const h = await harness(false, time.clock);
    try {
      const { assignment, sessionId } = await create(h);
      const params = { format: "png", captureBeyondViewport: true };
      const shot = h.agent.receive({
        id: 7,
        sessionId,
        method: "Page.captureScreenshot",
        params,
      });
      await time.advanceTo(captureKickDelay(0));
      const [capture, first] = captures(h);
      expect(first?.params).toEqual(capture.params as Fields);
      expect(h.connection.pendingCount(assignment)).toBe(2);

      answer(h, capture, { result: { data: "capture" } });
      await time.flush();
      expect(reply(h, 7)).toBeUndefined();
      // The open kick keeps the chain going: a kick sent as the capture
      // finishes can stick, and the next kick frees it.
      await time.advanceTo(captureKickDelay(0) + captureKickDelay(1));
      const second = captures(h)[2];
      expect(second?.params).toEqual(capture.params as Fields);
      answer(h, first, { error: { message: "failed" } });
      await time.flush();
      expect(reply(h, 7)).toBeUndefined();
      answer(h, second, { result: { data: "kick" } });
      await shot;
      expect(reply(h, 7)?.result).toEqual({ data: "capture" });
      expect(h.connection.pendingCount(assignment)).toBe(0);
      await time.advanceTo(120_000);
      expect(captures(h)).toHaveLength(3);
    } finally {
      time.restore();
      h.connection.close();
    }
  });

  test("a full-page capture keeps its own failure, and a kick timeout fails a good capture", async () => {
    for (const failingCapture of [true, false]) {
      const time = fakeTimeline();
      const h = await harness(false, time.clock);
      try {
        const { assignment, sessionId } = await create(h);
        const shot = h.agent.receive({
          id: 8,
          sessionId,
          method: "Page.captureScreenshot",
          params: { format: "png", captureBeyondViewport: true },
        });
        await time.advanceTo(captureKickDelay(0));
        const [capture, kick] = captures(h);
        if (failingCapture) {
          answer(h, kick, { result: { data: "kick" } });
          answer(h, capture, { error: { message: "failed" } });
        } else {
          answer(h, capture, { result: { data: "capture" } });
          await time.flush();
          // The kick's timeout runs on the fake timeline, kicks meanwhile.
          await time.advanceTo(captureKickDelay(0) + 30_000);
          expect(h.connection.pendingTimedOut(assignment)).toBe(true);
        }
        await time.flush();
        // Any later kick still open must settle before the answer.
        for (const open of captures(h).slice(2))
          answer(h, open, { result: { data: "kick" } });
        await shot;
        expect(reply(h, 8)?.result).toBeUndefined();
        expect(reply(h, 8)?.error).toBeDefined();
      } finally {
        time.restore();
        h.connection.close();
      }
    }
  });

  test("a full-page capture nobody answers stops kicking after seven kicks", async () => {
    const time = fakeTimeline();
    const h = await harness(false, time.clock);
    try {
      const { sessionId } = await create(h);
      const shot = h.agent.receive({
        id: 9,
        sessionId,
        method: "Page.captureScreenshot",
        params: { format: "png", captureBeyondViewport: true },
      });
      await time.advanceTo(300_000);
      await shot;
      expect(reply(h, 9)?.error).toBeDefined();
      expect(captures(h)).toHaveLength(1 + 7);
    } finally {
      time.restore();
      h.connection.close();
    }
  });
});

// The office gate (task 2a3b5645). An agent may not reach an Isomux office page
// that the member did not offer. The bridge sees every relayed CDP event before
// Playwright and every page command before Chrome, so the gate lives here: a
// check at action boundaries would let an auto-waiting click land on an office
// that commits during the wait.
describe("office gate", () => {
  const OFFICE = "https://office.test";
  const SITE = "https://site.test";
  const credentials = ["gate-credential-a", "gate-credential-b"];
  type Gate = Awaited<ReturnType<typeof gateHarness>>;
  async function gateHarness(
    opts: {
      offerUrl?: string;
      offices?: () => string[];
      retainGrant?: boolean;
    } = {},
  ) {
    const extension = peer();
    const seed = opts.offices ?? (() => [OFFICE]);
    const bridge = new BrowserExtensionBridge({
      memberForCredentialHash: (hash) =>
        credentials.map(browserCredentialHash).includes(hash)
          ? "member"
          : undefined,
      mayUse: (member, agent) =>
        member === "member" && ["agent", "agent-2"].includes(agent),
      officeOrigins: seed,
    });
    const connection = bridge.connect(credentials[0], extension);
    const assignment = await offer(
      connection,
      extension.messages,
      "agent",
      "owned",
      opts.offerUrl ?? `${SITE}/start`,
    );
    const h = {
      bridge,
      connection,
      extension,
      assignment,
      client: peer(),
      agent: undefined as unknown as ReturnType<typeof connection.assign>,
      sessionId: "",
      ids: 100,
    };
    await attach(h, opts.retainGrant ?? false);
    return h;
  }
  async function attach(h: Gate, retainGrant: boolean) {
    h.client = peer();
    h.agent = h.connection.assign("agent", h.client, retainGrant);
    await h.agent.receive({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true },
    });
    h.sessionId = fields(
      h.client.messages.find((m) => m.method === "Target.attachedToTarget")!
        .params,
    ).sessionId as string;
  }
  const event = (
    h: Gate,
    [method, params]: [string, Fields],
    sessionId?: string,
  ) =>
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment: h.assignment,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    });
  // CDP event shapes as Chrome sends them. The main frame id of a page target
  // is its target id.
  const request = (
    url: string,
    opts: { frameId?: string; type?: string; redirectedFrom?: string } = {},
  ): [string, Fields] => [
    "Network.requestWillBeSent",
    {
      requestId: "req",
      loaderId: "req",
      frameId: opts.frameId ?? "owned",
      type: opts.type ?? "Document",
      documentURL: url,
      request: { url, method: "GET", headers: {} },
      ...(opts.redirectedFrom
        ? {
            redirectResponse: {
              url: opts.redirectedFrom,
              status: 302,
              headers: { location: url },
            },
          }
        : {}),
    },
  ];
  const commit = (url: string, frameId = "owned"): [string, Fields] => [
    "Page.frameNavigated",
    {
      frame: {
        id: frameId,
        loaderId: "loader",
        url,
        securityOrigin: new URL(url).origin,
        mimeType: "text/html",
      },
      type: "Navigation",
    },
  ];
  const response = (
    url: string,
    headers: Record<string, string>,
    opts: { frameId?: string; type?: string } = {},
  ): [string, Fields] => [
    "Network.responseReceived",
    {
      requestId: "res",
      loaderId: "res",
      frameId: opts.frameId ?? "owned",
      type: opts.type ?? "Document",
      response: { url, status: 200, headers, mimeType: "text/html" },
    },
  ];
  const marked = { "X-Isomux-Office": "1" };
  // Sends one page command as Playwright would and answers it if it reaches
  // the extension.
  async function command(
    h: Gate,
    method: string,
    params: Fields = {},
    sessionId: string = h.sessionId,
    reply: Fields = {},
  ) {
    const id = ++h.ids;
    const before = h.extension.messages.length;
    const work = h.agent.receive({ id, method, params, sessionId });
    for (
      let i = 0;
      i < 50 &&
      h.extension.messages.length === before &&
      !h.client.messages.some((m) => m.id === id);
      i++
    )
      await Promise.resolve();
    const sent = h.extension.messages
      .slice(before)
      .find(
        (m) =>
          m.kind === "command" &&
          m.method === "cdp" &&
          fields(m.params).method === method,
      );
    if (sent)
      h.connection.receive({
        kind: "result",
        generation: h.connection.generation,
        id: sent.id,
        result: reply,
      });
    await work;
    const answer = h.client.messages.find((m) => m.id === id);
    return { forwarded: !!sent, refused: !!answer?.error };
  }
  const passes = { forwarded: true, refused: false };
  const refused = { forwarded: false, refused: true };
  // The CDP session of each Page.stopLoading the gate sent: undefined is the
  // offered tab itself.
  const stops = (h: Gate) =>
    h.extension.messages
      .filter(
        (m) =>
          m.kind === "command" &&
          m.method === "cdp" &&
          fields(m.params).method === "Page.stopLoading",
      )
      .map((m) => fields(m.params).sessionId);
  // Every command class an action uses: reads, input, upload, capture, reload.
  const PAGE_COMMANDS: [string, Fields][] = [
    ["Runtime.evaluate", { expression: "document.title" }],
    ["Runtime.callFunctionOn", { functionDeclaration: "() => 1" }],
    ["DOM.getDocument", {}],
    ["Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 }],
    ["Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" }],
    ["Input.insertText", { text: "hello" }],
    ["DOM.setFileInputFiles", { files: [], backendNodeId: 1 }],
    ["Page.captureScreenshot", {}],
    ["Page.reload", {}],
  ];
  async function expectGated(h: Gate, sessionId = h.sessionId) {
    const start = h.connection.officeRefusals(h.assignment);
    for (const [method, params] of PAGE_COMMANDS)
      expect({
        method,
        ...(await command(h, method, params, sessionId)),
      }).toEqual({ method, ...refused });
    expect(h.connection.officeRefusals(h.assignment)).toBe(
      start + PAGE_COMMANDS.length,
    );
  }
  const read = (h: Gate, sessionId = h.sessionId) =>
    command(h, "Runtime.evaluate", { expression: "1" }, sessionId);

  test("a main-frame navigation toward a known office closes the page gate until a commit elsewhere", async () => {
    const h = await gateHarness();
    try {
      expect(await read(h)).toEqual(passes);
      expect(h.connection.officeGated(h.assignment)).toBe(false);
      expect(h.connection.offerOrigin(h.assignment)).toBe(SITE);

      event(h, request(`${OFFICE}/settings?tab=tokens`));
      // The gate stops the load outside the action fence: the next action is
      // not held behind it.
      expect(stops(h)).toEqual([undefined]);
      expect(h.connection.pendingCount(h.assignment)).toBe(0);
      expect(h.connection.officeGated(h.assignment)).toBe(true);
      await expectGated(h);

      // Only a stop, or a navigation that leaves for a page that is not
      // refused, passes.
      expect(await command(h, "Page.stopLoading")).toEqual(passes);
      expect(await command(h, "Page.navigate", { url: `${OFFICE}/` })).toEqual(
        refused,
      );
      // A navigation that would run in the office document is no way out.
      for (const url of ["javascript:alert(1)", "data:text/html,x"])
        expect({
          url,
          ...(await command(h, "Page.navigate", { url })),
        }).toEqual({ url, ...refused });
      expect(
        await command(h, "Page.navigate", { url: `${SITE}/next` }),
      ).toEqual(passes);
      // A request is not a commit: the gate stays closed until one.
      event(h, request(`${SITE}/next`));
      expect(await read(h)).toEqual(refused);
      event(h, commit(`${SITE}/next`));
      expect(h.connection.officeGated(h.assignment)).toBe(false);
      expect(await read(h)).toEqual(passes);

      // The late answer to the gate's own stop is dropped.
      const stop = h.extension.messages.find(
        (m) =>
          m.kind === "command" &&
          fields(m.params).method === "Page.stopLoading",
      )!;
      h.connection.receive({
        kind: "result",
        generation: h.connection.generation,
        id: stop.id,
        result: {},
      });
      expect(h.extension.closed).toBe(false);
      expect(await read(h)).toEqual(passes);
    } finally {
      h.connection.close();
    }
  });

  test("a navigation to a known office is refused at the bridge with the gate open", async () => {
    const h = await gateHarness();
    try {
      for (const url of [
        `${OFFICE}/`,
        `${OFFICE}/api/tokens`,
        "HTTPS://OFFICE.TEST:443/x",
      ])
        expect(await command(h, "Page.navigate", { url })).toEqual(refused);
      expect(h.connection.officeRefusals(h.assignment)).toBe(3);
      expect(
        await command(h, "Page.navigate", { url: `${SITE}/other` }),
      ).toEqual(passes);
      expect(h.connection.officeGated(h.assignment)).toBe(false);
      expect(await read(h)).toEqual(passes);
    } finally {
      h.connection.close();
    }
  });

  const triggers: {
    name: string;
    events: [string, Fields][];
    closes: boolean;
  }[] = [
    {
      name: "a main-frame document request",
      events: [request(`${OFFICE}/`)],
      closes: true,
    },
    {
      name: "a redirect hop to the office",
      events: [
        request(`${SITE}/hop`),
        request(`${OFFICE}/`, { redirectedFrom: `${SITE}/hop` }),
      ],
      closes: true,
    },
    {
      name: "a main-frame commit",
      events: [commit(`${OFFICE}/tasks`)],
      closes: true,
    },
    {
      name: "a marked document response from an unknown origin",
      events: [response("https://unknown.test/", marked)],
      closes: true,
    },
    {
      // HTTP/2 sends header names in lower case.
      name: "a lower-case marker",
      events: [response("https://unknown.test/", { "x-isomux-office": "1" })],
      closes: true,
    },
    {
      name: "a document request elsewhere",
      events: [request("https://elsewhere.test/")],
      closes: false,
    },
    {
      name: "a subresource request to the office",
      events: [request(`${OFFICE}/icon.png`, { type: "Image" })],
      closes: false,
    },
    {
      name: "an iframe document request to the office",
      events: [request(`${OFFICE}/`, { frameId: "child-frame" })],
      closes: false,
    },
    {
      name: "an unmarked document response from an unknown origin",
      events: [response("https://unknown.test/", {})],
      closes: false,
    },
    {
      name: "a marked document response from the offer's own origin",
      events: [response(`${SITE}/page`, marked)],
      closes: false,
    },
    {
      name: "a marked subresource while the page is elsewhere",
      events: [
        commit(`${SITE}/page`),
        response("https://unknown.test/api", marked, { type: "XHR" }),
      ],
      closes: false,
    },
  ];
  for (const { name, events, closes } of triggers)
    test(`${name} ${closes ? "closes" : "leaves open"} the gate`, async () => {
      const h = await gateHarness();
      try {
        for (const e of events) event(h, e);
        expect(h.connection.officeGated(h.assignment)).toBe(closes);
        expect(stops(h)).toEqual(closes ? [undefined] : []);
        expect(await read(h)).toEqual(closes ? refused : passes);
      } finally {
        h.connection.close();
      }
    });

  test("a marked response teaches its origin to every connection of the process", async () => {
    const h = await gateHarness();
    const other = peer();
    const second = h.bridge.connect(credentials[1], other);
    try {
      // A subresource is enough to learn; it does not close the gate.
      event(
        h,
        response("https://learned.test/app.js", marked, { type: "Script" }),
      );
      expect(h.connection.officeGated(h.assignment)).toBe(false);
      await offer(second, other.messages, "agent-2", "second-tab", `${SITE}/b`);
      const client = peer();
      const agent = second.assign("agent-2", client);
      await agent.receive({
        id: 1,
        method: "Target.setAutoAttach",
        params: { autoAttach: true },
      });
      const sessionId = fields(
        client.messages.find((m) => m.method === "Target.attachedToTarget")!
          .params,
      ).sessionId;
      const before = other.messages.length;
      const work = agent.receive({
        id: 2,
        method: "Page.navigate",
        params: { url: "https://learned.test/" },
        sessionId,
      });
      for (let i = 0; i < 50 && other.messages.length === before; i++)
        await Promise.resolve();
      const forwarded = other.messages.slice(before);
      for (const sent of forwarded)
        second.receive({
          kind: "result",
          generation: second.generation,
          id: sent.id,
          result: {},
        });
      await work;
      expect(forwarded).toHaveLength(0);
      expect(client.messages.find((m) => m.id === 2)?.error).toBeDefined();
    } finally {
      second.close();
      h.connection.close();
    }
  });

  test("the seed is read at each check, normalized, and a bad value is skipped", async () => {
    const seed = ["HTTPS://Office.Test:443/some/path", "not a url"];
    const h = await gateHarness({ offices: () => seed });
    try {
      expect(await read(h)).toEqual(passes);
      expect(await command(h, "Page.navigate", { url: `${OFFICE}/x` })).toEqual(
        refused,
      );
      // The public origin changed after the bridge was built.
      seed.push("https://moved.test");
      expect(
        await command(h, "Page.navigate", { url: "https://moved.test/" }),
      ).toEqual(refused);
    } finally {
      h.connection.close();
    }
  });

  test("an office page that committed unseen is gated once its origin is known", async () => {
    // A commit to an origin the process has not learned yet leaves the gate
    // open; the first marked response from that origin closes it.
    const seen = await gateHarness();
    try {
      event(seen, commit("https://late.test/"));
      expect(await read(seen)).toEqual(passes);
      event(
        seen,
        response("https://late.test/assets/main.js", marked, {
          type: "Script",
        }),
      );
      expect(seen.connection.officeGated(seen.assignment)).toBe(true);
      expect(stops(seen)).toEqual([undefined]);
      expect(await read(seen)).toEqual(refused);
    } finally {
      seen.connection.close();
    }
    // A new client's first frame tree read is the only sight of a page that
    // committed while no client watched: a known office closes the gate, and
    // an unknown one is checked again when its origin is learned.
    for (const [url, closesAtOnce] of [
      [`${OFFICE}/`, true],
      ["https://later.test/", false],
    ] as const) {
      const h = await gateHarness();
      try {
        expect(
          await command(h, "Page.getFrameTree", {}, h.sessionId, {
            frameTree: { frame: { id: "owned", loaderId: "l", url } },
          }),
        ).toEqual(passes);
        expect({ url, gated: h.connection.officeGated(h.assignment) }).toEqual({
          url,
          gated: closesAtOnce,
        });
        if (!closesAtOnce) {
          event(h, response(`${url}api/state`, marked, { type: "Fetch" }));
          expect(h.connection.officeGated(h.assignment)).toBe(true);
        }
        expect(await read(h)).toEqual(refused);
      } finally {
        h.connection.close();
      }
    }
  });

  test("a tab the member offered on an office stays usable on that office only", async () => {
    const h = await gateHarness({
      offerUrl: `${OFFICE}/tasks`,
      offices: () => [OFFICE, "https://second.test"],
    });
    try {
      expect(h.connection.offerOrigin(h.assignment)).toBe(OFFICE);
      event(h, request(`${OFFICE}/settings`));
      event(h, response(`${OFFICE}/settings`, marked));
      event(h, commit(`${OFFICE}/settings`));
      expect(h.connection.officeGated(h.assignment)).toBe(false);
      expect(await read(h)).toEqual(passes);
      expect(
        await command(h, "Page.navigate", { url: `${OFFICE}/integrations` }),
      ).toEqual(passes);
      expect(
        await command(h, "Page.navigate", { url: "https://second.test/" }),
      ).toEqual(refused);
      event(h, request("https://second.test/"));
      expect(h.connection.officeGated(h.assignment)).toBe(true);
      expect(await read(h)).toEqual(refused);
    } finally {
      h.connection.close();
    }
  });

  test("a popup has its own gate, and the leaf page decides officeGated", async () => {
    const h = await gateHarness();
    try {
      event(h, [
        "popup",
        {
          sessionId: "popup-session",
          targetInfo: {
            type: "page",
            targetId: "popup",
            openerId: "owned",
            url: `${SITE}/popup`,
          },
        },
      ]);
      expect(await read(h, "popup-session")).toEqual(passes);
      // The popup's main frame id is the popup's target id.
      event(h, request(`${OFFICE}/`, { frameId: "popup" }), "popup-session");
      expect(stops(h)).toEqual(["popup-session"]);
      expect(h.connection.officeGated(h.assignment)).toBe(true);
      await expectGated(h, "popup-session");
      // The opener tab is not gated by its popup.
      expect(await read(h)).toEqual(passes);
      event(h, ["popupDetached", { sessionId: "popup-session" }]);
      expect(h.connection.officeGated(h.assignment)).toBe(false);
      expect(await read(h)).toEqual(passes);
    } finally {
      h.connection.close();
    }
  });

  // tabs (task 34659f31): an entry whose leaf page is gated says so and
  // carries nothing read from that page; once the leaf leaves the office, no
  // field carries the office page it was on. Both leaf kinds: the offered tab
  // itself, and a popup opened on the office (an owner-invite link, whose URL
  // carries a token).
  for (const leaf of ["offered tab", "popup"] as const)
    test(`tabs flags a ${leaf} on a refused office page and keeps its url and title out`, async () => {
      const h = await gateHarness();
      try {
        const invite = `${OFFICE}/i/invite-token-secret`;
        const session = leaf === "popup" ? "popup-session" : undefined;
        const frameId = leaf === "popup" ? "popup" : "owned";
        if (leaf === "popup")
          // Chrome reports the popup's pending URL when it attaches.
          event(h, [
            "popup",
            {
              sessionId: "popup-session",
              targetInfo: {
                type: "page",
                targetId: "popup",
                openerId: "owned",
                title: "Office invite",
                url: invite,
              },
            },
          ]);
        else event(h, commit(invite));
        // The condition: the leaf's gate is closed.
        expect(h.connection.officeGated(h.assignment)).toBe(true);
        const [gated] = h.bridge.targets("member", "agent");
        expect(gated).toEqual({
          target: expect.any(String) as string,
          scope: { kind: "agent", agentId: "agent" },
          browser: "",
          title: "",
          url: "",
          officePageRefused: true,
        });
        event(h, commit(`${SITE}/after`, frameId), session);
        expect(h.connection.officeGated(h.assignment)).toBe(false);
        const tabs = h.bridge.targets("member", "agent");
        expect(tabs).toHaveLength(1);
        // Same target: the offer did not change.
        expect(tabs[0].target).toBe(gated.target);
        expect("officePageRefused" in tabs[0]).toBe(false);
        expect(tabs[0].url).toBe(`${SITE}/after`);
        expect(JSON.stringify(tabs[0])).not.toMatch(/invite|office\.test/i);
      } finally {
        h.connection.close();
      }
    });

  test("iframe sessions follow the gate of their page and never close it", async () => {
    const h = await gateHarness();
    try {
      event(h, [
        "Target.attachedToTarget",
        {
          sessionId: "child-session",
          targetInfo: { targetId: "child-target", type: "iframe" },
        },
      ]);
      // An office document inside an iframe session does not close the page
      // gate: Chrome refuses to frame an office.
      event(h, commit(`${OFFICE}/`, "child-target"), "child-session");
      event(
        h,
        response(`${OFFICE}/`, marked, { frameId: "child-target" }),
        "child-session",
      );
      expect(h.connection.officeGated(h.assignment)).toBe(false);
      expect(await read(h, "child-session")).toEqual(passes);
      expect(await read(h)).toEqual(passes);
      event(h, commit(`${OFFICE}/`));
      expect(await read(h)).toEqual(refused);
      expect(await read(h, "child-session")).toEqual(refused);
    } finally {
      h.connection.close();
    }
  });

  test("debugger recovery keeps a closed gate and the pinned offer origin", async () => {
    const h = await gateHarness({ retainGrant: true });
    try {
      event(h, commit(`${OFFICE}/`));
      expect(h.connection.officeGated(h.assignment)).toBe(true);
      event(h, ["recovering", {}]);
      event(h, ["recovered", {}]);
      expect(h.client.closed).toBe(true);
      await attach(h, true);
      expect(h.connection.offerOrigin(h.assignment)).toBe(SITE);
      expect(h.connection.officeGated(h.assignment)).toBe(true);
      expect(await read(h)).toEqual(refused);
      event(h, commit(`${SITE}/back`));
      expect(await read(h)).toEqual(passes);
    } finally {
      h.connection.close();
    }
  });
});

// Chrome keeps auto-attach on (waitForDebuggerOnStart) after a retained
// client leaves, and it announces an auto-attached frame only once per
// debugger session. The bridge resumes the frames nobody else will resume
// and announces earlier frames to each client, as Chrome does for a new one.
describe("child frames across clients", () => {
  type H = Awaited<ReturnType<typeof harness>>;
  type Client = ReturnType<H["connection"]["assign"]>;
  const frameInfo = (targetId: string) => ({
    targetId,
    type: "iframe",
    parentFrameId: "owned",
    parentId: "owned",
    url: "",
    title: "",
    attached: true,
  });
  const attachChild = (
    h: H,
    child: string,
    waiting: boolean,
    parent?: string,
  ) =>
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment: h.connection.offered("agent"),
      method: "Target.attachedToTarget",
      ...(parent ? { sessionId: parent } : {}),
      params: {
        sessionId: child,
        targetInfo: frameInfo(`${child}-target`),
        waitingForDebugger: waiting,
      },
    });
  const detachChild = (h: H, child: string) =>
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment: h.connection.offered("agent"),
      method: "Target.detachedFromTarget",
      params: { sessionId: child, targetId: `${child}-target` },
    });
  // Bridge-side resumes and client resumes both reach the extension.
  const resumes = (h: H) =>
    h.extension.messages
      .filter(
        (m) =>
          m.method === "cdp" &&
          fields(m.params).method === "Runtime.runIfWaitingForDebugger",
      )
      .map((m) => fields(m.params).sessionId);
  const announced = (client: ReturnType<typeof peer>) =>
    client.messages
      .filter(
        (m) =>
          m.method === "Target.attachedToTarget" &&
          fields(fields(m.params).targetInfo).type === "iframe",
      )
      .map((m) => ({
        parent: m.sessionId,
        child: fields(m.params).sessionId,
        targetInfo: fields(m.params).targetInfo,
        waiting: fields(m.params).waitingForDebugger,
      }));
  const lastCdp = async (h: H, method: string) => {
    for (let i = 0; i < 20; i++) {
      const command = h.extension.messages.at(-1);
      if (command?.method === "cdp" && fields(command.params).method === method)
        return command;
      await Promise.resolve();
    }
    throw new Error(`${method} did not reach the extension`);
  };
  const result = (h: H, command: Fields) =>
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      result: {},
    });
  // Playwright turns auto-attach on for each frame session it opens. The
  // optional hooks deliver extension traffic before the result (Chrome
  // announces existing frames first) and right after it.
  const autoAttach = async (
    h: H,
    client: Client,
    sessionId: unknown,
    hooks: { before?: () => void; after?: () => void } = {},
  ) => {
    const work = client.receive({
      id: 900,
      sessionId,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    });
    const command = await lastCdp(h, "Target.setAutoAttach");
    expect(fields(command.params).sessionId ?? sessionId).toBe(sessionId);
    hooks.before?.();
    result(h, command);
    hooks.after?.();
    await work;
  };

  test("a frame that starts while no client is connected is resumed when it waits", async () => {
    const h = await harness(true);
    try {
      const { sessionId, assignment } = await create(h);
      await autoAttach(h, h.agent, sessionId);
      h.agent.close();
      expect(h.connection.offered("agent")).toBe(assignment);
      attachChild(h, "waiting", true);
      attachChild(h, "running", false);
      attachChild(h, "nested", true, "waiting");
      expect(resumes(h)).toEqual(["waiting", "nested"]);
      expect(h.client.messages.some((m) => m.method === "cdp")).toBe(false);
      // The resume is outside the action fence: an unanswered one does not
      // block the next client, and its late result changes nothing.
      expect(h.connection.pendingCount(assignment)).toBe(0);
      const nextPeer = peer();
      h.connection.assign("agent", nextPeer, true);
      const [first] = h.extension.messages.filter(
        (m) =>
          m.method === "cdp" &&
          fields(m.params).method === "Runtime.runIfWaitingForDebugger",
      );
      result(h, first);
      expect(nextPeer.closed).toBe(false);
      expect(nextPeer.messages).toEqual([]);
      expect(h.connection.offered("agent")).toBe(assignment);
    } finally {
      h.connection.close();
    }
  });

  test("a retained client's close resumes only the frames it left waiting", async () => {
    const h = await harness(true);
    try {
      const { sessionId } = await create(h);
      await autoAttach(h, h.agent, sessionId);
      attachChild(h, "left", true);
      attachChild(h, "resumed", true);
      attachChild(h, "running", false);
      expect(announced(h.client).map((a) => a.child)).toEqual([
        "left",
        "resumed",
        "running",
      ]);
      // A connected client resumes its own frames.
      expect(resumes(h)).toEqual([]);
      const work = h.agent.receive({
        id: 5,
        sessionId: "resumed",
        method: "Runtime.runIfWaitingForDebugger",
        params: {},
      });
      result(h, await lastCdp(h, "Runtime.runIfWaitingForDebugger"));
      await work;
      expect(resumes(h)).toEqual(["resumed"]);
      h.agent.close();
      expect(resumes(h)).toEqual(["resumed", "left"]);
      h.agent.close();
      expect(resumes(h)).toEqual(["resumed", "left"]);
    } finally {
      h.connection.close();
    }
  });

  test("a later client learns each earlier frame once, on auto-attach of its parent", async () => {
    const h = await harness(true);
    try {
      const { sessionId } = await create(h);
      await autoAttach(h, h.agent, sessionId);
      attachChild(h, "frame", true);
      await autoAttach(h, h.agent, "frame");
      attachChild(h, "nested", false, "frame");
      h.agent.close();
      attachChild(h, "gone", false);
      detachChild(h, "gone");

      const nextPeer = peer();
      const next = h.connection.assign("agent", nextPeer, true);
      await next.receive({
        id: 1,
        method: "Target.setAutoAttach",
        params: { autoAttach: true },
      });
      expect(
        nextPeer.messages.some((m) => m.method === "Target.attachedToTarget"),
      ).toBe(true);
      expect(announced(nextPeer)).toEqual([]);

      await autoAttach(h, next, sessionId);
      // Chrome's own targetInfo, with the parentFrameId Playwright places the
      // frame by, and the frame's waiting state now: the close resumed it.
      expect(announced(nextPeer)).toEqual([
        {
          parent: sessionId,
          child: "frame",
          targetInfo: frameInfo("frame-target"),
          waiting: false,
        },
      ]);
      await autoAttach(h, next, sessionId);
      expect(announced(nextPeer)).toHaveLength(1);

      await autoAttach(h, next, "frame");
      await autoAttach(h, next, "frame");
      expect(announced(nextPeer).map((a) => [a.parent, a.child])).toEqual([
        [sessionId, "frame"],
        ["frame", "nested"],
      ]);
    } finally {
      h.connection.close();
    }
  });

  test("a frame that attaches before the client turns on auto-attach is held, then announced once", async () => {
    const h = await harness();
    try {
      const { sessionId } = await create(h);
      attachChild(h, "early", true);
      expect(announced(h.client)).toEqual([]);
      // The client is connected, so the frame is its to resume.
      expect(resumes(h)).toEqual([]);
      await autoAttach(h, h.agent, sessionId, {
        before: () => attachChild(h, "existing", false),
        after: () => attachChild(h, "racing", false),
      });
      const first = announced(h.client);
      expect(first.map((a) => a.child).sort()).toEqual([
        "early",
        "existing",
        "racing",
      ]);
      expect(first.every((a) => a.parent === sessionId)).toBe(true);
      expect(first.find((a) => a.child === "early")!.waiting).toBe(true);
      attachChild(h, "live", true);
      expect(announced(h.client).map((a) => a.child)).toHaveLength(4);
      expect(announced(h.client).at(-1)!.child).toBe("live");
      await autoAttach(h, h.agent, sessionId);
      expect(announced(h.client)).toHaveLength(4);
      expect(resumes(h)).toEqual([]);
    } finally {
      h.connection.close();
    }
  });
});

// An office restart drops every bridge object. The extension keeps the offers
// that were on and sends each again with the deadline and the pinned origin
// the office answered at the first offer (task 2c1c81ff).
describe("offer resume after a restart", () => {
  const SITE = "https://site.test";
  const OFFICE = "https://office.test";
  function restartHarness(offices: string[] = []) {
    let now = 1_800_000_000_000;
    const timers: Array<{
      callback: () => void;
      at: number;
      cancelled: boolean;
    }> = [];
    const clock = {
      now: () => now,
      schedule: (callback: () => void, delayMs: number) => {
        const timer = { callback, at: now + delayMs, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    };
    // A fresh bridge per boot, as a new office process builds one.
    const boot = () => {
      const bridge = new BrowserExtensionBridge(
        {
          memberForCredentialHash: (hash) =>
            hash === browserCredentialHash("restart-credential")
              ? "member"
              : undefined,
          mayUse: (member, agent) => member === "member" && agent === "agent",
          officeOrigins: () => offices,
        },
        clock,
      );
      const extension = peer();
      const connection = bridge.connect("restart-credential", extension);
      return { bridge, extension, connection };
    };
    const offer = async (
      b: ReturnType<typeof boot>,
      assignment: string,
      durationMinutes: number,
      url: string,
      resume?: { expiresAt: unknown; offerOrigin: unknown },
    ) => {
      const before = b.extension.messages.length;
      b.connection.receive({
        kind: "offer",
        generation: b.connection.generation,
        assignment,
        scope: { kind: "agent", agentId: "agent" },
        durationMinutes,
        ...resume,
      });
      const attach = b.extension.messages
        .slice(before)
        .find((m) => m.method === "attach");
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
      return {
        attached: !!attach,
        answer: b.extension.messages
          .slice(before)
          .findLast((m) => m.kind === "offered" && m.assignment === assignment),
      };
    };
    return {
      boot,
      offer,
      timers,
      now: () => now,
      advance: (ms: number) => {
        now += ms;
        for (const timer of [...timers])
          if (!timer.cancelled && timer.at <= now) timer.callback();
      },
    };
  }

  test("a resumed offer keeps its target, its deadline and its pinned origin; a new offer gets a new target", async () => {
    const h = restartHarness();
    const first = h.boot();
    expect(first.extension.messages[0]).toMatchObject({
      kind: "ready",
      offerResume: true,
    });
    const id = crypto.randomUUID();
    const { answer: original } = await h.offer(first, id, 15, `${SITE}/start`);
    expect(original).toMatchObject({
      durationMinutes: 15,
      expiresAt: h.now() + 15 * 60_000,
      offerOrigin: SITE,
    });
    const [before] = first.bridge.targets("member", "agent");
    first.connection.close();

    h.advance(5 * 60_000);
    const second = h.boot();
    // The tab moved to another site while the office was away.
    const { answer: resumed } = await h.offer(
      second,
      id,
      15,
      "https://elsewhere.test/page",
      { expiresAt: original!.expiresAt, offerOrigin: SITE },
    );
    expect(resumed).toMatchObject({
      durationMinutes: 15,
      expiresAt: original!.expiresAt,
      offerOrigin: SITE,
    });
    expect(resumed!.error).toBeUndefined();
    const after = second.bridge.targets("member", "agent");
    expect(after.map((t) => t.target)).toEqual([before.target]);
    expect(after[0].url).toBe("https://elsewhere.test/page");
    expect(
      second.bridge.resolve("member", "agent", before.target),
    ).toMatchObject({ grant: id, offerOrigin: SITE });

    // The deadline is the first offer's, not a fresh 15 minutes.
    h.advance(10 * 60_000 - 1);
    expect(second.connection.offered("agent")).toBe(id);
    h.advance(1);
    expect(second.connection.offered("agent")).toBeUndefined();

    const fresh = crypto.randomUUID();
    await h.offer(second, fresh, 0, `${SITE}/start`);
    const [renewed] = second.bridge.targets("member", "agent");
    expect(second.connection.offered("agent")).toBe(fresh);
    expect(renewed.target).not.toBe(before.target);
    second.connection.close();
  });

  test("a resume that the office cannot honor is refused with an answer and the connection stays open", async () => {
    const h = restartHarness();
    const minute = 60_000;
    // [durationMinutes, resume fields] relative to the clock at the resume.
    const cases: Array<[string, number, Record<string, unknown>]> = [
      ["expired", 15, { expiresAt: 0, offerOrigin: SITE }],
      ["expires now", 15, { expiresAt: "now", offerOrigin: SITE }],
      ["beyond its duration", 15, { expiresAt: 16, offerOrigin: SITE }],
      ["Never with a deadline", 0, { expiresAt: 5, offerOrigin: SITE }],
      ["a deadline without one", 15, { expiresAt: null, offerOrigin: SITE }],
      [
        "a deadline that is not a number",
        15,
        { expiresAt: "5", offerOrigin: SITE },
      ],
      [
        "an origin with a path",
        0,
        { expiresAt: null, offerOrigin: `${SITE}/start` },
      ],
      [
        "an origin that is not http",
        0,
        { expiresAt: null, offerOrigin: "file://" },
      ],
      ["no origin", 0, { expiresAt: null }],
      ["no deadline", 0, { offerOrigin: SITE }],
    ];
    for (const [name, duration, extra] of cases) {
      const b = h.boot();
      try {
        const resume = { ...extra };
        if (typeof resume.expiresAt === "number")
          resume.expiresAt = h.now() + resume.expiresAt * minute;
        if (resume.expiresAt === "now") resume.expiresAt = h.now();
        const id = crypto.randomUUID();
        const result = await h.offer(
          b,
          id,
          duration,
          `${SITE}/start`,
          resume as { expiresAt: unknown; offerOrigin: unknown },
        );
        expect({ name, attached: result.attached }).toEqual({
          name,
          attached: false,
        });
        expect({ name, error: result.answer?.error }).toEqual({
          name,
          error: true,
        });
        expect({ name, closed: b.extension.closed }).toEqual({
          name,
          closed: false,
        });
        expect(b.connection.offered("agent")).toBeUndefined();
      } finally {
        b.connection.close();
      }
    }
    // The enabling case: the same harness honors a valid resume.
    const b = h.boot();
    const id = crypto.randomUUID();
    const valid = await h.offer(b, id, 15, `${SITE}/start`, {
      expiresAt: h.now() + 15 * minute,
      offerOrigin: SITE,
    });
    expect(valid.attached).toBe(true);
    expect(valid.answer?.error).toBeUndefined();
    expect(b.connection.offered("agent")).toBe(id);
    b.connection.close();
  });

  test("a resumed tab on an office page keeps the pin: refused against another origin, usable on its own office", async () => {
    const h = restartHarness([OFFICE]);
    for (const [pin, gated] of [
      [SITE, true],
      [OFFICE, false],
    ] as const) {
      const b = h.boot();
      try {
        const id = crypto.randomUUID();
        const { answer } = await h.offer(b, id, 0, `${OFFICE}/tasks`, {
          expiresAt: null,
          offerOrigin: pin,
        });
        expect({ pin, error: answer?.error }).toEqual({
          pin,
          error: undefined,
        });
        expect({ pin, origin: b.connection.offerOrigin(id) }).toEqual({
          pin,
          origin: pin,
        });
        expect({ pin, gated: b.connection.officeGated(id) }).toEqual({
          pin,
          gated,
        });
        const [tab] = b.bridge.targets("member", "agent");
        expect({ pin, refused: tab.officePageRefused === true }).toEqual({
          pin,
          refused: gated,
        });
      } finally {
        b.connection.close();
      }
    }
  });
});
