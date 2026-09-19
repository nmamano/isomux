import { beforeAll, test, expect } from "bun:test";
import { runInNewContext } from "node:vm";
import { fields, type Fields } from "../shared/browser-extension-protocol";

let source: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: ["browser-extension/background.ts"], target: "browser" });
  if (!build.success) throw new Error("Extension build failed");
  source = await build.outputs[0].text();
});
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function harness() {
  const sockets: FakeSocket[] = [];
  const calls: string[] = [];
  let changed!: (_changes: unknown, area: string) => void;
  let created: () => Promise<{ id: number }> = () => Promise.resolve({ id: 7 });
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    sent: Fields[] = [];
    constructor(_url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(fields(JSON.parse(data))); }
    close() { this.readyState = 3; this.onclose?.(); }
    receive(message: Fields) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const chrome = {
    storage: {
      local: {
        setAccessLevel: () => Promise.resolve(),
        get: () => Promise.resolve({ connection: { url: "ws://127.0.0.1/extension", credential: "fixture" } }),
      },
      onChanged: { addListener: (callback: typeof changed) => { changed = callback; } },
    },
    runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    tabs: { create: () => { calls.push("create"); return created(); } },
    debugger: {
      attach: () => { calls.push("attach"); return Promise.resolve(); },
      detach: () => { calls.push("detach"); return Promise.resolve(); },
      sendCommand: (_target: unknown, method: string) => {
        calls.push(method);
        return Promise.resolve(method === "Target.getTargetInfo" ? { targetInfo: { targetId: "owned", type: "page" } } : {});
      },
      onEvent: { addListener() {} }, onDetach: { addListener() {} },
    },
  };
  runInNewContext(source, { chrome, WebSocket: FakeSocket, URL });
  await settle();
  const socket = sockets[0];
  socket.onopen?.();
  socket.receive({ kind: "ready", version: 1, generation: "generation-1" });
  return {
    socket, sockets, calls,
    reconnect: async () => { changed({}, "local"); await settle(); return sockets.at(-1)!; },
    delayCreate: () => {
      let resolve!: (value: { id: number }) => void;
      created = () => new Promise(done => { resolve = done; });
      return () => resolve({ id: 7 });
    },
    command: (id: number, method: string, params: Fields = {}, generation = "generation-1") =>
      socket.receive({ kind: "command", assignment: "assignment", id, generation, method, params }),
  };
}

test("built worker does not dispatch stale-generation or disconnected commands", async () => {
  const h = await harness();
  h.command(1, "create", {}, "old-generation");
  await settle();
  expect(h.calls).toHaveLength(0);
  h.command(2, "create");
  await settle();
  expect(h.calls.filter(call => call === "attach")).toHaveLength(1);
  h.socket.close();
  h.command(3, "cdp", { method: "Runtime.evaluate", params: {} });
  await settle();
  expect(h.calls).not.toContain("Runtime.evaluate");
  expect(h.calls).toContain("detach");
  const fresh = await h.reconnect();
  fresh.onopen?.();
  fresh.receive({ kind: "ready", version: 1, generation: "generation-2" });
  fresh.receive({ kind: "command", assignment: "assignment", id: 2, generation: "generation-1", method: "create", params: {} });
  await settle();
  expect(h.calls.filter(call => call === "create")).toHaveLength(1);
  fresh.close();
});

test("detach while tab creation is pending prevents debugger attachment", async () => {
  const h = await harness();
  const finish = h.delayCreate();
  h.command(1, "create");
  h.command(2, "detach");
  finish();
  await settle();
  expect(h.calls).toEqual(["create"]);
  h.socket.close();
});

test("built worker refuses unknown child sessions and profile commands", async () => {
  const h = await harness();
  h.command(1, "create");
  await settle();
  const count = h.calls.length;
  h.command(2, "cdp", { method: "Runtime.evaluate", sessionId: "foreign", params: {} });
  h.command(3, "cdp", { method: "Storage.getCookies", params: {} });
  await settle();
  expect(h.calls).toHaveLength(count);
  expect(h.socket.sent.filter(msg => msg.kind === "result" && msg.error)).toHaveLength(2);
  h.socket.close();
});
