// Boot reconciliation for app URLs: make every app's unit declare the address
// the office would give it today - once, at startup.
//
// WHY THIS EXISTS. An app learns its own address from its environment, and a
// process's environment is fixed at exec. The address itself is DERIVED, from
// the office's public origin and the app's issued label, so it can change
// without anything about the app changing: an operator points a real domain at
// the office and every app suddenly has a URL; the origin moves and every URL
// moves with it; the origin goes back to plain HTTP and no app has one any
// more. Nothing in the registration path notices, because nothing was
// registered - so a pass at boot is the only place the units can catch up.
//
// WHAT IT COMPARES, AND WHAT IT DELIBERATELY DOES NOT. Only the URL
// assignment: the line the installed unit carries, against the line it would
// carry now. NOT the whole rendered unit. A byte comparison would make this
// pass the general "the unit template changed" repair, and every future edit
// to renderUnit would bounce every running app on the next boot - a much
// larger promise than this pass is making.
//
// UNLIKE THE TOKEN PASS, IT RESTARTS THINGS. It has to: a token can be picked
// up whenever the app next restarts because nothing depends on it in the
// meantime, while an app that has just become reachable at a hostname and does
// not know its own address is wrong NOW. So what was running is restarted, at
// most once each, and what was at rest is left at rest with the new file - the
// same least-surprise rule reinstall follows for an updated command.
//
// NO PERSISTED STATE, WHICH IS WHAT MAKES THE FAILURE PATH INTERESTING. The
// pass knows an app is out of date only because its unit says so, so an app
// whose unit was rewritten and whose restart then FAILED would look correct
// forever afterwards while its process still holds the old environment. That
// is why a failed restart puts the previous unit back: the drift stays
// visible, and the next boot tries again. The one state that cannot be
// repaired that way - the rollback failing too - is reported rather than
// hidden, because it is the only way this pass can go quiet while being wrong.
//
// ADVISORY, like the token pass: every failure is per-app, logged, and retried
// on the next boot. Nothing here may throw into the boot path.

import type { AppRecord } from "../shared/types.ts";
import type { AppRuntime } from "./app-supervisor.ts";
import { appUrlEnvDirective, parseUnitAppUrl } from "./app-supervisor.ts";

export interface AppUrlReconcileDeps {
  // The live app records. Throwing (a corrupt registry) aborts the pass.
  list(): AppRecord[];
  // The address this app should have right now, or null if the office has no
  // app hostnames. Derived; nothing reads it off disk.
  expectedUrl(app: AppRecord): string | null;
  // The supervisor's raw-unit seam + its file/activation verbs.
  readUnitFile(appName: string): string | null;
  restoreUnitFile(appName: string, contents: string): void;
  regenerate(app: AppRecord): void;
  states(appNames: readonly string[]): Map<string, AppRuntime>;
  restart(appName: string): void;
}

export interface AppUrlReconcileReport {
  checked: number;
  // Apps whose unit now declares the right address (or rightly declares none).
  converged: string[];
  // Of those, the ones that were running and were restarted into it. At most
  // once each: this pass has one opportunity per app and does not retry.
  restarted: string[];
  // Apps with no unit file at all. Left alone deliberately - creating or
  // starting a unit is registration's job, and the token pass ahead of this one
  // is what repairs a missing one.
  noUnit: string[];
  // Apps this pass could not bring up to date. Their unit still shows the old
  // address, which is what makes the next boot try again.
  failed: string[];
  // The one unrepairable outcome: the unit was rewritten, the restart failed,
  // and the previous unit could not be put back. The app is running on an old
  // environment behind a unit that claims otherwise, and no later boot will
  // notice.
  stuck: string[];
}

export function reconcileAppUrls(
  deps: AppUrlReconcileDeps,
): AppUrlReconcileReport {
  const report: AppUrlReconcileReport = {
    checked: 0,
    converged: [],
    restarted: [],
    noUnit: [],
    failed: [],
    stuck: [],
  };
  const apps = deps.list();
  report.checked = apps.length;

  // Pass one: who disagrees, and with what. The previous bytes are kept
  // because they are the only way back if a restart fails.
  const drifted: { app: AppRecord; previous: string }[] = [];
  for (const app of apps) {
    try {
      const previous = deps.readUnitFile(app.name);
      const installed = parseUnitAppUrl(previous);
      if (!installed.unit || previous === null) {
        report.noUnit.push(app.name);
        continue;
      }
      const url = deps.expectedUrl(app);
      // Comparing DIRECTIVES, not values, so "no assignment" is a distinct
      // answer from "assigned the empty string" - the second is drift even
      // when the expected answer is "no URL", because an app can tell an
      // absent variable from an empty one and this loop must too.
      const wanted = url === null ? null : appUrlEnvDirective(url);
      if (installed.assignment === wanted) continue;
      drifted.push({ app, previous });
    } catch (err) {
      report.failed.push(app.name);
      console.error(
        `[app-urls] "${app.name}" could not be checked against its unit:`,
        err,
      );
    }
  }
  if (drifted.length === 0) return report;

  // ONE state read for the whole set, and BEFORE anything is written: after a
  // rewrite, an app that was deliberately stopped and an app that never had a
  // unit read the same, which is the distinction the restart decision turns
  // on. A read that fails leaves every app `unknown`, and unknown never
  // restarts - "systemd could not be asked" is not "it was running".
  let before: Map<string, AppRuntime>;
  try {
    before = deps.states(drifted.map((d) => d.app.name));
  } catch (err) {
    before = new Map();
    console.error(
      "[app-urls] boot: systemd could not be asked which apps are running; units will be updated without restarting anything:",
      err,
    );
  }

  for (const { app, previous } of drifted) {
    const state = before.get(app.name)?.state ?? "unknown";
    try {
      deps.regenerate(app);
    } catch (err) {
      report.failed.push(app.name);
      console.error(
        `[app-urls] "${app.name}" unit could not be updated with its address:`,
        err,
      );
      continue;
    }
    // `starting` counts as running: it is an activation somebody asked for,
    // and leaving it alone would let it come up on the old address.
    if (state !== "running" && state !== "starting") {
      report.converged.push(app.name);
      continue;
    }
    try {
      deps.restart(app.name);
      report.converged.push(app.name);
      report.restarted.push(app.name);
    } catch (err) {
      report.failed.push(app.name);
      console.error(
        `[app-urls] "${app.name}" could not be restarted onto its address; putting its previous unit back so the next boot retries:`,
        err,
      );
      // The launcher regenerate also rewrote is byte-identical - it is derived
      // from the record's command, and no record changed here - so the unit is
      // the whole rollback. What the app's state ends up as is systemd's
      // answer to a restart that failed, and is reported as such by the
      // supervisor; this only restores what the pass itself changed.
      try {
        deps.restoreUnitFile(app.name, previous);
      } catch (restoreErr) {
        report.stuck.push(app.name);
        console.error(
          `[app-urls] "${app.name}" unit could NOT be put back: it now claims an address the running app does not have, and no later boot will notice. Restart it to fix:`,
          restoreErr,
        );
      }
    }
  }

  return report;
}
