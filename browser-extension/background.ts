import { translatorFor } from "../shared/i18n/translate";
import { newerFiles } from "./disk-files";
import {
  BROWSER_EXTENSION_PROTOCOL,
  ATTACH_ANSWER_MS,
  BROWSER_REATTACH_MS,
  extensionOutdated,
  validExtensionPackage,
  validGrantDuration,
  validGrantScope,
  sameGrantScope,
  type BrowserGrantScope,
  validGrantExpiry,
  type BrowserGrantDuration,
  browserSocketURL,
  officeSocketURL,
  type BrowserMetadata,
  type ExtensionUIState,
  fields,
  pageCommandAllowed,
  screencastKickCommand,
  SCREENCAST_KICK_PARAMS,
  type Fields,
  EXTENSION_MAX_BYTES,
  trimOversizedEvent,
  utf8Bytes,
  type BrowserAttachFailure,
  type BrowserDetachCause,
  type AgentTabsScope,
  type BrowserAccess,
  validAgentTabsScope,
  validBrowserAccess,
} from "../shared/browser-extension-protocol";
import { confirmPairedCode } from "./pairing-draft";

type OwnedTab = {
  tabId: number;
  children: Set<string>;
  targetId?: string;
  parentTabId?: number;
  leafTabId?: number;
  popups: Map<string, OwnedTab>;
  attaching?: boolean;
  agent?: { id: string; name: string };
  scope?: BrowserGrantScope;
  durationMinutes?: BrowserGrantDuration;
  expiresAt?: number | null;
  phase?: "offering" | "on" | "revoking";
  work?: Promise<Fields>;
  releasing?: Promise<void>;
  recovery?: object;
  epoch?: number;
  // The origin the office pinned at the offer, sent back to resume it.
  offerOrigin?: string;
  resuming?: boolean;
  // An attach command got no answer within ATTACH_ANSWER_MS.
  unanswered?: boolean;
  // A tab an agent opened, until the office answers the open.
  opening?: boolean;
  // A tab opened via All agents: the agent's manager.
  manager?: { name: string };
  // The opened tab was closed; it is not closed again.
  tabClosed?: boolean;
  // A tab an agent opened closes when its grant ends: the popup's Close tab or
  // the agent's own close asked for it.
  closeTab?: boolean;
};
type Connection = {
  ws: WebSocket;
  generation?: string;
  tabs: Map<string, OwnedTab>;
  creating: Set<string>;
  closed: boolean;
  terminal?: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
  debuggerRecovery?: boolean;
  offerResume?: boolean;
  // The office accepts "office" offers, from ready.
  officeScope?: boolean;
  // The office takes agent tabs, from ready.
  agentTabs?: boolean;
  // The office takes access messages and "shared" offers, from ready.
  access?: boolean;
  // The office's extension package, from ready.
  officePackage?: string;
  // The office takes files reports and sends reload, from ready.
  reload?: boolean;
  // The newer files version this connection last reported, and a disk read
  // in flight.
  filesSent?: string;
  filesReading?: boolean;
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
const badgeTabs = new Set<number>();
let badgeWork = Promise.resolve();
let cleanup = Promise.resolve();
// The offers to send again after a connection loss, such as an office restart,
// by assignment id. An offer is written when it turns ON, so a worker that
// Chrome stops without close() leaves it to the next worker. An entry leaves
// on the end of its offer (Off, a revoke, a refused resume) or a terminal
// close. Session storage keeps the list across a worker restart; an extension
// reload or a Chrome restart clears it.
type ResumeOffer = {
  tabId: number;
  scope: BrowserGrantScope;
  agent?: { id: string; name: string };
  manager?: { name: string };
  durationMinutes: BrowserGrantDuration;
  expiresAt: number | null;
  // Absent only for a tab an agent opened, which has no pin.
  offerOrigin?: string;
};
const RESUME_KEY = "resumeOffers";
const resumable = new Map<string, ResumeOffer>();
let resumeWrites = Promise.resolve();
const resumeLoaded = chrome.storage.session.get(RESUME_KEY).then(
  (stored) => {
    const list = stored[RESUME_KEY];
    if (!Array.isArray(list)) return;
    for (const item of list as unknown[]) {
      if (!Array.isArray(item) || typeof item[0] !== "string") continue;
      const r = fields(item[1]);
      const agent = r.agent === undefined ? undefined : fields(r.agent);
      const manager = r.manager === undefined ? undefined : fields(r.manager);
      if (
        Number.isSafeInteger(r.tabId) &&
        validGrantScope(r.scope) &&
        validGrantExpiry(r.durationMinutes, r.expiresAt) &&
        (r.scope.kind === "opened"
          ? r.offerOrigin === undefined
          : typeof r.offerOrigin === "string") &&
        (agent === undefined ||
          (typeof agent.id === "string" && typeof agent.name === "string")) &&
        (manager === undefined || typeof manager.name === "string")
      )
        resumable.set(item[0], {
          tabId: r.tabId as number,
          scope: r.scope,
          ...(agent
            ? { agent: { id: agent.id as string, name: agent.name as string } }
            : {}),
          ...(manager ? { manager: { name: manager.name as string } } : {}),
          durationMinutes: r.durationMinutes as BrowserGrantDuration,
          expiresAt: r.expiresAt,
          ...(typeof r.offerOrigin === "string"
            ? { offerOrigin: r.offerOrigin }
            : {}),
        });
    }
  },
  () => {},
);
function saveResumable(): Promise<void> {
  const list = [...resumable];
  resumeWrites = resumeWrites
    .catch(() => {})
    .then(() => chrome.storage.session.set({ [RESUME_KEY]: list }));
  return resumeWrites;
}
// Keeps an ON offer to send again after a connection loss.
function remember(c: Connection, id: string, tab: OwnedTab): void {
  const opened = tab.scope?.kind === "opened";
  if (
    !c.offerResume ||
    !tab.scope ||
    tab.durationMinutes === undefined ||
    (!opened && !tab.offerOrigin)
  )
    return;
  resumable.set(id, {
    tabId: tab.tabId,
    scope: tab.scope,
    ...(tab.agent ? { agent: tab.agent } : {}),
    ...(tab.manager ? { manager: tab.manager } : {}),
    durationMinutes: tab.durationMinutes,
    expiresAt: tab.expiresAt ?? null,
    ...(opened ? {} : { offerOrigin: tab.offerOrigin }),
  });
  void saveResumable();
}
// Drops an offer that waits to resume. A tab an agent opened stays open as
// the member's.
function forgetResumable(id: string): void {
  const r = resumable.get(id);
  if (!r || !resumable.delete(id)) return;
  void saveResumable();
  if (r.scope.kind === "opened") keepOpened(r.tabId);
}
// Disconnect, pairing, unpairing and a refusal end every offer.
async function clearResumable(): Promise<void> {
  await resumeLoaded;
  if (!resumable.size) return;
  for (const id of [...resumable.keys()]) forgetResumable(id);
  await saveResumable();
}

// Which agents may use this browser (task 7355640c): the member's setting,
// kept in chrome.storage.local, so it survives a Chrome restart and an
// extension update. It took over the agent tabs setting (task 73a9fb57),
// which an earlier version stored under "agentTabs". Unpair, pairing and a
// refusal clear it.
const ACCESS_KEY = "access";
const LEGACY_AGENT_TABS_KEY = "agentTabs";
const DEFAULT_ACCESS: BrowserAccess = {
  agents: "mine",
  members: [],
  openTabs: false,
};
let access: BrowserAccess = DEFAULT_ACCESS;
const settingLoaded = chrome.storage.local
  .get([ACCESS_KEY, LEGACY_AGENT_TABS_KEY])
  .then(
    async (stored) => {
      if (ACCESS_KEY in stored) {
        if (validBrowserAccess(stored[ACCESS_KEY])) access = stored[ACCESS_KEY];
      } else if (LEGACY_AGENT_TABS_KEY in stored) {
        const value = stored[LEGACY_AGENT_TABS_KEY];
        const scope =
          value && typeof value === "object"
            ? (value as Fields).scope
            : undefined;
        if (validAgentTabsScope(scope) && scope !== null) {
          access = {
            agents: scope === "office" ? "office" : "mine",
            members: [],
            openTabs: true,
          };
          await chrome.storage.local.set({ [ACCESS_KEY]: access });
        }
      }
      await chrome.storage.local.remove(LEGACY_AGENT_TABS_KEY);
    },
    () => {},
  );
// The agent tabs setting that an office from before access takes: a picked
// members setting becomes the narrower My agents.
const legacyAgentTabs = (): AgentTabsScope | null =>
  access.openTabs ? (access.agents === "office" ? "office" : "all") : null;
// The setting still lets an agent open a tab via this scope. An office that
// takes access ends the tabs of agents it no longer admits itself.
const covers = (c: Connection | undefined, via: AgentTabsScope) =>
  access.openTabs &&
  (!!c?.access || access.agents === "office" || via === "all");
// Tells the office the setting, in the form it takes.
function sendAccess(c: Connection): void {
  if (!c.generation || c.closed) return;
  if (c.access) send(c, { kind: "access", generation: c.generation, access });
  else if (c.agentTabs)
    send(c, {
      kind: "agentTabs",
      generation: c.generation,
      scope: legacyAgentTabs(),
    });
}
async function setAccess(next: BrowserAccess | null): Promise<void> {
  await settingLoaded;
  access = next ?? DEFAULT_ACCESS;
  if (next === null) await chrome.storage.local.remove(ACCESS_KEY);
  else await chrome.storage.local.set({ [ACCESS_KEY]: next });
  const c = current;
  if (c) sendAccess(c);
  // Off, or a narrower setting, closes the tabs it no longer allows.
  for (const [id, tab] of c?.tabs ?? [])
    if (
      tab.scope?.kind === "opened" &&
      tab.phase !== "revoking" &&
      !covers(c, tab.scope.via)
    )
      void revoke(c!, id, "off");
  for (const [id, r] of [...resumable])
    if (
      r.scope.kind === "opened" &&
      !covers(c, r.scope.via) &&
      !c?.tabs.has(id)
    )
      forgetResumable(id);
}

// The scope of the member's offer from the popup: "shared" follows the
// setting on an office that takes it; an older office gets the old scope, and
// picked members the narrower My agents.
const offerScope = (c: Connection): BrowserGrantScope =>
  c.access
    ? { kind: "shared" }
    : access.agents === "office" && c.officeScope
      ? { kind: "office" }
      : { kind: "all" };

// An earlier version kept the tabs agents opened under "openedTabs", to close
// them at an extension update. Tabs agents opened now stay open.
void chrome.storage.local.remove("openedTabs").catch(() => {});
// Closes a tab an agent opened, and the pages that its sites opened.
async function closeOpened(tab: OwnedTab, popups: number[]): Promise<void> {
  if (tab.scope?.kind !== "opened" || tab.tabClosed || tab.tabId < 0) return;
  tab.tabClosed = true;
  await chrome.tabs.remove([tab.tabId, ...popups]).catch(() => {});
}
// A tab an agent opened whose grant ended without a close: it stays open as
// the member's plain tab, which Chrome may discard again.
function keepOpened(tabId: number): void {
  void chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
}
// Closes or keeps a tab an agent opened, at the end of its grant. An open
// that never finished leaves only a blank tab, which closes.
async function endOpened(tab: OwnedTab, popups: number[]): Promise<void> {
  if (tab.scope?.kind !== "opened" || tab.tabClosed || tab.tabId < 0) return;
  if (tab.closeTab || tab.opening) await closeOpened(tab, popups);
  else keepOpened(tab.tabId);
}

// One Agents window per browser, made at the first open without focus, so
// agent tabs stay out of the member's windows. Its id is kept in session
// storage; a window the member closed is made again. Opens wait for each
// other here, so two at once make one window.
const WINDOW_KEY = "agentsWindow";
let windowWork: Promise<unknown> = Promise.resolve();
// The new window takes the bounds of the member's last focused window, since
// Chrome can pick a strip. Chrome refuses a maximized window without focus,
// so a maximized one gives its bounds too; other states get a default size.
async function makeAgentsWindow() {
  const member = await chrome.windows
    .getLastFocused({ windowTypes: ["normal"] })
    .catch(() => undefined);
  const { left, top, width, height } = member ?? {};
  const placed =
    (member?.state === "normal" || member?.state === "maximized") &&
    [left, top, width, height].every(Number.isSafeInteger);
  const size = placed ? { width, height } : { width: 1280, height: 800 };
  // Bounds mostly off screen (a monitor that is gone) are refused: the size
  // alone lets Chrome place the window. A size larger than the screen is
  // refused too, and the last try has no bounds, which can be the strip.
  const tries = placed ? [{ left, top, ...size }, size, {}] : [size, {}];
  const create = (bounds: (typeof tries)[number]) =>
    chrome.windows.create({ focused: false, url: "about:blank", ...bounds });
  let made = create(tries[0]);
  for (const bounds of tries.slice(1)) made = made.catch(() => create(bounds));
  const window = await made;
  // A window shown without focus can sit over the member's window.
  if (member?.focused === true && Number.isSafeInteger(member.id))
    await chrome.windows.update(member.id!, { focused: true }).catch(() => {});
  return window;
}
function makeAgentTab(): Promise<number> {
  const work = windowWork
    .catch(() => {})
    .then(async () => {
      const stored = (await chrome.storage.session.get(WINDOW_KEY))[WINDOW_KEY];
      if (Number.isSafeInteger(stored))
        try {
          await chrome.windows.get(stored as number);
          const made = await chrome.tabs.create({
            windowId: stored as number,
            url: "about:blank",
          });
          if (Number.isSafeInteger(made.id)) return made.id!;
        } catch {
          // The member closed the window.
        }
      const window = await makeAgentsWindow();
      const tabId = window.tabs?.[0]?.id;
      if (!Number.isSafeInteger(window.id) || !Number.isSafeInteger(tabId))
        throw new AttachError("tab_unavailable");
      await chrome.storage.session.set({ [WINDOW_KEY]: window.id });
      return tabId!;
    });
  windowWork = work;
  return work;
}
function controlledTabs(): Set<number> {
  const result = new Set<number>();
  const c = current;
  if (!c?.generation || c.closed) return result;
  for (const tab of c.tabs.values()) {
    if (tab.phase !== "on") continue;
    result.add(tab.tabId);
    for (const popup of tab.popups.values())
      if (popup.targetId) result.add(popup.tabId);
  }
  return result;
}
function refreshBadges(): void {
  badgeWork = badgeWork
    .catch(() => {})
    .then(async () => {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setBadgeBackgroundColor({
        color: current?.generation && !current.closed ? "#207451" : "#6b7280",
      });
      await chrome.action.setTitle({
        title: t(
          current?.generation && !current.closed
            ? "browser.connected"
            : "browser.offline",
        ),
      });
      for (const tabId of new Set([...badgeTabs, ...controlledTabs()])) {
        try {
          // Read ownership immediately before each write; an earlier await may
          // have allowed Off, detach or a different connection to retire it.
          const on = controlledTabs().has(tabId);
          await chrome.action.setBadgeText({ tabId, text: on ? "ON" : null });
          if (on) badgeTabs.add(tabId);
          else badgeTabs.delete(tabId);
          await chrome.action.setBadgeBackgroundColor({
            tabId,
            color: controlledTabs().has(tabId) ? "#a34c12" : "#6b7280",
          });
          await chrome.action.setTitle({
            tabId,
            title: controlledTabs().has(tabId)
              ? t("browser.control")
              : "Isomux Browser",
          });
        } catch {
          /* A user may have closed this tab. */
        }
      }
    });
}
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === undefined) return;
  const c = current;
  if (!c || c.closed) return;
  const tracked = [...c.tabs.values()].some(
    (tab) =>
      tab.tabId === tabId ||
      [...tab.popups.values()].some((popup) => popup.tabId === tabId),
  );
  if (tracked) refreshBadges();
});
async function currentTab(tabId: unknown) {
  if (!Number.isSafeInteger(tabId)) return undefined;
  try {
    const tab = await chrome.tabs.get(tabId as number);
    return tab.id === tabId
      ? {
          id: tab.id!,
          eligible: /^https?:\/\//.test(tab.url ?? ""),
          active: tab.active,
          windowId: tab.windowId,
        }
      : undefined;
  } catch {
    return undefined;
  }
}
async function uiState(tabId?: unknown): Promise<ExtensionUIState> {
  await resumeLoaded;
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
    agents: online ? (c.metadata?.agents ?? []) : [],
    members: online ? (c.metadata?.members ?? []) : [],
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
    ...(online && c.officeScope ? { officeScope: true } : {}),
    ...(online && c.agentTabs ? { agentTabs: true } : {}),
    ...(online && c.access ? { sharedAccess: true } : {}),
    ...(online ? { access } : {}),
    ...(online &&
    c.officePackage &&
    extensionOutdated(chrome.runtime.getManifest().version, c.officePackage)
      ? { update: { latest: c.officePackage } }
      : {}),
    assignments: online
      ? [...c.tabs].flatMap(([id, tab]) =>
          tab.scope
            ? [
                {
                  id,
                  scope: tab.scope,
                  agent: tab.agent,
                  ...(tab.manager ? { manager: tab.manager } : {}),
                  tabId: tab.tabId,
                  phase: tab.phase ?? "offering",
                  durationMinutes: tab.durationMinutes!,
                  expiresAt: tab.expiresAt ?? null,
                  current:
                    selected?.id === tab.tabId ||
                    [...tab.popups.values()].some(
                      (p) => p.tabId === selected?.id,
                    ),
                },
              ]
            : [],
        )
      : // While the office is away, the offers that wait to resume.
        [...resumable].map(([id, r]) => ({
          id,
          scope: r.scope,
          agent: r.agent,
          ...(r.manager ? { manager: r.manager } : {}),
          tabId: r.tabId,
          phase: "offering" as const,
          durationMinutes: r.durationMinutes,
          expiresAt: r.expiresAt,
          current: selected?.id === r.tabId,
        })),
  };
}
async function uiCommand(value: unknown): Promise<ExtensionUIState> {
  const msg = fields(value);
  if (msg.action === "state") {
    if (current?.generation)
      send(current, { kind: "agents", generation: current.generation });
    return uiState(msg.tabId);
  }
  if (msg.action === "pair") {
    if (
      typeof msg.office !== "string" ||
      typeof msg.code !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(msg.code.trim())
    )
      throw new Error();
    await clearResumable();
    await setAccess(null);
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
    if (msg.action === "disconnect") await clearResumable();
    await chrome.storage.local.set({
      connection: { ...config, disabled: msg.action === "disconnect" },
    });
  } else if (
    msg.action === "stop" &&
    typeof msg.assignment === "string" &&
    resumable.has(msg.assignment) &&
    !current?.tabs.has(msg.assignment)
  ) {
    // Off while the office is away: the offer is not sent again.
    forgetResumable(msg.assignment);
    await saveResumable();
  } else if (msg.action === "access") {
    if (!validBrowserAccess(msg.access)) throw new Error();
    await setAccess(msg.access);
  } else {
    const c = current;
    if (!c) throw new Error();
    check(c);
    if (msg.generation !== c.generation) throw new Error();
    if (msg.action === "offer") {
      const selected = await currentTab(msg.tabId);
      await settingLoaded;
      check(c);
      const scope = offerScope(c);
      if (
        !selected?.eligible ||
        !selected.active ||
        selected.windowId !== msg.windowId ||
        [...c.tabs.values()].some(
          (tab) =>
            tab.tabId === selected.id ||
            [...tab.popups.values()].some(
              (popup) => popup.tabId === selected.id,
            ),
        )
      )
        throw new Error();
      const id = crypto.randomUUID();
      const tab: OwnedTab = {
        tabId: selected.id,
        scope,
        durationMinutes: 0,
        expiresAt: null,
        phase: "offering",
        children: new Set(),
        popups: new Map(),
      };
      const accepted = await requestOffer(c, id, tab);
      if (!accepted || c.tabs.get(id) !== tab || tab.phase !== "offering") {
        await revoke(c, id, "offer_refused");
        throw tab.unanswered ? new TabUnansweredError() : new Error();
      }
      check(c);
      tab.phase = "on";
      remember(c, id, tab);
      refreshBadges();
    } else if (msg.action === "unpair") {
      await clearResumable();
      await setAccess(null);
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
        await revoke(c, msg.assignment, "off");
      } else if (msg.action === "close") {
        // Close tab, also on a row that an Off still ends.
        tab.closeTab = true;
        await revoke(c, msg.assignment, "off");
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
    (error) =>
      reply({
        error:
          "Browser request failed. Check the office address and pairing code, or reconnect.",
        // The popup shows why an offer failed when the tab did not respond.
        ...(error instanceof TabUnansweredError
          ? { reason: "unanswered" }
          : {}),
      }),
  );
  return true;
});

