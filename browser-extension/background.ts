import { t } from "./i18n";
import { newerFiles } from "./disk-files";
import { ownMute } from "./own-mute";
import {
  BROWSER_EXTENSION_PROTOCOL,
  EXTENSION_MIN_PROTOCOL,
  CHROME_WEB_STORE_URL,
  storeInstall,
  validStoreUrl,
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
import { SELECTION_MAX, TITLE_MAX } from "../shared/browser-share";

// A protocol version the extension speaks. Offices back to v2026.9.22 speak
// only EXTENSION_MIN_PROTOCOL; a later one answers in the highest version the
// hello allows.
const spoken = (version: unknown): boolean =>
  Number.isInteger(version) &&
  (version as number) >= EXTENSION_MIN_PROTOCOL &&
  (version as number) <= BROWSER_EXTENSION_PROTOCOL;

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
  // The grant's pages are muted: from the open for a tab an agent opened,
  // else from the agent's mute.
  muted?: boolean;
  // An offered tab that had sound before the agent's first mute gets it back
  // when its grant ends.
  restoreSound?: boolean;
};
type Connection = {
  // The office's origin (officeOf): its key in connections and storage.
  office: string;
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
  // The office's store listing, from ready, when valid.
  storeUrl?: string;
  // The office takes files reports and sends reload, from ready.
  reload?: boolean;
  // The newer files version this connection last reported, and a disk read
  // in flight.
  filesSent?: string;
  filesReading?: boolean;
  // The office takes shares, from ready.
  share?: boolean;
  metadata?: BrowserMetadata;
  offers: Map<string, (ok: boolean) => void>;
  // The shares waiting for the office's answer, by id.
  shares: Map<string, (result: string) => void>;
  unpairResult?: (ok: boolean) => void;
};
// The extension holds a pairing per office at once (task 811ed3de): one
// connection per office, by origin. Offices are separate trust domains: no
// office reads or ends another office's tabs, offers or setting.
const connections = new Map<string, Connection>();
// Per office: the configure serial, the reconnect backoff and timer, and the
// credential its own paired message saved, which must not reopen it.
type Slot = {
  configuration: number;
  retry: number;
  reconnect?: ReturnType<typeof setTimeout>;
  savedCredential?: string;
};
const slots = new Map<string, Slot>();
function slot(office: string): Slot {
  let s = slots.get(office);
  if (!s) slots.set(office, (s = { configuration: 0, retry: 0 }));
  return s;
}
const online = (c: Connection | undefined): c is Connection =>
  !!c?.generation && !c.closed;
