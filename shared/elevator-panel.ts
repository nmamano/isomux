// The elevator panel: one button per office, the same list in every office a
// member rides to. No office holds the whole list. Each ride carries it in the
// address fragment (#isomux-panel=..., never sent to a server), and each office
// keeps it in that browser's localStorage and merges what arrives.
//
// The panel holds the offices this browser rode to or from (visits), the
// offices the member removed from it (removals), and the floors each visited
// office had at the last visit (snapshots). This office's own floors always
// come from its live store, never from a snapshot of itself.
//
// Nothing that arrives is trusted: every url passes normaliseFloorUrl, every
// time is clamped to now, and no carried name is ever shown.

import { MAX_FLOORS, normaliseFloorUrl, type Floor } from "./floors.ts";

export interface PanelVisit {
  url: string;
  addedAt: number;
}

export interface PanelRemoval {
  url: string;
  at: number;
}

// The floors an office had when this browser last loaded it: urls only.
export interface PanelSnapshot {
  origin: string;
  rev: number;
  floors: string[];
}

export interface Panel {
  visited: PanelVisit[];
  removed: PanelRemoval[];
  snapshots: PanelSnapshot[];
}

// "here" is this office, "floor" one of its own floors (floors.json), and
// "visited" or "snapshot" an entry that only this browser's panel holds.
export interface PanelButton {
  url: string;
  kind: "here" | "floor" | "visited" | "snapshot";
  floor?: Floor;
}

export const PANEL_HASH_KEY = "isomux-panel";
// The login page keeps the arriving fragment here until the member signs in.
export const PANEL_SESSION_KEY = "isomux-panel";
export const REMOVAL_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const MAX_SNAPSHOTS = 20;
export const MAX_PANEL_BUTTONS = 200;
export const MAX_PANEL_FRAGMENT_CHARS = 8192;
export const MAX_PANEL_REMOVALS = MAX_FLOORS;

// A url is kept only when it is already its own http(s) origin.
function isOrigin(url: unknown): url is string {
  return typeof url === "string" && normaliseFloorUrl(url) === url;
}

// A time that is a finite number >= 0, clamped to now; null otherwise.
function timeOf(raw: unknown, now: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.min(raw, now);
}

