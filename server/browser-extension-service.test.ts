import { test, expect } from "bun:test";
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
import type { Fields } from "../shared/browser-extension-protocol";

test("socket payload limits precede redemption; heartbeat loss rejects work without replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-service-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const socket = () => {
    const messages: Fields[] = [];
    let closed = false;
    const ws = {
      data: {
        kind: "extension",
        origin: "chrome-extension://" + "a".repeat(32),
      } as ExtensionWsData,
      send: (value: string) => {
        messages.push(JSON.parse(value));
      },
      close: () => {
        closed = true;
        service.close(ws as unknown as ServerWebSocket<ExtensionWsData>);
      },
    };
    const typed = ws as unknown as ServerWebSocket<ExtensionWsData>;
    service.open(typed);
    return { ws: typed, messages, closed: () => closed };
  };
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
      JSON.stringify({
        kind: "hello",
        version: 4,
        code: pair.code,
        padding: "x".repeat(4096),
      }),
    );
    expect(oversized.closed()).toBe(true);
    expect(store.paired("member")).toBe(false);
    const first = socket();
    service.message(
      first.ws,
      JSON.stringify({ kind: "hello", version: 4, code: pair.code }),
    );
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
    first.ws.data.lastPong = 0;
    service.message(
      first.ws,
      JSON.stringify({ kind: "pong", generation: "stale" }),
    );
    expect(first.ws.data.lastPong).toBe(0);
    service.heartbeat(first.ws);
    expect(connection.offered("agent")).toBeUndefined();
    expect(first.closed()).toBe(true);
    const fresh = socket();
    service.message(
      fresh.ws,
      JSON.stringify({ kind: "hello", version: 4, credential }),
    );
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
      origin: "chrome-extension://" + "a".repeat(32),
    } as ExtensionWsData,
    send: (text: string) => messages.push(JSON.parse(text)),
    close: () =>
      service.close(ws as unknown as ServerWebSocket<ExtensionWsData>),
  };
  const socket = ws as unknown as ServerWebSocket<ExtensionWsData>;
  try {
    const { code } = store.pair("m");
    service.open(socket);
    service.message(
      socket,
      JSON.stringify({ kind: "hello", version: 4, code }),
    );
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
        origin: "chrome-extension://" + "a".repeat(32),
      };
      service.open(socket);
      service.message(
        socket,
        JSON.stringify({ kind: "hello", version: 4, credential }),
      );
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
      origin: "chrome-extension://" + "a".repeat(32),
    };
    const count = messages.filter((m) => m.kind === "metadata").length;
    service.open(socket);
    service.message(
      socket,
      JSON.stringify({ kind: "hello", version: 4, code: fresh.code }),
    );
    expect(messages.filter((m) => m.kind === "metadata")).toHaveLength(count);
  } finally {
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("popup unpair from one of two browsers revokes only that browser and keeps a pending code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-two-unpair-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const socket = (code: string) => {
    const messages: Fields[] = [];
    let closed = false;
    const ws = {
      data: {
        kind: "extension",
        origin: "chrome-extension://" + "a".repeat(32),
      } as ExtensionWsData,
      send: (value: string) => {
        messages.push(JSON.parse(value));
      },
      close: () => {
        closed = true;
        service.close(ws as unknown as ServerWebSocket<ExtensionWsData>);
      },
    };
    const typed = ws as unknown as ServerWebSocket<ExtensionWsData>;
    service.open(typed);
    service.message(typed, JSON.stringify({ kind: "hello", version: 4, code }));
    return { ws: typed, messages, closed: () => closed };
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
    // The remaining browser still serves an offer.
    const connection = desk.ws.data.connection!;
    connection.receive({
      kind: "offer",
      durationMinutes: 0,
      generation: connection.generation,
      assignment: crypto.randomUUID(),
      scope: { kind: "all" },
    });
    connection.receive({
      kind: "result",
      generation: connection.generation,
      id: desk.messages.at(-1)!.id,
      result: {
        targetInfo: {
          targetId: "desk",
          type: "page",
          url: "https://example.com/",
        },
      },
    });
    await Promise.resolve();
    expect(service.bridge.resolve("m", "agent")?.connection).toBe(connection);
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
