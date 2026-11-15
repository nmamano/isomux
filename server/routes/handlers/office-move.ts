// The owner's move routes on the old office (task 78733adf): mint a move
// code, read the move state, cancel the move before the lock.
// server/office-move.ts holds the logic; the routes the new box calls are in
// server/office-move-routes.ts, before the auth wall.

import { fail, ok, type RouteHandler } from "../executor";
import type { Identity } from "../../identity/index.ts";
import {
  cancelMove,
  mintMoveCode,
  MoveStateError,
  readMoveState,
} from "../../office-move.ts";

export interface OfficeMoveHandlerDeps {
  stateRoot: string;
  /** The origin the code carries: the office's public origin, else the
   *  origin of the minting request. */
  origin(req: Request): string;
  /** The member's name. */
  byName(identity: Identity): string;
  /** Drops the preflight jobs of an ended pairing. */
  clearPreflights(): void;
  now(): Date;
}

export function officeMoveHandlers(
  deps: OfficeMoveHandlerDeps,
): Record<string, RouteHandler> {
  return {
    "office.mintMoveCode": (ctx) => {
      try {
        const minted = mintMoveCode(deps.stateRoot, {
          origin: deps.origin(ctx.req),
          by: deps.byName(ctx.identity),
          now: deps.now(),
        });
        return ok(minted);
      } catch (err) {
        if (err instanceof MoveStateError)
          return fail(409, err.code, err.message);
        throw err;
      }
    },
    "office.getMove": () => {
      const { current } = readMoveState(deps.stateRoot, deps.now());
      if (!current) return ok({ state: "none" });
      return ok({
        state: current.state,
        expiresAt:
          current.state === "code"
            ? current.redeemBy
            : current.state === "paired"
              ? current.sessionExpiresAt
              : null,
        ...(current.state !== "code"
          ? { pairedAt: current.pairedAt, newBox: current.newBox }
          : {}),
      });
    },
    "office.cancelMove": () => {
      try {
        const ended = cancelMove(deps.stateRoot, deps.now());
        if (ended) deps.clearPreflights();
        return ok({ cancelled: ended !== null });
      } catch (err) {
        if (err instanceof MoveStateError)
          return fail(409, err.code, err.message);
        throw err;
      }
    },
  };
}
