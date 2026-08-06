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
  failReinstall: string | null;
  failTeardown: string | null;
  failAction: string | null;
  // Throw something that is NOT an AppSupervisorError - a raw fs error, say.
  // The real supervisor converts these at its own boundary; this exists so a
  // route test can prove the handler does not depend on that conversion having
  // happened.
  throwRawOnInstall: Error | null;
  // Force a runtime for an app (a crash loop, a failed start, a missing unit).
  setRuntime(name: string, runtime: AppRuntime): void;
  // The token environment files this supervisor "wrote", by app name. Stands in
  // for <launcherDir>/<name>.env, so a test can assert an app was handed a
  // token - and, more to the point, that an update did NOT hand it a new one.
  tokenFiles: Map<string, string>;
  // Apps whose installed unit references their token file. Modelled rather than
  // implied, because the state that matters most is the one where a healthy
  // token sits behind a unit that does not read it - a test has to be able to
  // construct that.
  unitsInjectingToken: Set<string>;
  failProvisionToken: string | null;
  failRegenerate: string | null;
  // Model an install that gets as far as WRITING the unit and then fails (the
  // daemon-reload stage). The files are on disk and reference the token; what
  // systemd holds is another matter - which is the whole reason boot
  // reconciliation reloads.
  failInstallAfterFiles: string | null;
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
    failReinstall: null,
    failTeardown: null,
    failAction: null,
    throwRawOnInstall: null,
    installedState: { state: "running", restartCount: 0 },
    logLines: [],
    lastLogRequest: null,
    tokenFiles: new Map(),
    unitsInjectingToken: new Set(),
    failProvisionToken: null,
    failRegenerate: null,
    failInstallAfterFiles: null,

    setRuntime(name, runtime) {
      runtimes.set(name, runtime);
    },

    unitName: (name) => unitNameFor(unitPrefix, name),

    provisionToken(name: string, raw: string) {
      fake.calls.push(`provisionToken:${name}`);
      if (fake.failProvisionToken) {
        throw new AppSupervisorError(
          "supervisor_failed",
          fake.failProvisionToken,
        );
      }
      fake.tokenFiles.set(name, raw);
    },

    // Deliberately NOT recorded in `calls`: reconciliation reads every app's
    // token and unit at boot, and a read is not an effect a test should have to
    // allow for when asserting a call sequence.
    readToken: (name: string) => fake.tokenFiles.get(name) ?? null,

    unitInjectsToken: (name: string) => fake.unitsInjectingToken.has(name),

    reloadUnits() {
      fake.calls.push("reloadUnits");
    },

    removeToken(name: string) {
      fake.calls.push(`removeToken:${name}`);
      fake.tokenFiles.delete(name);
    },

    regenerate(app: AppRecord) {
      fake.calls.push(`regenerate:${app.name}`);
      if (fake.failRegenerate) {
        throw new AppSupervisorError("supervisor_failed", fake.failRegenerate);
      }
      // Files only: activation is deliberately untouched, so an app that was
      // not running does not become running (the property the real one has and
      // the reason reconciliation is allowed to call it).
      fake.installed.set(app.name, app);
      fake.unitsInjectingToken.add(app.name);
    },

    install(app: AppRecord) {
      fake.calls.push(`install:${app.name}`);
      if (fake.throwRawOnInstall) throw fake.throwRawOnInstall;
      if (fake.failInstallAfterFiles) {
        // Files written (so the unit references the token), then the failure -
        // the app is NOT installed as far as systemd is concerned.
        fake.unitsInjectingToken.add(app.name);
        runtimes.set(app.name, {
          state: "unknown",
          restartCount: 0,
          startError: fake.failInstallAfterFiles,
        });
        throw new AppSupervisorError(
          "supervisor_failed",
          fake.failInstallAfterFiles,
        );
      }
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
      fake.unitsInjectingToken.add(app.name);
      runtimes.set(app.name, { ...fake.installedState });
    },

    // Models the real one's contract rather than its systemctl sequence: what
    // was running is restarted into the new record, what was at rest stays at
    // rest, and an app with no unit at all is installed. A test that wants the
    // failure path sets failReinstall.
    reinstall(app: AppRecord) {
      fake.calls.push(`reinstall:${app.name}`);
      if (fake.failReinstall) {
        runtimes.set(app.name, {
          state: runtimes.get(app.name)?.state ?? "unknown",
          restartCount: runtimes.get(app.name)?.restartCount ?? 0,
          startError: fake.failReinstall,
        });
        throw new AppSupervisorError("supervisor_failed", fake.failReinstall);
      }
      fake.installed.set(app.name, app);
      // The unit is rewritten, so it carries the token directive again even if
      // it was written before tokens existed.
      fake.unitsInjectingToken.add(app.name);
      const prior = runtimes.get(app.name);
      if (!prior || prior.state === "unknown") {
        runtimes.set(app.name, { ...fake.installedState });
      } else if (prior.state === "running" || prior.state === "starting") {
        // An explicit restart is a new activation, so systemd's NRestarts
        // starts over - the same rule the header note gives for restart().
        runtimes.set(app.name, { state: "running", restartCount: 0 });
      } else {
        // stopped / failed: the app is left where it was, but the REMEMBERED
        // FAILURE still goes. The real supervisor clears startErrors on every
        // successful reinstall, and a fake that kept one would let a test pass
        // while production reported a stale reason for a call that worked.
        // Rebuilt rather than mutated, so state and restartCount survive.
        runtimes.set(app.name, {
          state: prior.state,
          restartCount: prior.restartCount,
        });
      }
    },

    teardown(name: string) {
      fake.calls.push(`teardown:${name}`);
      if (fake.failTeardown) {
        throw new AppSupervisorError("supervisor_failed", fake.failTeardown);
      }
      fake.installed.delete(name);
      runtimes.delete(name);
      // The real teardown removes the token file with the unit and launcher.
      fake.tokenFiles.delete(name);
      fake.unitsInjectingToken.delete(name);
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
