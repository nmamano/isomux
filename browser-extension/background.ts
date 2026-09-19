import {
  BROWSER_EXTENSION_PROTOCOL,
  browserSocketURL,
  fields,
  pageCommandAllowed,
  type Fields,
} from "../shared/browser-extension-protocol";

type OwnedTab = { tabId: number; children: Set<string> };
type Connection = {
  ws: WebSocket;
  generation?: string;
  tabs: Map<string, OwnedTab>;
  creating: Set<string>;
  closed: boolean;
};
let current: Connection | undefined;
let configuration = 0;

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
  try {
    await chrome.debugger.detach({ tabId: tab.tabId });
  } catch {}
}
function close(c: Connection): void {
  if (c.closed) return;
  c.closed = true;
  if (current === c) current = undefined;
  c.ws.close();
  for (const tab of c.tabs.values()) void detach(tab);
  c.tabs.clear();
  c.creating.clear();
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
    const owned: OwnedTab = { tabId: tab.id, children: new Set() };
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
  const child = args.sessionId;
  if (
    child !== undefined &&
    (typeof child !== "string" || !tab.children.has(child))
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
    { tabId: tab.tabId, sessionId: child },
    args.method,
    commandParams,
  );
  check(c);
  if (c.tabs.get(id) !== tab) throw new Error("Browser control ended");
  return fields(result ?? {});
}

async function configure(): Promise<void> {
  const serial = ++configuration;
  if (current) close(current);
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const stored = await chrome.storage.local.get("connection");
  if (serial !== configuration || !stored.connection) return;
  try {
    const config = fields(stored.connection);
    if (typeof config.url !== "string" || typeof config.credential !== "string")
      return;
    const ws = new WebSocket(browserSocketURL(config.url));
    const c: Connection = {
      ws,
      tabs: new Map(),
      creating: new Set(),
      closed: false,
    };
    current = c;
    ws.onopen = () =>
      send(c, {
        kind: "hello",
        version: BROWSER_EXTENSION_PROTOCOL,
        credential: config.credential,
      });
    ws.onclose = () => close(c);
    ws.onerror = () => close(c);
    ws.onmessage = (event: MessageEvent<string>) => {
      if (c.closed || current !== c) return;
      try {
        const msg = fields(JSON.parse(event.data));
        if (
          msg.kind === "ready" &&
          msg.version === BROWSER_EXTENSION_PROTOCOL &&
          typeof msg.generation === "string" &&
          !c.generation
        ) {
          c.generation = msg.generation;
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
  for (const [assignment, tab] of c.tabs) {
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
      sessionId: source.sessionId,
    });
  }
});
chrome.debugger.onDetach.addListener((source) => {
  const c = current;
  if (!c) return;
  for (const [assignment, tab] of c.tabs) {
    if (source.tabId !== tab.tabId) continue;
    c.tabs.delete(assignment);
    send(c, {
      kind: "event",
      generation: c.generation,
      assignment,
      method: "detached",
      params: {},
    });
  }
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void configure();
});
chrome.runtime.onStartup.addListener(() => {
  void configure();
});
chrome.runtime.onInstalled.addListener(() => {
  void configure();
});
void configure();
