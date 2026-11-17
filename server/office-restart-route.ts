// The office restart route (task d3d229a8). POST /api/office/restart lets an
// owner, or an owner's agent, restart the office without root: the office
// stops itself the way a service manager does (restartOfficeProcess, SIGTERM
// to its own pid, so every stop hook runs), and the service manager starts it
// again. On an installer system install the service user has no other way:
// it cannot run systemctl restart on a root unit.
//
// The route refuses (409) when nothing would start the office again, so it
// never only stops it: the office's own unit must have Restart=always (systemd
// counts death by SIGTERM as clean, so on-failure does not restart it), or the
// office runs in the container image, whose supervisor starts it again after
// any exit. A later call while a restart is pending answers as the first did
// and schedules no second stop: a second SIGTERM after the first would end
// the process at once and skip the remaining stop hooks.

import type { UpdateConfRead } from "./update-conf.ts";

export interface OfficeRestartDeps {
  /** True when a service manager starts the office again after any exit. */
  restartsAfterExit(): boolean;
  /** Stops the process after the response is sent. Production:
   *  restartOfficeProcess. The in-process harness injects a recorder. */
  requestRestart(): void;
}

export type OfficeRestartResult =
  | { ok: true }
  | { ok: false; status: 409; code: "no_service_manager"; message: string };

/** How long after the answer the process stops: time for the answer to go
 *  out. */
const STOP_DELAY_MS = 250;

/** One restarter per boot: it remembers a restart it already scheduled. */
export function officeRestarter(
  deps: OfficeRestartDeps,
): (by: string) => OfficeRestartResult {
  let scheduled = false;
  return (by) => {
    if (scheduled) return { ok: true };
    if (!deps.restartsAfterExit())
      return {
        ok: false,
        status: 409,
        code: "no_service_manager",
        message:
          "The office does not run under a service that starts it again (Restart=always), so this would only stop it. Restart it on the office's machine.",
      };
    scheduled = true;
    console.log(`[restart] restart requested by ${by}; stopping the office`);
    setTimeout(() => {
      try {
        deps.requestRestart();
      } catch (err) {
        console.error("[restart] could not stop the office:", err);
      }
    }, STOP_DELAY_MS);
    return { ok: true };
  };
}

/** Pure. `restartPolicy` is officeRestartPolicy()?.restart; `conf` is this
 *  box's update.conf. */
export function officeRestartsAfterExit(
  restartPolicy: string | null,
  conf: UpdateConfRead,
): boolean {
  if (restartPolicy === "always") return true;
  return conf.state === "parsed" && conf.values.DEPLOYMENT_KIND === "container";
}
