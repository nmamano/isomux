// Per-device local-only settings. Stored in localStorage; not synced across devices.
//
// `username` is the name of the member using this browser; `device` is an
// optional label for this connection point ("Phone", "Laptop", ...). Per-user
// preferences (notif rooms, managed variables, language) live
// server-side on the user record - see server/users.ts - and are edited from
// the Settings page, so they follow a member across devices. What stays here is what
// is genuinely about THIS browser.

import type { NotifRoomsSetting } from "../shared/types.ts";
import type { ChatCopyFormat } from "./log-view/plain-copy.ts";
import {
  clampSidebarWidth,
  type ChatSidebarChoice,
  type ChatSidebarSections,
} from "./chat-sidebar.ts";
import {
  FILTER_PRIORITIES,
  type PriorityFilterValue,
} from "./task-priority.ts";

const KEY_USERNAME = "isomux-username";
const KEY_DEVICE = "isomux-device";
const KEY_CHAT_COPY_FORMAT = "isomux-chat-copy-format";

// The chat bar's Copy format. Markdown unless this browser picked another.
export function getChatCopyFormat(): ChatCopyFormat {
  try {
    const stored = localStorage.getItem(KEY_CHAT_COPY_FORMAT);
    if (stored === "plain" || stored === "html") return stored;
  } catch {}
  return "markdown";
}

export function setChatCopyFormat(format: ChatCopyFormat): void {
  try {
    localStorage.setItem(KEY_CHAT_COPY_FORMAT, format);
  } catch {}
}

const KEY_CHAT_SIDEBAR = "isomux-chat-sidebar";

// The desktop chat sidebar, open or closed, as this browser last chose it.
// Null until the member toggles it (ui/chat-sidebar.ts sidebarStartsOpen).
export function getChatSidebar(): ChatSidebarChoice | null {
  try {
    const stored = localStorage.getItem(KEY_CHAT_SIDEBAR);
    if (stored === "open" || stored === "closed") return stored;
  } catch {}
  return null;
}

export function setChatSidebar(choice: ChatSidebarChoice): void {
  try {
    localStorage.setItem(KEY_CHAT_SIDEBAR, choice);
  } catch {}
}

// The chat sidebar's open sections on this device (task c23f23d0). Two tabs
// on one device share it: the last write wins, with no sync between them.
const KEY_CHAT_SIDEBAR_SECTIONS = "isomux-chat-sidebar-sections";

// Null when nothing is stored or the stored value is not a valid
// ChatSidebarSections.
export function getChatSidebarSections(): ChatSidebarSections | null {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(KEY_CHAT_SIDEBAR_SECTIONS) ?? "null",
    );
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const { rooms, back, more, lobby, pinned, recent, members, anchor } =
      raw as Record<string, unknown>;
    const ids = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((id) => typeof id === "string");
    if (
      ids(rooms) &&
      ids(back) &&
      typeof more === "boolean" &&
      typeof lobby === "boolean" &&
      (anchor === null || typeof anchor === "string")
    )
      return {
        rooms,
        back,
        more,
        lobby,
        // Absent before task 5dac6b9b: the sections start open.
        pinned: typeof pinned === "boolean" ? pinned : true,
        recent: typeof recent === "boolean" ? recent : true,
        ...(typeof members === "boolean" ? { members } : {}),
        anchor,
      };
  } catch {}
  return null;
}

export function setChatSidebarSections(sections: ChatSidebarSections): void {
  try {
    localStorage.setItem(KEY_CHAT_SIDEBAR_SECTIONS, JSON.stringify(sections));
  } catch {}
}

const KEY_CHAT_SIDEBAR_WIDTH = "isomux-chat-sidebar-width";

// The sidebar's width on this device (task 5dac6b9b), clamped; null when
// nothing valid is stored.
export function getChatSidebarWidth(): number | null {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(KEY_CHAT_SIDEBAR_WIDTH) ?? "null",
    );
    if (typeof raw === "number" && Number.isFinite(raw))
      return clampSidebarWidth(raw);
  } catch {}
  return null;
}

