// Access-settings resource handlers. The office
// bind/origin policy on the unified REST surface (opIds office.{getAccess,
// setAccess}). Owner-only - the route table gates both with office:admin +
// officeOwner; there is no member or scoped variant.
//
// GET returns AccessSettings; PUT selects signInUrl and restartRequired.

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

// The core permits only an unchanged, enabled address on a hosted office.
// Self-hosted changes retain their validation and persistence behavior.
type SetAccessOutcome =
  | { ok: true; signInUrl: string | null; restartRequired: boolean }
  | { ok: false; status: HandlerErrorStatus; error: string; code?: string };

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
        : fail(r.status, r.code ?? "set_access_failed", r.error);
    },
  };
}
