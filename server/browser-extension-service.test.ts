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
    const pair = store.pair("member", false);
    const obsolete = socket();
    service.message(obsolete.ws, JSON.stringify({ kind: "hello", version: 3, code: pair.code }));
    expect(obsolete.closed()).toBe(true);
    expect(store.record("member").hash).toBeUndefined();
    expect(obsolete.messages.some(m => m.kind === "ready" || m.kind === "command")).toBe(false);
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
    expect(store.record("member").hash).toBeUndefined();
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
    connection.receive({ kind: "offer", durationMinutes: 0, generation: connection.generation, assignment, scope: { kind: "agent", agentId: "agent" } });
    expect(first.messages.some((message) => message.method === "attach")).toBe(true);
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
    const { code } = store.pair("m", false);
    service.open(socket);
    service.message(
      socket,
      JSON.stringify({ kind: "hello", version: 4, code }),
    );
    const connection = ws.data.connection!;
    const assignment = crypto.randomUUID();
    connection.receive({ kind: "offer", durationMinutes: 0, generation: connection.generation, assignment, scope: { kind: "agent", agentId: "a" } });
    const attach = messages.at(-1)!;
    connection.receive({ kind: "result", generation: connection.generation, id: attach.id,
      result: { targetInfo: { targetId: "owned", type: "page", url: "https://example.com/" } } });
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
        { id: expect.any(String), scope: { kind: "agent", agentId: "a" }, agent: { id: "a", name: "Aname" }, durationMinutes: 0, expiresAt: null },
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
    expect(store.record("m").hash).toBeDefined();
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
    expect(store.record("m").hash).toBeDefined();
    reconnect();
    service.message(
      socket,
      JSON.stringify({
        kind: "unpair",
        generation: ws.data.connection!.generation,
      }),
    );
    expect(store.record("m").hash).toBeUndefined();
    expect(messages.some((m) => m.kind === "unpaired")).toBe(true);
    const fresh = store.pair("m", false);
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
