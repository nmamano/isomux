// Per-device local-only settings. Stored in localStorage; not synced across devices.

const KEY_USERNAME = "isomux-username";
const KEY_DEFAULT_ROOM = "isomux-default-room";
const KEY_NOTIF_ROOMS = "isomux-notif-rooms";

export function getUsername(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY_USERNAME);
}

export function setUsername(name: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY_USERNAME, name);
}

export function getDefaultRoomId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY_DEFAULT_ROOM);
}

export function setDefaultRoomId(id: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(KEY_DEFAULT_ROOM, id);
  else localStorage.removeItem(KEY_DEFAULT_ROOM);
}

// "all" notifies on every room (including future ones).
// string[] is an explicit allowlist of room IDs.
export type NotifRoomsSetting = "all" | string[];

export function getNotifRooms(): NotifRoomsSetting {
  if (typeof localStorage === "undefined") return "all";
  const raw = localStorage.getItem(KEY_NOTIF_ROOMS);
  if (!raw) return "all";
  try {
    const parsed = JSON.parse(raw);
    if (parsed === "all") return "all";
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
    return "all";
  } catch {
    return "all";
  }
}

export function setNotifRooms(value: NotifRoomsSetting): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY_NOTIF_ROOMS, JSON.stringify(value));
}

export function shouldNotifyRoom(roomId: string | null, setting: NotifRoomsSetting): boolean {
  if (setting === "all") return true;
  if (roomId == null) return false;
  return setting.includes(roomId);
}
