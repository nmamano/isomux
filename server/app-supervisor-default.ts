// The app supervisor this host uses: the container one in the image, none on
// a host without systemd, else the systemd user units. The office's managers
// and the locked office (task cdd7883d) pick it the same way.

import { statSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import {
  appSupervisor as systemdAppSupervisor,
  type AppSupervisor,
} from "./app-supervisor.ts";
import { createContainerAppSupervisor } from "./container-app-supervisor.ts";
import {
  appHostingUnsupportedReason,
  createUnavailableAppSupervisor,
} from "./app-hosting.ts";

export function defaultAppSupervisor(platform: NodeJS.Platform): AppSupervisor {
  if (process.env.ISOMUX_APP_SUPERVISOR === "container")
    return createContainerAppSupervisor();
  if (appHostingUnsupportedReason(platform) !== null)
    return createUnavailableAppSupervisor();
  return systemdAppSupervisor;
}

// The uid that runs this host's office apps, for the relay's port check
// (app-port-owner.ts). The systemd units run under the user manager of the
// server's own user. The container's supervisor.py runs every app as itself,
// and it made its control socket, so the socket's owner is that uid (also in
// the split rig, where it is the agent user and not the server's). Null when
// it cannot be read, or the host runs no apps: the relay refuses.
export function defaultOfficeAppUid(
  platform: NodeJS.Platform,
): () => number | null {
  if (process.env.ISOMUX_APP_SUPERVISOR === "container")
    return () => {
      try {
        return statSync(join(STATE_ROOT, "container-runtime", "control.sock"))
          .uid;
      } catch {
        return null;
      }
    };
  if (appHostingUnsupportedReason(platform) !== null) return () => null;
  return () => process.getuid?.() ?? null;
}
