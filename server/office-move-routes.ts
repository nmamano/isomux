// The move routes of the old office (task 78733adf). /api/move/* is public
// for the auth wall: the new box has no session of this office. Each route
// but the redeem takes the move session as a bearer (hash compare). The
// front door answers them before the auth wall, like the webhook ingress,
// rate-limited like /readyz for off-box callers.
//
//   POST /api/move/redeem          {token, newBox} -> pairs ("code" -> "paired")
//   POST /api/move/preflight       -> 202 {id}
//   GET  /api/move/preflight/:id   -> the job status
//   POST /api/move/lock            {preflightId} -> 202, the MOVE lock
//   GET  /api/move/status          -> {state}
//
// The lock mirrors lockOfficeFromRoute (server/office-lockdown-route.ts):
// units record + state "move" (a failure answers 500 and changes nothing),
// lock this process, close the sockets, audit, answer, then stop with the
// move stop step: no quarantine and no LOCKDOWN marker. The service manager
// (Restart=always, checked) starts the process again, and the boot gate
// starts the MOVE-locked server.

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AuditActor } from "../shared/audit.ts";
import { endOfficeLeftovers } from "./office-lockdown-route.ts";
import { getStopFinalStep, setStopFinalStep } from "./server-stop.ts";
import {
  checkMoveSession,
  markMoveLocked,
  MOVE_PREFLIGHT_FRESH_MS,
  readMoveBody,
  readMoveState,
  redeemMoveCode,
  type MoveBoxInfo,
  type MoveState,
} from "./office-move.ts";
import type {
  MovePreflightJobs,
  TurnInFlight,
} from "./office-move-preflight.ts";
import {
  MOVE_UNITS_FILE,
  writeUnitsRecord,
  type AgentUnit,
} from "./office-move-units.ts";

export const MOVE_API_PREFIX = "/api/move/";

export interface OfficeMoveRouteDeps {
  stateRoot: string;
  /** This box, as the redeem compares it. */
  ours(): MoveBoxInfo;
  preflight: MovePreflightJobs;
  turnsInFlight(): TurnInFlight[];
  /** The office unit's Restart= value, or null without a unit. */
  restartPolicy(): string | null;
  listUnits(): AgentUnit[];
  /** Locks this process (lockOfficeNow) and closes every socket. */
  lockProcess(): void;
  audit(input: {
    operation: "office.pairMove" | "office.lockForMove" | "office.moveExpired";
    actor: AuditActor;
    state?: MoveState;
  }): void;
  /** Stops the process after the answer, with the move stop step. The
   *  harness injects a recorder. */
  requestStop(units: AgentUnit[]): void;
  /** Off-box rate limit (allowReadyRequest's posture, its own budget). */
  allow(source: { onBox: boolean; client: string }): boolean;
  now(): Date;
}

export interface OfficeMoveFrontDoor {
  /** Drops an expired code or pairing (audited). The office's 1 min timer. */
  sweep(): void;
  /** The answer to a /api/move/* request, or null for any other path. */
  handle(
    req: Request,
    url: URL,
    source: { onBox: boolean; client: string },
  ): Promise<Response | null>;
}

/** The audit actor of the new box's requests. */
export const MOVE_AUDIT_ACTOR: AuditActor = {
  kind: "office_move",
  id: "move",
  name: "New office",
};

/** How long after the lock's answer the process stops: time for the answer
 *  to go out. */
const STOP_DELAY_MS = 250;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

