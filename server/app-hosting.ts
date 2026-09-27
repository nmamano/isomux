// Whether this host can run agent-built apps. The supervisor runs each app as
// a systemd user unit (server/app-supervisor.ts), and systemd exists only on
// Linux. On any other host (macOS local offices) the office starts no app,
// every route that would change or run one answers 501 apps_not_supported, and
// the UI and the agent prompt say why.

import {
  AppSupervisorError,
  type AppRuntime,
  type AppSupervisor,
} from "./app-supervisor.ts";

export const APPS_NOT_SUPPORTED_MESSAGE =
  "App hosting needs Linux with systemd, so it is not available on this computer.";

export function appHostingUnsupportedReason(
  platform: NodeJS.Platform,
): string | null {
  return platform === "linux" ? null : APPS_NOT_SUPPORTED_MESSAGE;
}

// A supervisor that never touches the machine. Reads report nothing installed
// and nothing running; teardown has nothing to remove, so an app registered
// before this host was known to be unsupported can still be deleted. Every
// operation that would install or run something refuses.
export function createUnavailableAppSupervisor(): AppSupervisor {
  const refuse = (): never => {
    throw new AppSupervisorError(
      "apps_not_supported",
      APPS_NOT_SUPPORTED_MESSAGE,
    );
  };
  return {
    unitName: (appName) => `isomux-app-${appName}`,
    install: refuse,
    provisionToken: refuse,
    readToken: () => null,
    removeToken: () => {},
    unitInjectsToken: () => false,
    readUnitFile: () => null,
    restoreUnitFile: refuse,
    reloadUnits: refuse,
    regenerate: refuse,
    reinstall: refuse,
    teardown: () => {},
    start: refuse,
    stop: refuse,
    restart: refuse,
    states: () => new Map<string, AppRuntime>(),
    logs: refuse,
  };
}