// Sends an offer of tab. Resolves with the office's answer, or with false when
// the connection ends first.
function requestOffer(
  c: Connection,
  id: string,
  tab: OwnedTab,
  resume?: { expiresAt: number | null; offerOrigin?: string },
): Promise<boolean> {
  c.tabs.set(id, tab);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      close(c);
    }, 30_000);
    c.offers.set(id, (ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
    send(c, {
      kind: "offer",
      generation: c.generation,
      assignment: id,
      scope: tab.scope,
      durationMinutes: tab.durationMinutes,
      ...resume,
    });
  });
}

// Called at ready, before any popup offer or metadata can take the tab. The
// office's answer keeps the entry with its deadline, or a refusal deletes it;
// a connection loss leaves it for the next connection.
function resumeOffer(c: Connection, id: string, r: ResumeOffer): void {
  const tab: OwnedTab = {
    tabId: r.tabId,
    scope: r.scope,
    agent: r.agent,
    ...(r.manager ? { manager: r.manager } : {}),
    durationMinutes: r.durationMinutes,
    expiresAt: r.expiresAt,
    offerOrigin: r.offerOrigin,
    phase: "offering",
    resuming: true,
    children: new Set(),
    popups: new Map(),
  };
  void requestOffer(c, id, tab, {
    expiresAt: r.expiresAt,
    ...(r.offerOrigin === undefined ? {} : { offerOrigin: r.offerOrigin }),
  }).then((accepted) => {
    if (!accepted && !c.closed) void revoke(c, id, "offer_refused");
  });
}