const fail = (
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response => json({ error: { code, message }, ...extra }, status);

const sessionInvalid = () =>
  fail(
    401,
    "move_session_invalid",
    "No move session, or it is wrong or expired.",
  );

const TOO_LARGE = Symbol("too large");

// The body as JSON; undefined when it does not parse; TOO_LARGE over 64 KB.
async function readJson(req: Request): Promise<unknown> {
  const text = await readMoveBody(req);
  if (text === null) return TOO_LARGE;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const tooLarge = () =>
  fail(413, "body_too_large", "The body is larger than 64 KB.");

function asBoxInfo(v: unknown): MoveBoxInfo | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const nullableString = (x: unknown) => x === null || typeof x === "string";
  if (
    !nullableString(b.release) ||
    !nullableString(b.commit) ||
    typeof b.homePath !== "string" ||
    b.homePath.length === 0
  )
    return null;
  return {
    release: b.release,
    commit: b.commit,
    homePath: b.homePath,
  };
}

export function createOfficeMoveFrontDoor(
  deps: OfficeMoveRouteDeps,
): OfficeMoveFrontDoor {
  // Drops an expired code or pairing, audited once, and its preflights.
  const currentState = (): MoveState | null => {
    const { current, dropped } = readMoveState(deps.stateRoot, deps.now());
    if (dropped) {
      deps.preflight.clear();
      try {
        deps.audit({
          operation: "office.moveExpired",
          actor: MOVE_AUDIT_ACTOR,
          state: dropped,
        });
      } catch (err) {
        console.error("[move] could not write the audit row:", err);
      }
    }
    return current;
  };

  const redeem = async (
    req: Request,
    source: { onBox: boolean; client: string },
  ): Promise<Response> => {
    if (!source.onBox && !deps.allow(source))
      return fail(429, "rate_limited", "Too many requests. Try again later.");
    const body = await readJson(req);
    if (body === TOO_LARGE) return tooLarge();
    const b =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const newBox = asBoxInfo(b?.newBox);
    if (!b || typeof b.token !== "string" || !b.token || !newBox)
      return fail(
        400,
        "invalid_request",
        "The body must be {token, newBox: {release, commit, homePath}}.",
      );
    currentState();
    const res = redeemMoveCode(deps.stateRoot, {
      token: b.token,
      newBox,
      ours: deps.ours(),
      now: deps.now(),
    });
    if (res.ok) {
      deps.preflight.clear();
      try {
        deps.audit({ operation: "office.pairMove", actor: MOVE_AUDIT_ACTOR });
      } catch (err) {
        console.error("[move] could not write the audit row:", err);
      }
      return json({
        session: res.session,
        sessionExpiresAt: res.sessionExpiresAt,
        office: res.office,
      });
    }
    if (res.status === 403)
      return fail(403, res.error, "The move code is wrong, used or expired.");
    return fail(409, res.error, refusalMessage(res.error), {
      ours: res.ours,
      theirs: res.theirs,
    });
  };

  const lock = async (
    req: Request,
    state: MoveState & { sessionHash: string },
  ): Promise<Response> => {
    if (state.state !== "paired")
      return fail(
        409,
        "not_paired",
        "The office is already locked for the move.",
      );
    const body = await readJson(req);
    if (body === TOO_LARGE) return tooLarge();
    const preflightId =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { preflightId?: unknown }).preflightId
        : undefined;
    if (typeof preflightId !== "string" || !preflightId)
      return fail(400, "invalid_request", "The body must be {preflightId}.");
    const pf = deps.preflight.status(preflightId, state.sessionHash);
    const now = deps.now();
    if (
      !pf ||
      pf.state !== "ready" ||
      now.getTime() - pf.result.finishedAt > MOVE_PREFLIGHT_FRESH_MS
    )
      return fail(
        409,
        "preflight_stale",
        "Run the preflight again: this one is unknown, not finished or too old.",
      );
    if (deps.restartPolicy() !== "always")
      return fail(
        409,
        "no_service_manager",
        "The office must run under a service that restarts it always (Restart=always).",
      );
    const seen = new Set(pf.result.turnsInFlight.map((t) => t.agentId));
    const current = deps.turnsInFlight();
    const added = current.filter((t) => !seen.has(t.agentId));
    if (added.length > 0)
      return fail(
        409,
        "turns_changed",
        "Agents started working after the preflight. Run it again.",
        { turnsInFlight: current, newAgentIds: added.map((t) => t.agentId) },
      );
    // The record and the state first: a failure changes nothing.
    let units: AgentUnit[];
    try {
      units = deps.listUnits();
      writeUnitsRecord(deps.stateRoot, units);
    } catch (err) {
      console.error("[move] could not write the units record:", err);
      rmSync(join(deps.stateRoot, `${MOVE_UNITS_FILE}.tmp`), { force: true });
      return fail(
        500,
        "lock_failed",
        "The office could not record its units. It is not locked.",
      );
    }
    try {
      markMoveLocked(deps.stateRoot, { preflightId, now });
    } catch (err) {
      console.error("[move] could not write the move state:", err);
      rmSync(join(deps.stateRoot, MOVE_UNITS_FILE), {
        force: true,
        recursive: true,
      });
      return fail(
        500,
        "lock_failed",
        "The office could not record the move. It is not locked.",
      );
    }
    try {
      deps.lockProcess();
    } catch (err) {
      console.error("[move] could not lock the process:", err);
    }
    try {
      deps.audit({ operation: "office.lockForMove", actor: MOVE_AUDIT_ACTOR });
    } catch (err) {
      console.error("[move] could not write the audit row:", err);
    }
    console.log("[move] locked for the move; stopping the office");
    setTimeout(() => {
      try {
        deps.requestStop(units);
      } catch (err) {
        console.error("[move] could not stop the office:", err);
      }
    }, STOP_DELAY_MS);
    return json({ locked: true }, 202);
  };

  return {
    sweep: () => {
      currentState();
    },
    async handle(req, url, source) {
      if (!url.pathname.startsWith(MOVE_API_PREFIX)) return null;
      const path = url.pathname.slice(MOVE_API_PREFIX.length);
      if (path === "redeem" && req.method === "POST")
        return redeem(req, source);

      const route =
        path === "preflight" && req.method === "POST"
          ? "startPreflight"
          : path.startsWith("preflight/") && req.method === "GET"
            ? "preflightStatus"
            : path === "lock" && req.method === "POST"
              ? "lock"
              : path === "status" && req.method === "GET"
                ? "status"
                : null;
      if (!route) return fail(404, "not_found", "No such move route.");

      currentState();
      const state = checkMoveSession(
        deps.stateRoot,
        req.headers.get("authorization"),
        deps.now(),
      );
      if (!state) return sessionInvalid();

      switch (route) {
        case "status":
          return json({ state: state.state });
        case "startPreflight": {
          if (state.state !== "paired")
            return fail(
              409,
              "not_paired",
              "The office is already locked for the move.",
            );
          const started = deps.preflight.start(state.sessionHash);
          return started.ok
            ? json({ id: started.id }, 202)
            : fail(409, "preflight_running", started.message);
        }
        case "preflightStatus": {
          let id = "";
          try {
            id = decodeURIComponent(path.slice("preflight/".length));
          } catch {
            // A bad % sequence names no preflight.
          }
          const status = id
            ? deps.preflight.status(id, state.sessionHash)
            : null;
          return status
            ? json(status)
            : fail(404, "not_found", "No such preflight.");
        }
        case "lock":
          return lock(req, state);
      }
    },
  };
}

