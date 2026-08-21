// Per-device local-only settings. Stored in localStorage; not synced across devices.
//
// `username` is the name of the boss using this browser; `device` is an
// optional label for this connection point ("Phone", "Laptop", ...). Per-user
// preferences (notif rooms, env file path, language, the Slide Mode gate) live
// server-side on the user record - see server/users.ts - and are edited from
// User Settings, so they follow a boss across devices. What stays here is what
// is genuinely about THIS browser.

import type { NotifRoomsSetting } from "../shared/types.ts";

const KEY_USERNAME = "isomux-username";
const KEY_DEVICE = "isomux-device";
const KEY_APP_PREVIEWS = "isomux-app-previews";
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

// App previews are on unless this device opted out. They can run several app
// front ends, so a phone and a laptop keep independent choices.
export function getAppPreviews(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(KEY_APP_PREVIEWS) !== "off";
}

export function setAppPreviews(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY_APP_PREVIEWS, enabled ? "on" : "off");
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

// Legacy per-device Slide Mode gate. The gate itself is a per-USER preference
// now (task 49d4e2f6) - it lives on the user record and follows a boss across
// devices - so all that survives here is the one-shot migration read: a device
// that had the experiment switched on hands that "on" to the user record once,
// then forgets the key forever. Turning it OFF on a device is deliberately NOT
// migrated: the write is a seed, not a sync, so a second device can't silently
// undo a preference the user set elsewhere.
const LEGACY_KEY_SLIDE_MODE = "isomux-slide-mode";

// null when this device never had the setting (nothing to migrate).
export function readLegacySlideMode(): boolean | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(LEGACY_KEY_SLIDE_MODE);
  if (raw === null) return null;
  return raw === "1";
}

export function clearLegacySlideMode(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LEGACY_KEY_SLIDE_MODE);
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

// Which plan-allowance limit the usage pill's number tracks, per device per
// agent (task df489513). The pill defaults to the most constrained window;
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
