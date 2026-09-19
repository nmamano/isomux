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
  let detach: (tabId: number) => Promise<void> = async () => {};
  let focus: () => Promise<unknown> = async () => ({});
  const focused: Array<{ tabId: number; params: unknown }> = [];
  let targetInfo: (tabId: number) => Promise<unknown> = async (tabId) => ({
    targetInfo: {
      targetId: tabId === 7 ? "owned" : `target-${tabId}`,
      type: "page",
      url: "https://example.com/",
    },
  });
  let changed!: (_changes: unknown, area: string) => void;
  let selected = { id: 7, url: "https://example.com/", active: true, windowId: 1 };
  let getTab = async () => selected;
  let assignment = "assignment";
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
      const msg = fields(JSON.parse(data));
      this.sent.push(msg);
      if (msg.kind === "result" && msg.id === 1) queueMicrotask(() => this.receive({
        kind: "offered", generation: "generation-1", assignment, error: msg.error,
      }));
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
    receive(message: Fields) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  let runtimeMessage!: (
    value: unknown,
    sender: { id?: string; url?: string },
    reply: (value: unknown) => void,
  ) => boolean | undefined;
  let config: Record<string, unknown> | null = {
    url: "ws://127.0.0.1/extension",
    credential: "fixture",
  };
  const badges: { text: string | null; tabId?: number }[] = [];
  const chrome = {
    action: {
      setBadgeText: async (value: { text: string | null; tabId?: number }) => {
        badges.push(value);
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
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
      onMessage: {
        addListener: (fn: typeof runtimeMessage) => {
          runtimeMessage = fn;
        },
      },
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
      query: async () => [selected],
      get: () => getTab(),
    },
    debugger: {
      attach: () => {
        calls.push("attach");
        return attach();
      },
      detach: (target: { tabId: number }) => {
        calls.push("detach");
        return detach(target.tabId);
      },
      sendCommand: (target: { tabId: number }, method: string, params?: unknown) => {
        calls.push(method);
        if (method === "Emulation.setFocusEmulationEnabled") {
          focused.push({ tabId: target.tabId, params });
          return focus();
        }
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
    navigator: { language: "en" },
    WebSocket: FakeSocket,
    URL,
    crypto,
    queueMicrotask,
    setTimeout: (fn: () => void) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  await settle();
  const socket = sockets[0];
  socket.onopen?.();
  socket.receive({ kind: "ready", version: 2, generation: "generation-1" });
  socket.receive({ kind: "metadata", generation: "generation-1", member: { id: "m", name: "Member" },
    agents: [{ id: "a", name: "Agent" }, { id: "b", name: "Other" }], assignments: [] });
  const ui = (message: unknown) => new Promise<Record<string, unknown>>((resolve) => runtimeMessage({ tabId: selected.id, windowId: 1, ...(message as object) },
    { id: "fixture-id", url: "chrome-extension://fixture-id/connection.html" },
    (value) => resolve(value as Record<string, unknown>)));
  return {
    socket,
    selected: (id: number, url = "https://example.com/") => { selected = { id, url, active: true, windowId: 1 }; },
    assignment: () => assignment,
    startOffer: async () => {
      const result = ui({ action: "offer", generation: "generation-1", tabId: selected.id, agent: "a" });
      await settle();
      assignment = String(socket.sent.findLast((m) => m.kind === "offer")!.assignment);
      return { result, assignment };
    },
    offer: async () => {
      const result = ui({ action: "offer", generation: "generation-1", tabId: selected.id, agent: "a" });
      await settle();
      assignment = String(socket.sent.findLast((m) => m.kind === "offer")!.assignment);
      socket.receive({ kind: "command", assignment, id: 1, generation: "generation-1", method: "attach", params: {} });
      await settle();
      return result;
    },
    sockets,
    badges,
    config: () => config,
    ui: (message: unknown) =>
      new Promise<Record<string, unknown>>((resolve) =>
        runtimeMessage(
          { tabId: selected.id, windowId: 1, ...(message as object) },
          {
            id: "fixture-id",
            url: "chrome-extension://fixture-id/connection.html",
          },
          (value) => resolve(value as Record<string, unknown>),
        ),
      ),
    foreign: (sender: { id?: string; url?: string }) =>
      runtimeMessage({ action: "state" }, sender, () => {
        throw new Error("Foreign reply");
      }),
    calls,
    focused,
    failFocus: () => { focus = async () => { throw new Error("focus failed"); }; },
    timers,
    navigation: (sourceTabId: number, tabId: number) =>
      navigation({ sourceTabId, tabId }),
    delayDetach: (tabId: number) => {
      let reached = false;
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      detach = async (id) => {
        if (id !== tabId) return;
        reached = true;
        await pending;
      };
      return { reached: () => reached, finish };
    },
    delayPopup: (stage: "attach" | "target" | "focus") => {
      let resolve!: () => void;
      if (stage === "attach")
        attach = () =>
          new Promise<void>((done) => {
            resolve = done;
          });
      else if (stage === "focus")
        focus = () => { focus = async () => ({}); return new Promise<void>(done => { resolve = done; }); };
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
      let resolve!: (value: { id: number; url: string; active: boolean; windowId: number }) => void;
      getTab = () =>
        new Promise((done) => {
          resolve = done;
        });
      return () => resolve({ id: 7, url: "https://example.com/", active: true, windowId: 1 });
    },
    command: (
      id: number,
      method: string,
      params: Fields = {},
      generation = "generation-1",
    ) =>
      socket.receive({
        kind: "command",
        assignment,
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
  await h.offer();
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(1);
  h.socket.close();
  h.command(3, "cdp", { method: "Runtime.evaluate", params: {} });
  await settle();
  expect(h.calls).not.toContain("Runtime.evaluate");
  expect(h.calls).toContain("detach");
  const fresh = await h.reconnect();
  fresh.onopen?.();
  fresh.receive({ kind: "ready", version: 2, generation: "generation-2" });
  fresh.receive({
    kind: "command",
    assignment: "assignment",
    id: 2,
    generation: "generation-1",
    method: "create",
    params: {},
  });
  await settle();
  expect(h.calls.filter((call) => call === "create")).toHaveLength(0);
  fresh.close();
});

test("Off while the tab lookup is pending prevents debugger attachment", async () => {
  const h = await harness();
  const offer = await h.startOffer();
  const finish = h.delayCreate();
  h.command(1, "attach");
  await settle();
  h.command(2, "detach");
  finish();
  await settle();
  expect(h.calls).not.toContain("attach");
  await offer.result;
  h.socket.close();
});

test("built worker refuses unknown child sessions and profile commands", async () => {
  const h = await harness();
  await h.offer();
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
  fresh.receive({ kind: "ready", version: 2, generation: "fresh" });
  fresh.receive({ kind: "refused" });
  expect(fresh.readyState).toBe(3);
  expect(h.timers.size).toBe(0);
});

test("navigation ownership uses only an assigned source and admits one leaf chain", async () => {
  const h = await harness();
  await h.offer();
  const attached = h.calls.filter((call) => call === "attach").length;
  expect(h.focused).toEqual([{ tabId: 7, params: { enabled: true } }]);
  expect(h.calls).toEqual(["attach", "Emulation.setFocusEmulationEnabled", "Target.getTargetInfo"]);
  h.navigation(900, 901);
  await settle();
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(attached);
  h.navigation(7, 8);
  await settle();
  expect(
    h.socket.sent.filter((message) => message.method === "popup"),
  ).toHaveLength(1);
  expect(h.focused).toEqual([{ tabId: 7, params: { enabled: true } }, { tabId: 8, params: { enabled: true } }]);
  expect(h.calls.slice(-3)).toEqual(["attach", "Emulation.setFocusEmulationEnabled", "Target.getTargetInfo"]);
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

for (const stage of ["attach", "target", "focus"] as const) {
  test(`popup ownership lost during ${stage} never publishes the popup`, async () => {
    const h = await harness();
    await h.offer();
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
  expect(
    h.foreign({ id: "fixture-id", url: "https://example.com/" }),
  ).toBeUndefined();
  expect(
    h.foreign({
      id: "foreign",
      url: "chrome-extension://fixture-id/connection.html",
    }),
  ).toBeUndefined();
  h.socket.receive({
    kind: "metadata",
    generation: "generation-1",
    member: { id: "m", name: "Member" },
    agents: [{ id: "a", name: "Agent" }],
    assignments: [],
  });
  await h.offer();
  const state = await h.ui({ action: "state" });
  expect(state.member).toEqual({ id: "m", name: "Member" });
  expect(state).not.toHaveProperty("credential");
  expect(state).not.toHaveProperty("code");
  expect(state.assignments).toHaveLength(1);
  expect(h.badges).toContainEqual({ tabId: 7, text: "ON" });
  expect(h.badges.filter((badge) => badge.tabId === undefined).every((badge) => badge.text === "")).toBe(true);
  expect(
    await h.ui({ action: "stop", generation: "old", assignment: h.assignment() }),
  ).toHaveProperty("error");
  expect((await h.ui({ action: "state" })).assignments).toHaveLength(1);
  await h.ui({
    action: "stop",
    generation: "generation-1",
    assignment: h.assignment(),
  });
  expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
  expect(h.calls).toContain("detach");
  expect(h.socket.sent).toContainEqual({
    kind: "event",
    generation: "generation-1",
    assignment: h.assignment(),
    method: "detached",
    params: {},
  });
  expect(
    h.calls.filter((call) => /close|remove|media|audio/i.test(call)),
  ).toHaveLength(0);
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
  expect(h.socket.sent.at(-1)).toEqual({
    kind: "unpair",
    generation: "generation-1",
  });
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


for (const popup of [false, true]) {
  test(`failed ${popup ? "popup" : "root"} focus setup detaches without publishing a target`, async () => {
    const h = await harness();
    if (popup) { await h.offer(); }
    h.failFocus();
    if (popup) h.navigation(7, 8);
    else void h.offer();
    await settle();
    expect(h.focused.at(-1)?.tabId).toBe(popup ? 8 : 7);
    expect(h.calls).toContain("detach");
    expect(h.socket.sent.some(m => m.method === "popup")).toBe(false);
    if (!popup) expect(h.socket.sent.find(m => m.kind === "result" && m.id === 1)?.error).toBeTruthy();
    h.socket.close();
  });
}

test("root ownership lost during focus setup cannot publish its target", async () => {
  const h = await harness();
  const finish = h.delayPopup("focus");
  const offering = h.offer();
  await settle();
  await settle();
  expect(h.focused).toHaveLength(1);
  h.command(2, "detach");
  finish();
  await settle();
  expect(h.socket.sent.find(m => m.kind === "result" && m.id === 1)?.error).toBeTruthy();
  await offering;
  expect(h.calls).not.toContain("Target.getTargetInfo");
  expect(h.calls).toContain("detach");
  h.socket.close();
});


test("detach restores focus on only the root and its owned popup", async () => {
  const h = await harness();
  await h.offer();
  h.navigation(7, 8);
  await settle();
  h.navigation(900, 901);
  h.command(2, "detach");
  await settle();
  expect(h.focused).toEqual([
    { tabId: 7, params: { enabled: true } },
    { tabId: 8, params: { enabled: true } },
    { tabId: 8, params: { enabled: false } },
    { tabId: 7, params: { enabled: false } },
  ]);
  expect(h.calls.filter(c => c === "detach")).toHaveLength(2);
  expect(h.calls.slice(-4)).toEqual(["Emulation.setFocusEmulationEnabled", "detach", "Emulation.setFocusEmulationEnabled", "detach"]);
  h.socket.close();
});

for (const conflict of ["agent", "tab", "popup"] as const) {
  test(`explicit offer rejects an owned ${conflict} without a transfer`, async () => {
    const h = await harness();
    await h.offer();
    if (conflict === "agent") h.selected(9);
    if (conflict === "popup") { h.navigation(7, 8); await settle(); h.selected(8); }
    const before = h.socket.sent.filter(m => m.kind === "offer").length;
    const result = await h.ui({ action: "offer", generation: "generation-1", tabId: conflict === "agent" ? 9 : conflict === "popup" ? 8 : 7, agent: conflict === "agent" ? "a" : "b" });
    expect(result).toHaveProperty("error");
    expect(h.socket.sent.filter(m => m.kind === "offer")).toHaveLength(before);
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(1);
    h.socket.close();
  });
}

test("pending offer reserves both identities; Off prevents late acceptance and CDP", async () => {
  const h = await harness();
  const pending = await h.startOffer();
  expect(await h.ui({ action: "offer", generation: "generation-1", tabId: 7, agent: "b" })).toHaveProperty("error");
  h.selected(9);
  expect(await h.ui({ action: "offer", generation: "generation-1", tabId: 9, agent: "a" })).toHaveProperty("error");
  await h.ui({ action: "stop", generation: "generation-1", assignment: pending.assignment });
  h.socket.receive({ kind: "offered", generation: "generation-1", assignment: pending.assignment });
  h.command(1, "attach");
  h.command(2, "cdp", { method: "Runtime.evaluate", params: {} });
  await pending.result;
  await settle();
  expect(h.calls).not.toContain("attach");
  expect(h.calls).not.toContain("Runtime.evaluate");
  expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
  h.socket.close();
});

for (const url of ["chrome://settings", "chrome-extension://fixture-id/connection.html", "file:///tmp/test"]) {
  test(`offer rejects ineligible current tab ${new URL(url).protocol}`, async () => {
    const h = await harness();
    h.selected(7, url);
    const pending = h.ui({ action: "offer", generation: "generation-1", tabId: 7, agent: "a" });
    await settle();
    const sentOffer = h.socket.sent.some(m => m.kind === "offer");
    const messages = JSON.stringify(h.socket.sent);
    h.socket.close();
    const result = await pending;
    expect(sentOffer).toBe(false);
    expect(result).toHaveProperty("error");
    expect(messages).not.toContain(url);
  });
}

test("changed current tab and unoffered attach cannot expose a page", async () => {
  const h = await harness();
  h.selected(8);
  expect(await h.ui({ action: "offer", generation: "generation-1", tabId: 7, agent: "a" })).toHaveProperty("error");
  h.command(1, "attach");
  await settle();
  expect(h.calls).toHaveLength(0);
  expect(h.socket.sent.some(m => m.kind === "offer")).toBe(false);
  h.socket.close();
});


test("obsolete ready protocol fails closed without a tab grant", async () => {
  const h = await harness();
  h.socket.close();
  const fresh = await h.reconnect();
  fresh.onopen?.();
  fresh.receive({ kind: "ready", version: 1, generation: "obsolete" });
  await settle();
  expect(fresh.readyState).toBe(3);
  expect(h.config()?.blocked).toBe(true);
  expect(h.calls).toHaveLength(0);
});


test("a failed popup cleanup retains its tab reservation until detach finishes", async () => {
  const h = await harness();
  await h.offer();
  const finishTarget = h.delayPopup("target");
  h.navigation(7, 8);
  await settle();
  const oldDetach = h.delayDetach(8);
  const stopping = h.ui({ action: "stop", generation: "generation-1", assignment: h.assignment() });
  finishTarget();
  await settle();
  expect(oldDetach.reached()).toBe(true);
  h.selected(8);
  const conflicting = h.ui({ action: "offer", generation: "generation-1", agent: "b" });
  await settle();
  expect(h.socket.sent.filter(message => message.kind === "offer")).toHaveLength(1);
  expect(await conflicting).toHaveProperty("error");
  oldDetach.finish();
  await stopping;
  expect(h.calls.filter(call => call === "detach")).toHaveLength(2);
  const next = h.ui({ action: "offer", generation: "generation-1", agent: "b" });
  await settle();
  const offers = h.socket.sent.filter(message => message.kind === "offer");
  expect(offers).toHaveLength(2);
  expect(offers[1].agent).toBe("b");
  h.socket.close();
  await next;
});


for (const mismatch of [false, true]) {
  test(`authoritative metadata revokes an ON grant with ${mismatch ? "a different agent" : "no assignment"}`, async () => {
    const h = await harness();
    await h.offer();
    h.navigation(7, 8);
    await settle();
    const metadata = {
      kind: "metadata", generation: "generation-1", member: { id: "m", name: "Member" },
      agents: [{ id: "a", name: "Agent" }, { id: "b", name: "Other" }],
      assignments: mismatch ? [{ id: h.assignment(), agent: { id: "b", name: "Other" } }] : [],
    };
    h.socket.receive({ ...metadata, generation: "old" });
    expect((await h.ui({ action: "state" })).assignments).toMatchObject([{ phase: "on" }]);
    expect(h.calls.filter(call => call === "detach")).toHaveLength(0);
    const cleanup = h.delayDetach(7);
    h.socket.receive(metadata);
    const state = await h.ui({ action: "state" });
    const calls = h.calls.length;
    h.command(9, "cdp", { method: "Runtime.evaluate", params: {} });
    await settle();
    const revoking = state.assignments;
    const blocked = h.socket.sent.find(message => message.kind === "result" && message.id === 9);
    const badge = (tabId: number) => h.badges.findLast(value => value.tabId === tabId)?.text;
    const rootBadge = badge(7), popupBadge = badge(8);
    const reached = cleanup.reached();
    const detached = h.socket.sent.filter(message => message.method === "detached");
    h.socket.receive(metadata);
    h.command(10, "detach");
    cleanup.finish();
    await settle();
    expect(revoking).toMatchObject([{ phase: "revoking" }]);
    expect(blocked?.error).toBeTruthy();
    expect(h.calls.slice(calls)).not.toContain("Runtime.evaluate");
    expect(rootBadge).not.toBe("ON");
    expect(popupBadge).not.toBe("ON");
    expect(reached).toBe(true);
    expect(detached).toMatchObject([{ generation: "generation-1", assignment: h.assignment() }]);
    expect(detached).toHaveLength(1);
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
    expect(h.calls.filter(call => call === "detach")).toHaveLength(2);
    expect(h.focused.filter(value => fields(value.params).enabled === false).map(value => value.tabId)).toEqual([8, 7]);
    h.socket.close();
  });
}

test("metadata before offer acknowledgement preserves the pending attachment", async () => {
  const h = await harness();
  const pending = await h.startOffer();
  const finish = h.delayPopup("focus");
  h.command(1, "attach");
  await settle();
  h.socket.receive({ kind: "metadata", generation: "generation-1", member: { id: "m", name: "Member" },
    agents: [{ id: "a", name: "Agent" }], assignments: [] });
  const state = await h.ui({ action: "state" });
  const detached = h.socket.sent.some(message => message.method === "detached");
  finish();
  const result = await pending.result;
  expect(state.assignments).toMatchObject([{ phase: "offering" }]);
  expect(detached).toBe(false);
  expect(result.assignments).toMatchObject([{ phase: "on" }]);
  h.socket.receive({ kind: "metadata", generation: "generation-1", member: { id: "m", name: "Member" },
    agents: [{ id: "a", name: "Agent" }], assignments: [{ id: h.assignment(), agent: { id: "a", name: "Agent" } }] });
  await settle();
  expect((await h.ui({ action: "state" })).assignments).toMatchObject([{ phase: "on" }]);
  expect(h.calls.filter(call => call === "detach")).toHaveLength(0);
  h.socket.close();
});
