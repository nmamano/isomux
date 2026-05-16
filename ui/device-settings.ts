// Per-device local-only settings. Stored in localStorage; not synced across devices.
//
// `username` is the name of the boss using this browser; `device` is an
// optional label for this connection point ("Phone", "Laptop", ...). Per-user
// preferences (default room, notif rooms, env file path) live server-side
// keyed by username — see server/users.ts.

import type { NotifRoomsSetting } from "../shared/types.ts";

const KEY_USERNAME = "isomux-username";
const KEY_DEVICE = "isomux-device";
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

// Read legacy localStorage prefs used during the one-shot claim_user
// migration. Once the server acks the claim, the corresponding keys can be
// cleared via `clearLegacyUserPrefs()` so they don't drift.
export function readLegacyUserPrefs(): {
  defaultRoomId: string | null;
  notifRooms: NotifRoomsSetting;
} {
  if (typeof localStorage === "undefined")
    return { defaultRoomId: null, notifRooms: [] };
  const defaultRoomId = localStorage.getItem(LEGACY_KEY_DEFAULT_ROOM);
  const raw = localStorage.getItem(LEGACY_KEY_NOTIF_ROOMS);
  let notifRooms: NotifRoomsSetting = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        notifRooms = parsed;
      }
      // Legacy "all" sentinel collapses to []; the user can re-enable
      // notifications per-room through User Settings if they want.
    } catch {}
  }
  return { defaultRoomId, notifRooms };
}

export function clearLegacyUserPrefs(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LEGACY_KEY_DEFAULT_ROOM);
  localStorage.removeItem(LEGACY_KEY_NOTIF_ROOMS);
}

export function shouldNotifyRoom(
  roomId: string | null,
  setting: NotifRoomsSetting,
): boolean {
  if (roomId == null) return false;
  return setting.includes(roomId);
}

export type { NotifRoomsSetting };