async function revoke(
  c: Connection,
  id: string,
  cause: BrowserDetachCause,
): Promise<void> {
  const tab = c.tabs.get(id);
  if (!tab) return;
  if (!c.closed && resumable.delete(id)) void saveResumable();
  if (tab.releasing) return tab.releasing;
  tab.phase = "revoking";
  c.creating.delete(id);
  c.offers.get(id)?.(false);
  c.offers.delete(id);
  send(c, {
    kind: "event",
    generation: c.generation,
    assignment: id,
    method: "detached",
    params: { cause },
  });
  refreshBadges();
  tab.releasing = (async () => {
    await tab.work?.catch(() => {});
    const popups = [...tab.popups.values()].map((popup) => popup.tabId);
    await detach(tab);
    await endOpened(tab, popups);
    if (c.tabs.get(id) === tab) c.tabs.delete(id);
    refreshBadges();
  })();
  return tab.releasing;
}

// No frame goes over EXTENSION_MAX_BYTES: the office's socket closes on a
// frame over its limit, which ends every offer (task 694e958e). An answer over
// it fails with its size. An event goes out cut, or ends only its own grant.
// While the office has a newer package, reports newer files on disk once per
// version, so the member can reload the extension from the office.
async function reportFiles(c: Connection): Promise<void> {
  if (
    !c.reload ||
    !c.officePackage ||
    !extensionOutdated(chrome.runtime.getManifest().version, c.officePackage) ||
    c.filesReading
  )
    return;
  c.filesReading = true;
  const files = await newerFiles();
  c.filesReading = false;
  if (!files || files === c.filesSent) return;
  c.filesSent = files;
  send(c, { kind: "files", generation: c.generation, package: files });
}
function send(c: Connection, message: Fields): void {
  if (c.closed || current !== c || c.ws.readyState !== WebSocket.OPEN) return;
  let json = JSON.stringify(message);
  // A UTF-16 unit is at most 3 UTF-8 bytes.
  const bytes =
    json.length * 3 > EXTENSION_MAX_BYTES ? utf8Bytes(json) : json.length;
  if (bytes > EXTENSION_MAX_BYTES) {
    if (message.kind === "result")
      json = JSON.stringify({
        kind: "result",
        generation: message.generation,
        id: message.id,
        error: "Browser command failed",
        tooLarge: bytes,
      });
    else if (
      message.kind === "event" &&
      typeof message.assignment === "string"
    ) {
      // The cut changes its input: cut a copy, not the live params.
      const trimmed = trimOversizedEvent(fields(JSON.parse(json)));
      if (!trimmed) {
        void revoke(c, message.assignment, "too_large");
        return;
      }
      json = JSON.stringify(trimmed);
    }
  }
  c.ws.send(json);
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
  // A tab that did not answer the attach does not answer the reset either.
  if (!tab.unanswered)
    try {
      await answered(
        { tabId: tab.tabId },
        "Emulation.setFocusEmulationEnabled",
        { enabled: false },
      );
    } catch {}
  try {
    await chrome.debugger.detach({ tabId: tab.tabId });
  } catch {}
}
// A tab that gave no answer to an attach command within ATTACH_ANSWER_MS.
class TabUnansweredError extends Error {}
// An attach that failed for a reason the office logs.
class AttachError extends Error {
  constructor(readonly reason: BrowserAttachFailure) {
    super("Browser attach failed");
  }
}
function attachFailure(error: unknown): BrowserAttachFailure {
  if (error instanceof TabUnansweredError) return "unanswered";
  if (error instanceof AttachError) return error.reason;
  // Duck-typed: Chrome's error can come from another realm.
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && /already attached/i.test(message))
    return "already_attached";
  return "attach_failed";
}
// One command of an attach or a detach, bounded by ATTACH_ANSWER_MS. It
// rejects with TabUnansweredError when the tab gives no answer.
function answered(
  target: { tabId: number; sessionId?: string },
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const command = chrome.debugger.sendCommand(target, method, params);
  // The detach that follows the bound rejects the command later.
  command.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TabUnansweredError()),
      ATTACH_ANSWER_MS,
    );
  });
  return Promise.race([command, bound]).finally(() => clearTimeout(timer));
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
  // A loss the member did not ask for keeps the ON offers, to send them again;
  // a terminal close ends them. A resume still in flight keeps its entry.
  // A tab an agent opened that waits to resume is left as it is.
  for (const [id, tab] of c.tabs)
    if (tab.phase === "on") {
      if (!c.terminal) remember(c, id, tab);
      else if (resumable.delete(id)) void saveResumable();
    }
  const retiring = [...c.tabs];
  for (const [, tab] of retiring) tab.phase = "revoking";
  cleanup = Promise.all([
    cleanup,
    ...retiring.map(async ([id, tab]) => {
      if (tab.releasing) await tab.releasing;
      else {
        await tab.work?.catch(() => {});
        const popups = [...tab.popups.values()].map((popup) => popup.tabId);
        await detach(tab);
        if (!resumable.has(id)) await endOpened(tab, popups);
      }
    }),
  ]).then(() => {});
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
  if (msg.method === "open") return openTab(c, id, fields(msg.params));
  if (msg.method === "attach") {
    const owned = c.tabs.get(id);
    if (!owned || owned.phase !== "offering" || owned.work || !c.offers.has(id))
      throw new AttachError("ended");
    c.creating.add(id);
    owned.work = (async () => {
      try {
        return await attachSteps(c, id, owned);
      } catch (error) {
        // A tab that shows a JavaScript dialog answers no command from a
        // debugger attached after the dialog opened.
        if (error instanceof TabUnansweredError) owned.unanswered = true;
        await detach(owned);
        throw error;
      } finally {
        c.creating.delete(id);
      }
    })();
    return owned.work;
  }
  const tab = c.tabs.get(id);
  if (msg.method === "detach") {
    // The agent's own close; an office from before close:false closes on
    // every detach.
    if (tab && fields(msg.params).close !== false) tab.closeTab = true;
    await revoke(c, id, "office");
    return {};
  }
  if (!tab || tab.phase !== "on" || msg.method !== "cdp")
    throw new Error("Unknown assignment");
  if (tab.recovery || [...tab.popups.values()].some((popup) => popup.recovery))
    throw new Error("Debugger recovery in progress");
  const args = fields(msg.params);
  const params = fields(args.params);
  const kick = screencastKickCommand(args.method);
  if (
    typeof args.method !== "string" ||
    (!kick && !pageCommandAllowed(args.method, params))
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
  // The office's capture kick draws a tab or a popup, never a frame.
  if (kick && child !== undefined) throw new Error("Unsupported page command");
  // Never let the client broaden auto-attach to unrelated targets or popups.
  const commandParams =
    args.method === "Target.setAutoAttach"
      ? {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }, { exclude: true }],
        }
      : args.method === "Page.startScreencast"
        ? { ...SCREENCAST_KICK_PARAMS }
        : args.method === "Page.stopScreencast"
          ? {}
          : params;
  const epoch = selected.epoch;
  const result = await chrome.debugger.sendCommand(
    { tabId: selected.tabId, sessionId: child },
    args.method,
    commandParams,
  );
  check(c);
  if (c.tabs.get(id) !== tab || tab.phase !== "on" || selected.epoch !== epoch)
    throw new Error("Browser control ended or debugger detached");
  // Playwright enables Page on child frame sessions before resuming them.
  // Each session needs its own interception to suppress the native chooser.
  if (args.method === "Page.enable" && child !== undefined) {
    await chrome.debugger.sendCommand(
      { tabId: selected.tabId, sessionId: child },
      "Page.setInterceptFileChooserDialog",
      { enabled: true },
    );
    check(c);
    if (
      c.tabs.get(id) !== tab ||
      tab.phase !== "on" ||
      selected.epoch !== epoch
    )
      throw new Error("Browser control ended or debugger detached");
  }
  return fields(result ?? {});
}