export function setChatSidebarWidth(width: number): void {
  try {
    localStorage.setItem(
      KEY_CHAT_SIDEBAR_WIDTH,
      String(clampSidebarWidth(width)),
    );
  } catch {}
}

const LEGACY_KEY_DEFAULT_ROOM = "isomux-default-room";
const LEGACY_KEY_NOTIF_ROOMS = "isomux-notif-rooms";

export function getUsername(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY_USERNAME);
}

export function setUsername(name: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY_USERNAME, name);
}

export function getDevice(): string | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(KEY_DEVICE);
  return v && v.trim() ? v : null;
}

export function setDevice(label: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (label && label.trim()) localStorage.setItem(KEY_DEVICE, label.trim());
  else localStorage.removeItem(KEY_DEVICE);
}

// The Apps page filter, remembered on this device. It starts off.
export type AppFilter = "onlyMine";
const APP_FILTER_KEYS: Record<AppFilter, string> = {
  onlyMine: "isomux-apps-only-mine",
};

export function getAppFilter(filter: AppFilter): boolean {
  try {
    return localStorage.getItem(APP_FILTER_KEYS[filter]) === "true";
  } catch {
    return false;
  }
}

export function setAppFilter(filter: AppFilter, on: boolean): void {
  try {
    if (on) localStorage.setItem(APP_FILTER_KEYS[filter], "true");
    else localStorage.removeItem(APP_FILTER_KEYS[filter]);
  } catch {}
}

// The Inbox Asks tab's sort, remembered on this device. It starts as "agent",
// and a value this build does not know reads as "agent".
export type AsksSort = "agent" | "room" | "priority" | "age";
export const ASKS_SORTS: readonly AsksSort[] = [
  "agent",
  "room",
  "priority",
  "age",
];
const KEY_ASKS_SORT = "isomux-asks-sort";

export function getAsksSort(): AsksSort {
  try {
    const stored = localStorage.getItem(KEY_ASKS_SORT);
    return ASKS_SORTS.find((sort) => sort === stored) ?? "agent";
  } catch {
    return "agent";
  }
}

export function setAsksSort(sort: AsksSort): void {
  try {
    if (sort === "agent") localStorage.removeItem(KEY_ASKS_SORT);
    else localStorage.setItem(KEY_ASKS_SORT, sort);
  } catch {}
}

// The direction of the Asks tab's sort, remembered on this device. It starts
// as "asc", and a value this build does not know reads as "asc".
export type AsksSortDir = "asc" | "desc";

const KEY_ASKS_SORT_DIR = "isomux-asks-sort-dir";

export function getAsksSortDir(): AsksSortDir {
  try {
    return localStorage.getItem(KEY_ASKS_SORT_DIR) === "desc" ? "desc" : "asc";
  } catch {
    return "asc";
  }
}

export function setAsksSortDir(dir: AsksSortDir): void {
  try {
    if (dir === "asc") localStorage.removeItem(KEY_ASKS_SORT_DIR);
    else localStorage.setItem(KEY_ASKS_SORT_DIR, dir);
  } catch {}
}

// Whose asks the Inbox Asks tab lists for an office owner, remembered on
// this device: their own, every member's, or one other member's.
export type AsksMember =
  | { kind: "mine" }
  | { kind: "all" }
  | { kind: "member"; name: string };

// Stored as "all" or "member:<name>", so a member named "all" or "mine"
// stays a member; nothing is mine, and so is a value this build does not
// know.
const KEY_ASKS_MEMBER = "isomux-asks-member";
const MEMBER_PREFIX = "member:";

export function getAsksMember(): AsksMember {
  try {
    const stored = localStorage.getItem(KEY_ASKS_MEMBER);
    if (stored === "all") return { kind: "all" };
    if (
      stored?.startsWith(MEMBER_PREFIX) &&
      stored.length > MEMBER_PREFIX.length
    )
      return { kind: "member", name: stored.slice(MEMBER_PREFIX.length) };
  } catch {}
  return { kind: "mine" };
}

