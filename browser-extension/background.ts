import {
  BROWSER_EXTENSION_PROTOCOL,
  browserSocketURL,
  fields,
  pageCommandAllowed,
  type Fields,
} from "../shared/browser-extension-protocol";

type OwnedTab = {
  tabId: number;
  children: Set<string>;
  targetId?: string;
  parentTabId?: number;
  leafTabId?: number;
  popups: Map<string, OwnedTab>;
  attaching?: boolean;
};
type Connection = {
  ws: WebSocket;
  generation?: string;
  tabs: Map<string, OwnedTab>;
  creating: Set<string>;
  closed: boolean;
  terminal?: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
};
let current: Connection | undefined;
let configuration = 0;
let retry = 0;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let savedCredential: string | undefined;

function send(c: Connection, message: Fields): void {
  if (!c.closed && current === c && c.ws.readyState === WebSocket.OPEN)
    c.ws.send(JSON.stringify(message));
}
function check(c: Connection): void {
  if (
    c.closed ||
    current !== c ||
    !c.generation ||
    c.ws.readyState !== WebSocket.OPEN
  )
    throw new Error("Browser disconnected");
}
async function detach(tab: OwnedTab): Promise<void> {
  for (const popup of tab.popups.values()) await detach(popup);
  tab.popups.clear();
  try {
    await chrome.debugger.detach({ tabId: tab.tabId });
  } catch {}
}
function close(c: Connection): void {
  if (c.closed) return;
  c.closed = true;
  clearTimeout(c.watchdog);
  if (current === c) current = undefined;
  c.ws.close();
  for (const tab of c.tabs.values()) void detach(tab);
  c.tabs.clear();
  c.creating.clear();
  if (!c.terminal) {
    clearTimeout(reconnect);
    void chrome.alarms.create("reconnect", { delayInMinutes: 0.5 });
    reconnect = setTimeout(
      () => {
        void configure(false);
      },
      Math.min(30_000, 1000 * 2 ** Math.min(retry++, 5)) +
        Math.floor(Math.random() * 250),
    );
  }
}

async function command(c: Connection, msg: Fields): Promise<Fields> {
  check(c);
  if (typeof msg.assignment !== "string") throw new Error("Invalid assignment");
  const id = msg.assignment;
  if (msg.method === "create") {
    if (c.tabs.has(id) || c.creating.has(id))
      throw new Error("Task tab already exists");
    c.creating.add(id);
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    check(c);
    if (!c.creating.has(id)) throw new Error("Browser control ended");
    if (tab.id === undefined) throw new Error("Task tab creation failed");
    const owned: OwnedTab = {
      tabId: tab.id,
      children: new Set(),
      popups: new Map(),
    };
    c.tabs.set(id, owned);
    try {
      await chrome.debugger.attach({ tabId: tab.id }, "1.3");
      check(c);
      if (!c.creating.has(id)) throw new Error("Browser control ended");
      const result = fields(
        await chrome.debugger.sendCommand(
          { tabId: tab.id },
          "Target.getTargetInfo",
        ),
      );
      check(c);
      if (!c.creating.has(id)) throw new Error("Browser control ended");
      owned.targetId = fields(result.targetInfo).targetId as string;
      return result;
    } catch (error) {
      await detach(owned);
      c.tabs.delete(id);
      throw error;
    } finally {
      c.creating.delete(id);
    }
  }
  const tab = c.tabs.get(id);
  if (msg.method === "detach") {
    c.creating.delete(id);
    if (tab) {
      c.tabs.delete(id);
      await detach(tab);
    }
    return {};
  }
  if (!tab || msg.method !== "cdp") throw new Error("Unknown assignment");
  const args = fields(msg.params);
  const params = fields(args.params);
  if (
    typeof args.method !== "string" ||
    !pageCommandAllowed(args.method, params)
  )
    throw new Error("Unsupported page command");
  const requested = args.sessionId;
  const selected =
    typeof requested === "string"
      ? (tab.popups.get(requested) ??
        [...tab.popups.values()].find((popup) =>
          popup.children.has(requested),
        ) ??
        tab)
      : tab;
  const child =
    typeof requested === "string" && tab.popups.has(requested)
      ? undefined
      : requested;
  if (
    child !== undefined &&
    (typeof child !== "string" || !selected.children.has(child))
  )
    throw new Error("Unknown child session");
  // Never let the client broaden auto-attach to unrelated targets or popups.
  const commandParams =
    args.method === "Target.setAutoAttach"
      ? {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }, { exclude: true }],
        }
      : params;
  const result = await chrome.debugger.sendCommand(
    { tabId: selected.tabId, sessionId: child },
    args.method,
    commandParams,
  );
  check(c);
  if (c.tabs.get(id) !== tab) throw new Error("Browser control ended");
  return fields(result ?? {});
}

