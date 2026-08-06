// A complete stand-in for the app supervisor, and the reason `bun test` never
// touches systemd.
//
// systemd is machine-global: one user manager per box, shared with whatever
// office is actually running on it. A test that reached the real supervisor
// would write unit files into ~/.config/systemd/user and run systemctl against
// that manager - so this is not a determinism fake like FakeBackend, it is a
// containment boundary. `startTestServer` injects one by DEFAULT, which is what
// makes "the suite cannot touch systemd" a property of the wiring rather than a
// convention every future test has to remember.
//
// It models the state machine, not systemd: install starts an app, stop stops
// it, teardown removes it, and `restartCount` only ever moves when a test moves
// it (systemd's NRestarts counts AUTOMATIC restarts, so an explicit restart
// leaves it alone - modelling that faithfully keeps a test from proving a
// behavior the real thing does not have).
//
// Test-support ONLY; never imported by a production path.

import {
  AppSupervisorError,
  UNKNOWN_RUNTIME,
  unitNameFor,
  type AppRuntime,
  type AppSupervisor,
} from "../app-supervisor.ts";
import type { AppRecord } from "../../shared/types.ts";

export interface FakeAppSupervisor extends AppSupervisor {
  // Every call in order, as "verb:name" - so a test can assert the SEQUENCE
  // (teardown before the registry drops the record, say), not just the effect.
  calls: string[];
  // Apps this supervisor believes it installed, by name.
  installed: Map<string, AppRecord>;
  // Set non-null to make the next call of that kind throw an
  // AppSupervisorError with this message.
  failInstall: string | null;
  failTeardown: string | null;
  failAction: string | null;
  // Throw something that is NOT an AppSupervisorError - a raw fs error, say.
  // The real supervisor converts these at its own boundary; this exists so a
  // route test can prove the handler does not depend on that conversion having
  // happened.
  throwRawOnInstall: Error | null;
  // Force a runtime for an app (a crash loop, a failed start, a missing unit).
  setRuntime(name: string, runtime: AppRuntime): void;
  // What an app's state is right after a successful install. Default running;
  // set it to `failed` to model a unit that installed fine and whose process
  // then died - the case that must still be a 201.
  installedState: AppRuntime;
  // What logs() returns.
  logLines: string[];
  // Arguments the last logs() call was made with.
  lastLogRequest: { name: string; lines: number } | null;
}

export function createFakeAppSupervisor(
  unitPrefix = "isomux-app-test-fake-",
): FakeAppSupervisor {
  const runtimes = new Map<string, AppRuntime>();
  const fake: FakeAppSupervisor = {
    calls: [],
    installed: new Map(),
    failInstall: null,
    failTeardown: null,
    failAction: null,
    throwRawOnInstall: null,
    installedState: { state: "running", restartCount: 0 },
    logLines: [],
    lastLogRequest: null,

    setRuntime(name, runtime) {
      runtimes.set(name, runtime);
    },

    unitName: (name) => unitNameFor(unitPrefix, name),

    install(app: AppRecord) {
      fake.calls.push(`install:${app.name}`);
      if (fake.throwRawOnInstall) throw fake.throwRawOnInstall;
      if (fake.failInstall) {
        // Records the reason before throwing, exactly as the real supervisor
        // does - the register route answers 201 and this is the only place the
        // caller can learn why the app is not running.
        runtimes.set(app.name, {
          state: "unknown",
          restartCount: 0,
          startError: fake.failInstall,
        });
        throw new AppSupervisorError("supervisor_failed", fake.failInstall);
      }
      fake.installed.set(app.name, app);
      runtimes.set(app.name, { ...fake.installedState });
    },

    teardown(name: string) {
      fake.calls.push(`teardown:${name}`);
      if (fake.failTeardown) {
        throw new AppSupervisorError("supervisor_failed", fake.failTeardown);
      }
      fake.installed.delete(name);
      runtimes.delete(name);
    },

    start(name: string) {
      fake.calls.push(`start:${name}`);
      if (fake.failAction) {
        throw new AppSupervisorError("supervisor_failed", fake.failAction);
      }
      runtimes.set(name, {
        state: "running",
        restartCount: runtimes.get(name)?.restartCount ?? 0,
      });
    },

    stop(name: string) {
      fake.calls.push(`stop:${name}`);
      if (fake.failAction) {
        throw new AppSupervisorError("supervisor_failed", fake.failAction);
      }
      runtimes.set(name, {
        state: "stopped",
        restartCount: runtimes.get(name)?.restartCount ?? 0,
      });
    },

    restart(name: string) {
      fake.calls.push(`restart:${name}`);
      if (fake.failAction) {
        throw new AppSupervisorError("supervisor_failed", fake.failAction);
      }
      runtimes.set(name, {
        state: "running",
        restartCount: runtimes.get(name)?.restartCount ?? 0,
      });
    },

    states(names) {
      fake.calls.push(`states:${[...names].join(",")}`);
      const out = new Map<string, AppRuntime>();
      for (const name of names) {
        out.set(name, runtimes.get(name) ?? UNKNOWN_RUNTIME);
      }
      return out;
    },

    logs(name: string, lines: number) {
      fake.calls.push(`logs:${name}`);
      fake.lastLogRequest = { name, lines };
      return fake.logLines;
    },
  };
  return fake;
}
