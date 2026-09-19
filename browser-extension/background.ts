import { translatorFor } from "../shared/i18n/translate";
import {
  BROWSER_EXTENSION_PROTOCOL,
  browserSocketURL,
  officeSocketURL,
  type BrowserMetadata,
  type ExtensionUIState,
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
  agent?: { id: string; name: string };
  phase?: "offering" | "on" | "revoking";
  work?: Promise<Fields>;
  releasing?: Promise<void>;
};
type Connection = {
  ws: WebSocket;
  generation?: string;
  tabs: Map<string, OwnedTab>;
  creating: Set<string>;
  closed: boolean;
  terminal?: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
  metadata?: BrowserMetadata;
  offers: Map<string, (ok: boolean) => void>;
  unpairResult?: (ok: boolean) => void;
};
const language = navigator.language.split("-")[0];
const { t } = translatorFor(
  language === "es" || language === "ca" || language === "zh" ? language : "en",
);
let current: Connection | undefined;
let configuration = 0;
let retry = 0;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let savedCredential: string | undefined;
let badgeTabs = new Set<number>();
let badgeWork = Promise.resolve();
let cleanup = Promise.resolve();
function refreshBadges(): void {
  badgeWork = badgeWork
    .catch(() => {})
    .then(async () => {
      const c = current;
      const online = !!c?.generation && !c.closed;
      const owned = new Set<number>();
      if (online)
        for (const tab of c.tabs.values()) {
          if (tab.phase !== "on") continue;
          owned.add(tab.tabId);
          for (const popup of tab.popups.values()) if (popup.targetId) owned.add(popup.tabId);
        }
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setBadgeBackgroundColor({
        color: online ? "#207451" : "#6b7280",
      });
      await chrome.action.setTitle({
        title: t(online ? "browser.connected" : "browser.offline"),
      });
      for (const tabId of new Set([...badgeTabs, ...owned])) {
        try {
          await chrome.action.setBadgeText({
            tabId,
            text: owned.has(tabId) ? "ON" : null,
          });
          await chrome.action.setBadgeBackgroundColor({
            tabId,
            color: owned.has(tabId)
              ? "#a34c12"
              : online
                ? "#207451"
                : "#6b7280",
          });
          await chrome.action.setTitle({
            tabId,
            title: owned.has(tabId) ? t("browser.control") : "Isomux Browser",
          });
        } catch {
          /* A user may have closed this tab. */
        }
      }
      badgeTabs = owned;
    });
}
async function currentTab(tabId: unknown) {
  if (!Number.isSafeInteger(tabId)) return undefined;
  try {
    const tab = await chrome.tabs.get(tabId as number);
    return tab.id === tabId ? { id: tab.id!, eligible: /^https?:\/\//.test(tab.url ?? ""), active: tab.active, windowId: tab.windowId } : undefined;
  } catch { return undefined; }
}
async function uiState(tabId?: unknown): Promise<ExtensionUIState> {
  const { connection } = await chrome.storage.local.get("connection");
  const config = connection ? fields(connection) : {};
  const selected = await currentTab(tabId);
  const c = current;
  const online = !!c?.generation && !c.closed;
  let office = "";
  if (typeof config.url === "string") {
    try {
      const u = new URL(config.url);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      office = u.origin;
    } catch {}
  }
  return {
    currentTab: selected,
    agents: online ? c.metadata?.agents ?? [] : [],
    office,
    state: online
      ? "connected"
      : config.blocked
        ? "blocked"
        : config.unknown
          ? "unknown"
          : config.disabled
            ? "disabled"
            : c
              ? "connecting"
              : config.credential || config.code
                ? "offline"
                : "unpaired",
    member: online ? c.metadata?.member : undefined,
    assignments: online
      ? [...c.tabs].flatMap(([id, tab]) => tab.agent ? [{
          id, agent: tab.agent, tabId: tab.tabId, phase: tab.phase ?? "offering",
          current: selected?.id === tab.tabId || [...tab.popups.values()].some((p) => p.tabId === selected?.id),
        }] : []) : [],
  };
}
async function uiCommand(value: unknown): Promise<ExtensionUIState> {
  const msg = fields(value);
  if (msg.action === "state") {
    if (current?.generation) send(current, { kind: "agents", generation: current.generation });
    return uiState(msg.tabId);
  }
  if (msg.action === "pair") {
    if (
      typeof msg.office !== "string" ||
      typeof msg.code !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(msg.code.trim())
    )
      throw new Error();
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    await chrome.storage.local.set({
      connection: {
        url: officeSocketURL(msg.office.trim()),
        code: msg.code.trim(),
      },
    });
  } else if (msg.action === "disconnect" || msg.action === "reconnect") {
    const stored = await chrome.storage.local.get("connection");
    const config = fields(stored.connection);
    if (
      msg.action === "reconnect" &&
      (config.blocked || config.unknown || !config.credential)
    )
      throw new Error();
    await chrome.storage.local.set({
      connection: { ...config, disabled: msg.action === "disconnect" },
    });
  } else {
    const c = current;
    if (!c) throw new Error();
    check(c);
    if (msg.generation !== c.generation) throw new Error();
    if (msg.action === "offer") {
      const selected = await currentTab(msg.tabId);
      check(c);
      const agent = c.metadata?.agents.find((a) => a.id === msg.agent);
      if (!selected?.eligible || !selected.active || selected.windowId !== msg.windowId || !agent ||
          [...c.tabs.values()].some((tab) => tab.agent?.id === agent.id || tab.tabId === selected.id ||
            [...tab.popups.values()].some((popup) => popup.tabId === selected.id))) throw new Error();
      const id = crypto.randomUUID();
      const tab: OwnedTab = { tabId: selected.id, agent, phase: "offering", children: new Set(), popups: new Map() };
      c.tabs.set(id, tab);
      const accepted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { close(c); }, 30_000);
        c.offers.set(id, (ok) => { clearTimeout(timer); resolve(ok); });
        send(c, { kind: "offer", generation: c.generation, assignment: id, agent: agent.id });
      });
      if (!accepted || c.tabs.get(id) !== tab || tab.phase !== "offering") {
        await revoke(c, id);
        throw new Error();
      }
      check(c);
      tab.phase = "on";
      refreshBadges();
    } else if (msg.action === "unpair") {
      const acknowledged = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          c.terminal = true;
          close(c);
        }, 5000);
        c.unpairResult = (ok) => {
          clearTimeout(timer);
          resolve(ok);
        };
        send(c, { kind: "unpair", generation: c.generation });
      });
      const stored = await chrome.storage.local.get("connection");
      await chrome.storage.local.set({
        connection: acknowledged
          ? null
          : { ...fields(stored.connection), disabled: true, unknown: true },
      });
    } else {
      if (typeof msg.assignment !== "string") throw new Error();
      const tab = c.tabs.get(msg.assignment);
      if (!tab) throw new Error();
      if (msg.action === "focus") {
        const target = await chrome.tabs.update(tab.leafTabId ?? tab.tabId, {
          active: true,
        });
        await chrome.windows.update(target.windowId, { focused: true });
      } else if (msg.action === "stop") {
        await revoke(c, msg.assignment);
      } else throw new Error();
    }
  }
  return uiState(msg.tabId);
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("connection.html")
  )
    return;
  void uiCommand(message).then(
    (state) => reply({ ...state, generation: current?.generation }),
    () =>
      reply({
        error:
          "Browser request failed. Check the office address and pairing code, or reconnect.",
      }),
  );
  return true;
});