// chrome.storage.local keeps one record per office, so two offices that
// write at once do not race over one shared object.
const CONNECTION_PREFIX = "connection:";
const ACCESS_PREFIX = "access:";
const connectionKey = (office: string) => CONNECTION_PREFIX + office;
const accessKey = (office: string) => ACCESS_PREFIX + office;
// The office's http(s) origin from its stored socket url.
function officeOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
  } catch {
    return undefined;
  }
}
// The picked office the popup named last, so a popup that names none opens
// on it.
const SELECTED_KEY = "selectedOffice";
// Before 0.10.0 the extension kept one connection under "connection" and its
// setting under "access" (and before that "agentTabs"). The worker start
// moves them to the office's own keys, once; everything that reads storage
// waits for it. A setting with no connection to move has no office and is
// dropped.
const LEGACY_CONNECTION_KEY = "connection";
const LEGACY_ACCESS_KEY = "access";
const LEGACY_AGENT_TABS_KEY = "agentTabs";
const migrated: Promise<void> = (async () => {
  try {
    const stored = await chrome.storage.local.get([
      LEGACY_CONNECTION_KEY,
      LEGACY_ACCESS_KEY,
      LEGACY_AGENT_TABS_KEY,
    ]);
    if (!Object.keys(stored).length) return;
    const record = stored[LEGACY_CONNECTION_KEY];
    const office = record ? officeOf(fields(record).url) : undefined;
    let setting: BrowserAccess | undefined;
    if (LEGACY_ACCESS_KEY in stored) {
      if (validBrowserAccess(stored[LEGACY_ACCESS_KEY]))
        setting = stored[LEGACY_ACCESS_KEY];
    } else if (LEGACY_AGENT_TABS_KEY in stored) {
      const value = stored[LEGACY_AGENT_TABS_KEY];
      const scope =
        value && typeof value === "object"
          ? (value as Fields).scope
          : undefined;
      if (validAgentTabsScope(scope) && scope !== null)
        setting = {
          agents: scope === "office" ? "office" : "mine",
          members: [],
          openTabs: true,
        };
    }
    if (office) {
      const present = await chrome.storage.local.get([
        connectionKey(office),
        accessKey(office),
      ]);
      const writes: Record<string, unknown> = {};
      if (!(connectionKey(office) in present))
        writes[connectionKey(office)] = record;
      if (setting && !(accessKey(office) in present))
        writes[accessKey(office)] = setting;
      if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    }
    await chrome.storage.local.remove([
      LEGACY_CONNECTION_KEY,
      LEGACY_ACCESS_KEY,
      LEGACY_AGENT_TABS_KEY,
    ]);
  } catch {}
})();
// Every stored office's record, by origin.
async function storedOffices(): Promise<Map<string, Fields>> {
  await migrated;
  const all = await chrome.storage.local.get(null);
  const result = new Map<string, Fields>();
  for (const key of Object.keys(all).sort())
    if (key.startsWith(CONNECTION_PREFIX) && all[key])
      result.set(key.slice(CONNECTION_PREFIX.length), fields(all[key]));
  return result;
}
const badgeTabs = new Set<number>();
let badgeWork = Promise.resolve();
// The detaches of closed connections. Shared by every office: a member can
// move a tab from one office to another (Off, then an offer), and the new
// attach waits for the old detach, which ATTACH_ANSWER_MS bounds.
let cleanup = Promise.resolve();
// The offers to send again after a connection loss, such as an office restart,
// by office and assignment id (resumeKey): an office picks the ids of its
// opens, so an id alone could name another office's offer. An offer is
// written when it turns ON, so a worker that
// Chrome stops without close() leaves it to the next worker. An entry leaves
// on the end of its offer (Off, a revoke, a refused resume) or a terminal
// close. Session storage keeps the list across a worker restart; an extension
// reload or a Chrome restart clears it.
type ResumeOffer = {
  office: string;
  id: string;
  tabId: number;
  scope: BrowserGrantScope;
  agent?: { id: string; name: string };
  manager?: { name: string };
  durationMinutes: BrowserGrantDuration;
  expiresAt: number | null;
  // Absent only for a tab an agent opened, which has no pin.
  offerOrigin?: string;
  // The grant's mute flags (OwnedTab), so a resume keeps them.
  muted?: boolean;
  restoreSound?: boolean;
};
const RESUME_KEY = "resumeOffers";
const resumable = new Map<string, ResumeOffer>();
const resumeKey = (office: string, id: string) => `${office} ${id}`;
// The offers of one office that wait to resume.
const resumableOf = (office: string) =>
  [...resumable.values()].filter((r) => r.office === office);
