import { test, expect, setSystemTime, spyOn } from "bun:test";
import type { ServerWebSocket } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrowserExtensionService,
  EXTENSION_MAX_BYTES,
  type ExtensionWsData,
} from "./browser-extension-service";
import { BrowserExtensionStore } from "./browser-extension-store";
import { fields, type Fields } from "../shared/browser-extension-protocol";

const origin = "chrome-extension://" + "a".repeat(32);
// An extension socket as the server opens one on the service.
function openSocket(service: BrowserExtensionService) {
  const messages: Fields[] = [];
  let closed = false;
  let code: number | undefined;
  const ws = {
    data: { kind: "extension", origin } as ExtensionWsData,
    send: (value: string) => {
      messages.push(JSON.parse(value));
    },
    close: (closeCode?: number) => {
      closed = true;
      code = closeCode;
      service.close(typed);
    },
  };
  const typed = ws as unknown as ServerWebSocket<ExtensionWsData>;
  service.open(typed);
  return { ws: typed, messages, closed: () => closed, code: () => code };
}
const hello = (fields: Fields) =>
  JSON.stringify({ kind: "hello", version: 4, ...fields });

test("socket payload limits precede redemption; heartbeat loss rejects work without replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-service-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const socket = () => openSocket(service);
  try {
    const pair = store.pair("member");
    const obsolete = socket();
    service.message(
      obsolete.ws,
      JSON.stringify({ kind: "hello", version: 3, code: pair.code }),
    );
    expect(obsolete.closed()).toBe(true);
    expect(store.paired("member")).toBe(false);
    expect(
      obsolete.messages.some((m) => m.kind === "ready" || m.kind === "command"),
    ).toBe(false);
    const oversized = socket();
    service.message(
      oversized.ws,
      hello({ code: pair.code, padding: "x".repeat(4096) }),
    );
    expect(oversized.closed()).toBe(true);
    expect(store.paired("member")).toBe(false);
    const first = socket();
    service.message(first.ws, hello({ code: pair.code }));
    const credential = first.messages.find(
      (message) => message.kind === "paired",
    )!.credential;
    const connection = first.ws.data.connection!;
    expect(connection).toBeDefined();
    const assignment = crypto.randomUUID();
    connection.receive({
      kind: "offer",
      durationMinutes: 0,
      generation: connection.generation,
      assignment,
      scope: { kind: "agent", agentId: "agent" },
    });
    expect(first.messages.some((message) => message.method === "attach")).toBe(
      true,
    );
    service.heartbeat(first.ws);
    expect(first.messages.at(-1)!.kind).toBe("ping");
    // 46 s with no message from the extension.
    setSystemTime(new Date(Date.now() + 46_000));
    try {
      service.heartbeat(first.ws);
    } finally {
      setSystemTime();
    }
    expect(connection.offered("agent")).toBeUndefined();
    expect(first.closed()).toBe(true);
    const fresh = socket();
    service.message(fresh.ws, hello({ credential }));
    expect(fresh.ws.data.connection!.generation).not.toBe(
      connection.generation,
    );
    expect(fresh.messages.some((message) => message.kind === "command")).toBe(
      false,
    );
    service.message(fresh.ws, "x".repeat(EXTENSION_MAX_BYTES + 1));
    expect(fresh.closed()).toBe(true);
  } finally {
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A non-browser client can forge the Origin, so the code or credential is the
// control: a wrong one costs the socket, and the member's code and live
// connection stay usable.
test("a wrong code or credential closes its socket and leaves the member's pairing alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-guess-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const socket = () => openSocket(service);
  const wrong = "A".repeat(43);
  try {
    const first = store.pair("member");
    const pairing = socket();
    service.message(pairing.ws, hello({ code: first.code }));
    const live = pairing.ws.data.connection;
    expect(live).toBeDefined();
    const pending = store.pair("member");
    for (const guess of [{ code: wrong }, { credential: wrong }]) {
      const guesser = socket();
      service.message(guesser.ws, hello(guess));
      expect(guesser.closed()).toBe(true);
      expect(guesser.ws.data.connection).toBeUndefined();
      expect(guesser.messages.map((m) => m.kind)).toEqual(["refused"]);
    }
    expect(pairing.closed()).toBe(false);
    expect(
      service.bridge.forCredentialHash(pairing.ws.data.credentialHash!),
    ).toBe(live);
    const second = socket();
    service.message(second.ws, hello({ code: pending.code }));
    expect(second.ws.data.connection).toBeDefined();
    expect(store.browsers("member")).toHaveLength(2);
  } finally {
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metadata uses current records; unpair is bound to authenticated generation and origin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-metadata-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  let member = true,
    permitted = true,
    name = "A\nname\u202e";
  const service = new BrowserExtensionService(store, {
    memberExists: () => member,
    mayUse: () => permitted,
    memberName: () => "Member\u0000",
    agentName: () => name,
    agents: () => ["a"],
  });
  const messages: Fields[] = [];
  const ws = {
    data: {
      kind: "extension",
      origin,
    } as ExtensionWsData,
    send: (text: string) => messages.push(JSON.parse(text)),
    close: () =>
      service.close(ws as unknown as ServerWebSocket<ExtensionWsData>),
  };
  const socket = ws as unknown as ServerWebSocket<ExtensionWsData>;
  try {
    const { code } = store.pair("m");
    service.open(socket);
    service.message(socket, hello({ code }));
    const connection = ws.data.connection!;
    const assignment = crypto.randomUUID();
    connection.receive({
      kind: "offer",
      durationMinutes: 0,
      generation: connection.generation,
      assignment,
      scope: { kind: "agent", agentId: "a" },
    });
    const attach = messages.at(-1)!;
    connection.receive({
      kind: "result",
      generation: connection.generation,
      id: attach.id,
      result: {
        targetInfo: {
          targetId: "owned",
          type: "page",
          url: "https://example.com/",
        },
      },
    });
    await Promise.resolve();
    let ended = false;
    connection.assign("a", {
      send() {},
      close() {
        ended = true;
      },
    });
    const metadata = () =>
      messages.filter((m) => m.kind === "metadata").at(-1)!;
    expect(metadata()).toEqual({
      kind: "metadata",
      generation: connection.generation,
      member: { id: "m", name: "Member" },
      agents: [{ id: "a", name: "Aname" }],
      assignments: [
        {
          id: expect.any(String),
          scope: { kind: "agent", agentId: "a" },
          agent: { id: "a", name: "Aname" },
          durationMinutes: 0,
          expiresAt: null,
        },
      ],
    });
    name = "Renamed";
    service.revalidate();
    expect(
      (metadata().assignments as { agent: { name: string } }[])[0].agent.name,
    ).toBe("Renamed");
    permitted = false;
    service.revalidate();
    expect(ended).toBe(true);
    expect(metadata().assignments).toEqual([]);
    // A forged generation cannot revoke even its own member's pairing.
    service.message(
      socket,
      JSON.stringify({ kind: "unpair", generation: "stale" }),
    );
    expect(store.paired("m")).toBe(true);
    expect(messages.some((m) => m.kind === "unpaired")).toBe(false);
    const credential = String(
      messages.find((m) => m.kind === "paired")!.credential,
    );
    const reconnect = () => {
      ws.data = {
        kind: "extension",
        origin,
      };
      service.open(socket);
      service.message(socket, hello({ credential }));
    };
    reconnect();
    ws.data.origin = "chrome-extension://" + "b".repeat(32);
    service.message(
      socket,
      JSON.stringify({
        kind: "unpair",
        generation: ws.data.connection!.generation,
      }),
    );
    expect(store.paired("m")).toBe(true);
    reconnect();
    service.message(
      socket,
      JSON.stringify({
        kind: "unpair",
        generation: ws.data.connection!.generation,
      }),
    );
    expect(store.paired("m")).toBe(false);
    expect(messages.some((m) => m.kind === "unpaired")).toBe(true);
    const fresh = store.pair("m");
    member = false;
    ws.data = {
      kind: "extension",
      origin,
    };
    const count = messages.filter((m) => m.kind === "metadata").length;
    service.open(socket);
    service.message(socket, hello({ code: fresh.code }));
    expect(messages.filter((m) => m.kind === "metadata")).toHaveLength(count);
  } finally {
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("popup unpair from one of two browsers revokes only that browser and keeps a pending code", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-two-unpair-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const socket = (code: string) => {
    const opened = openSocket(service);
    service.message(opened.ws, hello({ code }));
    return opened;
  };
  try {
    const laptop = socket(store.pair("m", "Laptop").code);
    const desk = socket(store.pair("m", "Desk").code);
    const hash = (s: typeof laptop) => s.ws.data.credentialHash!;
    // Precondition: two browsers of one member, both connected.
    expect(
      [laptop, desk].map((s) => s.messages.map((m) => m.kind).slice(0, 2)),
    ).toEqual([
      ["paired", "ready"],
      ["paired", "ready"],
    ]);
    expect(service.bridge.connections("m")).toEqual([
      laptop.ws.data.connection!,
      desk.ws.data.connection!,
    ]);
    expect(service.status("m").browsers.map((b) => [b.name, b.online])).toEqual(
      [
        ["Laptop", true],
        ["Desk", true],
      ],
    );
    const pending = store.pair("m");
    service.message(
      laptop.ws,
      JSON.stringify({
        kind: "unpair",
        generation: laptop.ws.data.connection!.generation,
      }),
    );
    expect(laptop.messages.at(-1)).toMatchObject({ kind: "unpaired" });
    expect(laptop.closed()).toBe(true);
    expect(store.memberForHash(hash(laptop))).toBeUndefined();
    expect(store.memberForHash(hash(desk))).toBe("m");
    expect(desk.closed()).toBe(false);
    expect(service.bridge.connections("m")).toEqual([desk.ws.data.connection!]);
    expect(service.status("m").browsers.map((b) => [b.name, b.online])).toEqual(
      [["Desk", true]],
    );
    // Popup unpair revokes one browser; the pending code still pairs.
    const third = socket(pending.code);
    expect(third.messages.map((m) => m.kind).slice(0, 2)).toEqual([
      "paired",
      "ready",
    ]);
    expect(store.browsers("m").map((b) => b.name)).toEqual([
      "Desk",
      "Browser 1",
    ]);
  } finally {
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Task 825bb286: each hello reports the extension's package, and the member's
// status marks a browser out of date against the office's package. An
// extension from before 0.4.5 reports none.
test("a hello records the extension package; status marks an older or missing one out of date", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-package-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const access = { memberExists: () => true, mayUse: () => true };
  const service = new BrowserExtensionService(store, access);
  try {
    const latest = service.status("m").version;
    const connect = (name: string, extra: Fields) => {
      const opened = openSocket(service);
      service.message(
        opened.ws,
        hello({ code: store.pair("m", name).code, ...extra }),
      );
      return opened;
    };
    const current = connect("Current", { package: latest });
    const old = connect("Old", {});
    const older = connect("Older", { package: "0.0.1" });
    // Precondition: all three are connected.
    for (const s of [current, old, older])
      expect(s.ws.data.connection).toBeDefined();
    // ready names the office's package, so an extension can see it is behind.
    expect(current.messages.find((m) => m.kind === "ready")!.package).toBe(
      latest,
    );
    const view = () =>
      service.status("m").browsers.map((b) => [b.name, b.package, b.outdated]);
    expect(view()).toEqual([
      ["Current", latest, false],
      ["Old", null, true],
      ["Older", "0.0.1", true],
    ]);
    // A malformed package is a bad hello: refused before the code is redeemed.
    for (const bad of ["0.4.x", 4, "", "1.2.3.4.5", "v0.4.5"]) {
      const s = openSocket(service);
      service.message(
        s.ws,
        hello({ code: store.pair("m", "Bad").code, package: bad }),
      );
      expect(s.closed()).toBe(true);
      expect(s.messages.map((m) => m.kind)).toEqual(["refused"]);
    }
    expect(store.browsers("m")).toHaveLength(3);
    // The updated extension reconnects with its new package.
    const credential = String(
      old.messages.find((m) => m.kind === "paired")!.credential,
    );
    old.ws.close();
    const updated = openSocket(service);
    service.message(updated.ws, hello({ credential, package: latest }));
    expect(updated.ws.data.connection).toBeDefined();
    expect(view()[1]).toEqual(["Old", latest, false]);
    // After an office restart nothing is known until each browser connects
    // again: no package, and not out of date.
    const restarted = new BrowserExtensionService(store, access);
    try {
      expect(
        restarted
          .status("m")
          .browsers.map((b) => [b.name, b.package === undefined, b.outdated]),
      ).toEqual([
        ["Current", true, false],
        ["Old", true, false],
        ["Older", true, false],
      ]);
    } finally {
      restarted.stop();
    }
  } finally {
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing extension package fails closed instead of serving the app shell", async () => {
  const { browserExtensionHandlers } =
    await import("./routes/handlers/browser-extension");
  const store = new BrowserExtensionStore(
    "/nonexistent/browser-connections.json",
  );
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const handler = browserExtensionHandlers(
    service,
    "/nonexistent/isomux-extension.zip",
  )["browser.download"];
  const result = await handler({} as Parameters<typeof handler>[0]);
  expect(result).toMatchObject({
    kind: "error",
    status: 404,
    code: "extension_unavailable",
  });
});

// Task f63edd81: the browser lost control of every tab, and stayed off until
// the member paired again, after one extension message the service could not
// take. Two tabs, each with an agent client that has its session.
async function twoTabs(service: BrowserExtensionService, code: string) {
  const socket = openSocket(service);
  service.message(socket.ws, hello({ code }));
  const connection = socket.ws.data.connection!;
  const generation = connection.generation;
  const send = (message: Fields) =>
    service.message(socket.ws, JSON.stringify({ generation, ...message }));
  const commandFor = async (assignment: string, method: string) => {
    for (let i = 0; i < 50; i++) {
      const sent = socket.messages.find(
        (m) =>
          m.kind === "command" &&
          m.assignment === assignment &&
          fields(m.params).method === method &&
          !answered.has(m.id as number),
      );
      if (sent) {
        answered.add(sent.id as number);
        return sent;
      }
      await Promise.resolve();
    }
    throw new Error(`${method} did not reach the extension`);
  };
  const answered = new Set<number>();
  const tabs = [];
  for (const [agent, target] of [
    ["agent", "tab-1"],
    ["other-agent", "tab-2"],
  ]) {
    const assignment = crypto.randomUUID();
    send({
      kind: "offer",
      durationMinutes: 0,
      assignment,
      scope: { kind: "agent", agentId: agent },
    });
    send({
      kind: "result",
      id: socket.messages.at(-1)!.id,
      result: {
        targetInfo: { targetId: target, type: "page", url: "https://a.test/" },
      },
    });
    await Promise.resolve();
    const client = {
      messages: [] as Fields[],
      closed: false,
      send(message: Fields) {
        this.messages.push(message);
      },
      close() {
        this.closed = true;
      },
    };
    const peer = connection.assign(agent, client);
    const attaching = peer.receive({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true },
    });
    const tree = await commandFor(assignment, "Page.getFrameTree");
    send({
      kind: "result",
      id: tree.id,
      result: {
        frameTree: {
          frame: {
            id: target,
            loaderId: "loader",
            url: "https://a.test/",
            securityOrigin: "https://a.test",
            mimeType: "text/html",
          },
        },
      },
    });
    await attaching;
    const sessionId = fields(
      client.messages.find((m) => m.method === "Target.attachedToTarget")!
        .params,
    ).sessionId;
    tabs.push({ agent, assignment, client, peer, sessionId });
  }
  // Precondition: both tabs are attached and the connection is live.
  expect(tabs.every((t) => typeof t.sessionId === "string")).toBe(true);
  expect(socket.closed()).toBe(false);
  return { socket, connection, send, commandFor, tabs };
}
function serviceFixture(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  return {
    store,
    service,
    done: () => {
      service.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
// The [browser-extension] lines logged while run() runs.
async function logged(run: () => Promise<void> | void) {
  const lines: Fields[] = [];
  const info = spyOn(console, "info").mockImplementation((...args) => {
    const text = String(args[0]);
    if (text.startsWith("[browser-extension] "))
      lines.push(JSON.parse(text.slice("[browser-extension] ".length)));
  });
  try {
    await run();
  } finally {
    info.mockRestore();
  }
  return lines;
}
const padding = (marker: string) =>
  marker + "x".repeat(EXTENSION_MAX_BYTES + 1);

test("an answer over the size cap fails only its own command; the browser and the other tab stay on", async () => {
  const f = serviceFixture("browser-too-large-");
  try {
    const h = await twoTabs(f.service, f.store.pair("member").code);
    const [one, two] = h.tabs;
    const work = h.tabs.map((t) =>
      t.peer.receive({
        id: 5,
        method: "Runtime.evaluate",
        sessionId: t.sessionId,
        params: { expression: "document.body.innerText" },
      }),
    );
    const first = await h.commandFor(one.assignment, "Runtime.evaluate");
    const second = await h.commandFor(two.assignment, "Runtime.evaluate");
    const lines = await logged(async () => {
      h.send({
        kind: "result",
        id: first.id,
        result: { result: { value: padding("https://secret.test/") } },
      });
      h.send({ kind: "result", id: second.id, result: { result: {} } });
      await Promise.all(work);
    });
    expect(h.socket.messages.some((m) => m.kind === "refused")).toBe(false);
    expect(h.socket.closed()).toBe(false);
    expect(h.socket.ws.data.connection).toBe(h.connection);
    // Tab 1's command failed and is counted; its grant stays.
    expect(one.client.messages.find((m) => m.id === 5)!.error).toBeDefined();
    expect(h.connection.answersTooLarge(one.assignment)).toBe(1);
    expect(h.connection.pendingCount(one.assignment)).toBe(0);
    expect(h.connection.offered("agent")).toBe(one.assignment);
    expect(one.client.closed).toBe(false);
    // Tab 2's answer arrived after it.
    expect(two.client.messages.find((m) => m.id === 5)).toMatchObject({
      result: {},
    });
    expect(h.connection.answersTooLarge(two.assignment)).toBe(0);
    // The log names the size, never the content.
    const line = lines.find((l) => l.reason === "too_large");
    expect(line).toMatchObject({ kind: "result", id: first.id });
    expect(line!.bytes).toBeGreaterThan(EXTENSION_MAX_BYTES);
    expect(JSON.stringify(lines)).not.toContain("secret.test");
    expect(lines.some((l) => l.reason === "connection_ended")).toBe(false);
  } finally {
    f.done();
  }
});

test("an event over the size cap releases only its tab", async () => {
  const f = serviceFixture("browser-too-large-event-");
  try {
    const h = await twoTabs(f.service, f.store.pair("member").code);
    const [one, two] = h.tabs;
    const lines = await logged(() =>
      h.send({
        kind: "event",
        assignment: one.assignment,
        method: "Runtime.consoleAPICalled",
        params: { args: [{ value: padding("https://secret.test/") }] },
      }),
    );
    expect(h.socket.messages.some((m) => m.kind === "refused")).toBe(false);
    expect(h.socket.closed()).toBe(false);
    expect(h.connection.offered("agent")).toBeUndefined();
    expect(one.client.closed).toBe(true);
    expect(h.connection.offered("other-agent")).toBe(two.assignment);
    expect(two.client.closed).toBe(false);
    expect(
      lines.find(
        (l) => l.reason === "grant_released" && l.assignment === one.assignment,
      ),
    ).toMatchObject({ cause: "too_large" });
    expect(
      lines.some(
        (l) => l.reason === "grant_released" && l.assignment === two.assignment,
      ),
    ).toBe(false);
    expect(JSON.stringify(lines)).not.toContain("secret.test");
  } finally {
    f.done();
  }
});

test("a message that does not parse ends the connection with a code the extension recovers from", async () => {
  const f = serviceFixture("browser-bad-message-");
  try {
    const { code } = f.store.pair("member");
    let socket!: ReturnType<typeof openSocket>;
    const opened = await logged(() => {
      socket = openSocket(f.service);
      f.service.message(socket.ws, hello({ code }));
    });
    const generation = socket.ws.data.connection!.generation;
    const lines = await logged(() =>
      f.service.message(socket.ws, '{"kind":"result","id":'),
    );
    expect(socket.closed()).toBe(true);
    // 4003 with refused makes the extension stop until the member pairs again.
    expect(socket.code()).toBe(1008);
    expect(socket.messages.some((m) => m.kind === "refused")).toBe(false);
    expect(f.store.paired("member")).toBe(true);
    expect(opened.find((l) => l.reason === "connection_opened")).toMatchObject({
      generation,
      auth: "code",
    });
    expect(lines.find((l) => l.reason === "connection_ended")).toMatchObject({
      generation,
      cause: "bad_message",
      bytes: 22,
    });
    // The extension reconnects with its credential.
    const credential = socket.messages.find((m) => m.kind === "paired")!
      .credential as string;
    const again = openSocket(f.service);
    const reopened = await logged(() =>
      f.service.message(again.ws, hello({ credential })),
    );
    expect(again.ws.data.connection).toBeDefined();
    expect(
      reopened.find((l) => l.reason === "connection_opened"),
    ).toMatchObject({ auth: "credential" });
  } finally {
    f.done();
  }
});

test("any message from the extension keeps the connection alive; silence ends it with a logged cause", async () => {
  const f = serviceFixture("browser-heartbeat-");
  const start = Date.now();
  setSystemTime(new Date(start));
  try {
    const socket = openSocket(f.service);
    f.service.message(socket.ws, hello({ code: f.store.pair("member").code }));
    const generation = socket.ws.data.connection!.generation;
    // Results and events, but no pong, for 40 s.
    setSystemTime(new Date(start + 40_000));
    f.service.message(
      socket.ws,
      JSON.stringify({ kind: "agents", generation }),
    );
    setSystemTime(new Date(start + 60_000));
    f.service.heartbeat(socket.ws);
    expect(socket.closed()).toBe(false);
    // Then nothing for 46 s.
    setSystemTime(new Date(start + 86_000));
    const lines = await logged(() => f.service.heartbeat(socket.ws));
    expect(socket.closed()).toBe(true);
    const ended = lines.find((l) => l.reason === "connection_ended");
    expect(ended).toMatchObject({ generation, cause: "pong_overdue" });
    expect(ended!.msSinceLastMessage).toBe(46_000);
  } finally {
    setSystemTime();
    f.done();
  }
});

test("a socket that closes logs its code and reason", async () => {
  const f = serviceFixture("browser-socket-closed-");
  try {
    const socket = openSocket(f.service);
    f.service.message(socket.ws, hello({ code: f.store.pair("member").code }));
    const generation = socket.ws.data.connection!.generation;
    // Bun closes a frame over its payload limit with 1009 itself.
    const lines = await logged(() =>
      f.service.close(socket.ws, 1009, "Message too big"),
    );
    expect(lines.find((l) => l.reason === "connection_ended")).toMatchObject({
      generation,
      cause: "socket_closed",
      code: 1009,
    });
  } finally {
    f.done();
  }
});
