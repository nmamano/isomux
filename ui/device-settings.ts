// Per-device local-only settings. Stored in localStorage; not synced across devices.
//
// `username` is the name of the boss using this browser; `device` is an
// optional label for this connection point ("Phone", "Laptop", ...). Per-user
// preferences (notif rooms, managed variables, language) live
// server-side on the user record - see server/users.ts - and are edited from
// the Settings page, so they follow a boss across devices. What stays here is what
// is genuinely about THIS browser.

import type { NotifRoomsSetting } from "../shared/types.ts";

const KEY_USERNAME = "isomux-username";
const KEY_DEVICE = "isomux-device";
const KEY_APP_PREVIEWS = "isomux-app-previews";
const KEY_APP_PREVIEW_OPENS = "isomux-app-preview-opens";
// Keep aligned with APP_SESSION_TTL_MS in server/app-auth.ts. A preview cannot
// renew that app-host session, so an older open fact must show the prompt again.
export const APP_PREVIEW_OPEN_TTL_MS = 12 * 60 * 60 * 1000;
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

// App previews are on unless this device opts out. A cold, serialized fill
// of a large Apps page can take tens of seconds; the toggle remains the out.
export function getAppPreviews(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(KEY_APP_PREVIEWS) !== "off";
}

export function setAppPreviews(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY_APP_PREVIEWS, enabled ? "on" : "off");
}

function readAppPreviewOpens(): Record<string, number> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(KEY_APP_PREVIEW_OPENS) ?? "{}",
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function getAppPreviewOpenedAt(
  url: string,
  now = Date.now(),
): number | null {
  const openedAt = readAppPreviewOpens()[url];
  if (openedAt === undefined || now - openedAt >= APP_PREVIEW_OPEN_TTL_MS) {
    return null;
  }
  return openedAt;
}

export function markAppPreviewOpened(url: string, openedAt = Date.now()): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    KEY_APP_PREVIEW_OPENS,
    JSON.stringify({ ...readAppPreviewOpens(), [url]: openedAt }),
  );
}

export function pruneAppPreviewOpens(urls: readonly string[]): void {
  if (typeof localStorage === "undefined") return;
  const keep = new Set(urls);
  const opens = readAppPreviewOpens();
  const entries = Object.entries(opens).filter(([url]) => keep.has(url));
  if (entries.length === Object.keys(opens).length) return;
  if (entries.length === 0) {
    localStorage.removeItem(KEY_APP_PREVIEW_OPENS);
  } else {
    localStorage.setItem(
      KEY_APP_PREVIEW_OPENS,
      JSON.stringify(Object.fromEntries(entries)),
    );
  }
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
