// Per-device local-only settings. Stored in localStorage; not synced across devices.
//
// `username` is the name of the member using this browser; `device` is an
// optional label for this connection point ("Phone", "Laptop", ...). Per-user
// preferences (notif rooms, managed variables, language) live
// server-side on the user record - see server/users.ts - and are edited from
// the Settings page, so they follow a member across devices. What stays here is what
// is genuinely about THIS browser.

import type {
  NotifRoomsSetting,
  ProviderAccountWire,
} from "../shared/types.ts";
import type { SkillEngine, SkillSource } from "../shared/contract-shapes.ts";
import type { ChatCopyFormat } from "./log-view/plain-copy.ts";
import { isLoopbackUrl } from "./webhook-helpers.ts";
import {
  clampSidebarWidth,
  parseChatSidebarPages,
  parseChatSidebarShape,
  type ChatSidebarChoice,
  type ChatSidebarPage,
  type ChatSidebarSections,
  type ChatSidebarShape,
} from "./chat-sidebar.ts";
import { parseOfficeShape, type OfficeShape } from "./office-shape.ts";
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

// The shape of the sidebar's list as last drawn on this device (task
// 4dcad6bf), for its placeholders while it loads.
const KEY_CHAT_SIDEBAR_SHAPE = "isomux-chat-sidebar-shape";

// Null when nothing is stored or the stored value is not a sane shape.
export function getChatSidebarShape(): ChatSidebarShape | null {
  try {
    return parseChatSidebarShape(
      JSON.parse(localStorage.getItem(KEY_CHAT_SIDEBAR_SHAPE) ?? "null"),
    );
  } catch {}
  return null;
}

export function setChatSidebarShape(shape: ChatSidebarShape): void {
  try {
    localStorage.setItem(KEY_CHAT_SIDEBAR_SHAPE, JSON.stringify(shape));
  } catch {}
}

// The office's tab bar and room scene as last drawn on this device (task
// ea29a8e2), for their placeholders while the office state loads.
const KEY_OFFICE_SHAPE = "isomux-office-shape";

// Null when nothing is stored or the stored value is not a sane shape.
export function getOfficeShape(): OfficeShape | null {
  try {
    return parseOfficeShape(
      JSON.parse(localStorage.getItem(KEY_OFFICE_SHAPE) ?? "null"),
    );
  } catch {}
  return null;
}

export function setOfficeShape(shape: OfficeShape): void {
  try {
    localStorage.setItem(KEY_OFFICE_SHAPE, JSON.stringify(shape));
  } catch {}
}

// The page rows the member's permissions showed at the last self record on
// this device (task f66e07e3), drawn before the next one arrives.
const KEY_CHAT_SIDEBAR_PAGES = "isomux-chat-sidebar-pages";

// Null when nothing valid is stored: every page row draws.
export function getChatSidebarPages(): ChatSidebarPage[] | null {
  try {
    return parseChatSidebarPages(
      JSON.parse(localStorage.getItem(KEY_CHAT_SIDEBAR_PAGES) ?? "null"),
    );
  } catch {}
  return null;
}

export function setChatSidebarPages(pages: ChatSidebarPage[]): void {
  try {
    localStorage.setItem(KEY_CHAT_SIDEBAR_PAGES, JSON.stringify(pages));
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
  { kind: "mine" } | { kind: "all" } | { kind: "member"; name: string };

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
    // A first visit: a page served from outside this machine reached the
    // office from outside, so its external access is on.
    { hosted: false, enabled: !isLoopbackUrl(window.location.origin) },
  );
}

export function setExternalAccessLayout(layout: ExternalAccessLayout): void {
  setHeldLayout(KEY_EXTERNAL_ACCESS_LAYOUT, layout);
}

// Settings → Office → Enterprise: whether the office has the Enterprise box
// (the sidebar row), and which parts of the pane it showed.
export type EnterpriseLayout = {
  available: boolean;
  enabled: boolean;
  connected: boolean;
  locked: boolean;
  problem: boolean;
};

