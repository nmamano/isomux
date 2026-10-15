// Paging for GET /agents?killed=1 (task 9643a66a). Spawning agents kill
// finished workers, so the killed roster grows without bound.
//
// The body stays a bare array, newest kill first. `limit` (default 100, max
// 500) caps a page; `before=<killedAt>` returns only kills strictly older than
// that. A caller pages by passing the last item's killedAt as `before`, and a
// page shorter than `limit` is the last one.
//
// A page never ends inside a group of equal kill times: with a strict `before`,
// the rest of that group would fall between two pages. So a page runs past
// `limit` until the group ends. That keeps the "short page is the last" rule.

import type { KilledAgentSummary } from "../shared/types.ts";

export const KILLED_PAGE_DEFAULT = 100;
export const KILLED_PAGE_MAX = 500;

export type KilledPageQuery =
  | { ok: true; limit: number; before: number | null }
  | { ok: false; error: string };

// Strict digits only: Number() alone would accept "", " 5", "1e3" and "0x10".
// `before` takes a fraction because a legacy entry's killedAt is its log dir
// mtime, which carries sub-millisecond digits.
export function parseKilledPageQuery(query: URLSearchParams): KilledPageQuery {
  const rawLimit = query.get("limit");
  const limit = rawLimit === null ? KILLED_PAGE_DEFAULT : Number(rawLimit);
  if (
    rawLimit !== null &&
    (!/^[0-9]+$/.test(rawLimit) || limit < 1 || limit > KILLED_PAGE_MAX)
  ) {
    return {
      ok: false,
      error: `limit must be a whole number from 1 to ${KILLED_PAGE_MAX}`,
    };
  }
  const rawBefore = query.get("before");
  if (rawBefore !== null && !/^[0-9]+(\.[0-9]+)?$/.test(rawBefore)) {
    return { ok: false, error: "before must be a kill time in epoch ms" };
  }
  return {
    ok: true,
    limit,
    before: rawBefore === null ? null : Number(rawBefore),
  };
}

export function pageKilledAgents(
  killed: readonly KilledAgentSummary[],
  limit: number,
  before: number | null,
): KilledAgentSummary[] {
  const older = killed
    .filter((k) => before === null || k.killedAt < before)
    .sort((a, b) => b.killedAt - a.killedAt || a.id.localeCompare(b.id));
  let end = Math.min(limit, older.length);
  while (
    end < older.length &&
    older[end].killedAt === older[end - 1].killedAt
  ) {
    end++;
  }
  return older.slice(0, end);
}
