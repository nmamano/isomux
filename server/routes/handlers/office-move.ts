// The owner's move routes on the old office (task 78733adf): mint a move
// code, read the move state, cancel the move before the lock.
// server/office-move.ts holds the logic; the routes the new box calls are in
// server/office-move-routes.ts, before the auth wall.

import { fail, ok, type RouteHandler } from "../executor";
import type { Identity } from "../../identity/index.ts";
import { auditActor } from "../../audit-actor.ts";
import type { MoveIn, MoveInAnswer } from "../../office-move-in.ts";
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
  /** The new office's side (slice 2b), built at the first use. */
  moveIn(): MoveIn;
  now(): Date;
}

function answer(a: MoveInAnswer) {
  return a.ok
    ? ok(a.body, a.status)
    : fail(a.status as Parameters<typeof fail>[0], a.code, a.message, a.extra);
}

const field = (body: unknown, name: string): unknown =>
  body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)[name]
    : undefined;

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
        // Slice 4: the new office has copied a part of this office.
        ...(current.state !== "code" && current.servedAt !== undefined
          ? { servedAt: current.servedAt }
          : {}),
      });
    },
    // The new office (slice 2b): the owner pastes the old office's code.
    "office.startMoveIn": async (ctx) => {
      const code = field(ctx.body, "code");
      if (typeof code !== "string" || !code)
        return fail(400, "invalid_request", "The body must be {code}.");
      return answer(
        await deps.moveIn().start({
          code,
          by: auditActor(ctx.identity, deps.byName(ctx.identity)),
        }),
      );
    },
    "office.getMoveIn": () => ok(deps.moveIn().status()),
    "office.rerunMoveInPreflight": async (ctx) =>
      answer(
        await deps.moveIn().rerunPreflight({
          by: auditActor(ctx.identity, deps.byName(ctx.identity)),
        }),
      ),
    "office.lockMoveIn": async (ctx) => {
      const preflightId = field(ctx.body, "preflightId");
      if (typeof preflightId !== "string" || !preflightId)
        return fail(400, "invalid_request", "The body must be {preflightId}.");
      return answer(
        await deps.moveIn().lock({
          preflightId,
          by: auditActor(ctx.identity, deps.byName(ctx.identity)),
        }),
      );
    },
    "office.finishMoveIn": async (ctx) => {
      const acceptMissing = field(ctx.body, "acceptMissing");
      if (acceptMissing !== undefined && typeof acceptMissing !== "boolean")
        return fail(
          400,
          "invalid_request",
          "The body must be {acceptMissing?: boolean}.",
        );
      return answer(
        await deps.moveIn().finish({
          acceptMissing: acceptMissing === true,
          by: auditActor(ctx.identity, deps.byName(ctx.identity)),
          requestOrigin: deps.origin(ctx.req),
        }),
      );
    },
    "office.copyMoveInLive": async (ctx) =>
      answer(
        await deps.moveIn().copyLive({
          by: auditActor(ctx.identity, deps.byName(ctx.identity)),
        }),
      ),
    "office.retryMoveIn": async (ctx) =>
      answer(
        await deps.moveIn().retryPull({
          by: auditActor(ctx.identity, deps.byName(ctx.identity)),
        }),
      ),
    "office.cancelMoveIn": async (ctx) =>
      answer(
        await deps
          .moveIn()
          .cancel({ by: auditActor(ctx.identity, deps.byName(ctx.identity)) }),
      ),
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
