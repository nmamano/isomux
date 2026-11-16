// The apps a lock stops and disables, over one app registry and supervisor
// (task 367596bc). The office passes its own; the host command
// (scripts/rescue.ts) builds both from the state root it was given.

import type { AppSupervisor } from "./app-supervisor.ts";
import type { LockdownApps } from "./lockdown.ts";

export function lockdownApps(
  supervisor: AppSupervisor,
  registry: { list(): { name: string }[] },
): LockdownApps {
  const apps: LockdownApps = {
    list: () => registry.list().map((app) => app.name),
    // Anything not known to be stopped is stopped (fail safe).
    isActive: (name) =>
      supervisor.states([name]).get(name)?.state !== "stopped",
    stop: (name) => supervisor.stop(name),
    start: (name) => supervisor.start(name),
  };
  if (supervisor.enabledApps && supervisor.enable && supervisor.disable) {
    apps.enabledApps = (names) => supervisor.enabledApps?.(names) ?? [];
    apps.enable = (name) => supervisor.enable?.(name);
    apps.disable = (name) => supervisor.disable?.(name);
  }
  return apps;
}
