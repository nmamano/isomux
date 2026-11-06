// The elevator panel (shared/elevator-panel.ts) in this browser: the panel a
// ride brought, this office's localStorage copy, and the office names this
// browser asked its server for.

import {
  PANEL_SESSION_KEY,
  arrive,
  encodePanelFragment,
  mergePanels,
  readPanelFragment,
  sanitisePanel,
  type Panel,
} from "../shared/elevator-panel.ts";
import {
  MAX_FLOOR_NAME_CHARS,
  normaliseFloorUrl,
  type Floor,
} from "../shared/floors.ts";
import { RECORDING_STORAGE_KEY, isRecording } from "./recording-mode.ts";

export const PANEL_STORAGE_KEY = "isomux-elevator-panel";
export const PANEL_NAMES_STORAGE_KEY = "isomux-elevator-names";
export const PANEL_NAME_TTL_MS = 24 * 60 * 60 * 1000;

function storageGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Full or blocked storage: the panel lives until the next load only.
  }
}

function storageRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Blocked storage: nothing was kept there either.
  }
}

// The panel the ride to this page brought, from the address fragment and the
// login page's sessionStorage copy, merged. Strips only the isomux-panel part
// of the address and deletes the copy. Call once, before the first render.
// The departure office is the one the address names, else the copy's.
export function takeArrivingPanel(
  now: number = Date.now(),
): { panel: Panel; from: string | null; recording: boolean } | null {
  const fromHash = readPanelFragment(location.hash);
  if (fromHash) {
    const hash = fromHash.rest ? `#${fromHash.rest}` : "";
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search + hash,
    );
  }
  const copy = storageGet(sessionStorage, PANEL_SESSION_KEY);
  if (copy !== null) storageRemove(sessionStorage, PANEL_SESSION_KEY);
  const fromCopy = copy === null ? null : readPanelFragment(copy);
  if (!fromHash && !fromCopy) return null;
  const panel = mergePanels(
    sanitisePanel(fromHash?.panel, now),
    sanitisePanel(fromCopy?.panel, now),
    now,
  );
  return {
    panel,
    from: fromHash?.from ?? fromCopy?.from ?? null,
    recording: !!(fromHash?.recording || fromCopy?.recording),
  };
}

// The panel the ride to this page brought, until the office sends its floors.
let arriving: { panel: Panel; from: string | null } | null = null;

// Takes the arriving panel off the address before anything else reads it
// (ui/index.tsx), and holds it for syncPanel. True when a ride brought one.
export function holdArrivingPanel(now: number = Date.now()): boolean {
  const taken = takeArrivingPanel(now);
  if (taken) arriving = taken;
  // Recording mode was on where the ride started: on here too, before the
  // boot reads the flag. A ride never turns it off.
  if (taken?.recording) storageSet(localStorage, RECORDING_STORAGE_KEY, "1");
  return taken !== null;
}

// This office's floors arrived (full_state, floors_updated): merges the
// panel a ride brought, once, puts the departure office and this office on
// the panel, and writes this office's snapshot from its live floors.
export function syncPanel(
  ownFloors: readonly Floor[],
  here: string = location.origin,
  now: number = Date.now(),
): Panel {
  const brought = arriving;
  arriving = null;
  return commitPanel(
    (p) =>
      arrive(brought ? mergePanels(p, brought.panel, now) : p, {
        from: brought?.from ?? null,
        here,
        ownFloors: ownFloors.map((f) => f.url),
        now,
      }),
    now,
  );
}

// The fragment of a ride from this office: the stored panel as it is now
// (another tab may have changed it), with this office and its floors on it.
export function rideFragment(
  here: string,
  ownFloors: readonly Floor[],
  now: number = Date.now(),
): string {
  const panel = commitPanel(
    (p) =>
      arrive(p, {
        from: null,
        here,
        ownFloors: ownFloors.map((f) => f.url),
        now,
      }),
    now,
  );
  return encodePanelFragment(panel, here, isRecording());
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The stored panel, sanitised.
export function readPanel(now: number = Date.now()): Panel {
  return sanitisePanel(
    parseJson(storageGet(localStorage, PANEL_STORAGE_KEY)),
    now,
  );
}

// Reads, changes and writes the stored panel in one synchronous step, so a
// second tab never loses a change. Returns the panel written.
export function commitPanel(
  fn: (panel: Panel) => Panel,
  now: number = Date.now(),
): Panel {
  const next = sanitisePanel(fn(readPanel(now)), now);
  storageSet(localStorage, PANEL_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export interface PanelName {
  name: string | null;
  at: number;
}

// The names this browser's office server gave for panel origins. A damaged
// entry is dropped; a long name is cut.
export function readNames(): Record<string, PanelName> {
  const raw = parseJson(storageGet(localStorage, PANEL_NAMES_STORAGE_KEY));
  const out: Record<string, PanelName> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [origin, entry] of Object.entries(raw)) {
    if (normaliseFloorUrl(origin) !== origin) continue;
    if (!entry || typeof entry !== "object") continue;
    const { name, at } = entry as Record<string, unknown>;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (name !== null && typeof name !== "string") continue;
    out[origin] = { name: name === null ? null : cutName(name), at };
  }
  return out;
}

// At most MAX_FLOOR_NAME_CHARS UTF-16 units, never half a surrogate pair.
function cutName(name: string): string | null {
  let cut = name.slice(0, MAX_FLOOR_NAME_CHARS);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trim() || null;
}

// `keep` lists the origins still on the panel; the others are pruned.
export function rememberName(
  origin: string,
  name: string | null,
  keep: readonly string[],
  now: number = Date.now(),
): void {
  const names = readNames();
  names[origin] = { name, at: now };
  const kept = new Set(keep);
  const next: Record<string, PanelName> = {};
  for (const [o, entry] of Object.entries(names))
    if (kept.has(o)) next[o] = entry;
  storageSet(localStorage, PANEL_NAMES_STORAGE_KEY, JSON.stringify(next));
}
