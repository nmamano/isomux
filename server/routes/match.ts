// Route matcher - Phase 3a. Resolves an incoming (method, pathname) to a route
// in the typed table (server/routes/table.ts) plus its extracted path params.
// The HTTP dispatcher (server/routes/executor.ts, wired in server/isomux-office.ts) uses
// this to turn a raw Request into a RouteDef + params before the
// identity -> authorize -> precondition -> handler pipeline runs.
//
// LONGEST-STATIC-WINS: when more than one route matches the same concrete path,
// the one with the more STATIC (literal) segments wins over a `:param` segment
// at the same position. That is what lets /api/sessions/current beat
// /api/sessions/:sessionPrefix, and /api/cronjobs/:id/runs/:runId/read-file beat
// nothing it shouldn't. Encoded as a lexicographic comparison of each match's
// per-segment "kind vector" (static = 0, param = 1): the smallest vector wins.
// The route table forbids duplicate (method,path) pairs, so an exact tie cannot
// occur. See internal-docs/generic-runtime-refactor.md -> Conventions.
//
// LEAF: imports only the route table's types. No manager / auth / emit coupling.

import type { RouteDef } from "./table.ts";

export interface RouteMatch {
  route: RouteDef;
  // Decoded path params keyed by the `:name` declared in the route path.
  params: Record<string, string>;
}

// Split a path into non-empty segments, so a trailing slash and a double slash
// never change matching (/api/tasks/ === /api/tasks).
function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

// Lexicographically compare two equal-length kind vectors. Returns true when `a`
// is strictly "more static" than `b` (smaller at the first differing position).
function kindsLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false; // equal vectors => not strictly less (and the table forbids dup paths)
}

// Match a concrete (method, pathname) against the supplied routes. Returns the
// most-specific matching route and its decoded params, or null when nothing
// matches (the caller then falls through to the legacy handlers / static serve).
export function matchRoute(
  routes: readonly RouteDef[],
  method: string,
  pathname: string,
): RouteMatch | null {
  const reqSegs = segmentsOf(pathname);
  let best: RouteMatch | null = null;
  let bestKinds: number[] | null = null;

  for (const route of routes) {
    if (route.method !== method) continue;
    const segs = segmentsOf(route.path);
    if (segs.length !== reqSegs.length) continue;

    const params: Record<string, string> = {};
    const kinds: number[] = [];
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.startsWith(":")) {
        // Param segment: capture (decoded). An empty incoming segment can't
        // happen here because segmentsOf dropped empties and lengths matched.
        params[s.slice(1)] = safeDecode(reqSegs[i]);
        kinds.push(1);
      } else if (s === reqSegs[i]) {
        kinds.push(0);
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    if (best === null || kindsLess(kinds, bestKinds as number[])) {
      best = { route, params };
      bestKinds = kinds;
    }
  }

  return best;
}

// Decode a single path segment, falling back to the raw value if it isn't valid
// percent-encoding (a malformed %xx must not throw the whole dispatch).
function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}
