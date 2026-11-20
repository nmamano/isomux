// Pure helpers of the account usage card (tasks 3e70b6d4, faf036ad).

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
// (AGENTS.md UI rules). A row is one line (task faf036ad), two with an email
// under the name: its state, its section and its email line set the card's
// height.
export type AccountUsageRowShape = {
  state: "usage" | "no_limit" | "signed_out" | "failed";
  office: boolean;
  email: boolean;
};

// A reading older than this shows its age.
export const ACCOUNT_USAGE_AGE_MS = 60_000;

// Whether the row is one of the office's accounts: the card's first section.
export function isOfficeAccountUsage(row: AccountUsageRowWire): boolean {
  return row.owners.some((owner) => owner.kind === "office");
}

// The shape a loaded row draws; null for a loading row.
export function accountUsageRowShape(
  row: AccountUsageRowWire,
  _nowMs: number,
): AccountUsageRowShape | null {
  if (row.state === "loading") return null;
  return {
    state: row.state,
    office: isOfficeAccountUsage(row),
    email: row.accountLabel !== null,
  };
}

// A blank row that draws `shape`, for the held layout: a weekly window for a
// usage row, an empty email for a row with an email line.
export function heldAccountUsageRow(
  shape: AccountUsageRowShape,
  id: string,
  nowMs: number,
): AccountUsageRowWire {
  return {
    id,
    provider: "claude",
    owners: shape.office ? [{ kind: "office" }] : [],
    accountLabel: shape.email ? "" : null,
    identity: null,
    members: [],
    state: shape.state,
    plan: null,
    windows:
      shape.state === "usage"
        ? [
            {
              label: "",
              usedPercent: 0,
              resetsAtMs: nowMs + 3 * 24 * 60 * 60 * 1000,
            },
          ]
        : [],
    weeklyIndex: shape.state === "usage" ? 0 : null,
    observedAtMs: nowMs,
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
  // A member reads the office's row with no email: their own row of the
  // same account names it.
  return {
    ...into,
    owners,
    members,
    accountLabel: into.accountLabel ?? from.accountLabel,
  };
}
