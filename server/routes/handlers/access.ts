// Access-settings resource handlers. The office
// bind/origin policy on the unified REST surface (opIds office.{getAccess,
// setAccess}). Owner-only - the route table gates both with office:admin +
// officeOwner; there is no member or scoped variant.
//
// Strangler EXPAND: these REST handlers + the legacy WS arms (get_access_settings
// / update_access_settings) BOTH delegate to the SAME shared cores in the index
// seam - computeAccessSettings() (read) and applyAccessSettings() (validate →
// save → owner self-invite → emitInvitesList). Handlers stay pure REST mappers.
//
// RESPONSE shapes: getAccess returns the full AccessSettings; setAccess returns
// the NARROW table shape { signInUrl, restartRequired }. The shared core returns
// the richer object (externalAccess/publicOrigin/envOrigin) so the WS arm keeps
// its bespoke access_settings_updated payload; the handler selects the REST shape.
//
// LEAF over the executor + shared types. Only the injected AccessDeps surface.

import {
  ok,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type {
  AccessSettings,
  AccessSettingsReq,
} from "../../../shared/contract-shapes.ts";

// setAccess outcome the seam shapes: ok → the narrow REST body; or a status-
// mapped failure (400 invalid/enable-without-origin, 409 env-mismatch, 500 save).
type SetAccessOutcome =
  | { ok: true; signInUrl: string | null; restartRequired: boolean }
  | { ok: false; status: HandlerErrorStatus; error: string };

export interface AccessDeps {
  getAccess(): AccessSettings;
  setAccess(input: {
    externalAccess: boolean;
    publicOrigin: string;
    identity: Identity;
  }): Promise<SetAccessOutcome>;
}

export function accessHandlers(deps: AccessDeps): Record<string, RouteHandler> {
  return {
    "office.getAccess": () => ok(deps.getAccess()),

    "office.setAccess": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AccessSettingsReq>;
      if (typeof body.externalAccess !== "boolean") {
        return fail(
          400,
          "invalid_request",
          "externalAccess (boolean) is required",
        );
      }
      // publicOrigin is required in the contract but may be empty when disabling
      // external access; the seam normalizes/validates it.
      const publicOrigin =
        typeof body.publicOrigin === "string" ? body.publicOrigin : "";
      const r = await deps.setAccess({
        externalAccess: body.externalAccess,
        publicOrigin,
        identity: ctx.identity,
      });
      return r.ok
        ? ok({ signInUrl: r.signInUrl, restartRequired: r.restartRequired })
        : fail(r.status, "set_access_failed", r.error);
    },
  };
}
