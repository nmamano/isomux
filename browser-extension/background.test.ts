import { beforeAll, test, expect } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  ATTACH_ANSWER_MS,
  EXTENSION_MAX_BYTES,
  fields,
  type Fields,
} from "../shared/browser-extension-protocol";
import manifest from "./manifest.json";

// The scope of the member's offer from the popup on an office that does not
// take access messages, with the default setting (My agents): the popup names
// no agent and no expiry (task 7355640c).
const OFFERED = { kind: "all" } as const;

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

async function harness(
  autoAck = true,
  debuggerRecovery = true,
  // offerResume: the office advertises offer resume in ready. session: the
  // chrome.storage.session of an earlier worker, for a worker restart.
  // slowSession: session reads answer after the first socket could open.
  // extensionVersion: this extension's manifest version (default: the real
  // one). officePackage: the office's package in ready. leftover: the tabs
  // whose debugger session an earlier worker of this extension left attached
  // when Chrome stopped it; Chrome refuses a new attach to them until this
  // extension detaches them, and refuses a detach of any other tab.
  opts: {
    offerResume?: boolean;
    // The office accepts offers to All agents (task d4224f2f).
    officeScope?: boolean;
    session?: Map<string, unknown>;
    slowSession?: boolean;
    extensionVersion?: string;
    officePackage?: string;
    leftover?: number[];
    // The office takes agent tabs (task 73a9fb57): ready has agentTabs.
    agentTabs?: boolean;
    // The office takes access messages and shared offers (task 7355640c).
    access?: boolean;
    // chrome.storage.local apart from the connection, for example the agent
    // tabs setting and the opened tab ids an earlier run kept.
    local?: Map<string, unknown>;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const calls: string[] = [];
  let debuggerDetached!: (source: { tabId: number }, reason: string) => void;
  let cdpEvent!: (
    source: { tabId: number; sessionId?: string },
    method: string,
    params?: Fields,
  ) => void;
  // The UTF-8 size of every frame the extension sent.
  const frames: number[] = [];
  const leftover = opts.leftover ? new Set(opts.leftover) : undefined;
  let targets: Array<{ id: string; tabId?: number; type: string }> = leftover
    ? [
        // A tab this extension never attached, and a target with no tab.
        { id: "foreign", tabId: 5, type: "page" },
        { id: "worker", type: "service_worker" },
        ...[...leftover].map((tabId) => ({
          id: tabId === 7 ? "owned" : `target-${tabId}`,
          tabId,
          type: "page",
        })),
      ]
    : [{ id: "owned", tabId: 7, type: "page" }];
  let updated!: (id: number, change: { status?: string }) => void;
  let badgeDelay: () => Promise<void> = async () => {};
  let navigation!: (event: { sourceTabId: number; tabId: number }) => void;
  let attach: () => Promise<void> = async () => {};
  let detach: (tabId: number) => Promise<void> = async () => {};
  let evaluation: () => Promise<unknown> = async () => ({});
  let focus: () => Promise<unknown> = async () => ({});
  let chooser: () => Promise<unknown> = async () => ({});
  const intercepted: Array<{ tabId: number; params: unknown }> = [];
  // A tab that shows a JavaScript dialog: from the command `from` on, no
  // command to the tab answers. chrome.debugger.detach rejects the pending
  // ones, as Chrome does ("Detached while handling command.").
  const dialogs = new Map<
    number,
    {
      from: string;
      open: boolean;
      pending: Array<{ answer: () => void; fail: (error: Error) => void }>;
    }
  >();
  const detachedTabs: number[] = [];
  const focused: Array<{ tabId: number; params: unknown }> = [];
  let targetInfo: (tabId: number) => Promise<unknown> = async (tabId) => ({
    targetInfo: {
      targetId: tabId === 7 ? "owned" : `target-${tabId}`,
      type: "page",
      url: "https://example.com/",
    },
  });
  let changed!: (_changes: unknown, area: string) => void;
  let selected = {
    id: 7,
    url: "https://example.com/",
    active: true,
    windowId: 1,
  };
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
      frames.push(Buffer.byteLength(data));
      const msg = fields(JSON.parse(data));
      this.sent.push(msg);
      if (autoAck && msg.kind === "result" && msg.id === 1)
        queueMicrotask(() =>
          this.receive({
            kind: "offered",
            scope: this.sent.findLast(
              (m) => m.kind === "offer" && m.assignment === assignment,
            )?.scope,
            generation: "generation-1",
            assignment,
            durationMinutes: 0,
            expiresAt: null,
            error: msg.error,
          }),
        );
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
  const session = opts.session ?? new Map<string, unknown>();
  const local = opts.local ?? new Map<string, unknown>();
  // Tabs and windows the extension made. Made tabs show about:blank until a
  // test changes their url; a removed one leaves both maps.
  let nextTab = 100;
  let nextWindow = 10;
  const madeTabs = new Map<
    number,
    { id: number; windowId: number; url: string }
  >();
  const windows = new Map<number, { id: number; state?: string }>();
  const tabUpdates: Array<{ tabId: number; options: Record<string, unknown> }> =
    [];
  const removedTabs: number[] = [];
  const createdWindows: Array<Record<string, unknown>> = [];
  let windowCreate: () => Promise<void> = async () => {};
  // The member's last focused normal window (null: Chrome has none), and the
  // window calls in order; "made" is a create that Chrome finished.
  // refuseBounds: Chrome refuses a create with bounds, as it does for bounds
  // mostly off screen. refuseUpdate: Chrome refuses a window update.
  let lastFocused: Record<string, unknown> | null = {
    id: 1,
    focused: true,
    state: "normal",
    left: 0,
    top: 0,
    width: 1200,
    height: 900,
  };
  const windowCalls: Array<{ call: string; arg?: unknown }> = [];
  let refuseBounds = false;
  let refuseUpdate = false;
  let installed!: (details: { reason: string }) => void;
  let startup!: () => void;
  const chrome = {
    action: {
      setBadgeText: async (value: { text: string | null; tabId?: number }) => {
        badges.push(value);
        await badgeDelay();
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    windows: {
      update: async (id: number, options: Record<string, unknown>) => {
        windowCalls.push({ call: "update", arg: { id, ...options } });
        if (refuseUpdate) throw new Error(`No window with id: ${id}.`);
      },
      create: async (options: Record<string, unknown>) => {
        windowCalls.push({ call: "create", arg: options });
        createdWindows.push(options);
        await windowCreate();
        if (
          refuseBounds &&
          ["left", "top", "width", "height"].some((key) => key in options)
        )
          throw new Error(
            "Invalid value for bounds. Bounds must be at least 50% within visible screen space.",
          );
        windowCalls.push({ call: "made" });
        const id = ++nextWindow;
        windows.set(id, {
          id,
          ...(typeof options.state === "string"
            ? { state: options.state }
            : {}),
        });
        const tab = { id: ++nextTab, windowId: id, url: "about:blank" };
        madeTabs.set(tab.id, tab);
        return { id, tabs: [{ ...tab }] };
      },
      get: async (id: number) => {
        const window = windows.get(id);
        if (!window) throw new Error(`No window with id: ${id}.`);
        return { ...window };
      },
      getLastFocused: async (options: unknown) => {
        windowCalls.push({ call: "getLastFocused", arg: options });
        if (!lastFocused) throw new Error("No last-focused window");
        return { ...lastFocused };
      },
    },
    alarms: {
      create: async () => {},
      clear: async () => true,
      onAlarm: { addListener() {} },
    },
    storage: {
      local: {
        set: async (value: Record<string, unknown>) => {
          const changes: Record<string, { newValue: unknown }> = {};
          for (const [key, item] of Object.entries(value)) {
            if (key === "connection")
              config = item as Record<string, unknown> | null;
            else local.set(key, item);
            changes[key] = { newValue: item };
          }
          changed(changes, "local");
        },
        setAccessLevel: () => Promise.resolve(),
        // One key or several, as Chrome takes them.
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .flatMap((key) =>
                key === "connection"
                  ? [["connection", config]]
                  : local.has(key)
                    ? [[key, local.get(key)]]
                    : [],
              ),
          ),
        remove: async (keys: string | string[]) => {
          const changes: Record<string, object> = {};
          for (const key of [keys].flat()) {
            local.delete(key);
            changes[key] = {};
          }
          changed(changes, "local");
        },
      },
      session: {
        get: async (key: string) => {
          if (opts.slowSession)
            await new Promise((resolve) => setTimeout(resolve, 20));
          return session.has(key) ? { [key]: session.get(key) } : {};
        },
        set: async (value: Record<string, unknown>) => {
          for (const [key, item] of Object.entries(value))
            session.set(key, item);
        },
        remove: async (keys: string | string[]) => {
          for (const key of [keys].flat()) session.delete(key);
        },
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
      getManifest: () => ({
        version: opts.extensionVersion ?? manifest.version,
      }),
      onMessage: {
        addListener: (fn: typeof runtimeMessage) => {
          runtimeMessage = fn;
        },
      },
      onStartup: {
        addListener: (fn: typeof startup) => {
          startup = fn;
        },
      },
      onInstalled: {
        addListener: (fn: typeof installed) => {
          installed = fn;
        },
      },
    },
    webNavigation: {
      onCreatedNavigationTarget: {
        addListener: (fn: typeof navigation) => {
          navigation = fn;
        },
      },
    },
    tabs: {
      onUpdated: {
        addListener(fn: typeof updated) {
          updated = fn;
        },
      },
      update: async (tabId: number, options: Record<string, unknown>) => {
        tabUpdates.push({ tabId, options });
        return { windowId: madeTabs.get(tabId)?.windowId ?? 1 };
      },
      query: async () => [selected],
      get: (id: number) => {
        const made = madeTabs.get(id);
        return made
          ? // Without the tabs permission, Chrome gives no url for a tab
            // the extension made.
            Promise.resolve({
              id: made.id,
              windowId: made.windowId,
              active: false,
            })
          : made === undefined && removedTabs.includes(id)
            ? Promise.reject(new Error(`No tab with id: ${id}.`))
            : getTab();
      },
      create: async (options: { windowId?: number; url?: string }) => {
        if (options.windowId !== undefined && !windows.has(options.windowId))
          throw new Error(`No window with id: ${options.windowId}.`);
        const tab = {
          id: ++nextTab,
          windowId: options.windowId ?? 1,
          url: options.url ?? "about:blank",
        };
        madeTabs.set(tab.id, tab);
        return { ...tab };
      },
      remove: async (ids: number | number[]) => {
        for (const id of [ids].flat()) {
          removedTabs.push(id);
          const made = madeTabs.get(id);
          madeTabs.delete(id);
          // Chrome closes a window with its last tab.
          if (
            made &&
            ![...madeTabs.values()].some((t) => t.windowId === made.windowId)
          )
            windows.delete(made.windowId);
        }
      },
    },
    debugger: {
      getTargets: async () => targets,
      attach: async (target: { tabId: number }) => {
        calls.push("attach");
        if (leftover?.has(target.tabId))
          throw new Error(
            `Another debugger is already attached to the tab with id: ${target.tabId}.`,
          );
        await attach();
        leftover?.add(target.tabId);
      },
      detach: async (target: { tabId: number }) => {
        calls.push("detach");
        detachedTabs.push(target.tabId);
        // Chrome answers a detach later than the storage reads a worker
        // starts with.
        if (leftover) for (let i = 0; i < 3; i++) await settle();
        if (leftover && !leftover.delete(target.tabId))
          throw new Error(
            `Debugger is not attached to the tab with id: ${target.tabId}.`,
          );
        const dialog = dialogs.get(target.tabId);
        for (const command of dialog?.pending.splice(0) ?? [])
          command.fail(new Error("Detached while handling command."));
        return detach(target.tabId);
      },
      sendCommand: (
        target: { tabId: number },
        method: string,
        params?: unknown,
      ) => {
        calls.push(method);
        const dialog = dialogs.get(target.tabId);
        if (dialog && (dialog.open || method === dialog.from)) {
          dialog.open = true;
          return new Promise((resolve, reject) =>
            dialog.pending.push({
              answer: () => resolve(answer(target, method, params)),
              fail: reject,
            }),
          );
        }
        return answer(target, method, params);
      },
      onEvent: {
        addListener(fn: typeof cdpEvent) {
          cdpEvent = fn;
        },
      },
      onDetach: {
        addListener(fn: typeof debuggerDetached) {
          debuggerDetached = fn;
        },
      },
    },
  };
  function answer(
    target: { tabId: number },
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    if (method === "Runtime.evaluate") return evaluation();
    if (method === "Page.setInterceptFileChooserDialog") {
      intercepted.push({ tabId: target.tabId, params });
      return chooser();
    }
    if (method === "Emulation.setFocusEmulationEnabled") {
      focused.push({ tabId: target.tabId, params });
      return focus();
    }
    const made = madeTabs.get(target.tabId);
    if (method === "Target.getTargetInfo" && made)
      return Promise.resolve({
        targetInfo: {
          targetId: `target-${target.tabId}`,
          type: "page",
          url: made.url,
        },
      });
    return method === "Target.getTargetInfo"
      ? targetInfo(target.tabId)
      : Promise.resolve({});
  }
  const timers = new Map<number, () => void>();
  const delays = new Map<number, number | undefined>();
  let timerId = 0;
  runInNewContext(source, {
    chrome,
    navigator: { language: "en" },
    WebSocket: FakeSocket,
    URL,
    crypto,
    queueMicrotask,
    setTimeout: (fn: () => void, ms?: number) => {
      timers.set(++timerId, fn);
      delays.set(timerId, ms);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  for (let i = 0; i < 100 && !sockets.length; i++) await settle();
  // A test's calls start at its first connection: the worker's start-up
  // release of leftover debugger sessions is not one of them.
  calls.length = 0;
  detachedTabs.length = 0;
  const socket = sockets[0];
  socket.onopen?.();
  socket.receive({
    kind: "ready",
    version: 4,
    generation: "generation-1",
    debuggerRecovery,
    ...(opts.offerResume ? { offerResume: true } : {}),
    ...(opts.officeScope ? { officeScope: true } : {}),
    ...(opts.officePackage ? { package: opts.officePackage } : {}),
    ...(opts.agentTabs ? { agentTabs: true } : {}),
    ...(opts.access ? { access: true } : {}),
  });
  socket.receive({
    kind: "metadata",
    generation: "generation-1",
    member: { id: "m", name: "Member" },
    agents: [
      { id: "a", name: "Agent" },
      { id: "b", name: "Other" },
    ],
    assignments: [],
  });
  const ui = (message: unknown) =>
    new Promise<Record<string, unknown>>((resolve) =>
      runtimeMessage(
        {
          tabId: selected.id,
          windowId: 1,
          ...(message as object),
        },
        {
          id: "fixture-id",
          url: "chrome-extension://fixture-id/connection.html",
        },
        (value) => resolve(value as Record<string, unknown>),
      ),
    );
  return {
    socket,
    selected: (id: number, url = "https://example.com/") => {
      selected = { id, url, active: true, windowId: 1 };
    },
    assignment: () => assignment,
    startOffer: async () => {
      const result = ui({
        action: "offer",
        generation: "generation-1",
        tabId: selected.id,
      });
      await settle();
      assignment = String(
        socket.sent.findLast((m) => m.kind === "offer")!.assignment,
      );
      return { result, assignment };
    },
    offer: async () => {
      const result = ui({
        action: "offer",
        generation: "generation-1",
        tabId: selected.id,
      });
      await settle();
      assignment = String(
        socket.sent.findLast((m) => m.kind === "offer")!.assignment,
      );
      socket.receive({
        kind: "command",
        assignment,
        id: 1,
        generation: "generation-1",
        method: "attach",
        params: {},
      });
      await settle();
      return result;
    },
    sockets,
    badges,
    updated: (id: number, status = "complete") => updated(id, { status }),
    delayBadge: (fn: () => Promise<void>) => {
      badgeDelay = fn;
    },
    config: () => config,
    session,
    ui: (message: unknown) =>
      new Promise<Record<string, unknown>>((resolve) =>
        runtimeMessage(
          {
            tabId: selected.id,
            windowId: 1,
            ...(message as object),
          },
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
    debuggerDetached: (reason: string, tabId = 7) =>
      debuggerDetached({ tabId }, reason),
    targets: (value: typeof targets) => {
      targets = value;
    },
    holdEvaluation: () => {
      let finish!: () => void;
      evaluation = () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        });
      return () => finish();
    },
    failAttach: (message = "attach failed") => {
      attach = async () => {
        throw new Error(message);
      };
    },
    // Chrome's answer to the next Runtime.evaluate commands.
    answerEvaluation: (value: unknown) => {
      evaluation = async () => value;
    },
    cdpEvent: (tabId: number, method: string, params: Fields) =>
      cdpEvent({ tabId }, method, params),
    frames,
    removeTab: () => {
      getTab = async () => {
        throw new Error("tab closed");
      };
    },
    focused,
    intercepted,
    delayChooser: () => {
      let finish!: () => void;
      chooser = () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        });
      return () => finish();
    },
    failFocus: () => {
      focus = async () => {
        throw new Error("focus failed");
      };
    },
    timers,
    // Runs every pending timer set for `ms`; returns how many ran.
    fire: (ms: number) => {
      const due = [...timers].filter(([id]) => delays.get(id) === ms);
      for (const [id, run] of due) {
        timers.delete(id);
        run();
      }
      return due.length;
    },
    pendingTimers: (ms: number) =>
      [...timers.keys()].filter((id) => delays.get(id) === ms).length,
    dialog: (tabId: number, from: string) =>
      dialogs.set(tabId, { from, open: false, pending: [] }),
    // Chrome answers the commands that waited when the member closes it.
    closeDialog: (tabId: number) => {
      for (const command of dialogs.get(tabId)?.pending ?? []) command.answer();
      dialogs.delete(tabId);
    },
    detachedTabs,
    navigation: (sourceTabId: number, tabId: number) =>
      navigation({ sourceTabId, tabId }),
    delayDetach: (tabId: number) => {
      let reached = false;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
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
        focus = () => {
          focus = async () => ({});
          return new Promise<void>((done) => {
            resolve = done;
          });
        };
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
      changed({ connection: { newValue: config } }, "local");
      await settle();
      return sockets.at(-1)!;
    },
    delayCreate: () => {
      let resolve!: (value: {
        id: number;
        url: string;
        active: boolean;
        windowId: number;
      }) => void;
      getTab = () =>
        new Promise((done) => {
          resolve = done;
        });
      return () =>
        resolve({
          id: 7,
          url: "https://example.com/",
          active: true,
          windowId: 1,
        });
    },
    local,
    madeTabs,
    windows,
    tabUpdates,
    removedTabs,
    createdWindows,
    windowCalls,
    lastFocused: (window: Record<string, unknown> | null) => {
      lastFocused = window;
    },
    refuseBounds: () => {
      refuseBounds = true;
    },
    refuseUpdate: () => {
      refuseUpdate = true;
    },
    // Holds the next windows.create until the returned function runs.
    delayWindow: () => {
      let finish!: () => void;
      windowCreate = () => {
        windowCreate = async () => {};
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      };
      return () => finish();
    },
    // The member closes a window: Chrome removes it and its tabs.
    closeWindow: (id: number) => {
      windows.delete(id);
      for (const [tabId, tab] of madeTabs)
        if (tab.windowId === id) {
          madeTabs.delete(tabId);
          removedTabs.push(tabId);
        }
    },
    installed: (reason: string) => installed({ reason }),
    startup: () => startup(),
    // The office asks for a tab that the agent opens (an open command).
    open: (
      id: number,
      openAssignment: string,
      params: Fields = {
        agentId: "a",
        agentName: "Agent",
        scope: { kind: "opened", agentId: "a", via: "all" },
      },
    ) => {
      assignment = openAssignment;
      socket.receive({
        kind: "command",
        assignment: openAssignment,
        id,
        generation: "generation-1",
        method: "open",
        params,
      });
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
  await h.offer();
  const evaluate = { method: "Runtime.evaluate", params: {} };
  h.command(2, "cdp", evaluate);
  await settle();
  // The enabling condition: a current-generation command reaches the page.
  expect(h.calls.filter((call) => call === "Runtime.evaluate")).toHaveLength(1);
  h.command(3, "cdp", evaluate, "old-generation");
  await settle();
  expect(h.calls.filter((call) => call === "Runtime.evaluate")).toHaveLength(1);
  expect(h.socket.sent.some((m) => m.kind === "result" && m.id === 3)).toBe(
    false,
  );
  h.socket.close();
  h.command(4, "cdp", evaluate);
  await settle();
  expect(h.calls.filter((call) => call === "Runtime.evaluate")).toHaveLength(1);
  expect(h.calls).toContain("detach");
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

// The command filter's full table is pinned at the server bridge
// (server/browser-extension-bridge.test.ts); here the worker must apply it.
test("built worker permits owned frame hit testing but refuses foreign sessions and profile commands", async () => {
  const h = await harness();
  await h.offer();
  h.command(2, "cdp", {
    method: "DOM.getFrameOwner",
    params: { frameId: "child" },
  });
  await settle();
  const count = h.calls.length;
  expect(h.calls.at(-1)).toBe("DOM.getFrameOwner");
  h.command(3, "cdp", {
    method: "DOM.getFrameOwner",
    sessionId: "foreign",
    params: { frameId: "child" },
  });
  h.command(4, "cdp", { method: "Storage.getCookies", params: {} });
  h.command(5, "cdp", {
    method: "DOM.getFrameOwner",
    params: { frameId: "child", targetId: "foreign" },
  });
  await settle();
  expect(h.calls).toHaveLength(count);
  for (const id of [3, 4, 5])
    expect(
      h.socket.sent.find((m) => m.kind === "result" && m.id === id)?.error,
    ).toBeTruthy();
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
  fresh.receive({ kind: "ready", version: 4, generation: "fresh" });
  fresh.receive({ kind: "refused" });
  expect(fresh.readyState).toBe(3);
  expect(h.timers.size).toBe(0);
});

test("navigation ownership uses only an assigned source and admits one leaf chain", async () => {
  const h = await harness();
  await h.offer();
  const attached = h.calls.filter((call) => call === "attach").length;
  expect(h.focused).toEqual([{ tabId: 7, params: { enabled: true } }]);
  expect(h.intercepted).toEqual([{ tabId: 7, params: { enabled: true } }]);
  expect(h.calls).toEqual([
    "attach",
    "Page.enable",
    "Page.setInterceptFileChooserDialog",
    "Emulation.setFocusEmulationEnabled",
    "Target.getTargetInfo",
  ]);
  h.navigation(900, 901);
  await settle();
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(attached);
  h.navigation(7, 8);
  await settle();
  expect(
    h.socket.sent.filter((message) => message.method === "popup"),
  ).toHaveLength(1);
  expect(h.focused).toEqual([
    { tabId: 7, params: { enabled: true } },
    { tabId: 8, params: { enabled: true } },
  ]);
  expect(h.intercepted).toEqual([
    { tabId: 7, params: { enabled: true } },
    { tabId: 8, params: { enabled: true } },
  ]);
  expect(h.calls.slice(-5)).toEqual([
    "attach",
    "Page.enable",
    "Page.setInterceptFileChooserDialog",
    "Emulation.setFocusEmulationEnabled",
    "Target.getTargetInfo",
  ]);
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

test("popup is exact-extension-only, does not disclose credentials, and stops a grant only in its generation", async () => {
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
  await h.offer();
  const state = await h.ui({ action: "state" });
  expect(state.member).toEqual({ id: "m", name: "Member" });
  expect(state).not.toHaveProperty("credential");
  expect(state).not.toHaveProperty("code");
  expect(state.assignments).toHaveLength(1);
  expect(h.badges).toContainEqual({ tabId: 7, text: "ON" });
  expect(
    h.badges
      .filter((badge) => badge.tabId === undefined)
      .every((badge) => badge.text === ""),
  ).toBe(true);
  expect(
    await h.ui({
      action: "stop",
      generation: "old",
      assignment: h.assignment(),
    }),
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
    params: { cause: "off" },
  });
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
  await settle();
  expect(h.socket.readyState).toBe(1);
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
    // A root offer stays unacknowledged, so only the failed setup can detach.
    const h = await harness(popup);
    if (popup) {
      await h.offer();
    }
    h.failFocus();
    if (popup) h.navigation(7, 8);
    else void h.offer();
    await settle();
    expect(h.focused.at(-1)?.tabId).toBe(popup ? 8 : 7);
    expect(h.calls).toContain("detach");
    expect(h.socket.sent.some((m) => m.method === "popup")).toBe(false);
    if (!popup)
      expect(
        h.socket.sent.find((m) => m.kind === "result" && m.id === 1)?.error,
      ).toBeTruthy();
    h.socket.close();
  });
}

for (const stage of ["chooser", "focus"] as const) {
  test(`root ownership lost during ${stage} setup cannot publish its target`, async () => {
    const h = await harness();
    const finish =
      stage === "chooser" ? h.delayChooser() : h.delayPopup("focus");
    const offering = h.offer();
    await settle();
    await settle();
    expect((stage === "chooser" ? h.intercepted : h.focused).length).toBe(1);
    h.command(2, "detach");
    finish();
    await settle();
    expect(
      h.socket.sent.find((m) => m.kind === "result" && m.id === 1)?.error,
    ).toBeTruthy();
    await offering;
    // No setup step after the held one runs: cleanup only turns focus off.
    expect(
      h.focused.filter((value) => fields(value.params).enabled === true),
    ).toHaveLength(stage === "focus" ? 1 : 0);
    expect(h.calls).not.toContain("Target.getTargetInfo");
    expect(h.calls).toContain("detach");
    h.socket.close();
  });
}

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
  expect(h.calls.filter((c) => c === "detach")).toHaveLength(2);
  expect(h.calls.slice(-4)).toEqual([
    "Emulation.setFocusEmulationEnabled",
    "detach",
    "Emulation.setFocusEmulationEnabled",
    "detach",
  ]);
  h.socket.close();
});

for (const conflict of ["tab", "popup"] as const) {
  test(`explicit offer rejects an owned ${conflict} without a transfer`, async () => {
    const h = await harness();
    await h.offer();
    if (conflict === "popup") {
      h.navigation(7, 8);
      await settle();
      h.selected(8);
    }
    const before = h.socket.sent.filter((m) => m.kind === "offer").length;
    // Not awaited: an accepted offer would wait for an acknowledgement.
    const result = h.ui({
      action: "offer",
      generation: "generation-1",
    });
    await settle();
    expect(h.socket.sent.filter((m) => m.kind === "offer")).toHaveLength(
      before,
    );
    expect(await result).toHaveProperty("error");
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(1);
    h.socket.close();
  });
}

test("a pending offer reserves its tab; Off prevents late acceptance and CDP", async () => {
  const h = await harness();
  const pending = await h.startOffer();
  expect(
    await h.ui({
      action: "offer",
      generation: "generation-1",
      tabId: 7,
    }),
  ).toHaveProperty("error");
  await h.ui({
    action: "stop",
    generation: "generation-1",
    assignment: pending.assignment,
  });
  h.socket.receive({
    kind: "offered",
    scope: OFFERED,
    generation: "generation-1",
    assignment: pending.assignment,
  });
  h.command(1, "attach");
  h.command(2, "cdp", { method: "Runtime.evaluate", params: {} });
  await pending.result;
  await settle();
  expect(h.calls).not.toContain("attach");
  expect(h.calls).not.toContain("Runtime.evaluate");
  expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
  h.socket.close();
});

for (const url of [
  "chrome://settings",
  "chrome-extension://fixture-id/connection.html",
  "file:///tmp/test",
]) {
  test(`offer rejects ineligible current tab ${new URL(url).protocol}`, async () => {
    const h = await harness();
    h.selected(7, url);
    const pending = h.ui({
      action: "offer",
      generation: "generation-1",
      tabId: 7,
    });
    await settle();
    const sentOffer = h.socket.sent.some((m) => m.kind === "offer");
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
  expect(
    await h.ui({
      action: "offer",
      generation: "generation-1",
      tabId: 7,
    }),
  ).toHaveProperty("error");
  h.command(1, "attach");
  await settle();
  expect(h.calls).toHaveLength(0);
  expect(h.socket.sent.some((m) => m.kind === "offer")).toBe(false);
  h.socket.close();
});

test("obsolete ready protocol fails closed without a tab grant", async () => {
  const h = await harness();
  h.socket.close();
  const fresh = await h.reconnect();
  fresh.onopen?.();
  fresh.receive({ kind: "ready", version: 3, generation: "obsolete" });
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
  const stopping = h.ui({
    action: "stop",
    generation: "generation-1",
    assignment: h.assignment(),
  });
  finishTarget();
  await settle();
  expect(oldDetach.reached()).toBe(true);
  h.selected(8);
  const conflicting = h.ui({
    action: "offer",
    generation: "generation-1",
  });
  await settle();
  expect(
    h.socket.sent.filter((message) => message.kind === "offer"),
  ).toHaveLength(1);
  expect(await conflicting).toHaveProperty("error");
  oldDetach.finish();
  await stopping;
  expect(h.calls.filter((call) => call === "detach")).toHaveLength(2);
  const next = h.ui({
    action: "offer",
    generation: "generation-1",
  });
  await settle();
  const offers = h.socket.sent.filter((message) => message.kind === "offer");
  expect(offers).toHaveLength(2);
  expect(offers[1].scope).toEqual(OFFERED);
  h.socket.close();
  await next;
});

for (const mismatch of [false, true]) {
  test(`authoritative metadata revokes an ON grant with ${mismatch ? "another scope" : "no assignment"}`, async () => {
    const h = await harness();
    await h.offer();
    h.navigation(7, 8);
    await settle();
    const metadata = {
      kind: "metadata",
      generation: "generation-1",
      member: { id: "m", name: "Member" },
      agents: [
        { id: "a", name: "Agent" },
        { id: "b", name: "Other" },
      ],
      assignments: mismatch
        ? [
            {
              id: h.assignment(),
              scope: { kind: "office" },
              durationMinutes: 0,
              expiresAt: null,
            },
          ]
        : [],
    };
    h.socket.receive({ ...metadata, generation: "old" });
    expect((await h.ui({ action: "state" })).assignments).toMatchObject([
      { phase: "on" },
    ]);
    expect(h.calls.filter((call) => call === "detach")).toHaveLength(0);
    const cleanup = h.delayDetach(7);
    h.socket.receive(metadata);
    const state = await h.ui({ action: "state" });
    const calls = h.calls.length;
    h.command(9, "cdp", { method: "Runtime.evaluate", params: {} });
    await settle();
    const revoking = state.assignments;
    const blocked = h.socket.sent.find(
      (message) => message.kind === "result" && message.id === 9,
    );
    const badge = (tabId: number) =>
      h.badges.findLast((value) => value.tabId === tabId)?.text;
    const rootBadge = badge(7),
      popupBadge = badge(8);
    const reached = cleanup.reached();
    const detached = h.socket.sent.filter(
      (message) => message.method === "detached",
    );
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
    expect(detached).toMatchObject([
      { generation: "generation-1", assignment: h.assignment() },
    ]);
    expect(detached).toHaveLength(1);
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
    expect(h.calls.filter((call) => call === "detach")).toHaveLength(2);
    expect(
      h.focused
        .filter((value) => fields(value.params).enabled === false)
        .map((value) => value.tabId),
    ).toEqual([8, 7]);
    h.socket.close();
  });
}

test("metadata before offer acknowledgement preserves the pending attachment", async () => {
  const h = await harness();
  const pending = await h.startOffer();
  const finish = h.delayPopup("focus");
  h.command(1, "attach");
  await settle();
  h.socket.receive({
    kind: "metadata",
    generation: "generation-1",
    member: { id: "m", name: "Member" },
    agents: [{ id: "a", name: "Agent" }],
    assignments: [],
  });
  const state = await h.ui({ action: "state" });
  const detached = h.socket.sent.some(
    (message) => message.method === "detached",
  );
  finish();
  const result = await pending.result;
  expect(state.assignments).toMatchObject([{ phase: "offering" }]);
  expect(detached).toBe(false);
  expect(result.assignments).toMatchObject([{ phase: "on" }]);
  h.socket.receive({
    kind: "metadata",
    generation: "generation-1",
    member: { id: "m", name: "Member" },
    agents: [{ id: "a", name: "Agent" }],
    assignments: [
      {
        id: h.assignment(),
        scope: OFFERED,
        durationMinutes: 0,
        expiresAt: null,
      },
    ],
  });
  await settle();
  expect((await h.ui({ action: "state" })).assignments).toMatchObject([
    { phase: "on" },
  ]);
  expect(h.calls.filter((call) => call === "detach")).toHaveLength(0);
  h.socket.close();
});

// The pair table is pinned on validGrantExpiry in
// shared/browser-extension-protocol.test.ts; here both paths must apply it.
test("an invalid expiry pair fails closed in the acknowledgement and in metadata", async () => {
  const pendingHarness = await harness(false);
  const pending = await pendingHarness.startOffer();
  pendingHarness.command(1, "attach");
  await settle();
  pendingHarness.socket.receive({
    kind: "offered",
    scope: OFFERED,
    generation: "generation-1",
    assignment: pending.assignment,
    durationMinutes: 0,
    expiresAt: Date.now() + 60_000,
  });
  expect((await pending.result).error).toBeDefined();
  expect(pendingHarness.socket.readyState).toBe(3);
  const active = await harness();
  await active.offer();
  active.socket.receive({
    kind: "metadata",
    generation: "generation-1",
    member: { id: "m", name: "Member" },
    agents: [{ id: "a", name: "Agent" }],
    assignments: [
      {
        id: active.assignment(),
        scope: OFFERED,
        durationMinutes: 15,
        expiresAt: null,
      },
    ],
  });
  await settle();
  expect(active.socket.readyState).toBe(3);
  expect((await active.ui({ action: "state" })).assignments).toHaveLength(0);
});

test("offers reserve exact tabs, permit multiple roots, and metadata with another scope ends one", async () => {
  const h = await harness();
  try {
    expect(await h.offer()).not.toHaveProperty("error");
    const first = h.assignment();
    expect(h.badges.some((b) => b.tabId === 7 && b.text === "ON")).toBe(true);
    expect(
      await h.ui({
        action: "offer",
        generation: "generation-1",
      }),
    ).toHaveProperty("error");
    h.selected(8);
    expect(await h.offer()).not.toHaveProperty("error");
    const second = h.assignment();
    expect(second).not.toBe(first);
    expect(h.socket.sent.filter((m) => m.kind === "offer")).toHaveLength(2);
    const state = await h.ui({ action: "state" });
    expect(state.assignments).toHaveLength(2);
    expect(
      (state.assignments as Fields[]).every(
        (a) => fields(a.scope).kind === "all",
      ),
    ).toBe(true);
    h.socket.receive({
      kind: "metadata",
      generation: "generation-1",
      member: { id: "m", name: "Member" },
      agents: [],
      assignments: [first, second].map((id) => ({
        id,
        scope: { kind: "all" },
        durationMinutes: 0,
        expiresAt: null,
      })),
    });
    await settle();
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(2);
    await h.ui({
      action: "stop",
      generation: "generation-1",
      assignment: first,
    });
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(1);
    h.socket.receive({
      kind: "metadata",
      generation: "generation-1",
      member: { id: "m", name: "Member" },
      agents: [{ id: "b", name: "Other" }],
      assignments: [
        {
          id: second,
          scope: { kind: "office" },
          durationMinutes: 0,
          expiresAt: null,
        },
      ],
    });
    await settle();
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
  } finally {
    h.socket.close();
  }
});

test("navigation restores only owned root/popup badges and Off wins delayed refresh", async () => {
  const h = await harness();
  try {
    await h.offer();
    const before = h.badges.length;
    h.updated(99);
    await settle();
    expect(h.badges).toHaveLength(before);
    h.updated(7);
    await settle();
    expect(h.badges.slice(before)).toContainEqual({ tabId: 7, text: "ON" });
    h.navigation(7, 8);
    await settle();
    expect(h.socket.sent.some((m) => m.method === "popup")).toBe(true);
    const popupBoundary = h.badges.length;
    h.updated(8);
    await settle();
    expect(h.badges.slice(popupBoundary)).toContainEqual({
      tabId: 8,
      text: "ON",
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.delayBadge(() => held);
    h.updated(7);
    await settle();
    const off = h.ui({
      action: "stop",
      generation: "generation-1",
      assignment: h.assignment(),
    });
    await settle();
    const boundary = h.badges.length;
    h.delayBadge(async () => {});
    release();
    await off;
    await settle();
    expect(h.badges.slice(boundary).some((b) => b.text === "ON")).toBe(false);
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
  } finally {
    h.socket.close();
  }
});

test("confirmed pairing records its code and never writes the popup's draft", async () => {
  const code = "a".repeat(43);
  const h = await harness();
  const draft = { office: "http://127.0.0.1", code: "typed-since" };
  h.session.set("pairingDraft", draft);
  await h.ui({ action: "pair", office: "http://127.0.0.1", code });
  await settle();
  const socket = h.sockets.at(-1)!;
  socket.onopen?.();
  expect(socket.sent.at(-1)).toMatchObject({ kind: "hello", code });
  // Submitting is not pairing: nothing is confirmed before the office answers.
  expect(h.session.has("pairedCode")).toBe(false);
  socket.receive({ kind: "paired", version: 4, credential: "issued" });
  await settle();
  expect(h.config()?.credential).toBe("issued");
  expect(h.session.get("pairedCode")).toBe(code);
  expect(h.session.get("pairingDraft")).toBe(draft);
  socket.close();
});

const recoveryEvents = (h: Awaited<ReturnType<typeof harness>>) =>
  h.socket.sent.filter((m) => m.kind === "event").map((m) => m.method);

test("target_closed reattaches once only when the same tab and page target survive", async () => {
  const h = await harness();
  await h.offer();
  h.debuggerDetached("target_closed");
  await settle();
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(2);
  expect(recoveryEvents(h)).toEqual(["recovering", "recovered"]);
  expect((await h.ui({ action: "state" })).assignments).toHaveLength(1);
});

test("a detach other than target_closed releases without a recovery attempt", async () => {
  const h = await harness();
  await h.offer();
  h.debuggerDetached("canceled_by_user");
  await settle();
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(1);
  expect(recoveryEvents(h)).toEqual(["detached"]);
  expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
});

for (const failure of [
  "closed tab",
  "different target",
  "different tab",
  "non-page target",
  "attach failure",
] as const) {
  test(`target_closed releases on ${failure}`, async () => {
    const h = await harness();
    await h.offer();
    if (failure === "closed tab") h.removeTab();
    if (failure === "different target")
      h.targets([{ id: "replacement", tabId: 7, type: "page" }]);
    if (failure === "different tab")
      h.targets([{ id: "owned", tabId: 8, type: "page" }]);
    if (failure === "non-page target")
      h.targets([{ id: "owned", tabId: 7, type: "iframe" }]);
    if (failure === "attach failure") h.failAttach();
    h.debuggerDetached("target_closed");
    await settle();
    expect(recoveryEvents(h)).toEqual(
      failure === "attach failure" ? ["recovering", "detached"] : ["detached"],
    );
    expect(h.calls.filter((call) => call === "attach")).toHaveLength(
      failure === "attach failure" ? 2 : 1,
    );
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(0);
  });
}

test("recovery timeout releases and a late tab lookup cannot attach", async () => {
  const h = await harness();
  await h.offer();
  const finish = h.delayCreate();
  const priorTimers = new Set(h.timers.keys());
  h.debuggerDetached("target_closed");
  await settle();
  const timers = [...h.timers].filter(([id]) => !priorTimers.has(id));
  expect(timers).toHaveLength(1);
  timers[0][1]();
  await settle();
  finish();
  await settle();
  expect(recoveryEvents(h)).toEqual(["detached"]);
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(1);
});

test("a bridge without recovery capability keeps detach-and-release behavior", async () => {
  // Simulates the old bridge ready message, with no supported capability.
  const h = await harness(true, false);
  await h.offer();
  h.debuggerDetached("target_closed");
  await settle();
  expect(recoveryEvents(h)).toEqual(["detached"]);
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(1);
});

test("a command spanning detach fails even if Chrome returns a late success", async () => {
  const h = await harness();
  await h.offer();
  const finish = h.holdEvaluation();
  h.socket.receive({
    kind: "command",
    generation: "generation-1",
    assignment: h.assignment(),
    id: 99,
    method: "cdp",
    params: { method: "Runtime.evaluate", params: { expression: "1" } },
  });
  await settle();
  h.debuggerDetached("target_closed");
  await settle();
  expect(recoveryEvents(h)).toEqual(["recovering", "recovered"]);
  finish();
  await settle();
  const reply = h.socket.sent.find((m) => m.kind === "result" && m.id === 99);
  expect(typeof reply?.error).toBe("string");
  expect(reply?.result).toBeUndefined();
});

// Without the capability no recovery runs, so what is missing cannot matter.
for (const [capability, missing] of [
  [false, "tab"],
  [true, "tab"],
  [true, "target"],
] as const) {
  test(`closing an owned popup keeps the root grant (recovery=${capability}, missing ${missing})`, async () => {
    const h = await harness(true, capability);
    await h.offer();
    h.navigation(7, 8);
    await settle();
    if (missing === "tab") h.removeTab();
    else h.selected(8);
    h.debuggerDetached("target_closed", 8);
    await settle();
    expect(recoveryEvents(h)).toEqual(["popup", "popupDetached"]);
    expect((await h.ui({ action: "state" })).assignments).toHaveLength(1);
  });
}

test("popup retirement during the identity check cannot later release the root", async () => {
  const h = await harness();
  await h.offer();
  h.navigation(7, 8);
  await settle();
  const finish = h.delayCreate();
  h.debuggerDetached("target_closed", 8);
  await settle();
  h.debuggerDetached("canceled_by_user", 8);
  finish();
  await settle();
  expect(recoveryEvents(h)).toEqual(["popup", "popupDetached"]);
  expect(h.calls.filter((call) => call === "attach")).toHaveLength(2);
});

test("commands cannot dispatch while detached target identity is being checked", async () => {
  const h = await harness();
  await h.offer();
  const finish = h.delayCreate();
  h.debuggerDetached("target_closed");
  h.socket.receive({
    kind: "command",
    generation: "generation-1",
    assignment: h.assignment(),
    id: 98,
    method: "cdp",
    params: { method: "Runtime.evaluate", params: { expression: "1" } },
  });
  await settle();
  expect(h.calls.includes("Runtime.evaluate")).toBe(false);
  expect(
    typeof h.socket.sent.find((m) => m.kind === "result" && m.id === 98)?.error,
  ).toBe("string");
  finish();
  await settle();
  expect(recoveryEvents(h)).toEqual(["recovering", "recovered"]);
  expect(h.calls.includes("Runtime.evaluate")).toBe(false);
});

// Offer resume (task 2c1c81ff): an office restart closes the socket without a
// terminal reason. The worker keeps each ON offer and sends it again, with the
// same id, the office's deadline (none since task 7355640c) and the pinned
// origin, to an office that advertises offerResume. The office decides
// whether it still holds.
const ORIGIN = "https://example.com";
type Harness = Awaited<ReturnType<typeof harness>>;
async function onOffer(h: Harness) {
  const { result, assignment } = await h.startOffer();
  h.command(1, "attach");
  await settle();
  h.socket.receive({
    kind: "offered",
    generation: "generation-1",
    assignment,
    // The scope the extension offered.
    scope: offers(h.socket).at(-1)!.scope,
    durationMinutes: 0,
    expiresAt: null,
    offerOrigin: ORIGIN,
  });
  await settle();
  expect((await result).error).toBeUndefined();
  return assignment;
}
// The office goes away (its socket closes) and comes back as generation n.
// ready: more fields of the new office's ready, for example agentTabs.
async function restart(
  h: Harness,
  n: number,
  offerResume = true,
  ready: Fields = {},
) {
  h.sockets.at(-1)!.close();
  const backoff = Math.max(...h.timers.keys());
  await settle();
  const run = h.timers.get(backoff)!;
  h.timers.delete(backoff);
  run();
  await settle();
  const ws = h.sockets.at(-1)!;
  expect(h.sockets).toHaveLength(n);
  ws.onopen?.();
  ws.receive({
    kind: "ready",
    version: 4,
    generation: `generation-${n}`,
    debuggerRecovery: true,
    ...(offerResume ? { offerResume: true } : {}),
    ...ready,
  });
  ws.receive({
    kind: "metadata",
    generation: `generation-${n}`,
    member: { id: "m", name: "Member" },
    agents: [
      { id: "a", name: "Agent" },
      { id: "b", name: "Other" },
    ],
    assignments: [],
  });
  await settle();
  return ws;
}
const offers = (ws: { sent: Fields[] }) =>
  ws.sent.filter((m) => m.kind === "offer");
const listed = async (h: Harness) =>
  ((await h.ui({ action: "state" })).assignments as Fields[]).map((a) => ({
    id: a.id,
    phase: a.phase,
  }));

test("an office restart resumes each ON offer with its id, no deadline and its pinned origin; a pending offer is not resumed", async () => {
  const h = await harness(false, true, { offerResume: true });
  const id = await onOffer(h);
  // A second offer, still waiting for its attach at the restart.
  h.selected(8);
  void h.ui({
    action: "offer",
    generation: "generation-1",
  });
  await settle();
  expect(offers(h.socket)).toHaveLength(2);
  const detaches = h.calls.filter((c) => c === "detach").length;

  const ws = await restart(h, 2);
  // No tab stays half controlled while the office is away.
  expect(h.calls.filter((c) => c === "detach").length).toBeGreaterThan(
    detaches,
  );
  expect(offers(ws)).toEqual([
    {
      kind: "offer",
      generation: "generation-2",
      assignment: id,
      scope: OFFERED,
      durationMinutes: 0,
      expiresAt: null,
      offerOrigin: ORIGIN,
    },
  ]);
  const attaches = h.calls.filter((c) => c === "attach").length;
  ws.receive({
    kind: "command",
    assignment: id,
    id: 1,
    generation: "generation-2",
    method: "attach",
    params: {},
  });
  await settle();
  expect(h.calls.filter((c) => c === "attach")).toHaveLength(attaches + 1);
  expect(ws.sent.find((m) => m.kind === "result" && m.id === 1)?.error).toBe(
    undefined,
  );
  ws.receive({
    kind: "offered",
    generation: "generation-2",
    assignment: id,
    scope: OFFERED,
    durationMinutes: 0,
    expiresAt: null,
    offerOrigin: ORIGIN,
  });
  await settle();
  h.selected(7);
  expect(await listed(h)).toEqual([{ id, phase: "on" }]);
});

test("a connection loss during a resume keeps the offer; only the office's answer settles it", async () => {
  const h = await harness(false, true, { offerResume: true });
  const id = await onOffer(h);
  const second = await restart(h, 2);
  expect(offers(second).map((m) => m.assignment)).toEqual([id]);
  // The office goes away again before it answers.
  const third = await restart(h, 3);
  expect(offers(third)).toEqual([
    expect.objectContaining({
      generation: "generation-3",
      assignment: id,
      expiresAt: null,
      offerOrigin: ORIGIN,
    }),
  ]);
  third.receive({
    kind: "offered",
    generation: "generation-3",
    assignment: id,
    error: true,
  });
  await settle();
  third.close();
  await settle();
  expect(await listed(h)).toEqual([]);
  const fourth = await restart(h, 4);
  expect(offers(fourth)).toEqual([]);
});

test("while the office is away the popup lists the offer as offering, and Off removes it", async () => {
  const h = await harness(false, true, { offerResume: true });
  const id = await onOffer(h);
  h.socket.close();
  await settle();
  const state = await h.ui({ action: "state" });
  expect(state.state).not.toBe("connected");
  expect(state.assignments).toEqual([
    expect.objectContaining({
      id,
      phase: "offering",
      tabId: 7,
      current: true,
      scope: OFFERED,
      durationMinutes: 0,
      expiresAt: null,
    }),
  ]);
  // The popup sends the generation of its last state: none while offline.
  const off = await h.ui({
    action: "stop",
    assignment: id,
    generation: state.generation,
  });
  expect(off.error).toBeUndefined();
  expect(off.assignments).toEqual([]);
  // A worker restart reads the same session storage.
  const later = await harness(false, true, {
    offerResume: true,
    session: h.session,
  });
  expect(offers(later.socket)).toEqual([]);
  expect(await listed(later)).toEqual([]);
});

test("a worker restart during the outage keeps the offers to resume", async () => {
  const h = await harness(false, true, { offerResume: true });
  const id = await onOffer(h);
  h.socket.close();
  await settle();
  // Chrome stops an idle worker; the next one starts with empty memory, and
  // its session storage answers after it could already connect.
  const later = await harness(false, true, {
    offerResume: true,
    session: h.session,
    slowSession: true,
  });
  expect(offers(later.socket)).toEqual([
    {
      kind: "offer",
      generation: "generation-1",
      assignment: id,
      scope: OFFERED,
      durationMinutes: 0,
      expiresAt: null,
      offerOrigin: ORIGIN,
    },
  ]);
});

test("an office without offerResume clears the offers to resume", async () => {
  const h = await harness(false, true, { offerResume: true });
  const id = await onOffer(h);
  h.socket.close();
  await settle();
  // The enabling state: the offer waits to resume.
  expect(await listed(h)).toEqual([{ id, phase: "offering" }]);
  const old = await restart(h, 2, false);
  expect(offers(old)).toEqual([]);
  old.close();
  await settle();
  expect(await listed(h)).toEqual([]);
  expect(offers(await restart(h, 3))).toEqual([]);
});

for (const when of ["online", "offline"] as const)
  test(`Disconnect ${when} ends the offers to resume`, async () => {
    const h = await harness(false, true, { offerResume: true });
    const id = await onOffer(h);
    if (when === "offline") {
      h.socket.close();
      await settle();
      expect(await listed(h)).toEqual([{ id, phase: "offering" }]);
    } else expect(await listed(h)).toEqual([{ id, phase: "on" }]);
    await h.ui({ action: "disconnect" });
    await settle();
    expect(await listed(h)).toEqual([]);
    await h.ui({ action: "reconnect" });
    await settle();
    const ws = h.sockets.at(-1)!;
    ws.onopen?.();
    ws.receive({
      kind: "ready",
      version: 4,
      generation: "generation-2",
      debuggerRecovery: true,
      offerResume: true,
    });
    await settle();
    expect(h.sockets.length).toBeGreaterThan(1);
    expect(offers(ws)).toEqual([]);
  });

test("a resumed tab is reserved from ready on: a popup offer cannot take the tab before the resume settles", async () => {
  const h = await harness(false, true, { offerResume: true });
  const id = await onOffer(h);
  const ws = await restart(h, 2);
  expect(offers(ws).map((m) => m.assignment)).toEqual([id]);
  const taken = await h.ui({
    action: "offer",
    generation: "generation-2",
  });
  expect(taken.error).toBeDefined();
  // The same popup offer on another tab goes out.
  h.selected(8);
  void h.ui({
    action: "offer",
    generation: "generation-2",
  });
  await settle();
  expect(offers(ws)).toHaveLength(2);
  expect(offers(ws)[1]).toMatchObject({
    scope: OFFERED,
  });
});

// Task 416df5d8: Chrome can stop the worker (a crash, a forced kill) with
// tabs attached and without close(). The offers to resume are kept from the
// moment each turns ON, and the next worker first releases the debugger
// sessions its predecessor left, which still belong to this extension.
async function onOfferOf(
  h: Harness,
  tabId: number,
  generation = "generation-1",
) {
  h.selected(tabId);
  const result = h.ui({
    action: "offer",
    generation,
  });
  await settle();
  const ws = h.sockets.at(-1)!;
  const assignment = String(offers(ws).at(-1)!.assignment);
  ws.receive({
    kind: "command",
    assignment,
    id: 100 + tabId,
    generation,
    method: "attach",
    params: {},
  });
  await settle();
  ws.receive({
    kind: "offered",
    generation,
    assignment,
    scope: OFFERED,
    durationMinutes: 0,
    expiresAt: null,
    offerOrigin: ORIGIN,
  });
  await settle();
  expect((await result).error).toBeUndefined();
  return assignment;
}
// The next worker after Chrome stopped this one with no close().
const nextWorker = (h: Harness, leftover: number[]) =>
  harness(false, true, { offerResume: true, session: h.session, leftover });
const lastBadge = (h: Harness, tabId: number) =>
  h.badges.findLast((b) => b.tabId === tabId)?.text;
// The answer to command id: "attached", or the reason the attach failed.
async function attachAnswer(ws: { sent: Fields[] }, id: number) {
  for (let i = 0; i < 20; i++) {
    const answer = ws.sent.find((m) => m.kind === "result" && m.id === id);
    if (answer) return answer.error === undefined ? "attached" : answer.reason;
    await settle();
  }
  return "no answer";
}

test("a worker stopped without a close leaves its ON offer to the next worker, which resumes it on the same tab", async () => {
  const h = await harness(false, true, { offerResume: true });
  const id = await onOffer(h);
  const later = await nextWorker(h, [7]);
  expect(offers(later.socket)).toEqual([
    {
      kind: "offer",
      generation: "generation-1",
      assignment: id,
      scope: OFFERED,
      durationMinutes: 0,
      expiresAt: null,
      offerOrigin: ORIGIN,
    },
  ]);
  later.socket.receive({
    kind: "command",
    assignment: id,
    id: 1,
    generation: "generation-1",
    method: "attach",
    params: {},
  });
  expect(await attachAnswer(later.socket, 1)).toBe("attached");
  later.socket.receive({
    kind: "offered",
    generation: "generation-1",
    assignment: id,
    scope: OFFERED,
    durationMinutes: 0,
    expiresAt: null,
    offerOrigin: ORIGIN,
  });
  await settle();
  expect(await listed(later)).toEqual([{ id, phase: "on" }]);
  expect(lastBadge(later, 7)).toBe("ON");
});

test("a resumed offer the office accepts stays to resume", async () => {
  const h = await harness(false, true, { offerResume: true });
  const id = await onOffer(h);
  const ws = await restart(h, 2);
  expect(offers(ws).map((m) => m.assignment)).toEqual([id]);
  ws.receive({
    kind: "offered",
    generation: "generation-2",
    assignment: id,
    scope: OFFERED,
    durationMinutes: 0,
    expiresAt: null,
    offerOrigin: ORIGIN,
  });
  await settle();
  expect(await listed(h)).toEqual([{ id, phase: "on" }]);
  const later = await nextWorker(h, [7]);
  expect(offers(later.socket)).toEqual([
    expect.objectContaining({ assignment: id, expiresAt: null }),
  ]);
});

for (const end of ["off", "metadata"] as const)
  test(`an ON offer ended by ${end === "off" ? "the member's Off" : "the office's metadata"} is not resumed by the next worker; the other ON offer is`, async () => {
    const h = await harness(false, true, { offerResume: true });
    const ended = await onOfferOf(h, 7);
    const kept = await onOfferOf(h, 8);
    expect(await listed(h)).toEqual([
      { id: ended, phase: "on" },
      { id: kept, phase: "on" },
    ]);
    if (end === "off")
      await h.ui({
        action: "stop",
        assignment: ended,
        generation: "generation-1",
      });
    else
      h.socket.receive({
        kind: "metadata",
        generation: "generation-1",
        member: { id: "m", name: "Member" },
        agents: [
          { id: "a", name: "Agent" },
          { id: "b", name: "Other" },
        ],
        assignments: [
          {
            id: kept,
            scope: OFFERED,
            durationMinutes: 0,
            expiresAt: null,
          },
        ],
      });
    await settle();
    expect(await listed(h)).toEqual([{ id: kept, phase: "on" }]);
    const later = await nextWorker(h, [8]);
    expect(offers(later.socket).map((m) => m.assignment)).toEqual([kept]);
  });

test("Reconnect ends the ON offers: neither its new connection nor a later worker resumes them", async () => {
  const h = await harness(false, true, { offerResume: true });
  const id = await onOfferOf(h, 7);
  // The enabling state: before Reconnect, a next worker would resume it.
  const before = await nextWorker(h, [7]);
  expect(offers(before.socket).map((m) => m.assignment)).toEqual([id]);
  const ws = await h.reconnect();
  expect(h.sockets).toHaveLength(2);
  ws.onopen?.();
  ws.receive({
    kind: "ready",
    version: 4,
    generation: "generation-2",
    debuggerRecovery: true,
    offerResume: true,
  });
  await settle();
  expect((await h.ui({ action: "state" })).state).toBe("connected");
  expect(offers(ws)).toEqual([]);
  expect(await listed(h)).toEqual([]);
  const later = await nextWorker(h, [7]);
  expect(offers(later.socket)).toEqual([]);
});

test("a new worker releases the debugger sessions its predecessor left before its first attach, and clears a leftover ON badge", async () => {
  const h = await harness(false, true, { offerResume: true });
  const resumed = await onOfferOf(h, 7);
  // Tab 8 was attached for an offer the office had not answered yet.
  h.selected(8);
  void h.ui({
    action: "offer",
    generation: "generation-1",
  });
  await settle();
  h.socket.receive({
    kind: "command",
    assignment: String(offers(h.socket).at(-1)!.assignment),
    id: 9,
    generation: "generation-1",
    method: "attach",
    params: {},
  });
  await settle();
  expect(lastBadge(h, 7)).toBe("ON");
  const later = await nextWorker(h, [7, 8]);
  // The member offers tab 8 again, and Chrome lets this worker attach it.
  later.selected(8);
  const result = later.ui({
    action: "offer",
    generation: "generation-1",
  });
  await settle();
  const fresh = String(offers(later.socket).at(-1)!.assignment);
  later.socket.receive({
    kind: "command",
    assignment: fresh,
    id: 1,
    generation: "generation-1",
    method: "attach",
    params: {},
  });
  expect(await attachAnswer(later.socket, 1)).toBe("attached");
  later.socket.receive({
    kind: "offered",
    generation: "generation-1",
    assignment: fresh,
    scope: OFFERED,
    durationMinutes: 0,
    expiresAt: null,
    offerOrigin: ORIGIN,
  });
  await settle();
  expect((await result).error).toBeUndefined();
  expect(lastBadge(later, 8)).toBe("ON");
  // The offer on tab 7 was resumed, and the office no longer holds it.
  expect(offers(later.socket)[0]?.assignment).toBe(resumed);
  later.socket.receive({
    kind: "offered",
    generation: "generation-1",
    assignment: resumed,
    error: true,
  });
  await settle();
  expect(lastBadge(later, 7)).toBe(null);
});

// Task 825bb286: the hello reports this extension's package, and the popup
// learns when the office has a newer one.
test("the hello reports the extension's package; a newer office package offers an update", async () => {
  // Not the real manifest version, so a hard-coded one fails.
  const fresh = await harness(true, true, {
    extensionVersion: "0.4.3",
    officePackage: "0.4.10",
  });
  expect(fresh.socket.sent[0]).toMatchObject({
    kind: "hello",
    package: "0.4.3",
  });
  // Precondition: ready was accepted.
  expect((await fresh.ui({ action: "state" })).state).toBe("connected");
  expect((await fresh.ui({ action: "state" })).update).toEqual({
    latest: "0.4.10",
  });
  for (const officePackage of ["0.4.3", "0.4.2", undefined]) {
    const h = await harness(true, true, {
      extensionVersion: "0.4.3",
      officePackage,
    });
    const state = await h.ui({ action: "state" });
    expect(state.state).toBe("connected");
    expect(state.update).toBeUndefined();
  }
});

// A tab that shows a JavaScript dialog answers no command from a debugger
// session that attached after the dialog opened.
const settled = async () => {
  for (let i = 0; i < 10; i++) await settle();
};
for (const from of [
  "Page.enable",
  "Page.setInterceptFileChooserDialog",
  "Emulation.setFocusEmulationEnabled",
  "Target.getTargetInfo",
] as const) {
  test(`an offer whose tab stops answering at ${from} fails at the attach bound with its reason, and the connection stays`, async () => {
    const h = await harness();
    h.dialog(7, from);
    let replied = false;
    const reply = h.offer().finally(() => {
      replied = true;
    });
    await settled();
    // The enabling condition: the tab got the command and gave no answer.
    expect(h.calls).toContain(from);
    expect(replied).toBe(false);
    expect(h.socket.sent.some((m) => m.kind === "result" && m.id === 1)).toBe(
      false,
    );
    expect(h.fire(ATTACH_ANSWER_MS)).toBeGreaterThan(0);
    await settled();
    // One bound: the reason does not wait for a second timer.
    expect(replied).toBe(true);
    expect(h.pendingTimers(ATTACH_ANSWER_MS)).toBe(0);
    const failed = h.socket.sent.find((m) => m.kind === "result" && m.id === 1);
    expect(failed?.error).toBeDefined();
    // The office logs why the offer failed (task 694e958e).
    expect(failed?.reason).toBe("unanswered");
    expect(h.detachedTabs).toContain(7);
    expect(await reply).toMatchObject({
      error: expect.any(String),
      reason: "unanswered",
    });
    // The extension's connection, and so every other offered tab, stays.
    expect(h.sockets).toHaveLength(1);
    expect(h.socket.readyState).toBe(1);
    const state = await h.ui({ action: "state" });
    expect(state.state).toBe("connected");
    expect(state.assignments).toEqual([]);
  });
}

test("a tab that answers the attach late but inside the bound is offered", async () => {
  const h = await harness();
  h.dialog(7, "Page.enable");
  const reply = h.offer();
  await settled();
  // The enabling condition: the bound is armed on a command with no answer.
  expect(h.pendingTimers(ATTACH_ANSWER_MS)).toBeGreaterThan(0);
  h.closeDialog(7);
  await settled();
  expect((await reply).error).toBeUndefined();
  // A bound that outlives its answer ends nothing.
  h.fire(ATTACH_ANSWER_MS);
  await settled();
  expect(h.detachedTabs).toEqual([]);
  expect(await listed(h)).toEqual([{ id: h.assignment(), phase: "on" }]);
});

// The office logs the reason the extension sends (task 694e958e); the popup
// shows only the dialog reason.
for (const [message, sent] of [
  ["attach failed", "attach_failed"],
  [
    "Another debugger is already attached to the tab with id: 7.",
    "already_attached",
  ],
] as const)
  test(`an attach that fails with "${message}" gives no dialog reason and tells the office ${sent}`, async () => {
    const h = await harness();
    h.failAttach(message);
    const reply = await h.offer();
    expect(reply.error).toBeDefined();
    expect(reply.reason).toBeUndefined();
    const failed = h.socket.sent.find((m) => m.kind === "result" && m.id === 1);
    expect(failed?.error).toBeDefined();
    expect(failed?.reason).toBe(sent);
  });

test("a site-opened popup that gives no answer is dropped at the bound; a later popup attaches and Stop completes", async () => {
  const h = await harness();
  await h.offer();
  h.dialog(8, "Page.enable");
  h.navigation(7, 8);
  await settled();
  // The enabling condition: the popup got Page.enable and gave no answer.
  expect(h.calls.filter((call) => call === "Page.enable")).toHaveLength(2);
  expect(h.fire(ATTACH_ANSWER_MS)).toBeGreaterThan(0);
  await settled();
  expect(h.detachedTabs).toEqual([8]);
  expect(h.socket.sent.some((m) => m.method === "popup")).toBe(false);
  h.navigation(7, 9);
  await settled();
  const popups = h.socket.sent.filter((m) => m.method === "popup");
  expect(popups).toHaveLength(1);
  expect(fields(fields(popups[0].params).targetInfo).targetId).toBe("target-9");
  h.command(2, "detach");
  await settled();
  expect(h.detachedTabs).toContain(7);
  expect(h.socket.sent).toContainEqual({
    kind: "event",
    generation: "generation-1",
    assignment: h.assignment(),
    method: "detached",
    params: { cause: "office" },
  });
});

// Task 694e958e: the office's socket closes on a frame over its payload limit,
// which ends every offered tab at once. The extension sends no frame over
// EXTENSION_MAX_BYTES.
const largest = (h: Harness) => Math.max(...h.frames);
const detachCauses = (h: Harness) =>
  h.socket.sent
    .filter((m) => m.kind === "event" && m.method === "detached")
    .map((m) => [m.assignment, fields(m.params).cause]);

test("an answer over the size cap fails only its command, with its size; the tab and the connection stay, and the next answer goes out whole", async () => {
  const h = await harness();
  await h.offer();
  // Two UTF-8 bytes per character: under the cap in characters, over it in
  // bytes.
  const value = "é".repeat(EXTENSION_MAX_BYTES / 2 + 1024);
  h.answerEvaluation({ result: { type: "string", value } });
  h.command(2, "cdp", { method: "Runtime.evaluate", params: {} });
  await settled();
  // The enabling condition: Chrome gave the answer.
  expect(h.calls.filter((call) => call === "Runtime.evaluate")).toHaveLength(1);
  const failed = h.socket.sent.find((m) => m.kind === "result" && m.id === 2)!;
  // Scalars only: a failure must not print the 8 MiB value.
  expect("result" in failed).toBe(false);
  expect(failed.error).toBeDefined();
  expect(Number.isSafeInteger(failed.tooLarge)).toBe(true);
  expect(failed.tooLarge).toBeGreaterThan(EXTENSION_MAX_BYTES);
  expect(largest(h)).toBeLessThanOrEqual(EXTENSION_MAX_BYTES);
  expect(h.sockets).toHaveLength(1);
  expect(h.socket.readyState).toBe(1);
  expect(await listed(h)).toEqual([{ id: h.assignment(), phase: "on" }]);
  expect(detachCauses(h)).toEqual([]);

  h.answerEvaluation({ result: { type: "string", value: "small" } });
  h.command(3, "cdp", { method: "Runtime.evaluate", params: {} });
  await settled();
  const next = h.socket.sent.find((m) => m.kind === "result" && m.id === 3)!;
  expect(next).not.toHaveProperty("tooLarge");
  expect(next.result).toEqual({ result: { type: "string", value: "small" } });
});

test("an event over the size cap goes out without its request body and with its URL whole; the grant stays", async () => {
  const h = await harness();
  await h.offer();
  const url = "https://example.com/upload?q=1";
  h.cdpEvent(7, "Network.requestWillBeSent", {
    requestId: "r1",
    request: {
      url,
      method: "POST",
      hasPostData: true,
      postData: "x".repeat(EXTENSION_MAX_BYTES + 10),
    },
  });
  await settled();
  const sent = h.socket.sent.filter(
    (m) => m.method === "Network.requestWillBeSent",
  );
  expect(sent).toHaveLength(1);
  const request = fields(fields(sent[0].params).request);
  // Scalars only: a failure must not print the 8 MiB body.
  expect("postData" in request).toBe(false);
  expect([request.url, request.method, request.hasPostData]).toEqual([
    url,
    "POST",
    true,
  ]);
  expect(fields(sent[0].params).requestId).toBe("r1");
  expect(sent[0].assignment).toBe(h.assignment());
  expect(largest(h)).toBeLessThanOrEqual(EXTENSION_MAX_BYTES);
  expect(await listed(h)).toEqual([{ id: h.assignment(), phase: "on" }]);
  expect(detachCauses(h)).toEqual([]);
});

test("an event still over the size cap after the cut ends only its own tab's grant, with cause too_large; the other tab and the connection stay", async () => {
  const h = await harness();
  expect(await h.offer()).not.toHaveProperty("error");
  const first = h.assignment();
  h.selected(8);
  expect(await h.offer()).not.toHaveProperty("error");
  const second = h.assignment();
  // Each string is at the cut length, so the cut keeps every one.
  const piece = "y".repeat(64 * 1024);
  const count = Math.ceil(EXTENSION_MAX_BYTES / piece.length) + 4;
  h.cdpEvent(7, "Runtime.consoleAPICalled", {
    type: "log",
    args: Array.from({ length: count }, () => ({
      type: "string",
      value: piece,
    })),
  });
  await settled();
  expect(largest(h)).toBeLessThanOrEqual(EXTENSION_MAX_BYTES);
  expect(
    h.socket.sent.filter((m) => m.method === "Runtime.consoleAPICalled").length,
  ).toBe(0);
  expect(detachCauses(h)).toEqual([[first, "too_large"]]);
  expect(h.detachedTabs).toContain(7);
  expect(h.detachedTabs).not.toContain(8);
  expect(await listed(h)).toEqual([{ id: second, phase: "on" }]);
  expect(h.sockets).toHaveLength(1);
  expect(h.socket.readyState).toBe(1);
});

// Each way the extension ends an offer names itself in its "detached" event,
// so the office log tells them apart.
for (const cause of [
  "off",
  "office",
  "metadata",
  "debugger_detached",
  "recovery_failed",
  "offer_refused",
] as const) {
  test(`an offer the extension ends at ${cause} sends that cause`, async () => {
    const h = await harness(cause !== "offer_refused");
    if (cause === "offer_refused") {
      // No office answer yet: the popup's reply waits for it.
      const reply = h.offer();
      await settled();
      // The enabling condition: the extension attached and answered.
      const attached = h.socket.sent.find(
        (m) => m.kind === "result" && m.id === 1,
      );
      expect(attached).toBeDefined();
      expect(attached!.error).toBeUndefined();
      h.socket.receive({
        kind: "offered",
        generation: "generation-1",
        assignment: h.assignment(),
        error: true,
      });
      expect(await reply).toHaveProperty("error");
    } else {
      await h.offer();
      expect(await listed(h)).toEqual([{ id: h.assignment(), phase: "on" }]);
      if (cause === "off")
        await h.ui({
          action: "stop",
          generation: "generation-1",
          assignment: h.assignment(),
        });
      else if (cause === "office") h.command(2, "detach");
      else if (cause === "metadata")
        h.socket.receive({
          kind: "metadata",
          generation: "generation-1",
          member: { id: "m", name: "Member" },
          agents: [{ id: "a", name: "Agent" }],
          assignments: [],
        });
      else if (cause === "debugger_detached")
        h.debuggerDetached("canceled_by_user");
      else {
        h.delayCreate();
        const prior = new Set(h.timers.keys());
        h.debuggerDetached("target_closed");
        await settle();
        const timers = [...h.timers].filter(([id]) => !prior.has(id));
        expect(timers).toHaveLength(1);
        timers[0][1]();
      }
    }
    await settled();
    expect(detachCauses(h)).toEqual([[h.assignment(), cause]]);
  });
}

// Agent tabs (task 73a9fb57): with the member's setting on, the office's open
// command makes a tab for an agent in one Agents window. Task 9361ce1b: when
// its grant ends, the tab stays open as the member's plain tab. Only the
// popup's Close tab, the agent's own close (an office detach with close) and
// a failed open close it.
const OPENED = { kind: "opened", agentId: "a", via: "all" };
// The member's access setting (task 7355640c), as the extension stores it.
const MINE_OFF = { agents: "mine", members: [], openTabs: false };
const MINE_ON = { agents: "mine", members: [], openTabs: true };
const MEMBERS_ON = { agents: "members", members: ["bob"], openTabs: true };
const OFFICE_ON = { agents: "office", members: [], openTabs: true };
const SHARED = { kind: "shared" };
type AgentTabsSetting = "all" | "office" | null;
const ON_ALL = () => new Map<string, unknown>([["access", MINE_ON]]);
const ON_OFFICE = () => new Map<string, unknown>([["access", OFFICE_ON]]);
// An office that takes the access setting.
async function agentTabs(local = ON_ALL(), extra: object = {}) {
  return harness(false, true, {
    offerResume: true,
    officeScope: true,
    agentTabs: true,
    access: true,
    local,
    ...extra,
  });
}
// An office from before the access setting: it takes agent tabs only.
async function olderOffice(local = ON_ALL()) {
  return harness(false, true, {
    offerResume: true,
    officeScope: true,
    agentTabs: true,
    local,
  });
}
const result = (ws: { sent: Fields[] }, id: number) =>
  ws.sent.findLast((m) => m.kind === "result" && m.id === id);
const agentTabsSent = (ws: { sent: Fields[] }) =>
  ws.sent.filter((m) => m.kind === "agentTabs").map((m) => m.scope);
const accessSent = (ws: { sent: Fields[] }) =>
  ws.sent.filter((m) => m.kind === "access").map((m) => m.access);
// The tab of each listed grant, by grant id.
const tabOf = async (h: Harness, id: string) =>
  ((await h.ui({ action: "state" })).assignments as Fields[]).find(
    (a) => a.id === id,
  )?.tabId as number | undefined;
// The last autoDiscardable the extension set on a tab: an open sets false, so
// Chrome does not discard the agent's tab; a kept tab gets true back.
const discardable = (h: Harness, tabId: number) =>
  h.tabUpdates
    .filter((u) => u.tabId === tabId && "autoDiscardable" in u.options)
    .at(-1)?.options.autoDiscardable;
// The tab is still open, and the extension did not close it.
const stillOpen = (h: Harness, tabId: number) =>
  h.madeTabs.has(tabId) && !h.removedTabs.includes(tabId);
// The office's open for agent "a" (or params), answered with offered.
async function opened(
  h: Harness,
  id: number,
  params?: Fields,
  ws = h.socket,
  generation = "generation-1",
) {
  const assignment = crypto.randomUUID();
  h.open(id, assignment, params);
  await settle();
  await settle();
  expect(result(ws, id)?.error).toBeUndefined();
  ws.receive({
    kind: "offered",
    generation,
    assignment,
    scope: params?.scope ?? OPENED,
    durationMinutes: 0,
    expiresAt: null,
  });
  await settle();
  const tabId = await tabOf(h, assignment);
  expect(tabId).toBeNumber();
  return { assignment, tabId: tabId! };
}

test("the access setting is kept, sent to an office that takes it, and does not reconnect; an office that takes neither access nor agent tabs gets nothing", async () => {
  const old = await harness(false, true, {
    offerResume: true,
    officeScope: true,
  });
  expect((await old.ui({ action: "state" })).sharedAccess).toBeFalsy();
  // The member can still choose; it is kept, and nothing goes out.
  expect(
    (await old.ui({ action: "access", access: MEMBERS_ON })).error,
  ).toBeUndefined();
  await settle();
  expect(old.local.get("access")).toEqual(MEMBERS_ON);
  expect([...accessSent(old.socket), ...agentTabsSent(old.socket)]).toEqual([]);

  const h = await agentTabs(new Map());
  await settle();
  const first = await h.ui({ action: "state" });
  expect([first.sharedAccess, first.access]).toEqual([true, MINE_OFF]);
  expect(accessSent(h.socket)).toEqual([MINE_OFF]);
  // The office lists the members to pick.
  h.socket.receive({
    kind: "metadata",
    generation: "generation-1",
    member: { id: "m", name: "Member" },
    agents: [],
    members: [{ id: "bob", name: "Bob" }],
    assignments: [],
  });
  await settle();
  expect((await h.ui({ action: "state" })).members).toEqual([
    { id: "bob", name: "Bob" },
  ]);
  const sockets = h.sockets.length;
  await h.ui({ action: "access", access: MEMBERS_ON });
  await settle();
  expect(h.local.get("access")).toEqual(MEMBERS_ON);
  expect((await h.ui({ action: "state" })).access).toEqual(MEMBERS_ON);
  // An invalid setting changes nothing.
  expect(
    (
      await h.ui({
        action: "access",
        access: { agents: "everyone", members: [], openTabs: true },
      })
    ).error,
  ).toBeDefined();
  expect(h.local.get("access")).toEqual(MEMBERS_ON);
  expect(accessSent(h.socket)).toEqual([MINE_OFF, MEMBERS_ON]);
  // An office that takes access gets no agent tabs message.
  expect(agentTabsSent(h.socket)).toEqual([]);
  expect(h.sockets).toHaveLength(sockets);
  expect(h.socket.readyState).toBe(1);

  // A new worker with the stored setting sends it after ready.
  const kept = await agentTabs(new Map([["access", MEMBERS_ON]]));
  await settle();
  expect(accessSent(kept.socket)).toEqual([MEMBERS_ON]);
});

test("a stored agent tabs setting from an earlier version becomes the access setting, and an invalid stored setting is My agents with tabs off", async () => {
  const rows: Array<[string, Map<string, unknown>, Fields]> = [
    [
      "Only my agents",
      new Map([["agentTabs", { scope: "all" }]]),
      { agents: "mine", members: [], openTabs: true },
    ],
    [
      "All agents",
      new Map([["agentTabs", { scope: "office" }]]),
      { agents: "office", members: [], openTabs: true },
    ],
    [
      "invalid access",
      new Map([
        ["access", { agents: "everyone", members: [], openTabs: true }],
      ]),
      MINE_OFF,
    ],
  ];
  for (const [name, local, access] of rows) {
    const h = await agentTabs(local);
    await settle();
    expect({ name, sent: accessSent(h.socket) }).toEqual({
      name,
      sent: [access],
    });
    expect({ name, state: (await h.ui({ action: "state" })).access }).toEqual({
      name,
      state: access,
    });
    expect({ name, old: h.local.has("agentTabs") }).toEqual({
      name,
      old: false,
    });
  }
});

test("the popup's offer is shared on an office that takes access, else the narrower old scope; it never expires, and the stored setting stays", async () => {
  // [name, ready, stored access, offer scope, agent tabs message]
  const rows: Array<
    [string, Fields, Fields, Fields, AgentTabsSetting | undefined]
  > = [
    [
      "access",
      { access: true, agentTabs: true },
      MEMBERS_ON,
      SHARED,
      undefined,
    ],
    [
      "access, office",
      { access: true, agentTabs: true },
      OFFICE_ON,
      SHARED,
      undefined,
    ],
    ["older, mine", { agentTabs: true }, MINE_ON, { kind: "all" }, "all"],
    ["older, members", { agentTabs: true }, MEMBERS_ON, { kind: "all" }, "all"],
    [
      "older, office",
      { agentTabs: true },
      OFFICE_ON,
      { kind: "office" },
      "office",
    ],
    [
      "older, office, tabs off",
      { agentTabs: true },
      { ...OFFICE_ON, openTabs: false },
      { kind: "office" },
      null,
    ],
    // An office that takes neither All agents offers nor agent tabs.
    ["oldest, office", {}, OFFICE_ON, { kind: "all" }, undefined],
  ];
  for (const [name, ready, access, scope, legacy] of rows) {
    const h = await harness(true, true, {
      offerResume: true,
      officeScope: name !== "oldest, office",
      ...ready,
      local: new Map([["access", access]]),
    });
    await settle();
    expect({ name, legacy: agentTabsSent(h.socket) }).toEqual({
      name,
      legacy: legacy === undefined ? [] : [legacy],
    });
    expect({ name, error: (await h.offer()).error }).toEqual({
      name,
      error: undefined,
    });
    const offer = h.socket.sent.findLast((m) => m.kind === "offer");
    expect({
      name,
      scope: offer?.scope,
      minutes: offer?.durationMinutes,
    }).toEqual({ name, scope, minutes: 0 });
    expect({ name, stored: h.local.get("access") }).toEqual({
      name,
      stored: access,
    });
    h.socket.close();
  }
  // A change on an older office goes out as the old setting.
  const h = await olderOffice(ON_ALL());
  await settle();
  await h.ui({ action: "access", access: OFFICE_ON });
  await h.ui({ action: "access", access: { ...OFFICE_ON, openTabs: false } });
  await settle();
  expect(agentTabsSent(h.socket)).toEqual(["all", "office", null]);
  expect(accessSent(h.socket)).toEqual([]);
});

test("open makes an about:blank tab in one unfocused Agents window, kept from discard, and answers its target; the next open uses the same window", async () => {
  const h = await agentTabs();
  const first = await opened(h, 5);
  expect(h.createdWindows).toHaveLength(1);
  expect(h.createdWindows[0].focused).toBe(false);
  expect(h.calls).toContain("attach");
  expect(fields(result(h.socket, 5)!.result).targetInfo).toMatchObject({
    type: "page",
    url: "about:blank",
  });
  const second = await opened(h, 6);
  expect(h.createdWindows).toHaveLength(1);
  const [window] = [...h.windows.keys()];
  // The Agents window holds the agents' tabs and nothing else.
  expect(
    [...h.madeTabs.values()].map((t) => [t.id, t.windowId]).sort(),
  ).toEqual(
    [
      [first.tabId, window],
      [second.tabId, window],
    ].sort(),
  );
  for (const { tabId } of [first, second])
    expect(
      h.tabUpdates.some(
        (u) => u.tabId === tabId && u.options.autoDiscardable === false,
      ),
    ).toBe(true);
  // The popup lists each one as the agent's tab.
  const rows = (await h.ui({ action: "state" })).assignments as Fields[];
  expect(
    rows.map((r) => [r.id, r.phase, (r.scope as Fields).kind]).sort(),
  ).toEqual(
    [
      [first.assignment, "on", "opened"],
      [second.assignment, "on", "opened"],
    ].sort(),
  );
});

test("an open for another member's agent shows that agent and its manager in the popup", async () => {
  const h = await agentTabs(ON_OFFICE());
  const { assignment } = await opened(h, 5, {
    agentId: "visitor",
    agentName: "Visitor",
    managerName: "Bob",
    scope: { kind: "opened", agentId: "visitor", via: "office" },
  });
  const row = ((await h.ui({ action: "state" })).assignments as Fields[]).find(
    (a) => a.id === assignment,
  );
  expect(row).toMatchObject({
    agent: { name: "Visitor" },
    manager: { name: "Bob" },
  });
});

test("open is refused with agent_tabs_off, and makes no tab, when the setting is off or does not reach the agent", async () => {
  const cases: Array<[string, () => Promise<Harness>, Fields]> = [
    ["off", () => agentTabs(new Map()), OPENED],
    [
      "older office, Only my agents, via All agents",
      () => olderOffice(ON_ALL()),
      { ...OPENED, via: "office" },
    ],
  ];
  for (const [name, start, scope] of cases) {
    const h = await start();
    h.open(5, crypto.randomUUID(), { agentId: "a", agentName: "Agent", scope });
    await settle();
    await settle();
    expect({ name, answer: result(h.socket, 5) }).toMatchObject({
      name,
      answer: { error: expect.anything(), reason: "agent_tabs_off" },
    });
    expect({
      name,
      windows: h.createdWindows.length,
      tabs: h.madeTabs.size,
    }).toEqual({ name, windows: 0, tabs: 0 });
    expect({ name, attached: h.calls.includes("attach") }).toEqual({
      name,
      attached: false,
    });
  }
  // The enabling case: the same open with the setting on succeeds.
  const h = await agentTabs();
  await opened(h, 5);
});

test("two opens at once with no Agents window make one window", async () => {
  const h = await agentTabs();
  const finish = h.delayWindow();
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  h.open(5, a);
  await settle();
  h.open(6, b);
  await settle();
  finish();
  for (let i = 0; i < 5; i++) await settle();
  expect(result(h.socket, 5)?.error).toBeUndefined();
  expect(result(h.socket, 6)?.error).toBeUndefined();
  expect(h.createdWindows).toHaveLength(1);
  expect(new Set([...h.madeTabs.values()].map((t) => t.windowId)).size).toBe(1);
  expect(h.madeTabs.size).toBe(2);
});

test("after the member closes the Agents window, the next open makes a new one", async () => {
  const h = await agentTabs();
  const first = await opened(h, 5);
  const [window] = [...h.windows.keys()];
  h.closeWindow(window);
  h.debuggerDetached("target_closed", first.tabId);
  for (let i = 0; i < 5; i++) await settle();
  const second = await opened(h, 6);
  expect(h.createdWindows).toHaveLength(2);
  expect(h.madeTabs.get(second.tabId)?.windowId).not.toBe(window);
});

// The member's window that a new Agents window takes its size from.
const MEMBER_WINDOW = {
  id: 3,
  focused: true,
  state: "normal",
  left: 30,
  top: 40,
  width: 1500,
  height: 900,
};
const boundsOf = (options: Record<string, unknown>) =>
  Object.fromEntries(
    (["left", "top", "width", "height"] as const)
      .filter((key) => key in options)
      .map((key) => [key, options[key]]),
  );
const windowUpdates = (h: Harness) =>
  h.windowCalls.filter((c) => c.call === "update").map((c) => c.arg);

test("a new Agents window takes the bounds of the member's last focused normal window, also a maximized one, and opens unfocused as a normal window; an open into it reads no window", async () => {
  const cases: Array<[string, typeof MEMBER_WINDOW]> = [
    ["normal", MEMBER_WINDOW],
    [
      "maximized",
      {
        ...MEMBER_WINDOW,
        state: "maximized",
        left: -8,
        top: -8,
        width: 1936,
        height: 1056,
      },
    ],
  ];
  for (const [name, window] of cases) {
    const h = await agentTabs();
    h.lastFocused(window);
    await opened(h, 5);
    expect({
      name,
      asked: h.windowCalls
        .filter((c) => c.call === "getLastFocused")
        .map((c) => c.arg),
    }).toEqual({
      name,
      asked: [expect.objectContaining({ windowTypes: ["normal"] })],
    });
    expect({ name, created: h.createdWindows.length }).toEqual({
      name,
      created: 1,
    });
    const made = h.createdWindows[0];
    expect({
      name,
      bounds: boundsOf(made),
      focused: made.focused,
      state: made.state ?? "normal",
    }).toEqual({
      name,
      bounds: {
        left: window.left,
        top: window.top,
        width: window.width,
        height: window.height,
      },
      focused: false,
      state: "normal",
    });
    // The next open uses that window and reads, sizes and focuses none.
    const before = h.windowCalls.length;
    await opened(h, 6);
    expect({ name, calls: h.windowCalls.slice(before) }).toEqual({
      name,
      calls: [],
    });
    h.socket.close();
  }
});

test("without a usable last focused window, a new Agents window gets a usable default size and no position", async () => {
  const cases: Array<[string, Record<string, unknown> | null]> = [
    ["none", null],
    // Windows reports a minimized window at -32000 with the size of its
    // taskbar button.
    [
      "minimized",
      {
        ...MEMBER_WINDOW,
        focused: false,
        state: "minimized",
        left: -32000,
        top: -32000,
        width: 160,
        height: 28,
      },
    ],
    ["fullscreen", { ...MEMBER_WINDOW, state: "fullscreen" }],
    ["no size", { id: 3, focused: true, state: "normal", left: 30, top: 40 }],
  ];
  for (const [name, window] of cases) {
    const h = await agentTabs();
    h.lastFocused(window);
    await opened(h, 5);
    expect({ name, created: h.createdWindows.length }).toEqual({
      name,
      created: 1,
    });
    const made = h.createdWindows[0];
    const { width, height } = made as { width?: number; height?: number };
    expect({
      name,
      position: [made.left, made.top],
      usable:
        Number.isInteger(width) &&
        width! >= 800 &&
        Number.isInteger(height) &&
        height! >= 600,
      focused: made.focused,
      state: made.state ?? "normal",
    }).toEqual({
      name,
      position: [undefined, undefined],
      usable: true,
      focused: false,
      state: "normal",
    });
    h.socket.close();
  }
});

test("the member's window is focused again after a new Agents window is made when it had focus; an unfocused one or none is left alone, and a refused focus does not fail the open", async () => {
  const focused = await agentTabs();
  focused.lastFocused(MEMBER_WINDOW);
  await opened(focused, 5);
  expect(
    focused.windowCalls.map((c) => (c.call === "update" ? c : c.call)),
  ).toEqual([
    "getLastFocused",
    "create",
    "made",
    { call: "update", arg: { id: MEMBER_WINDOW.id, focused: true } },
  ]);
  focused.socket.close();
  // Chrome was not the focused app, or had no normal window.
  for (const [name, window] of [
    ["unfocused", { ...MEMBER_WINDOW, focused: false }],
    ["none", null],
  ] as const) {
    const h = await agentTabs();
    h.lastFocused(window);
    await opened(h, 5);
    expect({ name, created: h.createdWindows.length }).toEqual({
      name,
      created: 1,
    });
    expect({ name, updates: windowUpdates(h) }).toEqual({ name, updates: [] });
    h.socket.close();
  }
  const refused = await agentTabs();
  refused.lastFocused(MEMBER_WINDOW);
  refused.refuseUpdate();
  const { tabId } = await opened(refused, 5);
  expect(windowUpdates(refused)).toHaveLength(1);
  expect(stillOpen(refused, tabId)).toBe(true);
  expect(refused.calls).toContain("attach");
});

test("when Chrome refuses the bounds, the Agents window is made once more without them and the open answers; the member's window is focused again and the next open uses that window", async () => {
  for (const [name, window] of [
    ["member window", MEMBER_WINDOW],
    ["default size", null],
  ] as const) {
    const h = await agentTabs();
    h.lastFocused(window);
    h.refuseBounds();
    const first = await opened(h, 5);
    expect({ name, created: h.createdWindows.length }).toEqual({
      name,
      created: 2,
    });
    const [sized, plain] = h.createdWindows;
    expect({
      name,
      sized: Object.keys(boundsOf(sized)).length > 0,
      plain: boundsOf(plain),
      focused: plain.focused,
    }).toEqual({ name, sized: true, plain: {}, focused: false });
    expect({ name, updates: windowUpdates(h) }).toEqual({
      name,
      updates: window ? [{ id: window.id, focused: true }] : [],
    });
    const second = await opened(h, 6);
    expect({ name, created: h.createdWindows.length }).toEqual({
      name,
      created: 2,
    });
    expect({
      name,
      same: h.madeTabs.get(second.tabId)?.windowId,
    }).toEqual({ name, same: h.madeTabs.get(first.tabId)?.windowId });
    h.socket.close();
  }
});

test("Open their own tabs off ends the agents' access to their tabs and leaves the tabs open as plain tabs; the member's offered tab stays offered", async () => {
  const h = await agentTabs(ON_OFFICE());
  const own = await onOffer(h);
  const mine = await opened(h, 5);
  const visitor = await opened(h, 6, {
    agentId: "visitor",
    agentName: "Visitor",
    scope: { kind: "opened", agentId: "visitor", via: "office" },
  });
  // The enabling state: the open kept both tabs from discard.
  expect([mine, visitor].map((t) => discardable(h, t.tabId))).toEqual([
    false,
    false,
  ]);
  await h.ui({ action: "access", access: { ...OFFICE_ON, openTabs: false } });
  for (let i = 0; i < 3; i++) await settle();
  expect(detachCauses(h).sort()).toEqual(
    [
      [mine.assignment, "off"],
      [visitor.assignment, "off"],
    ].sort(),
  );
  expect(h.removedTabs).toEqual([]);
  expect([mine, visitor].map((t) => stillOpen(h, t.tabId))).toEqual([
    true,
    true,
  ]);
  expect([mine, visitor].map((t) => discardable(h, t.tabId))).toEqual([
    true,
    true,
  ]);
  expect(await listed(h)).toEqual([{ id: own, phase: "on" }]);
});

test("Open their own tabs off while the office is away forgets the opened tab's resume and leaves the tab open", async () => {
  const h = await agentTabs();
  const { assignment, tabId } = await opened(h, 5);
  h.socket.close();
  await settle();
  // The enabling state: the tab waits to resume, still kept from discard.
  expect(await listed(h)).toEqual([{ id: assignment, phase: "offering" }]);
  expect(discardable(h, tabId)).toBe(false);
  await h.ui({ action: "access", access: MINE_OFF });
  for (let i = 0; i < 3; i++) await settle();
  expect(await listed(h)).toEqual([]);
  expect(stillOpen(h, tabId)).toBe(true);
  expect(discardable(h, tabId)).toBe(true);
});

test("on an older office, narrowing to My agents ends only the tabs opened via All agents, and leaves them open", async () => {
  const h = await olderOffice(ON_OFFICE());
  const mine = await opened(h, 5);
  const visitor = await opened(h, 6, {
    agentId: "visitor",
    agentName: "Visitor",
    scope: { kind: "opened", agentId: "visitor", via: "office" },
  });
  await h.ui({ action: "access", access: MINE_ON });
  for (let i = 0; i < 3; i++) await settle();
  expect(detachCauses(h)).toEqual([[visitor.assignment, "off"]]);
  expect(h.removedTabs).toEqual([]);
  expect(stillOpen(h, visitor.tabId)).toBe(true);
  expect(await listed(h)).toEqual([{ id: mine.assignment, phase: "on" }]);
});

test("Off while an open waits for its attach leaves no tab", async () => {
  const h = await agentTabs();
  const release = h.delayPopup("attach");
  h.open(5, crypto.randomUUID());
  for (let i = 0; i < 3; i++) await settle();
  // The enabling state: the tab exists and its attach waits.
  expect(h.madeTabs.size).toBe(1);
  await h.ui({ action: "access", access: MINE_OFF });
  await settle();
  release();
  for (let i = 0; i < 5; i++) await settle();
  expect(result(h.socket, 5)?.error).toBeDefined();
  expect(h.madeTabs.size).toBe(0);
  expect(await listed(h)).toEqual([]);
});

test("the office's detach ends an opened tab's access and leaves the tab open when it says close:false; with close, or from an older office with no params, it closes the tab; the member's offer is never closed", async () => {
  const h = await agentTabs();
  const kept = await opened(h, 5);
  h.command(20, "detach", { close: false });
  for (let i = 0; i < 3; i++) await settle();
  expect(detachCauses(h)).toEqual([[kept.assignment, "office"]]);
  expect(await listed(h)).toEqual([]);
  expect(h.removedTabs).toEqual([]);
  expect(stillOpen(h, kept.tabId)).toBe(true);
  expect(discardable(h, kept.tabId)).toBe(true);

  // The agent's own close.
  const closed = await opened(h, 6);
  h.command(21, "detach", { close: true });
  for (let i = 0; i < 3; i++) await settle();
  expect(h.removedTabs).toEqual([closed.tabId]);

  // An office from before close: every detach closes, as it did.
  const older = await opened(h, 7);
  h.command(22, "detach");
  for (let i = 0; i < 3; i++) await settle();
  expect(h.removedTabs).toEqual([closed.tabId, older.tabId]);

  // The member's own offer: the office's detach ends control only.
  await onOffer(h);
  h.command(23, "detach", { close: true });
  for (let i = 0; i < 3; i++) await settle();
  expect(h.removedTabs).not.toContain(7);
});

test("a tab whose open has not finished closes when the office ends it, also with close:false", async () => {
  const h = await agentTabs();
  const release = h.delayPopup("attach");
  h.open(7, crypto.randomUUID());
  for (let i = 0; i < 3; i++) await settle();
  // The enabling state: the tab exists and its attach waits.
  expect(h.madeTabs.size).toBe(1);
  h.command(21, "detach", { close: false });
  await settle();
  release();
  for (let i = 0; i < 5; i++) await settle();
  expect(h.madeTabs.size).toBe(0);
  expect(await listed(h)).toEqual([]);

  // The attach answered, but the office has not accepted the open yet: its
  // detach, or its refusal, closes the tab.
  for (const end of ["detach", "refusal"] as const) {
    const g = await agentTabs();
    const id = crypto.randomUUID();
    g.open(8, id);
    for (let i = 0; i < 3; i++) await settle();
    // The enabling state: the open answered, and the tab waits for offered.
    expect({ end, answered: !!result(g.socket, 8) }).toEqual({
      end,
      answered: true,
    });
    expect({ end, rows: await listed(g) }).toEqual({
      end,
      rows: [{ id, phase: "offering" }],
    });
    if (end === "detach") g.command(20, "detach", { close: false });
    else
      g.socket.receive({
        kind: "offered",
        generation: "generation-1",
        assignment: id,
        error: true,
      });
    for (let i = 0; i < 5; i++) await settle();
    expect({ end, tabs: g.madeTabs.size }).toEqual({ end, tabs: 0 });
  }
});

test("the popup's Off ends the agent's access and leaves its opened tab open; Close tab closes the tab and the pages its sites opened", async () => {
  const h = await agentTabs();
  const off = await opened(h, 5);
  const stopped = await h.ui({
    action: "stop",
    generation: "generation-1",
    assignment: off.assignment,
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(stopped.error).toBeUndefined();
  expect(detachCauses(h)).toEqual([[off.assignment, "off"]]);
  expect(await listed(h)).toEqual([]);
  expect(h.removedTabs).toEqual([]);
  expect(stillOpen(h, off.tabId)).toBe(true);
  expect(discardable(h, off.tabId)).toBe(true);

  const closed = await opened(h, 6);
  // A page that the tab's site opened, which the agent controls with it.
  h.navigation(closed.tabId, 300);
  for (let i = 0; i < 3; i++) await settle();
  const answer = await h.ui({
    action: "close",
    generation: "generation-1",
    assignment: closed.assignment,
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(answer.error).toBeUndefined();
  expect(detachCauses(h).map(([id]) => id)).toContain(closed.assignment);
  // The enabling state: the popup page was the agent's, so its debugger
  // session ended with the tab.
  expect(h.detachedTabs).toContain(300);
  expect([...h.removedTabs].sort()).toEqual([closed.tabId, 300].sort());
  expect(await listed(h)).toEqual([]);
});

test("a close that comes while an Off still detaches the tab closes it: the popup's Close tab, or the agent's own close", async () => {
  const h = await agentTabs();
  for (const via of ["popup", "agent"] as const) {
    const tab = await opened(h, via === "popup" ? 5 : 6);
    const held = h.delayDetach(tab.tabId);
    const stopped = h.ui({
      action: "stop",
      generation: "generation-1",
      assignment: tab.assignment,
    });
    for (let i = 0; i < 3; i++) await settle();
    // The enabling state: the Off waits on the detach, and the popup still
    // lists the tab.
    expect({ via, reached: held.reached() }).toEqual({ via, reached: true });
    expect({ via, rows: await listed(h) }).toEqual({
      via,
      rows: [{ id: tab.assignment, phase: "revoking" }],
    });
    const closing =
      via === "popup"
        ? h.ui({
            action: "close",
            generation: "generation-1",
            assignment: tab.assignment,
          })
        : h.command(30, "detach", { close: true });
    await settle();
    held.finish();
    await stopped;
    await closing;
    for (let i = 0; i < 3; i++) await settle();
    expect({ via, closed: h.removedTabs.includes(tab.tabId) }).toEqual({
      via,
      closed: true,
    });
  }
});

test("a connection loss keeps an opened tab, and it resumes after the access setting, with no deadline and no origin", async () => {
  const h = await agentTabs();
  const { assignment, tabId } = await opened(h, 5);
  const ws = await restart(h, 2, true, { agentTabs: true, access: true });
  expect(h.removedTabs).toEqual([]);
  // It waits to resume: still kept from discard.
  expect(discardable(h, tabId)).toBe(false);
  const order = ws.sent.map((m) => m.kind);
  expect(order.indexOf("access")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("access")).toBeLessThan(order.indexOf("offer"));
  expect(offers(ws)).toEqual([
    {
      kind: "offer",
      generation: "generation-2",
      assignment,
      scope: OPENED,
      durationMinutes: 0,
      expiresAt: null,
    },
  ]);
  // The office refuses it: the tab stays open as the member's.
  ws.receive({
    kind: "offered",
    generation: "generation-2",
    assignment,
    error: true,
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(await listed(h)).toEqual([]);
  expect(h.removedTabs).toEqual([]);
  expect(stillOpen(h, tabId)).toBe(true);
  expect(discardable(h, tabId)).toBe(true);
});

test("Off in the popup while the office is away forgets the opened tab's resume and leaves the tab open", async () => {
  const h = await agentTabs();
  const { assignment, tabId } = await opened(h, 5);
  h.socket.close();
  await settle();
  expect(await listed(h)).toEqual([{ id: assignment, phase: "offering" }]);
  await h.ui({ action: "stop", assignment });
  for (let i = 0; i < 3; i++) await settle();
  expect(await listed(h)).toEqual([]);
  expect(h.removedTabs).toEqual([]);
  expect(stillOpen(h, tabId)).toBe(true);
  expect(discardable(h, tabId)).toBe(true);
});

test("an office without agent tabs gets no opened tab to resume, and the tab stays open", async () => {
  const h = await agentTabs();
  const { tabId } = await opened(h, 5);
  const ws = await restart(h, 2, true);
  for (let i = 0; i < 3; i++) await settle();
  expect(offers(ws)).toEqual([]);
  expect([...agentTabsSent(ws), ...accessSent(ws)]).toEqual([]);
  expect(h.removedTabs).toEqual([]);
  expect(stillOpen(h, tabId)).toBe(true);
  expect(discardable(h, tabId)).toBe(true);
});

for (const end of ["Disconnect", "Disconnect while away", "a refusal"] as const)
  test(`${end} ends an opened tab's access and leaves the tab open`, async () => {
    const h = await agentTabs();
    const { tabId } = await opened(h, 5);
    if (end === "Disconnect while away") {
      h.socket.close();
      await settle();
    }
    if (end === "a refusal") h.socket.receive({ kind: "refused" });
    else await h.ui({ action: "disconnect" });
    for (let i = 0; i < 3; i++) await settle();
    expect(await listed(h)).toEqual([]);
    expect(h.removedTabs).toEqual([]);
    expect(stillOpen(h, tabId)).toBe(true);
    expect(discardable(h, tabId)).toBe(true);
  });

test("no extension update, Chrome update or Chrome start closes a tab; the opened tab list an earlier version kept is dropped", async () => {
  for (const reason of ["update", "chrome_update", "startup"] as const) {
    const local = ON_ALL();
    local.set("openedTabs", [{ tabId: 41, targetId: "kept-41" }]);
    const h = await agentTabs(local);
    // Tab 41 still shows the page target an earlier version kept.
    h.targets([
      { id: "kept-41", tabId: 41, type: "page" },
      { id: "owned", tabId: 7, type: "page" },
    ]);
    if (reason === "startup") h.startup();
    else h.installed(reason);
    for (let i = 0; i < 3; i++) await settle();
    expect({ reason, removed: h.removedTabs }).toEqual({ reason, removed: [] });
    expect({ reason, kept: h.local.has("openedTabs") }).toEqual({
      reason,
      kept: false,
    });
    // The setting itself stays.
    expect({ reason, setting: h.local.get("access") }).toEqual({
      reason,
      setting: MINE_ON,
    });
  }
});

test("unpair, a terminal refusal and a new pairing turn agent tabs off", async () => {
  const unpaired = await agentTabs();
  const pending = unpaired.ui({ action: "unpair", generation: "generation-1" });
  await settle();
  unpaired.socket.receive({ kind: "unpaired", generation: "generation-1" });
  await pending;
  expect(unpaired.local.has("access")).toBe(false);

  const refused = await agentTabs();
  refused.socket.receive({ kind: "refused" });
  await settle();
  expect(refused.local.has("access")).toBe(false);

  const paired = await agentTabs();
  await paired.ui({
    action: "pair",
    office: "http://127.0.0.1",
    code: "a".repeat(43),
  });
  await settle();
  const socket = paired.sockets.at(-1)!;
  socket.onopen?.();
  socket.receive({ kind: "paired", version: 4, credential: "issued" });
  await settle();
  expect(paired.local.has("access")).toBe(false);

  // The enabling case: a reconnect keeps it.
  const kept = await agentTabs();
  await kept.reconnect();
  expect(kept.local.get("access")).toEqual(MINE_ON);
});