const KEY_ENTERPRISE_LAYOUT = "isomux-enterprise-layout";

export function getEnterpriseLayout(): EnterpriseLayout {
  return getHeldLayout(
    KEY_ENTERPRISE_LAYOUT,
    ({ available, enabled, connected, locked, problem }) =>
      typeof available === "boolean" &&
      typeof enabled === "boolean" &&
      typeof connected === "boolean" &&
      typeof locked === "boolean" &&
      typeof problem === "boolean"
        ? { available, enabled, connected, locked, problem }
        : null,
    // Every office but a Hosted one has the box.
    {
      available: true,
      enabled: false,
      connected: false,
      locked: false,
      problem: false,
    },
  );
}

export function setEnterpriseLayout(layout: EnterpriseLayout): void {
  setHeldLayout(KEY_ENTERPRISE_LAYOUT, layout);
}

// Settings → Usage: how many rows each table had.
export type UsageLayout = { agents: number; rooms: number; schedules: number };

const KEY_USAGE_LAYOUT = "isomux-usage-layout";

// A sanity bound only: the counts are exact, so a lower cap would bring the
// growth back.
const isRowCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1000;

// `fallback` is what the reader sees of the office, for a first visit.
export function getUsageLayout(fallback: UsageLayout): UsageLayout {
  return getHeldLayout(
    KEY_USAGE_LAYOUT,
    ({ agents, rooms, schedules }) =>
      isRowCount(agents) && isRowCount(rooms) && isRowCount(schedules)
        ? { agents, rooms, schedules }
        : null,
    fallback,
  );
}

export function setUsageLayout(layout: UsageLayout): void {
  setHeldLayout(KEY_USAGE_LAYOUT, layout);
}

// Settings → Move office: whether the move-in card showed the not-fresh
// blocker, and how many reasons it listed. The held card order follows it.
export type MoveInLayout = { blocked: boolean; reasons: number };

const KEY_MOVE_IN_LAYOUT = "isomux-move-in-layout";

// `fallback` is the caller's guess from the office state, for a first visit.
export function getMoveInLayout(fallback: MoveInLayout): MoveInLayout {
  return getHeldLayout(
    KEY_MOVE_IN_LAYOUT,
    ({ blocked, reasons }) =>
      typeof blocked === "boolean" && isRowCount(reasons)
        ? { blocked, reasons }
        : null,
    fallback,
  );
}

export function setMoveInLayout(layout: MoveInLayout): void {
  setHeldLayout(KEY_MOVE_IN_LAYOUT, layout);
}

// Settings → Storage: whether the automatic cleanup showed its last-run line.
export type StorageLayout = { lastRun: boolean };

const KEY_STORAGE_LAYOUT = "isomux-storage-layout";

export function getStorageLayout(): StorageLayout {
  return getHeldLayout(
    KEY_STORAGE_LAYOUT,
    ({ lastRun }) => (typeof lastRun === "boolean" ? { lastRun } : null),
    // The cleanup runs on its own, so most offices have a last run.
    { lastRun: true },
  );
}

export function setStorageLayout(layout: StorageLayout): void {
  setHeldLayout(KEY_STORAGE_LAYOUT, layout);
}

// Automations → Webhooks: how many rows the list showed, after the room
// filter (at most WEBHOOKS_HELD_ROWS_MAX).
const KEY_WEBHOOKS_LAYOUT = "isomux-webhooks-layout";
export const WEBHOOKS_HELD_ROWS_MAX = 20;

export type WebhooksLayout = { rows: number };

export function getWebhooksLayout(): WebhooksLayout {
  return getHeldLayout(
    KEY_WEBHOOKS_LAYOUT,
    ({ rows }) =>
      typeof rows === "number" &&
      Number.isInteger(rows) &&
      rows >= 0 &&
      rows <= WEBHOOKS_HELD_ROWS_MAX
        ? { rows }
        : null,
    // The fuller layout: the table with one row, not the empty box.
    { rows: 1 },
  );
}