export function setAsksMember(member: AsksMember): void {
  try {
    if (member.kind === "mine") localStorage.removeItem(KEY_ASKS_MEMBER);
    else
      localStorage.setItem(
        KEY_ASKS_MEMBER,
        member.kind === "all" ? "all" : MEMBER_PREFIX + member.name,
      );
  } catch {}
}

// The Inbox Asks tab's filters, remembered on this device: the rooms and the
// agents the member unchecked, and the checked priorities. They start as all.
export interface AsksFilterSetting {
  uncheckedRooms: string[];
  uncheckedAgents: string[];
  priorities: PriorityFilterValue[];
}

const KEY_ASKS_FILTER = "isomux-asks-filter";

const isAllAsksFilter = (filter: AsksFilterSetting) =>
  filter.uncheckedRooms.length === 0 &&
  filter.uncheckedAgents.length === 0 &&
  FILTER_PRIORITIES.every((p) => filter.priorities.includes(p));

const stringIds = (ids: unknown[]) =>
  ids.filter((id): id is string => typeof id === "string");

// A value that is not this shape reads as all; a room or agent id that is not
// a string, or a level this build does not know, is dropped. A value stored
// before the agent filter (task b3cb0a41), with no agent list, keeps its rooms
// and priorities and shows every agent.
export function getAsksFilter(): AsksFilterSetting {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(KEY_ASKS_FILTER) ?? "null",
    );
    if (stored && typeof stored === "object") {
      const { uncheckedRooms, uncheckedAgents, priorities } = stored as Record<
        string,
        unknown
      >;
      if (Array.isArray(uncheckedRooms) && Array.isArray(priorities)) {
        return {
          uncheckedRooms: stringIds(uncheckedRooms),
          uncheckedAgents: Array.isArray(uncheckedAgents)
            ? stringIds(uncheckedAgents)
            : [],
          priorities: FILTER_PRIORITIES.filter((p) => priorities.includes(p)),
        };
      }
    }
  } catch {}
  return {
    uncheckedRooms: [],
    uncheckedAgents: [],
    priorities: [...FILTER_PRIORITIES],
  };
}

export function setAsksFilter(filter: AsksFilterSetting): void {
  try {
    if (isAllAsksFilter(filter)) localStorage.removeItem(KEY_ASKS_FILTER);
    else localStorage.setItem(KEY_ASKS_FILTER, JSON.stringify(filter));
  } catch {}
}

// The ids of the open asks this device showed on the Asks tab. The Inbox
// badge counts only the open asks not in it.
const KEY_ASKS_SEEN = "isomux-asks-seen";
const asksSeenListeners = new Set<() => void>();
// The last value read, by its raw string, so a reader gets the same set until
// the stored value changes (useSyncExternalStore compares by identity).
let asksSeenCache: { raw: string | null; seen: ReadonlySet<string> } | null =
  null;

function readAsksSeenRaw(): string | null {
  try {
    return localStorage.getItem(KEY_ASKS_SEEN);
  } catch {
    return null;
  }
}

export function getAsksSeen(): ReadonlySet<string> {
  const raw = readAsksSeenRaw();
  if (asksSeenCache?.raw === raw) return asksSeenCache.seen;
  let seen = new Set<string>();
  try {
    const stored: unknown = JSON.parse(raw ?? "[]");
    if (Array.isArray(stored)) {
      seen = new Set(
        stored.filter((id): id is string => typeof id === "string"),
      );
    }
  } catch {}
  asksSeenCache = { raw, seen };
  return seen;
}

/**
 * Marks the asks the tab shows (`visibleIds`) seen, and keeps of the earlier
 * ones only those still in the asks slice (`sliceIds`), so the set stays as
 * small as the open asks. An empty slice (asks not loaded yet) writes nothing.
 */
