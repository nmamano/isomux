// Pure helpers of the owners' account usage card (task 3e70b6d4).

import type { AccountUsageRowWire } from "./contract-shapes.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// How much of the weekly window has passed at `nowMs`, 0..100, from the
// window's reset time. Null without a reset time.
export function weekElapsedPercent(
  resetsAtMs: number | null,
  nowMs: number,
): number | null {
  if (resetsAtMs === null) return null;
  const passed = 100 * (1 - (resetsAtMs - nowMs) / WEEK_MS);
  return Math.min(100, Math.max(0, passed));
}

// Weekly headroom of a loaded row: week passed minus used. Null for a row
// with no weekly reading.
function headroom(row: AccountUsageRowWire, nowMs: number): number | null {
  if (row.state !== "usage" || row.weeklyIndex === null) return null;
  const win = row.windows[row.weeklyIndex];
  if (!win) return null;
  const passed = weekElapsedPercent(win.resetsAtMs, nowMs);
  return passed === null ? null : passed - win.usedPercent;
}

// The order of the loaded rows on the card. Rows in `placed` keep their
// order; each loaded row not yet placed goes in at its place by weekly
// headroom (week passed minus used, most first), without moving the others.
// Rows with no weekly reading (no_limit, signed_out, failed) go last. Loading
// rows are not in the result. `placed` empty sorts every loaded row.
export function accountUsageOrder(
  placed: readonly string[],
  rows: readonly AccountUsageRowWire[],
  nowMs: number,
): string[] {
  const loaded = new Map(
    rows.filter((row) => row.state !== "loading").map((row) => [row.id, row]),
  );
  const order = placed.filter((id) => loaded.has(id));
  const room = (id: string) => headroom(loaded.get(id)!, nowMs);
  const fresh = [...loaded.keys()]
    .filter((id) => !order.includes(id))
    .map((id) => ({ id, room: room(id) }));
  // Most headroom first; Array.prototype.sort is stable.
  fresh.sort((a, b) =>
    a.room === null
      ? b.room === null
        ? 0
        : 1
      : b.room === null
        ? -1
        : b.room - a.room,
  );
  for (const { id, room: mine } of fresh) {
    if (mine === null) {
      order.push(id);
      continue;
    }
    // Before the first placed row with less headroom, or none.
    const at = order.findIndex((other) => {
      const theirs = room(other);
      return theirs === null || theirs < mine;
    });
    if (at < 0) order.push(id);
    else order.splice(at, 0, id);
  }
  return order;
}

// What a row draws, for the card to hold its layout while the list loads
// (AGENTS.md UI rules): the state line, the weekly bar and its tick, the
// other bars, the members line and the age line.
export type AccountUsageRowShape = {
  state: "usage" | "no_limit" | "signed_out" | "failed";
  weekly: boolean;
  resets: boolean;
  others: number;
  members: boolean;
  age: boolean;
};

// A reading older than this shows its age.
export const ACCOUNT_USAGE_AGE_MS = 60_000;

// The shape a loaded row draws at `nowMs`; null for a loading row.
export function accountUsageRowShape(
  row: AccountUsageRowWire,
  nowMs: number,
): AccountUsageRowShape | null {
  if (row.state === "loading") return null;
  const weekly =
    row.weeklyIndex === null ? null : (row.windows[row.weeklyIndex] ?? null);
  return {
    state: row.state,
    weekly: weekly !== null,
    resets: weekly !== null && weekly.resetsAtMs !== null,
    others: row.windows.length - (weekly ? 1 : 0),
    members: row.members.length > 0,
    age:
      row.observedAtMs !== null &&
      nowMs - row.observedAtMs >= ACCOUNT_USAGE_AGE_MS,
  };
}

// A blank row that draws `shape`, for the held layout.
export function heldAccountUsageRow(
  shape: AccountUsageRowShape,
  id: string,
  nowMs: number,
): AccountUsageRowWire {
  const blank = (resetsAtMs: number | null) => ({
    label: "",
    usedPercent: 0,
    resetsAtMs,
  });
  const windows = [
    ...(shape.weekly
      ? [blank(shape.resets ? nowMs + 3 * 24 * 60 * 60 * 1000 : null)]
      : []),
    ...Array.from({ length: shape.others }, () => blank(null)),
  ];
  return {
    id,
    provider: "claude",
    owners: [],
    accountLabel: null,
    identity: null,
    members: shape.members ? [""] : [],
    state: shape.state,
    plan: null,
    windows,
    weeklyIndex: shape.weekly ? 0 : null,
    observedAtMs: shape.age ? nowMs - 2 * ACCOUNT_USAGE_AGE_MS : nowMs,
  };
}

// Whether two rows are one provider account: the same provider and identity.
// A row with no identity is no account's.
export function sameAccountUsage(
  a: AccountUsageRowWire,
  b: AccountUsageRowWire,
): boolean {
  return (
    a.identity !== null &&
    a.provider === b.provider &&
    a.identity === b.identity
  );
}

// `into` with the owners and members of `from` added: one row for one
// provider account. `into` keeps its id, reading and place.
export function foldAccountUsageRow(
  into: AccountUsageRowWire,
  from: AccountUsageRowWire,
): AccountUsageRowWire {
  const owners = [...into.owners];
  for (const owner of from.owners)
    if (
      !owners.some((o) =>
        o.kind === "office"
          ? owner.kind === "office"
          : owner.kind === "member" && o.username === owner.username,
      )
    )
      owners.push(owner);
  const members = [...into.members];
  for (const member of from.members)
    if (!members.includes(member)) members.push(member);
  return { ...into, owners, members };
}