export function setWebhooksLayout(layout: WebhooksLayout): void {
  setHeldLayout(KEY_WEBHOOKS_LAYOUT, {
    rows: Math.min(layout.rows, WEBHOOKS_HELD_ROWS_MAX),
  });
}

// The Apps page: whether the filter bar showed, and how many rows each
// section showed after the filters (at most APPS_HELD_ROWS_MAX each).
export const APPS_HELD_ROWS_MAX = 20;

export type AppsLayout = {
  filters: boolean;
  running: number;
  stopped: number;
  archived: number;
};

const KEY_APPS_LAYOUT = "isomux-apps-layout";

const isAppsRowCount = (n: unknown): n is number =>
  typeof n === "number" &&
  Number.isInteger(n) &&
  n >= 0 &&
  n <= APPS_HELD_ROWS_MAX;

export function getAppsLayout(): AppsLayout {
  return getHeldLayout(
    KEY_APPS_LAYOUT,
    ({ filters, running, stopped, archived }) =>
      typeof filters === "boolean" &&
      isAppsRowCount(running) &&
      isAppsRowCount(stopped) &&
      isAppsRowCount(archived)
        ? { filters, running, stopped, archived }
        : null,
    // The fuller layout: the filter bar and one running app.
    { filters: true, running: 1, stopped: 0, archived: 0 },
  );
}

export function setAppsLayout(layout: AppsLayout): void {
  const cap = (n: number) => Math.min(n, APPS_HELD_ROWS_MAX);
  setHeldLayout(KEY_APPS_LAYOUT, {
    filters: layout.filters,
    running: cap(layout.running),
    stopped: cap(layout.stopped),
    archived: cap(layout.archived),
  });
}

// Skills: what the page showed when it last loaded on this device: each
// engine tab's count, the groups of one tab with each row's height, and on
// desktop the heights of the auto-opened skill's header and controls row.
// The heights depend on the width (padding, line wraps): one device, the
// last width wins.
export const SKILLS_HELD_ROWS_MAX = 40;

export type SkillsHeldTab = "all" | SkillEngine;

export type SkillsLayout = {
  counts: Record<SkillsHeldTab, number>;
  tab: SkillsHeldTab;
  groups: { source: SkillSource; rows: number[] }[];
  detail: { head: number; controls: number } | null;
};

// A first visit: the built-in skills (more than nine, most with a two-line
// description) shared by every engine, and nothing else yet.
export const SKILLS_LAYOUT_FALLBACK: SkillsLayout = {
  counts: { all: 10, claude: 0, codex: 0, opencode: 0 },
  tab: "all",
  groups: [{ source: "isomux", rows: Array.from({ length: 10 }, () => 72) }],
  detail: { head: 90, controls: 32 },
};

const KEY_SKILLS_LAYOUT = "isomux-skills-layout";
const SKILLS_HELD_TABS: readonly SkillsHeldTab[] = [
  "all",
  "claude",
  "codex",
  "opencode",
];
const SKILL_SOURCES: readonly SkillSource[] = [
  "user",
  "project",
  "plugin",
  "isomux",
];

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isHeight = (v: unknown): v is number => isInt(v, 1, 400);

