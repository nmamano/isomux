// The app supervisor this host uses: the container one in the image, none on
// a host without systemd, else the systemd user units. The office's managers
// and the locked office (task cdd7883d) pick it the same way.

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
