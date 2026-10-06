// Per-device local-only settings. Stored in localStorage; not synced across devices.
//
// `username` is the name of the member using this browser; `device` is an
// optional label for this connection point ("Phone", "Laptop", ...). Per-user
// preferences (notif rooms, managed variables, language) live
// server-side on the user record - see server/users.ts - and are edited from
// the Settings page, so they follow a member across devices. What stays here is what
// is genuinely about THIS browser.

import type { NotifRoomsSetting } from "../shared/types.ts";

const KEY_USERNAME = "isomux-username";
const KEY_DEVICE = "isomux-device";
const KEY_MEMBERS_CHAT_HIDDEN = "isomux-members-chat-hidden";
const KEY_MEMBERS_CHAT_WIDTH = "isomux-members-chat-width";
export const DEFAULT_MEMBERS_CHAT_WIDTH = 520;
export const MIN_MEMBERS_CHAT_WIDTH = 300;

export function maxMembersChatWidth(viewportWidth: number): number {
  return Math.max(MIN_MEMBERS_CHAT_WIDTH, Math.min(900, viewportWidth - 48));
}

export function clampMembersChatWidth(
  width: number,
  viewportWidth: number,
): number {
  const safe = Number.isFinite(width) ? width : DEFAULT_MEMBERS_CHAT_WIDTH;
  return Math.round(
    Math.max(
      MIN_MEMBERS_CHAT_WIDTH,
      Math.min(maxMembersChatWidth(viewportWidth), safe),
    ),
  );
}

export function getMembersChatWidth(viewportWidth: number): number {
  let width = DEFAULT_MEMBERS_CHAT_WIDTH;
  try {
    const raw = localStorage.getItem(KEY_MEMBERS_CHAT_WIDTH);
    if (raw !== null && raw.trim() !== "") width = Number(raw);
  } catch {}
  return clampMembersChatWidth(width, viewportWidth);
}

export function setMembersChatWidth(width: number): void {
  try {
    localStorage.setItem(KEY_MEMBERS_CHAT_WIDTH, String(width));
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

export function getMembersChatHidden(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(KEY_MEMBERS_CHAT_HIDDEN) === "true"
    );
  } catch {
    return false;
  }
}

export function setMembersChatHidden(hidden: boolean): void {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(KEY_MEMBERS_CHAT_HIDDEN, String(hidden));
  } catch {}
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

// The room filter on the Apps and Automations pages, each remembered on this
// device. Absent = all rooms.
export type RoomFilterPage = "apps" | "schedules";
const ROOM_FILTER_KEYS: Record<RoomFilterPage, string> = {
  apps: "isomux-apps-room-filter",
  schedules: "isomux-schedules-room-filter",
};

export function getRoomFilter(page: RoomFilterPage): string {
  try {
    return localStorage.getItem(ROOM_FILTER_KEYS[page]) ?? "all";
  } catch {
    return "all";
  }
}

export function setRoomFilter(page: RoomFilterPage, value: string): void {
  try {
    if (value === "all") localStorage.removeItem(ROOM_FILTER_KEYS[page]);
    else localStorage.setItem(ROOM_FILTER_KEYS[page], value);
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
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
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
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
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

export function shouldNotifyRoom(
  roomId: string | null,
  setting: NotifRoomsSetting,
): boolean {
  if (roomId == null) return false;
  return setting.includes(roomId);
}

export type { NotifRoomsSetting };
