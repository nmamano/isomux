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

// null when this browser has no saved choice.
export function getMembersChatHidden(): boolean | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(KEY_MEMBERS_CHAT_HIDDEN);
    return raw === "true" ? true : raw === "false" ? false : null;
  } catch {
    return null;
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

// What a pane showed when it last loaded on this device. While it loads
// again, it holds that layout, so it keeps its height when the answer arrives
// (task 0eab60fd). Before a pane's first load on a device it holds its fuller
// layout (`fallback`). `read` returns null for a stored value it cannot use.
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

// Settings → You → Pager: whether a webhook was saved (its row is taller than
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