function refusalMessage(
  error: "home_path_differs" | "release_older" | "release_unknown",
): string {
  switch (error) {
    case "home_path_differs":
      return "The office user's home folder differs between the two machines.";
    case "release_older":
      return "The new machine runs an older Isomux release. Update it first.";
    case "release_unknown":
      return "One machine does not run an Isomux release, and the two run different code.";
  }
}

/** The move stop step: the previous final step, the office's leftover
 *  processes, then stopAppsForLock and stopUnitsForMove. Never the
 *  credential quarantine. Each step logs its own failure and does not skip
 *  the next. */
export function moveStopStep(deps: {
  previous: ((signalAt: number) => Promise<unknown>) | null;
  endLeftovers(): Promise<number>;
  stopApps(): void;
  stopUnits(): void;
}): (signalAt: number) => Promise<void> {
  return async (signalAt) => {
    try {
      await deps.previous?.(signalAt);
    } catch (err) {
      console.error("[move] the stop-reap step failed:", err);
    }
    try {
      const ended = await deps.endLeftovers();
      if (ended > 0) console.log(`[move] ended ${ended} office processes`);
    } catch (err) {
      console.error("[move] could not end the office processes:", err);
    }
    try {
      deps.stopApps();
    } catch (err) {
      console.error("[move] could not stop the apps:", err);
    }
    try {
      deps.stopUnits();
    } catch (err) {
      console.error("[move] could not stop the units:", err);
    }
  };
}

/** The production stop of the move lock: after the stop hooks and the
 *  stop-reap step, ends the office's leftover processes, stops the apps and
 *  the units (moveStopStep), then raises SIGTERM on this process. The
 *  service manager (Restart=always) starts it again, in the MOVE-locked
 *  server. */
export function requestStopForMove(input: {
  stopApps: () => void;
  stopUnits: () => void;
}): void {
  setStopFinalStep(
    moveStopStep({
      previous: getStopFinalStep(),
      endLeftovers: endOfficeLeftovers,
      stopApps: input.stopApps,
      stopUnits: input.stopUnits,
    }),
  );
  process.kill(process.pid, "SIGTERM");
}
