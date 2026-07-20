// Update-trigger resource handlers (release-channel, in-UI update slice).
// opIds office.{updateInfo,triggerUpdate} — both owner-only in the route table
// (office:admin + officeOwner), same posture as the office access/settings
// surface: applying an update restarts the server and interrupts every agent,
// an office-admin act. The owner-only gate is UX-level authorization; the
// SECURITY boundary on system boxes is the root-owned template unit + polkit
// rule (see server/update-trigger.ts and deploy/install.sh) — the route never
// widens what the service user could already invoke by shell.
//
// updateInfo reads the conf fresh per call (a just-installed updater should
// not need a server restart to be seen); the passive banner rides the
// update_status WS event instead and never hits these routes.
//
// LEAF over the executor. Only the injected UpdateDeps.

import { ok, fail, type RouteHandler } from "../executor.ts";
import type { UpdateStatusWire } from "../../../shared/types.ts";

export interface UpdateDeps {
  getUpdateInfo(): {
    managed: boolean;
    serviceKind: "system" | "user" | null;
    // OFFICE-WIDE mid-turn agent count for the confirm dialog, computed
    // server-side: the client's own agent store is projected to the viewer's
    // visible rooms, so a room-restricted owner would undercount what the
    // restart actually interrupts. A bare aggregate is safe for the owner.
    busyAgents: number;
    status: UpdateStatusWire;
  };
  triggerUpdate(
    tag: string,
  ): Promise<
    | { ok: true; via: "system" | "user"; tag: string }
    | { ok: false; status: 400 | 409 | 500; code: string; message: string }
  >;
}

export function updateHandlers(deps: UpdateDeps): Record<string, RouteHandler> {
  return {
    "office.updateInfo": () => ok(deps.getUpdateInfo()),

    "office.triggerUpdate": async (ctx) => {
      const b = (ctx.body ?? {}) as { tag?: unknown };
      if (typeof b.tag !== "string" || b.tag.length === 0) {
        return fail(400, "invalid_tag", "body must carry a release tag");
      }
      const r = await deps.triggerUpdate(b.tag);
      if (!r.ok) return fail(r.status, r.code, r.message);
      // 202: the detached launch was ACCEPTED (systemd took the job). Whether
      // the update succeeds is decided out-of-band by the updater — its flock,
      // downgrade refusal, or rollback all land in its status file, not here.
      return ok({ ok: true, via: r.via, tag: r.tag }, 202);
    },
  };
}