// The attach of an offered or opened tab, up to its target. A tab an agent
// opened may still show about:blank; any other page must be http(s).
async function attachSteps(
  c: Connection,
  id: string,
  owned: OwnedTab,
): Promise<Fields> {
  const opened = owned.scope?.kind === "opened";
  const pageAllowed = (url: string | undefined) =>
    /^https?:\/\//.test(url ?? "") || (opened && url === "about:blank");
  const tab = await chrome.tabs.get(owned.tabId);
  check(c);
  // Without the tabs permission, Chrome gives the URL only of a tab the
  // member offered (activeTab). An opened tab's page is checked from its
  // target after the attach.
  if ((!opened && !pageAllowed(tab.url)) || !c.creating.has(id))
    throw new AttachError("tab_unavailable");
  await chrome.debugger.attach({ tabId: owned.tabId }, "1.3");
  check(c);
  if (!c.creating.has(id)) throw new AttachError("ended");
  await answered({ tabId: owned.tabId }, "Page.enable");
  check(c);
  if (!c.creating.has(id)) throw new AttachError("ended");
  await answered({ tabId: owned.tabId }, "Page.setInterceptFileChooserDialog", {
    enabled: true,
  });
  check(c);
  if (!c.creating.has(id)) throw new AttachError("ended");
  await answered({ tabId: owned.tabId }, "Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  check(c);
  if (!c.creating.has(id)) throw new AttachError("ended");
  const result = fields(
    await answered({ tabId: owned.tabId }, "Target.getTargetInfo"),
  );
  check(c);
  if (!c.creating.has(id) || owned.phase !== "offering")
    throw new AttachError("ended");
  const target = fields(result.targetInfo);
  if (
    target.type !== "page" ||
    typeof target.targetId !== "string" ||
    typeof target.url !== "string" ||
    !pageAllowed(target.url)
  )
    throw new AttachError("tab_unavailable");
  owned.targetId = target.targetId;
  return result;
}

// The office's open: a new about:blank tab in the Agents window for the
// agent, attached as an offered tab is. The tab counts as offering from the
// start, so Off, a narrower scope or the office's detach finds it; an open
// that fails closes it.
function openTab(c: Connection, id: string, params: Fields): Promise<Fields> {
  const scope = params.scope;
  if (
    !validGrantScope(scope) ||
    scope.kind !== "opened" ||
    params.agentId !== scope.agentId ||
    typeof params.agentName !== "string" ||
    (params.managerName !== undefined && typeof params.managerName !== "string")
  )
    return Promise.reject(new Error("Invalid open"));
  if (!(c.agentTabs || c.access) || !covers(c, scope.via))
    return Promise.reject(new AttachError("agent_tabs_off"));
  if (c.tabs.has(id)) return Promise.reject(new AttachError("ended"));
  const tab: OwnedTab = {
    tabId: -1,
    scope,
    agent: { id: scope.agentId, name: params.agentName },
    ...(typeof params.managerName === "string"
      ? { manager: { name: params.managerName } }
      : {}),
    durationMinutes: 0,
    expiresAt: null,
    phase: "offering",
    opening: true,
    children: new Set(),
    popups: new Map(),
  };
  c.tabs.set(id, tab);
  // The office's offered answer: a refusal ends the tab.
  c.offers.set(id, (ok) => {
    if (!ok && tab.phase === "offering" && !c.closed)
      void revoke(c, id, "offer_refused");
  });
  c.creating.add(id);
  tab.work = (async () => {
    try {
      tab.tabId = await makeAgentTab();
      check(c);
      if (!c.creating.has(id) || tab.phase !== "offering")
        throw new AttachError("ended");
      await chrome.tabs.update(tab.tabId, { autoDiscardable: false });
      check(c);
      if (!c.creating.has(id)) throw new AttachError("ended");
      return await attachSteps(c, id, tab);
    } catch (error) {
      if (error instanceof TabUnansweredError) tab.unanswered = true;
      if (tab.tabId >= 0) await detach(tab);
      await closeOpened(tab, []);
      if (c.tabs.get(id) === tab && tab.phase !== "revoking") {
        c.tabs.delete(id);
        c.offers.delete(id);
      }
      throw error;
    } finally {
      c.creating.delete(id);
    }
  })();
  return tab.work;
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
    await Promise.all([cleanup, resumeLoaded, leftovers, settingLoaded]);
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
      void clearResumable();
      void setAccess(null);
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
        package: chrome.runtime.getManifest().version,
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
        if (
          (msg.kind === "ready" || msg.kind === "paired") &&
          msg.version !== BROWSER_EXTENSION_PROTOCOL
        ) {
          refuse();
          return;
        }
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
          if (typeof config.code === "string")
            void confirmPairedCode(config.code);
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
          void reportFiles(c);
          return;
        }

        if (
          msg.kind === "ready" &&
          msg.version === BROWSER_EXTENSION_PROTOCOL &&
          typeof msg.generation === "string" &&
          !c.generation
        ) {
          c.generation = msg.generation;
          c.debuggerRecovery = msg.debuggerRecovery === true;
          c.offerResume = msg.offerResume === true;
          c.officeScope = msg.officeScope === true;
          c.agentTabs = msg.agentTabs === true;
          c.access = msg.access === true;
          if (validExtensionPackage(msg.package)) c.officePackage = msg.package;
          c.reload = msg.reload === true;
          // The setting goes first, so the office takes the opened tabs that
          // resume.
          sendAccess(c);
          if (!c.offerResume) void clearResumable();
          else
            for (const [id, r] of [...resumable]) {
              // An office without agent tabs would refuse the scope; a tab the
              // setting no longer allows ends.
              if (
                r.scope.kind === "opened" &&
                (!(c.agentTabs || c.access) || !covers(c, r.scope.via))
              )
                forgetResumable(id);
              else resumeOffer(c, id, r);
            }
          refreshBadges();
          retry = 0;
          void chrome.alarms.clear("reconnect");
          c.watchdog = setTimeout(() => close(c), 45_000);
          void reportFiles(c);
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
          const displays = (list: unknown[]) =>
            list.map((value) => {
              const item = fields(value);
              if (typeof item.id !== "string" || typeof item.name !== "string")
                throw new Error();
              return { id: item.id, name: item.name };
            });
          if (msg.members !== undefined && !Array.isArray(msg.members))
            throw new Error();
          c.metadata = {
            member: { id: member.id, name: member.name },
            agents: displays(msg.agents),
            // An older office sends no members.
            members: displays(msg.members ?? []),
            assignments: msg.assignments.map((value) => {
              const a = fields(value);
              if (!validGrantScope(a.scope)) throw new Error();
              const agent =
                a.scope.kind === "agent" ? fields(a.agent) : undefined;
              if (
                typeof a.id !== "string" ||
                (a.scope.kind === "agent" &&
                  (!agent ||
                    agent.id !== a.scope.agentId ||
                    typeof agent.name !== "string")) ||
                !validGrantDuration(a.durationMinutes) ||
                !validGrantExpiry(a.durationMinutes, a.expiresAt)
              )
                throw new Error();
              return {
                id: a.id,
                scope: a.scope,
                ...(agent
                  ? {
                      agent: {
                        id: agent.id as string,
                        name: agent.name as string,
                      },
                    }
                  : {}),
                durationMinutes: a.durationMinutes,
                expiresAt: a.expiresAt,
              };
            }),
          };
          for (const [id, tab] of c.tabs) {
            const agent = c.metadata.agents.find((a) => a.id === tab.agent?.id);
            if (agent) tab.agent = agent;
            if (
              tab.phase === "on" &&
              !c.metadata.assignments.some(
                (a) =>
                  a.id === id &&
                  !!tab.scope &&
                  sameGrantScope(a.scope, tab.scope) &&
                  a.durationMinutes === tab.durationMinutes &&
                  a.expiresAt === tab.expiresAt,
              )
            )
              void revoke(c, id, "metadata");
          }
          return;
        }
        if (msg.kind === "offered" && typeof msg.assignment === "string") {
          const tab = c.tabs.get(msg.assignment);
          if (!c.offers.has(msg.assignment) || !tab || tab.phase !== "offering")
            return;
          if (!msg.error) {
            if (
              !validGrantScope(msg.scope) ||
              !tab.scope ||
              !sameGrantScope(msg.scope, tab.scope) ||
              msg.durationMinutes !== tab.durationMinutes ||
              !validGrantExpiry(msg.durationMinutes, msg.expiresAt)
            )
              throw new Error("Invalid grant expiry");
            tab.expiresAt = msg.expiresAt;
            if (typeof msg.offerOrigin === "string")
              tab.offerOrigin = msg.offerOrigin;
            if (tab.resuming || tab.opening) {
              tab.opening = false;
              tab.phase = "on";
              remember(c, msg.assignment, tab);
              refreshBadges();
            }
          } else if (resumable.delete(msg.assignment)) void saveResumable();
          tab.resuming = false;
          c.offers.get(msg.assignment)?.(!msg.error);
          c.offers.delete(msg.assignment);
          return;
        }
        // The member's Reload in the office. Agent control of every tab ends.
        if (msg.kind === "reload") {
          void newerFiles().then((files) => {
            if (files) chrome.runtime.reload();
          });
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
          (error) =>
            send(c, {
              kind: "result",
              generation: c.generation,
              id: msg.id,
              error: "Browser command failed",
              ...(msg.method === "attach" || msg.method === "open"
                ? { reason: attachFailure(error) }
                : {}),
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
        await answered({ tabId: popup.tabId }, "Page.enable");
        owned();
        await answered(
          { tabId: popup.tabId },
          "Page.setInterceptFileChooserDialog",
          { enabled: true },
        );
        owned();
        await answered(
          { tabId: popup.tabId },
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
        );
        owned();
        const result = fields(
          await answered({ tabId: popup.tabId }, "Target.getTargetInfo"),
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
      } catch (error) {
        if (error instanceof TabUnansweredError) popup.unanswered = true;
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
// Chrome can detach its debugger for an external-protocol launch while the
// page target survives. Rebuild the debugger connection, never replay input.
function recoverDebugger(
  c: Connection,
  assignment: string,
  main: OwnedTab,
  tab: OwnedTab,
): void {
  const recovery = {};
  tab.recovery = recovery;
  tab.epoch = (tab.epoch ?? 0) + 1;
  const owned = () => {
    check(c);
    if (
      c.tabs.get(assignment) !== main ||
      main.phase !== "on" ||
      tab.recovery !== recovery ||
      (tab !== main && ![...main.popups.values()].includes(tab))
    )
      throw new Error("Browser control ended");
  };
  let recovering = false;
  const retire = () => {
    if (recovering) void revoke(c, assignment, "recovery_failed");
    else retireDebugger(c, assignment, main, tab.tabId, "recovery_failed");
  };
  const timer = setTimeout(() => {
    if (tab.recovery !== recovery) return;
    tab.recovery = undefined;
    retire();
  }, BROWSER_REATTACH_MS);
  tab.work = (async () => {
    let attached = false;
    try {
      const currentTab = await chrome.tabs.get(tab.tabId);
      owned();
      if (currentTab.id !== tab.tabId) throw new Error("Tab closed");
      const targets = await chrome.debugger.getTargets();
      owned();
      if (
        !targets.some(
          (target) =>
            target.type === "page" &&
            target.tabId === tab.tabId &&
            target.id === tab.targetId,
        )
      )
        throw new Error("Page target changed");
      recovering = true;
      send(c, {
        kind: "event",
        generation: c.generation,
        assignment,
        method: "recovering",
        params: {},
      });
      // One attempt. Every await checks ownership before more work is sent.
      await chrome.debugger.attach({ tabId: tab.tabId }, "1.3");
      attached = true;
      owned();
      const info = fields(
        await chrome.debugger.sendCommand(
          { tabId: tab.tabId },
          "Target.getTargetInfo",
        ),
      );
      owned();
      if (fields(info.targetInfo).targetId !== tab.targetId)
        throw new Error("Page target changed");
      for (const [method, params] of [
        ["Page.enable", {}],
        ["Page.setInterceptFileChooserDialog", { enabled: true }],
        ["Emulation.setFocusEmulationEnabled", { enabled: true }],
      ] as const) {
        await chrome.debugger.sendCommand({ tabId: tab.tabId }, method, params);
        owned();
      }
      tab.children.clear();
      tab.recovery = undefined;
      send(c, {
        kind: "event",
        generation: c.generation,
        assignment,
        method: "recovered",
        params: {},
      });
      refreshBadges();
    } catch {
      // A timed-out attach can finish late; retire that attachment as well.
      if (attached) await detach(tab);
      if (tab === main || [...main.popups.values()].includes(tab)) retire();
    } finally {
      clearTimeout(timer);
      if (tab.recovery === recovery) tab.recovery = undefined;
    }
    return {};
  })();
}

function retireDebugger(
  c: Connection,
  assignment: string,
  tab: OwnedTab,
  tabId: number,
  cause: BrowserDetachCause,
): void {
  if (tabId === tab.tabId) {
    void revoke(c, assignment, cause);
    return;
  }
  const popup = [...tab.popups].find(([, owned]) => owned.tabId === tabId);
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
      node.recovery = undefined;
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

chrome.debugger.onDetach.addListener((source, reason) => {
  refreshBadges();
  const c = current;
  if (!c) return;
  for (const [assignment, tab] of c.tabs) {
    if (tab.phase === "revoking") continue;
    const detached =
      source.tabId === tab.tabId
        ? tab
        : [...tab.popups.values()].find(
            (popup) => popup.tabId === source.tabId,
          );
    if (
      detached &&
      reason === "target_closed" &&
      c.debuggerRecovery &&
      tab.phase === "on" &&
      !tab.recovery &&
      ![...tab.popups.values()].some((popup) => popup.recovery)
    ) {
      recoverDebugger(c, assignment, tab, detached);
      continue;
    }
    retireDebugger(c, assignment, tab, source.tabId, "debugger_detached");
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  // Only the connection reconnects; the agent tabs setting and the opened
  // tab ids do not.
  if (area !== "local" || !("connection" in changes)) return;
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
// A worker that Chrome stopped without close() leaves its debugger sessions
// attached, and Chrome refuses a new attach to those tabs. This worker holds
// none yet, so it detaches every tab first; a detach of a tab this extension
// did not attach fails and changes nothing.
const leftovers = chrome.debugger.getTargets().then(
  (targets) =>
    Promise.all(
      targets.map(async ({ tabId, type }) => {
        if (type !== "page" || tabId === undefined) return;
        // Its badge may still say ON.
        badgeTabs.add(tabId);
        try {
          await chrome.debugger.detach({ tabId });
        } catch {}
      }),
    ).then(() => {}),
  () => {},
);
chrome.runtime.onStartup.addListener(() => {
  void configure();
});
chrome.runtime.onInstalled.addListener(() => {
  void configure();
});
void configure();
