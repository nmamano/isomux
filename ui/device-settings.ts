// Per-device local-only settings. Stored in localStorage; not synced across devices.
//
// `username` is the name of the boss using this browser; `device` is an
// optional label for this connection point ("Phone", "Laptop", ...). Per-user
// preferences (notif rooms, env file path) live server-side keyed by username
// - see server/users.ts.

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
      // notifications per-room through User Settings if they want.
    } catch {}
  }
  return { notifRooms };
}

export function clearLegacyUserPrefs(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LEGACY_KEY_DEFAULT_ROOM);
  localStorage.removeItem(LEGACY_KEY_NOTIF_ROOMS);
}

// Global Slide Mode gate (experimental feature, default OFF). Sits ABOVE the
// per-agent view toggle below: while off, the deck entry point is hidden and
// every agent renders as chat, whatever their per-agent pref says. The gate
// never writes the per-agent prefs, so turning it back on restores them.
const KEY_SLIDE_MODE = "isomux-slide-mode";

const slideModeListeners = new Set<() => void>();

export function getSlideModeEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(KEY_SLIDE_MODE) === "1";
}

export function setSlideModeEnabled(on: boolean): void {
  if (typeof localStorage === "undefined") return;
  // Compare BEFORE the write (it also normalizes a hand-edited value), and
  // notify only on a real change - a Save that left the box untouched must not
  // wake every subscriber.
  const changed = getSlideModeEnabled() !== on;
  if (on) localStorage.setItem(KEY_SLIDE_MODE, "1");
  else localStorage.removeItem(KEY_SLIDE_MODE);
  if (!changed) return;
  for (const cb of slideModeListeners) cb();
}

// The settings surface that writes the gate renders OVER a live LogView, which
// therefore never remounts to re-read it - so subscribers get notified instead.
// The storage event covers the same browser's other tabs.
export function subscribeSlideModeEnabled(cb: () => void): () => void {
  slideModeListeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY_SLIDE_MODE) cb();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    slideModeListeners.delete(cb);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

// Slide Mode view toggle (design: internal-docs/slide-mode-design.md). Per
// device, per agent - the server holds no slideMode setting; whether this
// browser shows an agent as a deck vs chat is purely local. Stored as one
// JSON object { [agentId]: true }; absent/false means chat view.
const KEY_SLIDE_VIEW = "isomux-slide-view";

function readSlideViewMap(): Record<string, boolean> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY_SLIDE_VIEW);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getSlideView(agentId: string): boolean {
  return readSlideViewMap()[agentId] === true;
}

export function setSlideView(agentId: string, on: boolean): void {
  if (typeof localStorage === "undefined") return;
  const map = readSlideViewMap();
  if (on) map[agentId] = true;
  else delete map[agentId];
  localStorage.setItem(KEY_SLIDE_VIEW, JSON.stringify(map));
}

// Last-viewed deck position, per device per agent (design:
// internal-docs/slide-mode-design.md). Persisted so the deck↔chat toggle
// restores where the viewer was instead of always jumping to the newest slide.
// `atEnd` records whether they were on the last slide at save time: if so, a
// re-entry follows the newest (picking up turns that arrived meanwhile); if
// not, the exact index is restored (clamped to range). Stored as one JSON
// object { [agentId]: { index, atEnd } }.
const KEY_SLIDE_POS = "isomux-slide-pos";

export type SlidePos = { index: number; atEnd: boolean };

function readSlidePosMap(): Record<string, SlidePos> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY_SLIDE_POS);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getSlidePos(agentId: string): SlidePos | null {
  const v = readSlidePosMap()[agentId];
  if (!v || typeof v.index !== "number") return null;
  return { index: v.index, atEnd: v.atEnd === true };
}

export function setSlidePos(agentId: string, pos: SlidePos): void {
  if (typeof localStorage === "undefined") return;
  try {
    const map = readSlidePosMap();
    map[agentId] = { index: pos.index, atEnd: pos.atEnd };
    localStorage.setItem(KEY_SLIDE_POS, JSON.stringify(map));
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