let resumeWrites = Promise.resolve();
// Chrome updates a store install by itself, so the hello tells the office.
// Read once per worker start; the first socket waits for it.
let storeBuild = false;
const installLoaded = (async () => {
  try {
    storeBuild = storeInstall((await chrome.management.getSelf()).installType);
  } catch {}
})();
const resumeLoaded = chrome.storage.session.get(RESUME_KEY).then(
  (stored) => {
    const list = stored[RESUME_KEY];
    if (!Array.isArray(list)) return;
    for (const item of list as unknown[]) {
      if (!Array.isArray(item) || typeof item[0] !== "string") continue;
      const r = fields(item[1]);
      // An entry from before 0.10.0 names no office: an extension update
      // clears session storage, so none is left to resume.
      if (typeof r.office !== "string") continue;
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
        (manager === undefined || typeof manager.name === "string") &&
        [r.muted, r.restoreSound].every(
          (flag) => flag === undefined || typeof flag === "boolean",
        )
      )
        resumable.set(resumeKey(r.office, item[0]), {
          office: r.office,
          id: item[0],
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
          // An entry from before 0.8.0 has no flag; an opened grant counts
          // as muted, as one opened now is.
          ...muteFlags({
            muted:
              (r.muted as boolean | undefined) ?? r.scope.kind === "opened",
            restoreSound: r.restoreSound as boolean | undefined,
          }),
        });
    }
  },
  () => {},
);
// The mute flags that are set, to copy between a grant and its resume entry.
function muteFlags(from: {
  muted?: boolean;
  restoreSound?: boolean;
}): Pick<ResumeOffer, "muted" | "restoreSound"> {
  return {
    ...(from.muted === undefined ? {} : { muted: from.muted }),
    ...(from.restoreSound === undefined
      ? {}
      : { restoreSound: from.restoreSound }),
  };
}
function saveResumable(): Promise<void> {
  const list = [...resumable.values()].map((r) => [r.id, r]);
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
  resumable.set(resumeKey(c.office, id), {
    office: c.office,
    id,
    tabId: tab.tabId,
    scope: tab.scope,
    ...(tab.agent ? { agent: tab.agent } : {}),
    ...(tab.manager ? { manager: tab.manager } : {}),
    durationMinutes: tab.durationMinutes,
    expiresAt: tab.expiresAt ?? null,
    ...(opened ? {} : { offerOrigin: tab.offerOrigin }),
    ...muteFlags(tab),
  });
  void saveResumable();
}
// Drops an offer that waits to resume. A tab an agent opened stays open as
// the member's.
function forgetResumable(office: string, id: string): void {
  const r = resumable.get(resumeKey(office, id));
  if (!r || !resumable.delete(resumeKey(office, id))) return;
  void saveResumable();
  if (r.scope.kind === "opened") keepOpened(r.tabId);
  // A live grant gives the sound back at its own end, with its popups. Here
  // the pages its site opened before the loss are not known.
  else if (!connections.get(office)?.tabs.has(id))
    void restoreSound(r.tabId, r.restoreSound, []);
}
// Ends a resume entry of c's that its own grant now ends.
function dropResumable(c: Connection, id: string): void {
  if (resumable.delete(resumeKey(c.office, id))) void saveResumable();
}
// Disconnect, pairing, unpairing and a refusal end every offer of the office.
async function clearResumable(office: string): Promise<void> {
  await resumeLoaded;
  const list = resumableOf(office);
  if (!list.length) return;
  for (const r of list) forgetResumable(office, r.id);
  await saveResumable();
}

// Which agents may use this browser (task 7355640c): the member's setting
// per office (task 811ed3de), kept in chrome.storage.local under
// access:<origin>, so it survives a Chrome restart and an extension update.
// Member ids and the office scope belong to one office. Unpair, pairing and
// a refusal clear the office's setting.
const DEFAULT_ACCESS: BrowserAccess = {
  agents: "mine",
  members: [],
  openTabs: false,
};
const settings = new Map<string, BrowserAccess>();
const accessOf = (office: string) => settings.get(office) ?? DEFAULT_ACCESS;
const settingLoaded = migrated
  .then(() => chrome.storage.local.get(null))
  .then(
    (all) => {
      for (const [key, value] of Object.entries(all))
        if (key.startsWith(ACCESS_PREFIX) && validBrowserAccess(value))
          settings.set(key.slice(ACCESS_PREFIX.length), value);
    },
    () => {},
  );
// The agent tabs setting that an office from before access takes: a picked
// members setting becomes the narrower My agents.
function legacyAgentTabs(office: string): AgentTabsScope | null {
  const access = accessOf(office);
  return access.openTabs
    ? access.agents === "office"
      ? "office"
      : "all"
    : null;
}
// The setting still lets an agent open a tab via this scope. An office that
// takes access ends the tabs of agents it no longer admits itself.
function covers(
  office: string,
  c: Connection | undefined,
  via: AgentTabsScope,
) {
  const access = accessOf(office);
  return (
    access.openTabs &&
    (!!c?.access || access.agents === "office" || via === "all")
  );
}
// Tells the office the setting, in the form it takes.
function sendAccess(c: Connection): void {
  if (!c.generation || c.closed) return;
  if (c.access)
    send(c, {
      kind: "access",
      generation: c.generation,
      access: accessOf(c.office),
    });
  else if (c.agentTabs)
    send(c, {
      kind: "agentTabs",
      generation: c.generation,
      scope: legacyAgentTabs(c.office),
    });
}
async function setAccess(
  office: string,
  next: BrowserAccess | null,
): Promise<void> {
  await settingLoaded;
  if (next === null) settings.delete(office);
  else settings.set(office, next);
  if (next === null) await chrome.storage.local.remove(accessKey(office));
  else await chrome.storage.local.set({ [accessKey(office)]: next });
  const c = connections.get(office);
  if (c) sendAccess(c);
  // Off, or a narrower setting, closes the tabs it no longer allows.
  for (const [id, tab] of c?.tabs ?? [])
    if (
      tab.scope?.kind === "opened" &&
      tab.phase !== "revoking" &&
      !covers(office, c, tab.scope.via)
    )
      void revoke(c!, id, "off");
  for (const r of resumableOf(office))
    if (
      r.scope.kind === "opened" &&
      !covers(office, c, r.scope.via) &&
      !c?.tabs.has(r.id)
    )
      forgetResumable(office, r.id);
}