export function markAsksSeen(
  visibleIds: readonly string[],
  sliceIds: readonly string[],
): void {
  if (sliceIds.length === 0) return;
  const before = getAsksSeen();
  const open = new Set(sliceIds);
  const next = new Set([...before].filter((id) => open.has(id)));
  for (const id of visibleIds) next.add(id);
  if (next.size === before.size && [...next].every((id) => before.has(id))) {
    return;
  }
  try {
    localStorage.setItem(KEY_ASKS_SEEN, JSON.stringify([...next]));
  } catch {
    return;
  }
  for (const listener of asksSeenListeners) listener();
}

// Fires on a mark here and on a change from another tab of this browser.
export function subscribeAsksSeen(onChange: () => void): () => void {
  asksSeenListeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY_ASKS_SEEN || e.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    asksSeenListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// Whether the member closed the office's "Install as app" notice
// (OfficeInstallNotice) or installed from it on this device. It shows until
// then.
const KEY_INSTALL_NOTICE_SEEN = "isomux-install-notice-dismissed";

export function officeInstallNoticeSeen(): boolean {
  try {
    return localStorage.getItem(KEY_INSTALL_NOTICE_SEEN) !== null;
  } catch {
    return false;
  }
}

export function markOfficeInstallNoticeSeen(): void {
  try {
    localStorage.setItem(KEY_INSTALL_NOTICE_SEEN, "1");
  } catch {}
}

// Read legacy localStorage prefs used during the one-shot claim_user
// migration. Once the server acks the claim, the corresponding keys can be
// cleared via `clearLegacyUserPrefs()` so they don't drift. The legacy
// default-room key is no longer read (the Default Room setting was removed),
// but clearLegacyUserPrefs still sweeps it so stale keys don't linger.
export function readLegacyUserPrefs(): {
  notifRooms: NotifRoomsSetting;
} {
  if (typeof localStorage === "undefined") return { notifRooms: [] };
  const raw = localStorage.getItem(LEGACY_KEY_NOTIF_ROOMS);
  let notifRooms: NotifRoomsSetting = [];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.every((x): x is string => typeof x === "string")
      ) {
        notifRooms = parsed;
      }
      // Legacy "all" sentinel collapses to []; the user can re-enable
      // notifications per-room through the Settings page if they want.
    } catch {}
  }
  return { notifRooms };
}

export function clearLegacyUserPrefs(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LEGACY_KEY_DEFAULT_ROOM);
  localStorage.removeItem(LEGACY_KEY_NOTIF_ROOMS);
}

// Which plan-allowance limit the usage pill's number tracks, per device per
// agent. The pill defaults to the most constrained window;
// pinning overrides that for people who care about one specific limit. Stored
// as one JSON object { [provider:agentId]: { label, index } }.
//
// Both halves are needed. The INDEX identifies the exact row that was clicked,
// which matters because window labels are NOT guaranteed unique (two Codex
// windows of equal duration render the same label; a server-supplied Claude
// model_scoped name can collide with a fixed one). The LABEL is what keeps the
// pin meaningful when the provider reorders its windows. resolveTrackedWindow
// in SubscriptionPill.tsx spells out how the two are combined.
//
// The key includes the PROVIDER, not just the agent, so switching an agent
// between engines can't leave it pinned to a window the new provider doesn't
// have - Claude's "Weekly (Opus)" means nothing to Codex. A pin whose window
// is simply absent from the current reading falls back to auto anyway (see
// resolveTrackedWindow in SubscriptionPill.tsx), so this is belt and braces.
const KEY_USAGE_PIN = "isomux-usage-pin";

function usagePinKey(agentId: string, provider: string): string {
  return `${provider}:${agentId}`;
}

export type UsagePin = { label: string; index: number };

function readUsagePinMap(): Record<string, UsagePin> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY_USAGE_PIN);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, UsagePin>)
      : {};
  } catch {
    return {};
  }
}

export function getUsagePin(
  agentId: string,
  provider: string,
): UsagePin | null {
  const v = readUsagePinMap()[usagePinKey(agentId, provider)];
  if (!v || typeof v !== "object") return null;
  if (typeof v.label !== "string" || v.label.length === 0) return null;
  if (typeof v.index !== "number" || !Number.isFinite(v.index)) return null;
  return { label: v.label, index: v.index };
}