function readSkillsLayout(raw: Record<string, unknown>): SkillsLayout | null {
  const { counts, tab, groups, detail } = raw;
  if (!counts || typeof counts !== "object") return null;
  const c = counts as Record<string, unknown>;
  if (!SKILLS_HELD_TABS.every((k) => isInt(c[k], 0, 99999))) return null;
  if (!SKILLS_HELD_TABS.includes(tab as SkillsHeldTab)) return null;
  if (!Array.isArray(groups)) return null;
  const seen = new Set<unknown>();
  let rowCount = 0;
  for (const g of groups as unknown[]) {
    if (!g || typeof g !== "object") return null;
    const { source, rows } = g as Record<string, unknown>;
    if (!SKILL_SOURCES.includes(source as SkillSource) || seen.has(source))
      return null;
    seen.add(source);
    if (!Array.isArray(rows) || rows.length === 0 || !rows.every(isHeight))
      return null;
    rowCount += rows.length;
  }
  if (rowCount > SKILLS_HELD_ROWS_MAX) return null;
  let held: SkillsLayout["detail"] = null;
  if (detail !== null) {
    if (!detail || typeof detail !== "object") return null;
    const { head, controls } = detail as Record<string, unknown>;
    if (!isHeight(head) || !isHeight(controls)) return null;
    held = { head, controls };
  }
  return {
    counts: {
      all: c.all as number,
      claude: c.claude as number,
      codex: c.codex as number,
      opencode: c.opencode as number,
    },
    tab: tab as SkillsHeldTab,
    groups: (groups as { source: SkillSource; rows: number[] }[]).map((g) => ({
      source: g.source,
      rows: [...g.rows],
    })),
    detail: held,
  };
}

export function getSkillsLayout(): SkillsLayout {
  return getHeldLayout(
    KEY_SKILLS_LAYOUT,
    readSkillsLayout,
    SKILLS_LAYOUT_FALLBACK,
  );
}

// Keeps the first SKILLS_HELD_ROWS_MAX rows: the rows past the cap are below
// the fold.
export function setSkillsLayout(layout: SkillsLayout): void {
  let left = SKILLS_HELD_ROWS_MAX;
  const groups: SkillsLayout["groups"] = [];
  for (const g of layout.groups) {
    if (left === 0) break;
    const rows = g.rows.slice(0, left);
    left -= rows.length;
    if (rows.length > 0) groups.push({ source: g.source, rows });
  }
  setHeldLayout(KEY_SKILLS_LAYOUT, { ...layout, groups });
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

// Integrations → Model providers: the row each Codex and Claude sign-in
// card drew under its status (a Sign out row, a Sign in row, or none), on
// the office card and on the viewer's own.
const KEY_PROVIDER_LAYOUT = "isomux-provider-layout";

export type ProviderRow = "signOut" | "signIn" | "none";
export type ProviderLayout = {
  office: { codex: ProviderRow; claude: ProviderRow };
  personal: { codex: ProviderRow; claude: ProviderRow };
};

const PROVIDER_ROWS: readonly unknown[] = ["signOut", "signIn", "none"];

const providerRows = (
  raw: unknown,
): { codex: ProviderRow; claude: ProviderRow } | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { codex, claude } = raw as Record<string, unknown>;
  return PROVIDER_ROWS.includes(codex) && PROVIDER_ROWS.includes(claude)
    ? { codex: codex as ProviderRow, claude: claude as ProviderRow }
    : null;
};

// The row a sign-in card draws under an account it knows: null while a
// sign-in runs (its controls, not a row to hold). `canAct`: the viewer may
// change this sign-in.
export function drawnProviderRow(
  account: ProviderAccountWire,
  canAct: boolean,
): ProviderRow | null {
  if (account.login || account.loginQueue) return null;
  if (account.accountStatus === "connected") return "signOut";
  return canAct && account.canBrowserLogin ? "signIn" : "none";
}

// A first visit holds an office that is signed in and a viewer who is not.
export function getProviderLayout(): ProviderLayout {
  return getHeldLayout(
    KEY_PROVIDER_LAYOUT,
    ({ office, personal }) => {
      const o = providerRows(office);
      const p = providerRows(personal);
      return o && p ? { office: o, personal: p } : null;
    },
    {
      office: { codex: "signOut", claude: "signOut" },
      personal: { codex: "signIn", claude: "signIn" },
    },
  );
}

export function setProviderLayout(layout: ProviderLayout): void {
  setHeldLayout(KEY_PROVIDER_LAYOUT, layout);
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