async function configure(reset = true): Promise<void> {
  clearTimeout(reconnect);
  void chrome.alarms.clear("reconnect");
  if (reset) retry = 0;
  const serial = ++configuration;
  if (current) {
    current.terminal = true;
    close(current);
  }
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const stored = await chrome.storage.local.get("connection");
  if (serial !== configuration || !stored.connection) return;
  try {
    const config = fields(stored.connection);
    if (config.blocked === true) return;
    if (
      typeof config.url !== "string" ||
      (typeof config.credential !== "string" && typeof config.code !== "string")
    )
      return;
    const ws = new WebSocket(browserSocketURL(config.url));
    const c: Connection = {
      ws,
      tabs: new Map(),
      creating: new Set(),
      closed: false,
    };
    current = c;
    const refuse = () => {
      c.terminal = true;
      void chrome.alarms.clear("reconnect");
      void chrome.storage.local.set({
        connection: { ...config, blocked: true },
      });
      close(c);
    };
    ws.onopen = () =>
      send(c, {
        kind: "hello",
        version: BROWSER_EXTENSION_PROTOCOL,
        ...(typeof config.credential === "string"
          ? { credential: config.credential }
          : { code: config.code }),
      });
    ws.onclose = (event) => {
      if (event.code === 4003) {
        refuse();
        return;
      }
      close(c);
    };
    ws.onerror = () => close(c);
    ws.onmessage = (event: MessageEvent<string>) => {
      if (c.closed || current !== c) return;
      try {
        if (event.data.length > 8 * 1024 * 1024)
          throw new Error("Invalid message");
        const msg = fields(JSON.parse(event.data));
        if (msg.kind === "refused") {
          refuse();
          return;
        }
        if (
          msg.kind === "paired" &&
          msg.version === BROWSER_EXTENSION_PROTOCOL &&
          typeof msg.credential === "string" &&
          !c.generation
        ) {
          savedCredential = msg.credential;
          void chrome.storage.local.set({
            connection: { url: config.url, credential: msg.credential },
          });
          return;
        }
        if (
          msg.kind === "ping" &&
          msg.generation === c.generation &&
          c.generation
        ) {
          clearTimeout(c.watchdog);
          c.watchdog = setTimeout(() => close(c), 45_000);
          send(c, { kind: "pong", generation: c.generation });
          return;
        }

        if (
          msg.kind === "ready" &&
          msg.version === BROWSER_EXTENSION_PROTOCOL &&
          typeof msg.generation === "string" &&
          !c.generation
        ) {
          c.generation = msg.generation;
          retry = 0;
          void chrome.alarms.clear("reconnect");
          c.watchdog = setTimeout(() => close(c), 45_000);
          return;
        }
        if (msg.generation !== c.generation || !c.generation) return;
        if (msg.kind !== "command" || !Number.isSafeInteger(msg.id))
          throw new Error("Invalid command");
        void command(c, msg).then(
          (result) =>
            send(c, {
              kind: "result",
              generation: c.generation,
              id: msg.id,
              result,
            }),
          () =>
            send(c, {
              kind: "result",
              generation: c.generation,
              id: msg.id,
              error: "Browser command failed",
            }),
        );
      } catch {
        close(c);
      }
    };
  } catch {
    /* Invalid saved configuration cannot open a transport. */
  }
}