// `pin` null clears the pin, i.e. back to auto.
export function setUsagePin(
  agentId: string,
  provider: string,
  pin: UsagePin | null,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    const map = readUsagePinMap();
    if (pin === null) delete map[usagePinKey(agentId, provider)];
    else map[usagePinKey(agentId, provider)] = pin;
    localStorage.setItem(KEY_USAGE_PIN, JSON.stringify(map));
  } catch {}
}

export { shouldNotifyRoom } from "../shared/notif-rooms.ts";

export type { NotifRoomsSetting };

// The Integrations page's last tab, remembered on this device (Nil,
// 2026-10-13). Read against the tabs the viewer has now: a stored value that
// is none of them (an older build's tab, junk) reads as no choice.
const KEY_INTEGRATIONS_TAB = "isomux-integrations-tab";

export function getIntegrationsTab<T extends string>(
  tabs: readonly T[],
): T | null {
  try {
    const raw = localStorage.getItem(KEY_INTEGRATIONS_TAB);
    return tabs.find((tab) => tab === raw) ?? null;
  } catch {
    return null;
  }
}

export function setIntegrationsTab(tab: string): void {
  try {
    localStorage.setItem(KEY_INTEGRATIONS_TAB, tab);
  } catch {}
}

// The Settings sidebar groups a member opened on this device (Rooms,
// Members), by group id. A group not in the set starts collapsed.
// Stored as a JSON array of group ids; a value that is not one reads as none.
const KEY_SETTINGS_GROUPS_OPEN = "isomux-settings-groups-open";

export function getSettingsGroupsOpen(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(KEY_SETTINGS_GROUPS_OPEN) ?? "[]",
    );
    return Array.isArray(parsed) && parsed.every((id) => typeof id === "string")
      ? new Set(parsed)
      : new Set();
  } catch {
    return new Set();
  }
}

export function setSettingsGroupOpen(id: string, open: boolean): void {
  const ids = getSettingsGroupsOpen();
  if (open) ids.add(id);
  else ids.delete(id);
  try {
    localStorage.setItem(KEY_SETTINGS_GROUPS_OPEN, JSON.stringify([...ids]));
  } catch {}
}

// What a pane showed when it last loaded on this device. While it loads
// again, it holds that layout, so it keeps its height when the answer arrives
// (task 0eab60fd). Before a pane's first load on a device it holds the layout
// a first visit most likely gets, usually its fuller one (`fallback`). `read`
// returns null for a stored value it cannot use.
function getHeldLayout<T>(
  key: string,
  read: (raw: Record<string, unknown>) => T | null,
  fallback: T,
): T {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      return read(raw as Record<string, unknown>) ?? fallback;
  } catch {}
  return fallback;
}

function setHeldLayout(key: string, layout: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(layout));
  } catch {}
}

// The member usage card: the share row, and how many status lines. Its read
// waits on the providers only while the cap is on, so the fuller layout is
// also the load long enough to see.
const KEY_MEMBER_USAGE_LAYOUT = "isomux-member-usage-layout";

export type MemberUsageLayout = { share: boolean; status: number };

export function getMemberUsageLayout(): MemberUsageLayout {
  return getHeldLayout(
    KEY_MEMBER_USAGE_LAYOUT,
    ({ share, status }) =>
      typeof share === "boolean" &&
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 0 &&
      status <= 4
        ? { share, status }
        : null,
    { share: true, status: 2 },
  );
}

export function setMemberUsageLayout(layout: MemberUsageLayout): void {
  setHeldLayout(KEY_MEMBER_USAGE_LAYOUT, layout);
}

// Settings → Access: a hosted office's card, or the switch and, when it is
// on, the public URL field.
const KEY_EXTERNAL_ACCESS_LAYOUT = "isomux-external-access-layout";

export type ExternalAccessLayout = { hosted: boolean; enabled: boolean };