async function revoke(c: Connection, id: string): Promise<void> {
  const tab = c.tabs.get(id);
  if (!tab) return;
  if (tab.releasing) return tab.releasing;
  tab.phase = "revoking";
  c.creating.delete(id);
  c.offers.get(id)?.(false);
  c.offers.delete(id);
  send(c, { kind: "event", generation: c.generation, assignment: id, method: "detached", params: {} });
  refreshBadges();
  tab.releasing = (async () => {
    await tab.work?.catch(() => {});
    await detach(tab);
    if (c.tabs.get(id) === tab) c.tabs.delete(id);
    refreshBadges();
  })();
  return tab.releasing;
}

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
  for (const [id, popup] of tab.popups) {
    await popup.work?.catch(() => {});
    if (tab.popups.get(id) === popup) await detach(popup);
  }
  tab.popups.clear();
  try {
    await chrome.debugger.sendCommand(
      { tabId: tab.tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false },
    );
  } catch {}
  try {
    await chrome.debugger.detach({ tabId: tab.tabId });
  } catch {}
}
function close(c: Connection): void {
  if (c.closed) return;
  c.closed = true;
  c.metadata = undefined;
  for (const resolve of c.offers.values()) resolve(false);
  c.offers.clear();
  c.unpairResult?.(false);
  c.unpairResult = undefined;
  clearTimeout(c.watchdog);
  if (current === c) current = undefined;
  c.ws.close();
  const retiring = [...c.tabs.values()];
  for (const tab of retiring) tab.phase = "revoking";
  cleanup = Promise.all([cleanup, ...retiring.map(async (tab) => { if (tab.releasing) await tab.releasing; else { await tab.work?.catch(() => {}); await detach(tab); } })]).then(() => {});
  c.tabs.clear();
  c.creating.clear();
  refreshBadges();
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
  if (msg.method === "attach") {
    const owned = c.tabs.get(id);
    if (!owned || owned.phase !== "offering" || owned.work || !c.offers.has(id))
      throw new Error("No pending tab offer");
    c.creating.add(id);
    owned.work = (async () => {
      try {
        const tab = await chrome.tabs.get(owned.tabId);
        check(c);
        if (!/^https?:\/\//.test(tab.url ?? "") || !c.creating.has(id)) throw new Error("Tab is unavailable");
        await chrome.debugger.attach({ tabId: owned.tabId }, "1.3");
        check(c);
        if (!c.creating.has(id)) throw new Error("Browser control ended");
        await chrome.debugger.sendCommand({ tabId: owned.tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
        check(c);
        if (!c.creating.has(id)) throw new Error("Browser control ended");
        const result = fields(await chrome.debugger.sendCommand({ tabId: owned.tabId }, "Target.getTargetInfo"));
        check(c);
        if (!c.creating.has(id) || owned.phase !== "offering") throw new Error("Browser control ended");
        const target = fields(result.targetInfo);
        if (target.type !== "page" || typeof target.targetId !== "string" || typeof target.url !== "string" || !/^https?:\/\//.test(target.url))
          throw new Error("Tab is unavailable");
        owned.targetId = target.targetId;
        return result;
      } catch (error) {
        await detach(owned);
        throw error;
      } finally { c.creating.delete(id); }
    })();
    return owned.work;
  }
  const tab = c.tabs.get(id);
  if (msg.method === "detach") {
    await revoke(c, id);
    return {};
  }
  if (!tab || tab.phase !== "on" || msg.method !== "cdp") throw new Error("Unknown assignment");
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
  if (c.tabs.get(id) !== tab || tab.phase !== "on") throw new Error("Browser control ended");
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
  refreshBadges();
  if (serial !== configuration || !stored.connection) return;
  try {
    const config = fields(stored.connection);
    if (config.blocked === true || config.disabled === true) return;
    if (
      typeof config.url !== "string" ||
      (typeof config.credential !== "string" && typeof config.code !== "string")
    )
      return;
    await cleanup;
    if (serial !== configuration) return;
    const ws = new WebSocket(browserSocketURL(config.url));
    const c: Connection = {
      ws,
      tabs: new Map(),
      offers: new Map(),
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
        if ((msg.kind === "ready" || msg.kind === "paired") && msg.version !== BROWSER_EXTENSION_PROTOCOL) { refuse(); return; }
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
          refreshBadges();
          retry = 0;
          void chrome.alarms.clear("reconnect");
          c.watchdog = setTimeout(() => close(c), 45_000);
          return;
        }
        if (msg.generation !== c.generation || !c.generation) return;
        if (msg.kind === "metadata") {
          const member = fields(msg.member);
          if (
            typeof member.id !== "string" ||
            typeof member.name !== "string" ||
            !Array.isArray(msg.agents) ||
            !Array.isArray(msg.assignments)
          )
            throw new Error();
          c.metadata = {
            member: { id: member.id, name: member.name },
            agents: (msg.agents as unknown[]).map((value) => {
              const agent = fields(value);
              if (typeof agent.id !== "string" || typeof agent.name !== "string") throw new Error();
              return { id: agent.id, name: agent.name };
            }),
            assignments: msg.assignments.map((value) => {
              const a = fields(value),
                agent = fields(a.agent);
              if (
                typeof a.id !== "string" ||
                typeof agent.id !== "string" ||
                typeof agent.name !== "string"
              )
                throw new Error();
              return { id: a.id, agent: { id: agent.id, name: agent.name } };
            }),
          };
          for (const [id, tab] of c.tabs) {
            const agent = c.metadata.agents.find(a => a.id === tab.agent?.id);
            if (agent) tab.agent = agent;
            if (tab.phase === "on" && !c.metadata.assignments.some(a => a.id === id && a.agent.id === tab.agent?.id))
              void revoke(c, id);
          }
          return;
        }
        if (msg.kind === "offered" && typeof msg.assignment === "string") {
          c.offers.get(msg.assignment)?.(!msg.error);
          c.offers.delete(msg.assignment);
          return;
        }
        if (msg.kind === "unpaired" && c.unpairResult) {
          c.terminal = true;
          c.unpairResult(true);
          c.unpairResult = undefined;
          close(c);
          return;
        }
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
    if (main.phase !== "on") continue;
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
    if (main.phase !== "on") continue;
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
        main.phase !== "on" ||
        main.popups.get(sessionId) !== popup ||
        opener.tabId !== (main.leafTabId ?? main.tabId) ||
        (opener !== main && ![...main.popups.values()].includes(opener))
      )
        throw new Error("Control ended");
    };
    popup.work = (async () => {
      try {
        await chrome.debugger.attach({ tabId: popup.tabId }, "1.3");
        owned();
        await chrome.debugger.sendCommand(
          { tabId: popup.tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true },
        );
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
        refreshBadges();
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
        await detach(popup);
        if (main.popups.get(sessionId) === popup) main.popups.delete(sessionId);
      } finally {
        main.attaching = false;
      }
      return {};
    })();
    break;
  }
});
chrome.debugger.onDetach.addListener((source) => {
  refreshBadges();
  const c = current;
  if (!c) return;
  for (const [assignment, tab] of c.tabs) {
    if (tab.phase === "revoking") continue;
    if (source.tabId === tab.tabId) {
      void revoke(c, assignment);
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
