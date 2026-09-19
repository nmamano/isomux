import { beforeAll, test, expect } from "bun:test";
import { runInNewContext } from "node:vm";
import { fields, type Fields } from "../shared/browser-extension-protocol";

let source: string;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: ["browser-extension/background.ts"],
    target: "browser",
  });
  if (!build.success) throw new Error("Extension build failed");
  source = await build.outputs[0].text();
});
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function harness() {
  const sockets: FakeSocket[] = [];
  const calls: string[] = [];
  let navigation!: (event: { sourceTabId: number; tabId: number }) => void;
  let attach: () => Promise<void> = async () => {};
  let targetInfo: (tabId: number) => Promise<unknown> = async (tabId) => ({
    targetInfo: {
      targetId: tabId === 7 ? "owned" : `target-${tabId}`,
      type: "page",
    },
  });
  let changed!: (_changes: unknown, area: string) => void;
  let created: () => Promise<{ id: number }> = () => Promise.resolve({ id: 7 });
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    sent: Fields[] = [];
    constructor(_url: string) {
      sockets.push(this);
    }
    send(data: string) {
      this.sent.push(fields(JSON.parse(data)));
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
    receive(message: Fields) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  let runtimeMessage!: (value: unknown, sender: { id?: string; url?: string }, reply: (value: unknown) => void) => boolean | undefined;
  let config: Record<string, unknown> | null = { url: "ws://127.0.0.1/extension", credential: "fixture" };
  const badges: { text: string | null; tabId?: number }[] = [];
  const chrome = {
    action: {
      setBadgeText: async (value: { text: string | null; tabId?: number }) => { badges.push(value); },
      setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
    },
    windows: { update: async () => {} },
    alarms: {
      create: async () => {},
      clear: async () => true,
      onAlarm: { addListener() {} },
    },
    storage: {
      local: {
        set: async (value: { connection: Record<string, unknown> | null }) => {
          config = value.connection;
          changed({ connection: { newValue: config } }, "local");
        },
        setAccessLevel: () => Promise.resolve(),
        get: async () => ({ connection: config }),
      },
      onChanged: {
        addListener: (callback: typeof changed) => {
          changed = callback;
        },
      },
    },
    runtime: {
      id: "fixture-id",
      getURL: (path: string) => "chrome-extension://fixture-id/" + path,
      onMessage: { addListener: (fn: typeof runtimeMessage) => { runtimeMessage = fn; } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: (fn: typeof navigation) => {
          navigation = fn;
        },
      },
    },
    tabs: {
      update: async () => ({ windowId: 1 }),
      create: () => {
        calls.push("create");
        return created();
      },
    },
    debugger: {
      attach: () => {
        calls.push("attach");
        return attach();
      },
      detach: () => {
        calls.push("detach");
        return Promise.resolve();
      },
      sendCommand: (target: { tabId: number }, method: string) => {
        calls.push(method);
        return method === "Target.getTargetInfo"
          ? targetInfo(target.tabId)
          : Promise.resolve({});
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  const timers = new Map<number, () => void>();
  let timerId = 0;
  runInNewContext(source, {
    chrome,
    WebSocket: FakeSocket,
    URL,
    crypto,
    setTimeout: (fn: () => void) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  await settle();
  const socket = sockets[0];
  socket.onopen?.();
  socket.receive({ kind: "ready", version: 1, generation: "generation-1" });
  return {
    socket,
    sockets,
    badges,
    config: () => config,
    ui: (message: unknown) => new Promise<Record<string, unknown>>(resolve => runtimeMessage(message, { id: "fixture-id", url: "chrome-extension://fixture-id/connection.html" }, value => resolve(value as Record<string, unknown>))),
    foreign: (sender: { id?: string; url?: string }) => runtimeMessage({ action: "state" }, sender, () => { throw new Error("Foreign reply"); }),
    calls,
    timers,
    navigation: (sourceTabId: number, tabId: number) =>
      navigation({ sourceTabId, tabId }),
    delayPopup: (stage: "attach" | "target") => {
      let resolve!: () => void;
      if (stage === "attach")
        attach = () =>
          new Promise<void>((done) => {
            resolve = done;
          });
      else
        targetInfo = (tabId) =>
          new Promise((done) => {
            resolve = () =>
              done({
                targetInfo: { targetId: `target-${tabId}`, type: "page" },
              });
          });
      return () => resolve();
    },
    reconnect: async () => {
      changed({}, "local");
      await settle();
      return sockets.at(-1)!;
    },
    delayCreate: () => {
      let resolve!: (value: { id: number }) => void;
      created = () =>
        new Promise((done) => {
          resolve = done;
        });
      return () => resolve({ id: 7 });
    },
    command: (
      id: number,
      method: string,
      params: Fields = {},
      generation = "generation-1",
    ) =>
      socket.receive({
        kind: "command",
        assignment: "assignment",
        id,
        generation,
        method,
        params,
      }),
  };
}

test("built worker does not dispatch stale-generation or disconnected commands", async () => {
  const h = await harness();
  h.command(1, "create", {}, "old-generation");
  await settle();
  expect(h.calls).toHaveLength(0);
  h.command(2, "create");
  await settle();
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(1);
  h.socket.close();
  h.command(3, "cdp", { method: "Runtime.evaluate", params: {} });
  await settle();
  expect(h.calls).not.toContain("Runtime.evaluate");
  expect(h.calls).toContain("detach");
  const fresh = await h.reconnect();
  fresh.onopen?.();
  fresh.receive({ kind: "ready", version: 1, generation: "generation-2" });
  fresh.receive({
    kind: "command",
    assignment: "assignment",
    id: 2,
    generation: "generation-1",
    method: "create",
    params: {},
  });
  await settle();
  expect(h.calls.filter((call) => call === "create")).toHaveLength(1);
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
  h.command(2, "cdp", {
    method: "Runtime.evaluate",
    sessionId: "foreign",
    params: {},
  });
  h.command(3, "cdp", { method: "Storage.getCookies", params: {} });
  await settle();
  expect(h.calls).toHaveLength(count);
  expect(
    h.socket.sent.filter((msg) => msg.kind === "result" && msg.error),
  ).toHaveLength(2);
  h.socket.close();
});

test("transient loss schedules reconnect but refusal stays terminal", async () => {
  const h = await harness();
  h.socket.close();
  expect(h.timers.size).toBe(1);
  const reconnect = [...h.timers.values()][0];
  reconnect();
  await settle();
  expect(h.sockets).toHaveLength(2);
  const fresh = h.sockets[1];
  fresh.onopen?.();
  fresh.receive({ kind: "ready", version: 1, generation: "fresh" });
  fresh.receive({ kind: "refused" });
  expect(fresh.readyState).toBe(3);
  expect(h.timers.size).toBe(0);
});

test("navigation ownership uses only an assigned source and admits one leaf chain", async () => {
  const h = await harness();
  h.command(1, "create");
  await settle();
  const attached = h.calls.filter((call) => call === "attach").length;
  h.navigation(900, 901);
  await settle();
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(attached);
  h.navigation(7, 8);
  await settle();
  expect(
    h.socket.sent.filter((message) => message.method === "popup"),
  ).toHaveLength(1);
  const event = h.socket.sent.find((message) => message.method === "popup")!;
  expect(fields(fields(event.params).targetInfo).openerId).toBe("owned");
  h.navigation(7, 9);
  await settle();
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(
    attached + 1,
  );
  h.navigation(8, 10);
  await settle();
  expect(
    h.socket.sent.filter((message) => message.method === "popup"),
  ).toHaveLength(2);
  expect(fields(fields(h.socket.sent.at(-1)!.params).targetInfo).openerId).toBe(
    "target-8",
  );
  h.socket.receive({ kind: "refused" });
});

for (const stage of ["attach", "target"] as const) {
  test(`popup ownership lost during ${stage} never publishes the popup`, async () => {
    const h = await harness();
    h.command(1, "create");
    await settle();
    const finish = h.delayPopup(stage);
    h.navigation(7, 8);
    await settle();
    expect(h.calls.filter((call) => call === "attach")).toHaveLength(2);
    h.command(2, "detach");
    finish();
    await settle();
    expect(h.socket.sent.some((message) => message.method === "popup")).toBe(
      false,
    );
    expect(h.calls).toContain("detach");
    h.socket.receive({ kind: "refused" });
  });
}

test("popup is exact-extension-only, does not disclose credentials, and stops only its assignment", async () => {
  const h = await harness();
  expect(h.foreign({ id: "fixture-id", url: "https://example.com/" })).toBeUndefined();
  expect(h.foreign({ id: "foreign", url: "chrome-extension://fixture-id/connection.html" })).toBeUndefined();
  h.socket.receive({ kind: "metadata", generation: "generation-1", member: { id: "m", name: "Member" }, assignments: [{ id: "assignment", agent: { id: "a", name: "Agent" } }] });
  h.command(1, "create");
  await settle();
  const state = await h.ui({ action: "state" });
  expect(state.member).toEqual({ id: "m", name: "Member" });
  expect(state).not.toHaveProperty("credential");
  expect(state).not.toHaveProperty("code");
  expect(state.assignments).toHaveLength(1);
  expect(h.badges).toContainEqual({ tabId: 7, text: "CTRL" });
  expect(await h.ui({ action: "stop", generation: "old", assignment: "assignment" })).toHaveProperty("error");
  expect((await h.ui({ action: "state" })).assignments).toHaveLength(1);
  await h.ui({ action: "stop", generation: "generation-1", assignment: "assignment" });
  expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
  expect(h.calls).toContain("detach");
  expect(h.socket.sent).toContainEqual({ kind: "event", generation: "generation-1", assignment: "assignment", method: "detached", params: {} });
  expect(h.calls.filter(call => /close|remove|media|audio/i.test(call))).toHaveLength(0);
  h.socket.close();
});

test("deliberate disconnect survives retries; terminal refusal cannot reconnect", async () => {
  const h = await harness();
  await h.ui({ action: "disconnect" });
  await settle();
  expect(h.config()?.disabled).toBe(true);
  const before = h.sockets.length;
  await h.reconnect();
  expect(h.sockets).toHaveLength(before);
  await h.ui({ action: "reconnect" });
  await settle();
  expect(h.sockets).toHaveLength(before + 1);
  h.sockets.at(-1)!.receive({ kind: "refused" });
  await settle();
  expect(h.config()?.blocked).toBe(true);
  expect(await h.ui({ action: "reconnect" })).toHaveProperty("error");
  expect(h.sockets).toHaveLength(before + 1);
});

test("unpair claims success only after generation-bound acknowledgement", async () => {
  const h = await harness();
  const pending = h.ui({ action: "unpair", generation: "generation-1" });
  await settle();
  expect(h.socket.sent.at(-1)).toEqual({ kind: "unpair", generation: "generation-1" });
  h.socket.receive({ kind: "unpaired", generation: "old" });
  expect(h.config()?.credential).toBe("fixture");
  h.socket.receive({ kind: "unpaired", generation: "generation-1" });
  expect((await pending).state).toBe("unpaired");
  expect(h.config()).toBeNull();
  const lost = await harness();
  const unknown = lost.ui({ action: "unpair", generation: "generation-1" });
  await settle();
  lost.socket.close();
  expect((await unknown).state).toBe("unknown");
  expect(await lost.ui({ action: "reconnect" })).toHaveProperty("error");
});