function listOf(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function fieldsOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

const byUrl = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const visitOrder = (a: PanelVisit, b: PanelVisit) =>
  a.addedAt - b.addedAt || byUrl(a.url, b.url);
const removalOrder = (a: PanelRemoval, b: PanelRemoval) =>
  a.at - b.at || byUrl(a.url, b.url);
// Two snapshots of one office with one rev: the result must not depend on
// which copy came first.
const snapshotOrder = (a: PanelSnapshot, b: PanelSnapshot) =>
  a.rev - b.rev ||
  byUrl(JSON.stringify(a.floors), JSON.stringify(b.floors)) ||
  byUrl(a.origin, b.origin);

// The normal form every function returns, from lists that may hold
// duplicates: per url the latest removal, kept REMOVAL_TTL_MS; the first visit
// that is not older than it (a later visit never moves an office, and a
// visit older than the removal is hidden); per office the newest snapshot,
// kept only while the office is a visit (rule A). Then the caps, oldest
// dropped first.
function normalise(
  visits: PanelVisit[],
  removals: PanelRemoval[],
  snapshots: PanelSnapshot[],
  now: number,
): Panel {
  const removedAt = new Map<string, number>();
  for (const r of removals) {
    if (r.at < now - REMOVAL_TTL_MS) continue;
    if ((removedAt.get(r.url) ?? -1) < r.at) removedAt.set(r.url, r.at);
  }
  const removed = [...removedAt]
    .map(([url, at]) => ({ url, at }))
    .sort(removalOrder)
    .slice(-MAX_PANEL_REMOVALS);
  const latest = new Map(removed.map((r) => [r.url, r.at]));

  const first = new Map<string, number>();
  for (const v of visits) {
    if (v.addedAt < (latest.get(v.url) ?? -1)) continue;
    if ((first.get(v.url) ?? Infinity) > v.addedAt) first.set(v.url, v.addedAt);
  }
  const visited = [...first]
    .map(([url, addedAt]) => ({ url, addedAt }))
    .sort(visitOrder)
    .slice(-MAX_PANEL_BUTTONS);
  const live = new Set(visited.map((v) => v.url));

  const newest = new Map<string, PanelSnapshot>();
  for (const snap of snapshots) {
    if (!live.has(snap.origin)) continue;
    const kept = newest.get(snap.origin);
    if (!kept || snapshotOrder(kept, snap) < 0) newest.set(snap.origin, snap);
  }
  const kept = [...newest.values()]
    .sort(snapshotOrder)
    .slice(-MAX_SNAPSHOTS)
    .map((snap) => ({ ...snap, floors: snap.floors.slice(0, MAX_FLOORS) }));
  return { visited, removed, snapshots: kept };
}

function readVisits(raw: unknown, now: number): PanelVisit[] {
  const out: PanelVisit[] = [];
  for (const item of listOf(raw)) {
    const f = fieldsOf(item);
    const addedAt = timeOf(f.addedAt, now);
    if (isOrigin(f.url) && addedAt !== null) out.push({ url: f.url, addedAt });
  }
  return out;
}

function readRemovals(raw: unknown, now: number): PanelRemoval[] {
  const out: PanelRemoval[] = [];
  for (const item of listOf(raw)) {
    const f = fieldsOf(item);
    const at = timeOf(f.at, now);
    if (isOrigin(f.url) && at !== null) out.push({ url: f.url, at });
  }
  return out;
}

function readSnapshots(raw: unknown, now: number): PanelSnapshot[] {
  const out: PanelSnapshot[] = [];
  for (const item of listOf(raw)) {
    const f = fieldsOf(item);
    const rev = timeOf(f.rev, now);
    if (!isOrigin(f.origin) || rev === null || !Array.isArray(f.floors))
      continue;
    const floors = [...new Set(f.floors.filter(isOrigin))];
    out.push({ origin: f.origin, rev, floors });
  }
  return out;
}

// A panel from storage or a ride: anything that is not a panel reads as an
// empty one, and every url and time is checked (see the top of this file).
export function sanitisePanel(raw: unknown, now: number): Panel {
  const f = fieldsOf(raw);
  return normalise(
    readVisits(f.visited, now),
    readRemovals(f.removed, now),
    readSnapshots(f.snapshots, now),
    now,
  );
}

export function mergePanels(a: Panel, b: Panel, now: number): Panel {
  return sanitisePanel(
    {
      visited: [...a.visited, ...b.visited],
      removed: [...a.removed, ...b.removed],
      snapshots: [...a.snapshots, ...b.snapshots],
    },
    now,
  );
}

// This office loaded, after a ride from `from` (null on a floors change):
// both offices are on the panel from now on unless they are there already,
// and this office's snapshot is its live floors, over anything that came in.
export function arrive(
  panel: Panel,
  opts: {
    from: string | null;
    here: string;
    ownFloors: string[];
    now: number;
  },
): Panel {
  const { from, here, ownFloors, now } = opts;
  const p = sanitisePanel(panel, now);
  const visits = [...p.visited];
  for (const url of from && from !== here ? [from, here] : [here]) {
    if (!visits.some((v) => v.url === url)) visits.push({ url, addedAt: now });
  }
  return sanitisePanel(
    {
      visited: visits,
      removed: p.removed,
      snapshots: [
        ...p.snapshots.filter((snap) => snap.origin !== here),
        { origin: here, rev: now, floors: ownFloors },
      ],
    },
    now,
  );
}

export function removeFromPanel(panel: Panel, url: string, now: number): Panel {
  return sanitisePanel(
    { ...panel, removed: [...panel.removed, { url, at: now }] },
    now,
  );
}

// The buttons, the same list in every office the panel rode through: each
// visited office in visit order, followed by the floors of its snapshot (for
// this office, its live floors). An origin shows once, at its first place.
// A removed origin is hidden unless it is this office or one of its floors.
// When this office is not a visit, it comes last, then its floors.
export function panelButtons(
  panel: Panel,
  here: string,
  ownFloors: Floor[],
): PanelButton[] {
  const own = new Map(ownFloors.map((f) => [f.url, f]));
  const removedAt = new Map<string, number>();
  for (const r of panel.removed)
    removedAt.set(r.url, Math.max(r.at, removedAt.get(r.url) ?? -1));
  const visits = panel.visited
    .filter((v) => v.addedAt >= (removedAt.get(v.url) ?? -1))
    .sort(visitOrder);
  const visible = new Set(visits.map((v) => v.url));
  const snapshotOf = new Map(panel.snapshots.map((s) => [s.origin, s]));

  const out: PanelButton[] = [];
  const shown = new Set<string>();
  const show = (url: string, fromSnapshot: boolean) => {
    if (shown.has(url)) return;
    const floor = own.get(url);
    if (url !== here && !floor && removedAt.has(url) && !visible.has(url))
      return;
    shown.add(url);
    if (url === here) out.push({ url, kind: "here" });
    else if (floor) out.push({ url, kind: "floor", floor });
    else out.push({ url, kind: fromSnapshot ? "snapshot" : "visited" });
  };
  const floorsOf = (origin: string): string[] =>
    origin === here
      ? ownFloors.map((f) => f.url)
      : (snapshotOf.get(origin)?.floors ?? []);
  for (const v of visits) {
    show(v.url, false);
    for (const url of floorsOf(v.url)) show(url, true);
  }
  if (!visible.has(here)) {
    show(here, false);
    for (const url of floorsOf(here)) show(url, true);
  }
  if (out.length <= MAX_PANEL_BUTTONS) return out;
  // The cap cuts personal entries, latest first; never this office or its
  // own floors.
  let room =
    MAX_PANEL_BUTTONS -
    out.filter((b) => b.kind === "here" || b.kind === "floor").length;
  return out.filter((b) => {
    if (b.kind === "here" || b.kind === "floor") return true;
    return room-- > 0;
  });
}

// UTF-8 JSON as base64url without padding, in a browser and in Bun alike.
function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*=*$/.test(value)) return null;
  try {
    const binary = atob(
      value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, ""),
    );
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function fragmentOf(panel: Panel, from: string): string {
  const body = {
    v: 1,
    from,
    visited: panel.visited,
    removed: panel.removed,
    snapshots: panel.snapshots,
  };
  return `${PANEL_HASH_KEY}=${toBase64Url(JSON.stringify(body))}`;
}

