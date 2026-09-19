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
    store.select("member", "extension");
    const pair = store.pair("member", false);
    const oversized = socket();
    service.message(
      oversized.ws,
      JSON.stringify({
        kind: "hello",
        version: 1,
        code: pair.code,
        padding: "x".repeat(4096),
      }),
    );
    expect(oversized.closed()).toBe(true);
    expect(store.record("member").hash).toBeUndefined();
    const first = socket();
    service.message(
      first.ws,
      JSON.stringify({ kind: "hello", version: 1, code: pair.code }),
    );
    const credential = first.messages.find(
      (message) => message.kind === "paired",
    )!.credential;
    const connection = first.ws.data.connection!;
    expect(connection).toBeDefined();
    let ended = false;
    const agent = connection.assign("agent", {
      send: () => {},
      close: () => {
        ended = true;
      },
    });
    const pending = agent.receive({
      id: 1,
      method: "Target.createTarget",
      params: { url: "about:blank" },
    });
    expect(first.messages.some((message) => message.kind === "command")).toBe(
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
    await pending;
    expect(ended).toBe(true);
    expect(first.closed()).toBe(true);
    const fresh = socket();
    service.message(
      fresh.ws,
      JSON.stringify({ kind: "hello", version: 1, credential }),
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