export function getExternalAccessLayout(): ExternalAccessLayout {
  return getHeldLayout(
    KEY_EXTERNAL_ACCESS_LAYOUT,
    ({ hosted, enabled }) =>
      typeof hosted === "boolean" && typeof enabled === "boolean"
        ? { hosted, enabled }
        : null,
    { hosted: false, enabled: true },
  );
}

export function setExternalAccessLayout(layout: ExternalAccessLayout): void {
  setHeldLayout(KEY_EXTERNAL_ACCESS_LAYOUT, layout);
}

// Integrations → Pager: whether a webhook was saved (its row is taller than
// the "not set" line).
const KEY_PAGER_LAYOUT = "isomux-pager-layout";

export type PagerLayout = { webhook: boolean };

export function getPagerLayout(): PagerLayout {
  return getHeldLayout(
    KEY_PAGER_LAYOUT,
    ({ webhook }) => (typeof webhook === "boolean" ? { webhook } : null),
    { webhook: true },
  );
}

export function setPagerLayout(layout: PagerLayout): void {
  setHeldLayout(KEY_PAGER_LAYOUT, layout);
}

// Integrations → Messaging: whether WhatsApp was linked, and how many contact
// rows it had (at most WHATSAPP_HELD_ROWS_MAX).
const KEY_WHATSAPP_LAYOUT = "isomux-whatsapp-layout";
export const WHATSAPP_HELD_ROWS_MAX = 20;

export type WhatsAppLayout = { linked: boolean; rows: number };

// A first visit is most likely a member who has not linked yet.
export function getWhatsAppLayout(): WhatsAppLayout {
  return getHeldLayout(
    KEY_WHATSAPP_LAYOUT,
    ({ linked, rows }) =>
      typeof linked === "boolean" &&
      Number.isInteger(rows) &&
      (rows as number) >= 0 &&
      (rows as number) <= WHATSAPP_HELD_ROWS_MAX
        ? { linked, rows: rows as number }
        : null,
    { linked: false, rows: 0 },
  );
}

export function setWhatsAppLayout(layout: WhatsAppLayout): void {
  setHeldLayout(KEY_WHATSAPP_LAYOUT, {
    linked: layout.linked,
    rows: Math.min(layout.rows, WHATSAPP_HELD_ROWS_MAX),
  });
}

// Integrations → Messaging: how many Discord bots and routes the card
// showed (each at most DISCORD_HELD_MAX).
export const DISCORD_HELD_MAX = 20;

export type DiscordLayout = { bots: number; rows: number };

const KEY_DISCORD_LAYOUT = "isomux-discord-layout";

const heldCount = (n: unknown): n is number =>
  Number.isInteger(n) &&
  (n as number) >= 0 &&
  (n as number) <= DISCORD_HELD_MAX;

// A first visit is most likely a member with no bot.
export function getDiscordLayout(): DiscordLayout {
  return getHeldLayout(
    KEY_DISCORD_LAYOUT,
    ({ bots, rows }) =>
      heldCount(bots) && heldCount(rows) ? { bots, rows } : null,
    { bots: 0, rows: 0 },
  );
}

export function setDiscordLayout(layout: DiscordLayout): void {
  setHeldLayout(KEY_DISCORD_LAYOUT, {
    bots: Math.min(layout.bots, DISCORD_HELD_MAX),
    rows: Math.min(layout.rows, DISCORD_HELD_MAX),
  });
}

// Integrations → GitHub issues: whether the room the card opens on was
// linked, and whether an office secret could sign the sync (a select, not the
// "no secret" line). A first visit is an owner who has not set it up.
const KEY_GITHUB_LAYOUT = "isomux-github-layout";

export type GithubLayout = { linked: boolean; secret: boolean };

export function getGithubLayout(): GithubLayout {
  return getHeldLayout(
    KEY_GITHUB_LAYOUT,
    ({ linked, secret }) =>
      typeof linked === "boolean" && typeof secret === "boolean"
        ? { linked, secret }
        : null,
    { linked: false, secret: false },
  );
}

export function setGithubLayout(layout: GithubLayout): void {
  setHeldLayout(KEY_GITHUB_LAYOUT, layout);
}