// The scope of the member's offer from the popup: "shared" follows the
// setting on an office that takes it; an older office gets the old scope, and
// picked members the narrower My agents.
const offerScope = (c: Connection): BrowserGrantScope =>
  c.access
    ? { kind: "shared" }
    : accessOf(c.office).agents === "office" && c.officeScope
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
// Mutes or unmutes every page of a grant. The first mute of an offered tab
// notes whether the member's tab had sound, to give it back at the end.
async function muteGrant(
  c: Connection,
  id: string,
  tab: OwnedTab,
  muted: boolean,
): Promise<Fields> {
  if (muted && tab.scope?.kind !== "opened" && tab.restoreSound === undefined)
    tab.restoreSound = !(await chrome.tabs.get(tab.tabId)).mutedInfo?.muted;
  tab.muted = muted;
  const r = resumable.get(resumeKey(c.office, id));
  if (r) {
    Object.assign(r, muteFlags(tab));
    void saveResumable();
  }
  await chrome.tabs.update(tab.tabId, { muted });
  await Promise.all(
    [...tab.popups.values()].map((popup) =>
      chrome.tabs.update(popup.tabId, { muted }).catch(() => {}),
    ),
  );
  return { muted };
}
// At the end of an offered tab's grant, the sound the agent's mute took. A
// mute or unmute of the member's since then wins.
// restore is the grant's restoreSound, which only an offered tab sets.
async function restoreSound(
  rootTabId: number,
  restore: boolean | undefined,
  popups: number[],
): Promise<void> {
  if (!restore) return;
  const root = await chrome.tabs.get(rootTabId).catch(() => undefined);
  if (!ownMute(root?.mutedInfo)) return;
  for (const tabId of [rootTabId, ...popups])
    try {
      if (ownMute((await chrome.tabs.get(tabId)).mutedInfo))
        await chrome.tabs.update(tabId, { muted: false });
    } catch {
      // The page closed.
    }
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
  for (const c of connections.values()) {
    if (!online(c)) continue;
    for (const tab of c.tabs.values()) {
      if (tab.phase !== "on") continue;
      result.add(tab.tabId);
      for (const popup of tab.popups.values())
        if (popup.targetId) result.add(popup.tabId);
    }
  }
  return result;
}
// The office that holds a tab, in any phase, as its root or one of its
// pages, or that waits to resume it. Chrome takes one debugger per tab, so a
// tab belongs to at most one office.
function holder(tabId: unknown): string | undefined {
  if (!Number.isSafeInteger(tabId) || (tabId as number) < 0) return undefined;
  for (const c of connections.values())
    for (const tab of c.tabs.values())
      if (
        tab.tabId === tabId ||
        [...tab.popups.values()].some((popup) => popup.tabId === tabId)
      )
        return c.office;
  return [...resumable.values()].find((r) => r.tabId === tabId)?.office;
}
const anyOnline = () => [...connections.values()].some(online);
function refreshBadges(): void {
  badgeWork = badgeWork
    .catch(() => {})
    .then(async () => {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setBadgeBackgroundColor({
        color: anyOnline() ? "#207451" : "#6b7280",
      });
      await chrome.action.setTitle({
        title: t(anyOnline() ? "browser.connected" : "browser.offline"),
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
  const tracked = [...connections.values()].some(
    (c) =>
      !c.closed &&
      [...c.tabs.values()].some(
        (tab) =>
          tab.tabId === tabId ||
          [...tab.popups.values()].some((popup) => popup.tabId === tabId),
      ),
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
// The state an office shows, from its stored record and its connection.
function officeState(
  config: Fields | undefined,
  c: Connection | undefined,
): ExtensionUIState["state"] {
  if (online(c)) return "connected";
  if (!config) return "unpaired";
  return config.blocked
    ? "blocked"
    : config.unknown
      ? "unknown"
      : config.disabled
        ? "disabled"
        : c
          ? "connecting"
          : config.credential || config.code
            ? "offline"
            : "unpaired";
}
// The office the popup named last (SELECTED_KEY).
let lastNamed: string | undefined;
const selectionLoaded = migrated
  .then(() => chrome.storage.local.get(SELECTED_KEY))
  .then(
    (stored) => {
      if (typeof stored[SELECTED_KEY] === "string")
        lastNamed = stored[SELECTED_KEY];
    },
    () => {},
  );
async function nameOffice(office: string | undefined): Promise<void> {
  await selectionLoaded;
  if (lastNamed === office) return;
  lastNamed = office;
  await (
    office === undefined
      ? chrome.storage.local.remove(SELECTED_KEY)
      : chrome.storage.local.set({ [SELECTED_KEY]: office })
  ).catch(() => {});
}
// The office a popup command acts on: the paired office it names, else the
// office that holds the popup's tab, else the last office named, else the
// first paired one.
async function pickOffice(
  named: unknown,
  tabId: unknown,
  stored: Map<string, Fields>,
): Promise<string | undefined> {
  await selectionLoaded;
  if (typeof named === "string" && stored.has(named)) return named;
  const owner = holder(tabId);
  if (owner && stored.has(owner)) return owner;
  if (lastNamed && stored.has(lastNamed)) return lastNamed;
  return stored.keys().next().value;
}
async function uiState(
  named: unknown,
  tabId?: unknown,
): Promise<ExtensionUIState> {
  // A popup opened as the worker starts must not show a store build as
  // unpacked.
  await Promise.all([resumeLoaded, installLoaded, settingLoaded]);
  const stored = await storedOffices();
  const office = await pickOffice(named, tabId, stored);
  const config = office ? stored.get(office) : undefined;
  const tab = await currentTab(tabId);
  const owner = holder(tab?.id);
  const selected = tab && { ...tab, ...(owner ? { office: owner } : {}) };
  const c = office ? connections.get(office) : undefined;
  const live = online(c);
  // Before a ready, only the built-in listing.
  const storeUrl = c?.storeUrl ?? CHROME_WEB_STORE_URL;
  return {
    currentTab: selected,
    agents: live ? (c.metadata?.agents ?? []) : [],
    members: live ? (c.metadata?.members ?? []) : [],
    office: office ?? "",
    offices: [...stored].map(([key, record]) => ({
      office: key,
      state: officeState(record, connections.get(key)),
    })),
    state: officeState(config, c),
    member: live ? c.metadata?.member : undefined,
    ...(live && c.officeScope ? { officeScope: true } : {}),
    ...(live && c.agentTabs ? { agentTabs: true } : {}),
    ...(live && c.access ? { sharedAccess: true } : {}),
    ...(live && c.share
      ? { share: true, shareAgents: c.metadata?.shareAgents ?? [] }
      : {}),
    ...(live ? { access: accessOf(c.office) } : {}),
    ...(live &&
    c.officePackage &&
    extensionOutdated(chrome.runtime.getManifest().version, c.officePackage)
      ? { update: { latest: c.officePackage } }
      : {}),
    ...(storeBuild ? { store: true } : {}),
    ...(storeUrl ? { storeUrl } : {}),
    assignments: live
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
        resumableOf(office ?? "").map((r) => ({
          id: r.id,
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
  await Promise.all([resumeLoaded, settingLoaded]);
  if (msg.action === "pair") {
    if (
      typeof msg.office !== "string" ||
      typeof msg.code !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(msg.code.trim())
    )
      throw new Error();
    const url = officeSocketURL(msg.office.trim());
    const office = officeOf(url);
    if (!office) throw new Error();
    // A pairing of a paired office replaces only that office's record.
    await clearResumable(office);
    await setAccess(office, null);
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    await chrome.storage.local.set({
      [connectionKey(office)]: { url, code: msg.code.trim() },
    });
    await nameOffice(office);
    return uiState(office, msg.tabId);
  }
  const stored = await storedOffices();
  // A command that names an office names a paired one; a popup may still
  // show an office unpaired since, and its state poll gets another office.
  if (
    msg.action !== "state" &&
    msg.office !== undefined &&
    !(typeof msg.office === "string" && stored.has(msg.office))
  )
    throw new Error();
  const office = await pickOffice(msg.office, msg.tabId, stored);
  if (typeof msg.office === "string" && msg.office === office)
    await nameOffice(office);
  const c = office ? connections.get(office) : undefined;
  if (msg.action === "state") {
    if (c?.generation) send(c, { kind: "agents", generation: c.generation });
    return uiState(office, msg.tabId);
  }
  if (!office) throw new Error();
  if (msg.action === "disconnect" || msg.action === "reconnect") {
    const config = stored.get(office)!;
    if (
      msg.action === "reconnect" &&
      (config.blocked || config.unknown || !config.credential)
    )
      throw new Error();
    if (msg.action === "disconnect") await clearResumable(office);
    await chrome.storage.local.set({
      [connectionKey(office)]: {
        ...config,
        disabled: msg.action === "disconnect",
      },
    });
  } else if (
    msg.action === "stop" &&
    typeof msg.assignment === "string" &&
    resumable.has(resumeKey(office, msg.assignment)) &&
    !c?.tabs.has(msg.assignment)
  ) {
    // Off while the office is away: the offer is not sent again.
    forgetResumable(office, msg.assignment);
    await saveResumable();
  } else if (msg.action === "access") {
    if (!validBrowserAccess(msg.access)) throw new Error();
    await setAccess(office, msg.access);
  } else if (msg.action === "share") {
    const shareResult = await requestShare(c, msg);
    return { ...(await uiState(office, msg.tabId)), shareResult };
  } else {
    if (!c) throw new Error();
    check(c);
    if (msg.generation !== c.generation) throw new Error();
    if (msg.action === "offer") {
      const selected = await currentTab(msg.tabId);
      check(c);
      const scope = offerScope(c);
      // A tab any office holds, in any phase, is not offered again.
      if (
        !selected?.eligible ||
        !selected.active ||
        selected.windowId !== msg.windowId ||
        holder(selected.id) !== undefined
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
      await clearResumable(office);
      await setAccess(office, null);
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
      if (acknowledged) {
        await chrome.storage.local.remove(connectionKey(office));
        if (lastNamed === office) await nameOffice(undefined);
      } else {
        const stored = await chrome.storage.local.get(connectionKey(office));
        await chrome.storage.local.set({
          [connectionKey(office)]: {
            ...fields(stored[connectionKey(office)]),
            disabled: true,
            unknown: true,
          },
        });
      }
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
  return uiState(office, msg.tabId);
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("connection.html")
  )
    return;
  void uiCommand(message).then(
    // The generation of the office the state describes.
    (state) =>
      reply({
        ...state,
        generation: connections.get(state.office)?.generation,
      }),
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

// The first max code points of text, read no further: a selection can be
// a whole long page.
function firstPoints(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const point of text) {
    if (count++ === max) break;
    end += point.length;
  }
  return text.slice(0, end);
}

// Sends the popup's page to an agent. Resolves with "sent", the office's
// error, "unanswered" when the office does not answer in 10 s or the
// connection ends first, or "not_sent" when the office takes no share.
function requestShare(c: Connection | undefined, msg: Fields): Promise<string> {
  if (!c || c.closed || !c.generation || !c.share)
    return Promise.resolve("not_sent");
  if (
    typeof msg.agentId !== "string" ||
    typeof msg.url !== "string" ||
    typeof msg.title !== "string" ||
    (msg.selection !== undefined && typeof msg.selection !== "string")
  )
    return Promise.resolve("invalid_share");
  // One code point over the office's cut, so the frame stays far under the
  // socket cap and the office still marks the text as cut.
  const title = firstPoints(msg.title, TITLE_MAX + 1);
  const selection = msg.selection
    ? firstPoints(msg.selection, SELECTION_MAX + 1)
    : "";
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle("unanswered"), 10_000);
    const settle = (result: string) => {
      clearTimeout(timer);
      c.shares.delete(id);
      resolve(result);
    };
    c.shares.set(id, settle);
    send(c, {
      kind: "share",
      generation: c.generation,
      id,
      agentId: msg.agentId,
      url: msg.url,
      title,
      ...(selection ? { selection } : {}),
    });
  });
}

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
    ...muteFlags(r),
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
  if (!c.closed) dropResumable(c, id);
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
    await restoreSound(tab.tabId, tab.restoreSound, popups);
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
  if (
    c.closed ||
    connections.get(c.office) !== c ||
    c.ws.readyState !== WebSocket.OPEN
  )
    return;
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
    connections.get(c.office) !== c ||
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
  // A share may have arrived before the connection ended.
  for (const resolve of c.shares.values()) resolve("unanswered");
  c.shares.clear();
  clearTimeout(c.watchdog);
  if (connections.get(c.office) === c) connections.delete(c.office);
  c.ws.close();
  // A loss the member did not ask for keeps the ON offers, to send them again;
  // a terminal close ends them. A resume still in flight keeps its entry.
  // A tab an agent opened that waits to resume is left as it is.
  for (const [id, tab] of c.tabs)
    if (tab.phase === "on") {
      if (!c.terminal) remember(c, id, tab);
      else dropResumable(c, id);
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
        if (!resumable.has(resumeKey(c.office, id))) {
          await endOpened(tab, popups);
          await restoreSound(tab.tabId, tab.restoreSound, popups);
        }
      }
    }),
  ]).then(() => {});
  c.tabs.clear();
  c.creating.clear();
  refreshBadges();
  if (!c.terminal) {
    const s = slot(c.office);
    clearTimeout(s.reconnect);
    void chrome.alarms.create(RECONNECT_ALARM + c.office, {
      delayInMinutes: 0.5,
    });
    s.reconnect = setTimeout(
      () => {
        void configure(c.office, false);
      },
      Math.min(30_000, 1000 * 2 ** Math.min(s.retry++, 5)) +
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
  if (msg.method === "mute" && tab?.phase === "on") {
    const muted = fields(msg.params).muted;
    if (typeof muted !== "boolean") throw new Error("Invalid mute");
    return muteGrant(c, id, tab, muted);
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
  if (!(c.agentTabs || c.access) || !covers(c.office, c, scope.via))
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
      // The agent reads the page; it never needs the sound.
      tab.muted = true;
      await chrome.tabs.update(tab.tabId, {
        autoDiscardable: false,
        muted: true,
      });
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

// The reconnect alarm of an office: its name is this prefix and the origin.
const RECONNECT_ALARM = "reconnect:";
// Opens the office's connection from its stored record, after closing the
// one it has. Other offices are not touched.
async function configure(office: string, reset = true): Promise<void> {
  const s = slot(office);
  clearTimeout(s.reconnect);
  void chrome.alarms.clear(RECONNECT_ALARM + office);
  if (reset) s.retry = 0;
  const serial = ++s.configuration;
  const previous = connections.get(office);
  if (previous) {
    previous.terminal = true;
    close(previous);
  }
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await migrated;
  const stored = await chrome.storage.local.get(connectionKey(office));
  const record = stored[connectionKey(office)];
  refreshBadges();
  if (serial !== s.configuration || !record) return;
  try {
    const config = fields(record);
    if (config.blocked === true || config.disabled === true) return;
    if (
      typeof config.url !== "string" ||
      (typeof config.credential !== "string" && typeof config.code !== "string")
    )
      return;
    await Promise.all([
      cleanup,
      resumeLoaded,
      leftovers,
      settingLoaded,
      installLoaded,
    ]);
    if (serial !== s.configuration) return;
    const ws = new WebSocket(browserSocketURL(config.url));
    const c: Connection = {
      office,
      ws,
      tabs: new Map(),
      offers: new Map(),
      shares: new Map(),
      creating: new Set(),
      closed: false,
    };
    connections.set(office, c);
    const refuse = () => {
      c.terminal = true;
      void clearResumable(office);
      void setAccess(office, null);
      void chrome.alarms.clear(RECONNECT_ALARM + office);
      void chrome.storage.local.set({
        [connectionKey(office)]: { ...config, blocked: true },
      });
      close(c);
    };
    ws.onopen = () =>
      send(c, {
        kind: "hello",
        version: EXTENSION_MIN_PROTOCOL,
        maxVersion: BROWSER_EXTENSION_PROTOCOL,
        package: chrome.runtime.getManifest().version,
        ...(storeBuild ? { install: "store" } : {}),
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
      if (c.closed || connections.get(office) !== c) return;
      try {
        if (event.data.length > 8 * 1024 * 1024)
          throw new Error("Invalid message");
        const msg = fields(JSON.parse(event.data));
        if (
          (msg.kind === "ready" || msg.kind === "paired") &&
          !spoken(msg.version)
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
          typeof msg.credential === "string" &&
          !c.generation
        ) {
          s.savedCredential = msg.credential;
          void chrome.storage.local.set({
            [connectionKey(office)]: {
              url: config.url,
              credential: msg.credential,
            },
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
          if (validStoreUrl(msg.storeUrl)) c.storeUrl = msg.storeUrl;
          c.reload = msg.reload === true;
          c.share = msg.share === true;
          // The setting goes first, so the office takes the opened tabs that
          // resume.
          sendAccess(c);
          if (!c.offerResume) void clearResumable(office);
          else
            for (const r of resumableOf(office)) {
              // An office without agent tabs would refuse the scope; a tab the
              // setting no longer allows ends.
              if (
                r.scope.kind === "opened" &&
                (!(c.agentTabs || c.access) || !covers(office, c, r.scope.via))
              )
                forgetResumable(office, r.id);
              else resumeOffer(c, r.id, r);
            }
          refreshBadges();
          s.retry = 0;
          void chrome.alarms.clear(RECONNECT_ALARM + office);
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
          if (msg.shareAgents !== undefined && !Array.isArray(msg.shareAgents))
            throw new Error();
          c.metadata = {
            member: { id: member.id, name: member.name },
            agents: displays(msg.agents),
            // An older office sends no members.
            members: displays(msg.members ?? []),
            // An office without share sends no share agents.
            shareAgents: (msg.shareAgents ?? []).map((value: unknown) => {
              const item = fields(value);
              if (
                typeof item.id !== "string" ||
                typeof item.name !== "string" ||
                typeof item.room !== "string"
              )
                throw new Error();
              return { id: item.id, name: item.name, room: item.room };
            }),
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
        if (msg.kind === "shareResult" && typeof msg.id === "string") {
          c.shares.get(msg.id)?.(
            msg.error === undefined
              ? "sent"
              : typeof msg.error === "string" && msg.error
                ? msg.error
                : "share_failed",
          );
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
          } else dropResumable(c, msg.assignment);
          tab.resuming = false;
          c.offers.get(msg.assignment)?.(!msg.error);
          c.offers.delete(msg.assignment);
          return;
        }
        // The member's Reload in the office. Agent control of every tab ends,
        // in every office.
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

// A tab belongs to at most one office: each office reads only its own tabs.
chrome.debugger.onEvent.addListener((source, method, params = {}) => {
  for (const c of [...connections.values()])
    debuggerEvent(c, source, method, params);
});
function debuggerEvent(
  c: Connection,
  source: { tabId?: number; sessionId?: string },
  method: string,
  params: Fields,
): void {
  if (c.closed || !c.generation) return;
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
}
chrome.webNavigation.onCreatedNavigationTarget.addListener((event) => {
  for (const c of [...connections.values()]) navigationTarget(c, event);
});
function navigationTarget(
  c: Connection,
  event: { tabId: number; sourceTabId: number },
): void {
  if (
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
    // A tab any office holds is not taken again.
    if (holder(event.tabId) !== undefined) return;
    main.attaching = true;
    const popup: OwnedTab = {
      tabId: event.tabId,
      parentTabId: opener.tabId,
      children: new Set(),
      popups: new Map(),
    };
    const sessionId = crypto.randomUUID();
    main.popups.set(sessionId, popup);
    if (main.muted)
      void chrome.tabs.update(popup.tabId, { muted: true }).catch(() => {});
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
}
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
  for (const c of [...connections.values()])
    debuggerDetached(c, source, reason);
});
function debuggerDetached(
  c: Connection,
  source: ChromeDebuggee,
  reason: string,
): void {
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
}
chrome.storage.onChanged.addListener((changes, area) => {
  // Only an office's connection record reconnects it; its setting, the
  // selection and the migration's removal of the old keys do not.
  if (area !== "local") return;
  for (const [key, change] of Object.entries(
    changes as Record<string, { newValue?: unknown }>,
  )) {
    if (!key.startsWith(CONNECTION_PREFIX)) continue;
    const office = key.slice(CONNECTION_PREFIX.length);
    const s = slot(office);
    const credential = (change.newValue as { credential?: unknown } | undefined)
      ?.credential;
    if (s.savedCredential && credential === s.savedCredential) {
      s.savedCredential = undefined;
      continue;
    }
    void configure(office);
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(RECONNECT_ALARM)) return;
  const office = alarm.name.slice(RECONNECT_ALARM.length);
  if (!connections.has(office)) void configure(office, false);
});
// Opens every stored office.
async function configureAll(): Promise<void> {
  for (const office of (await storedOffices()).keys()) void configure(office);
}
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
  void configureAll();
});
chrome.runtime.onInstalled.addListener(() => {
  void configureAll();
});
void configureAll();
