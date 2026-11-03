// Floors resource handlers (opIds floors.*): the lobby elevator's links to
// other offices. Any member reads and writes them (room:manage, the same reach
// as rooms.create); the route table keeps every other identity out.
//
// floors.add probes the office card on the SERVER (server/office-card.ts) and
// takes the name from it, never from the body. The duplicate and cap checks
// run after the probe resolves, in the store's synchronous add.
//
// Error codes: 400 invalid_request (bad url), 422 office_outdated (an Isomux
// office from before the card), 422 office_unreachable (any other probe
// failure, no detail), 409 floor_exists, 409 too_many_floors,
// 404 floor_not_found. floors.name: 400 invalid_request, 422
// office_unreachable (any probe failure, outdated included, no detail), 429
// too_many_requests (the caller's name probes in flight are at the limit).
//
// LEAF over the executor + shared types: the store, the probe and the emit
// are injected.

import {
  created,
  fail,
  noContent,
  ok,
  type RouteHandler,
} from "../executor.ts";
import {
  normaliseFloorUrl,
  type Floor,
  type OfficeCard,
} from "../../../shared/floors.ts";
import type {
  FloorAddReq,
  FloorNameRes,
} from "../../../shared/contract-shapes.ts";
import type { FloorsStore } from "../../floors-store.ts";
import type { OfficeNameCache } from "../../office-name-cache.ts";

export interface FloorsDeps {
  list: FloorsStore["list"];
  add: FloorsStore["add"];
  remove: FloorsStore["remove"];
  probe(origin: string): Promise<OfficeCard | "outdated" | null>;
  lookupName: OfficeNameCache["lookup"];
  emitFloors(floors: Floor[]): void;
}

export function floorsHandlers(deps: FloorsDeps): Record<string, RouteHandler> {
  return {
    "floors.list": () => ok({ floors: deps.list() }),

    "floors.add": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<FloorAddReq>;
      const url =
        typeof body.url === "string" ? normaliseFloorUrl(body.url) : null;
      if (!url)
        return fail(400, "invalid_request", "url must be an http(s) address");
      const card = await deps.probe(url);
      if (card === "outdated")
        return fail(
          422,
          "office_outdated",
          "the address answers as an Isomux office that must update first",
        );
      if (!card)
        return fail(
          422,
          "office_unreachable",
          "the address does not answer as an Isomux office",
        );
      const result = deps.add(url, card.name);
      if (result.kind === "exists")
        return fail(409, "floor_exists", "that office is already a floor");
      if (result.kind === "full")
        return fail(409, "too_many_floors", "the elevator has no more floors");
      deps.emitFloors(deps.list());
      return created({ floor: result.floor });
    },

    // The elevator panel's name for an office the member rode to: the
    // browser cannot read another office's card itself (connect-src 'self').
    "floors.name": async (ctx) => {
      const raw = ctx.query.get("url");
      const url = raw === null ? null : normaliseFloorUrl(raw);
      if (!url)
        return fail(400, "invalid_request", "url must be an http(s) address");
      const { identity } = ctx;
      const caller =
        identity.agentId ??
        identity.apiTokenId ??
        identity.appName ??
        `user:${identity.userId ?? ""}`;
      const found = await deps.lookupName(url, caller);
      if (found.kind === "busy")
        return fail(429, "too_many_requests", "too many name lookups at once");
      if (found.kind === "failed")
        return fail(
          422,
          "office_unreachable",
          "the address does not answer as an Isomux office",
        );
      const body: FloorNameRes = { name: found.name };
      return ok(body);
    },

    "floors.remove": (ctx) => {
      if (!deps.remove(ctx.params.id ?? ""))
        return fail(404, "floor_not_found", "no such floor");
      deps.emitFloors(deps.list());
      return noContent();
    },
  };
}