// "isomux-panel=<base64url JSON>", at most MAX_PANEL_FRAGMENT_CHARS long.
// Over the cap it drops the oldest snapshot whole, again and again, then the
// oldest removals, and the oldest visits only when nothing else is left.
export function encodePanelFragment(panel: Panel, from: string): string {
  const snapshots = [...panel.snapshots].sort(snapshotOrder);
  const removed = [...panel.removed].sort(removalOrder);
  const visited = [...panel.visited].sort(visitOrder);
  const fits = (p: Panel) =>
    fragmentOf(p, from).length <= MAX_PANEL_FRAGMENT_CHARS;
  const at = (s: number, r: number, v: number): Panel => ({
    visited: visited.slice(v),
    removed: removed.slice(r),
    snapshots: snapshots.slice(s),
  });
  // The fewest drops that fit, at each stage in turn (a binary search: the
  // fragment only shrinks as more is dropped).
  const fewest = (n: number, test: (k: number) => boolean): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (test(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  if (fits(at(0, 0, 0))) return fragmentOf(at(0, 0, 0), from);
  const s = fewest(snapshots.length, (k) => fits(at(k, 0, 0)));
  if (s < snapshots.length) return fragmentOf(at(s, 0, 0), from);
  const r = fewest(removed.length, (k) => fits(at(s, k, 0)));
  if (r < removed.length) return fragmentOf(at(s, r, 0), from);
  const v = fewest(visited.length, (k) => fits(at(s, r, k)));
  return fragmentOf(at(s, r, v), from);
}

// `hash` is location.hash, with or without its "#". Null when the hash has no
// isomux-panel part. `panel` is null when the first such part is refused (too
// long, not base64url JSON, not v 1); `rest` is the hash without any of them
// either way.
export function readPanelFragment(
  hash: string,
): { panel: unknown; from: string | null; rest: string } | null {
  const parts = hash.replace(/^#/, "").split("&");
  const prefix = `${PANEL_HASH_KEY}=`;
  const ours = parts.filter((part) => part.startsWith(prefix));
  if (ours.length === 0) return null;
  // Every part under our key leaves the address; the first is read.
  const part = ours[0];
  const rest = parts.filter((p) => !p.startsWith(prefix)).join("&");
  const refused = { panel: null, from: null, rest };
  if (part.length > MAX_PANEL_FRAGMENT_CHARS) return refused;
  const text = fromBase64Url(part.slice(prefix.length));
  if (text === null) return refused;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refused;
  }
  const f = fieldsOf(raw);
  if (f.v !== 1) return refused;
  return { panel: raw, from: isOrigin(f.from) ? f.from : null, rest };
}