chrome.debugger.onEvent.addListener((source, method, params = {}) => {
  const c = current;
  if (!c || c.closed || !c.generation) return;
  for (const [assignment, main] of c.tabs) {
    const popupEntry = [...main.popups].find(
      ([, popup]) => popup.tabId === source.tabId,
    );
    const tab = popupEntry?.[1] ?? main;
    if (
      tab.tabId !== source.tabId ||
      (source.sessionId && !tab.children.has(source.sessionId))
    )
      continue;
    if (method === "Target.attachedToTarget") {
      const info = fields(params.targetInfo);
      if (info.type !== "iframe" || typeof params.sessionId !== "string") {
        close(c);
        return;
      }
      tab.children.add(params.sessionId);
    } else if (
      method === "Target.detachedFromTarget" &&
      typeof params.sessionId === "string"
    ) {
      if (!tab.children.delete(params.sessionId)) return;
    } else if (method.startsWith("Target.")) return;
    send(c, {
      kind: "event",
      generation: c.generation,
      assignment,
      method,
      params,
      sessionId: source.sessionId ?? popupEntry?.[0],
    });
  }
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((event) => {
  const c = current;
  if (
    !c ||
    c.closed ||
    !c.generation ||
    !Number.isSafeInteger(event.tabId) ||
    !Number.isSafeInteger(event.sourceTabId)
  )
    return;
  for (const [assignment, main] of c.tabs) {
    // Source identity is authoritative. Do not retain the event or its URL.
    const opener =
      main.tabId === event.sourceTabId
        ? main
        : [...main.popups.values()].find(
            (node) => node.tabId === event.sourceTabId,
          );
    if (
      !opener ||
      opener.tabId !== (main.leafTabId ?? main.tabId) ||
      !opener.targetId ||
      main.attaching ||
      main.popups.size >= 8
    )
      continue;
    if (
      [...c.tabs.values()].some(
        (root) =>
          root.tabId === event.tabId ||
          [...root.popups.values()].some((node) => node.tabId === event.tabId),
      )
    )
      return;
    main.attaching = true;
    const popup: OwnedTab = {
      tabId: event.tabId,
      parentTabId: opener.tabId,
      children: new Set(),
      popups: new Map(),
    };
    const sessionId = crypto.randomUUID();
    main.popups.set(sessionId, popup);
    const owned = () => {
      check(c);
      if (
        c.tabs.get(assignment) !== main ||
        main.popups.get(sessionId) !== popup ||
        opener.tabId !== (main.leafTabId ?? main.tabId) ||
        (opener !== main && ![...main.popups.values()].includes(opener))
      )
        throw new Error("Control ended");
    };
    void (async () => {
      try {
        await chrome.debugger.attach({ tabId: popup.tabId }, "1.3");
        owned();
        const result = fields(
          await chrome.debugger.sendCommand(
            { tabId: popup.tabId },
            "Target.getTargetInfo",
          ),
        );
        owned();
        const info = fields(result.targetInfo);
        if (info.type !== "page" || typeof info.targetId !== "string")
          throw new Error("Invalid popup target");
        popup.targetId = info.targetId;
        main.leafTabId = popup.tabId;
        send(c, {
          kind: "event",
          generation: c.generation,
          assignment,
          method: "popup",
          params: {
            sessionId,
            targetInfo: { ...info, openerId: opener.targetId },
          },
        });
      } catch {
        main.popups.delete(sessionId);
        await detach(popup);
      } finally {
        main.attaching = false;
      }
    })();
    break;
  }
});
chrome.debugger.onDetach.addListener((source) => {
  const c = current;
  if (!c) return;
  for (const [assignment, tab] of c.tabs) {
    if (source.tabId === tab.tabId) {
      c.tabs.delete(assignment);
      void detach(tab);
      send(c, {
        kind: "event",
        generation: c.generation,
        assignment,
        method: "detached",
        params: {},
      });
      continue;
    }
    const popup = [...tab.popups].find(
      ([, owned]) => owned.tabId === source.tabId,
    );
    if (popup) {
      const removed = new Set([popup[1].tabId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of tab.popups.values())
          if (
            node.parentTabId !== undefined &&
            removed.has(node.parentTabId) &&
            !removed.has(node.tabId)
          ) {
            removed.add(node.tabId);
            changed = true;
          }
      }
      // Detach descendants first, so both the server and Playwright return
      // through the exact parent chain rather than map insertion order.
      const retiring = [...tab.popups].filter(([, node]) =>
        removed.has(node.tabId),
      );
      while (retiring.length) {
        const index = retiring.findIndex(
          ([, node]) =>
            !retiring.some(([, child]) => child.parentTabId === node.tabId),
        );
        const [sessionId, node] = retiring.splice(index, 1)[0];
        tab.popups.delete(sessionId);
        void detach(node);
        send(c, {
          kind: "event",
          generation: c.generation,
          assignment,
          method: "popupDetached",
          params: { sessionId },
        });
      }
      tab.leafTabId = popup[1].parentTabId ?? tab.tabId;
    }
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const connection = (
    changes as { connection?: { newValue?: { credential?: string } } }
  ).connection;
  if (connection?.newValue?.credential === savedCredential && savedCredential) {
    savedCredential = undefined;
    return;
  }
  void configure();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect" && !current) void configure(false);
});
chrome.runtime.onStartup.addListener(() => {
  void configure();
});
chrome.runtime.onInstalled.addListener(() => {
  void configure();
});
void configure();
