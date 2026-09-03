// Boot reconciliation for app tokens: make the token store, the apps'
// environment files, and the units that read them agree - once, at startup.
//
// WHY THIS EXISTS AT ALL. An app's token is a PAIR - a hash in the store and a
// plaintext in the file the app's unit reads - and isomux can only ever write
// the plaintext once, because it does not keep it. Anything that leaves the two
// halves disagreeing therefore cannot be repaired in flight; it has to be
// noticed and rotated. Several ways to get there, all real:
//   - an app registered before app tokens existed: no hash, no file, and a unit
//     with no reference to one;
//   - a registration whose hash was written and whose file was not (or the
//     reverse), from a crash or a full disk between the two;
//   - a file edited, truncated or deleted by hand.
//
// FOUR FACTS, CHECKED INDEPENDENTLY. A hash, a plaintext, a unit file that
// actually injects it, and systemd having READ that file. The last one is
// separate on purpose: the user systemd manager outlives isomux, so a unit
// written by a previous run whose daemon-reload never completed sits on disk
// looking perfect while systemd knows nothing about it. One reload at the top
// of the pass is what makes the on-disk fact a loaded fact - it changes no
// file, starts nothing, and costs one subprocess on a boot that has apps.
//
// A hash, a plaintext, and a unit that actually injects it. The pair being healthy says nothing about the third:
// registration provisions the token BEFORE it installs the unit (a process's
// environment is fixed at exec), and an install that fails afterwards is
// deliberately allowed to keep the token - which leaves a perfectly good pair
// behind a unit that injects nothing. Skipping on a healthy pair alone would
// make that state permanent, since nothing else ever looks again.
//
// WHEN IT RESTARTS. A running app whose token is re-minted must restart because
// its process still holds the rejected token and app:message is its only
// capability. Healthy and merely rewired apps are not bounced; stopped apps
// take the new token on their next start. Runtime state is captured before the
// pass changes anything. A false negative in the pair check would otherwise
// cause a silent re-mint and restart on every boot, so the healthy-pair test is
// also the guard against repeated user-visible disruption.
//
// BEST EFFORT, NOT ATOMIC. Two files and a store cannot be written as one
// transaction, so the cleanup after a half-finished provisioning is best effort
// too: revoke the hash, drop the stale plaintext, and let the next boot repair
// whatever that could not. What this guarantees is not "never half-provisioned"
// but "never SILENTLY half-provisioned": every state left behind is one this
// pass recognises and retries.
//
// The pass is ADVISORY: every failure is per-app and logged. An incomplete
// token pair is retried on the next boot; a restart failure leaves a valid new
// pair for the app's next start. Nothing here may throw into the boot path.

import type { AppRecord } from "../shared/types.ts";
import type { AppRuntime } from "./app-supervisor.ts";
import type { AppTokenStore } from "./app-tokens.ts";

export interface AppTokenReconcileDeps {
  // The live app records. Throwing (a corrupt registry) aborts the pass.
  list(): AppRecord[];
  tokens: AppTokenStore;
  // The supervisor's token verbs + its no-activation file regeneration.
  readToken(appName: string): string | null;
  removeToken(appName: string): void;
  // daemon-reload: no writes, no activation. See the header's fourth fact.
  reloadUnits(): void;
  unitInjectsToken(appName: string): boolean;
  provisionToken(appName: string, raw: string): void;
  regenerate(app: AppRecord): void;
  states(appNames: readonly string[]): Map<string, AppRuntime>;
  restart(appName: string): void;
}

export interface AppTokenReconcileReport {
  checked: number;
  // Whether systemd was asked to re-read its unit files (skipped when the
  // office has no apps, so an office that never registered one never touches
  // systemd at boot).
  reloaded: boolean;
  // Apps that were given a token by this pass (minted + written).
  provisioned: string[];
  // Apps whose token was fine but whose unit did not reference it: files
  // regenerated, token left alone.
  rewired: string[];
  // Running apps restarted after this pass gave them a new token.
  restarted: string[];
  // Restart failures do not mean token provisioning failed. The app keeps its
  // fresh token files and can recover on a later manual or systemd restart.
  restartFailed: string[];
  // Hashes dropped because no app answers to that name any more.
  pruned: string[];
  // Apps this pass could not fix. They are left with no token rather than half
  // of one, and the next boot tries again.
  failed: string[];
}

export function reconcileAppTokens(
  deps: AppTokenReconcileDeps,
): AppTokenReconcileReport {
  const report: AppTokenReconcileReport = {
    checked: 0,
    reloaded: false,
    provisioned: [],
    rewired: [],
    restarted: [],
    restartFailed: [],
    pruned: [],
    failed: [],
  };
  const apps = deps.list();
  report.checked = apps.length;

  let before: Map<string, AppRuntime>;
  try {
    before = deps.states(apps.map((app) => app.name));
  } catch (err) {
    before = new Map();
    console.error(
      "[app-tokens] boot: systemd could not be asked which apps are running; tokens will be repaired without restarting anything:",
      err,
    );
  }

  // Before anything is inspected: whatever is on disk is what systemd should be
  // holding. A failure here is not fatal to the pass - the per-app work below
  // is still worth doing, and the next boot tries again - but it IS the reason
  // an app could look wired and not be running, so it is never silent.
  if (apps.length > 0) {
    try {
      deps.reloadUnits();
      report.reloaded = true;
    } catch (err) {
      console.error(
        "[app-tokens] boot: systemd would not reload its unit files:",
        err,
      );
    }
  }

  for (const app of apps) {
    // The pair check is an INTEGRITY check, not a presence check: the plaintext
    // the app is actually handed is hashed and compared to the stored hash. Two
    // halves that both exist and disagree is exactly the state a presence check
    // would call healthy and an app would experience as a token that never
    // works.
    const current = deps.readToken(app.name);
    const paired = current !== null && deps.tokens.matches(app.name, current);
    const wired = deps.unitInjectsToken(app.name);
    if (paired && wired) continue;

    try {
      if (!wired) {
        // The unit does not read this app's token file - it was written before
        // tokens existed, or never written at all. Files first, and always
        // before minting: a token written for a unit that cannot reference it
        // would leave a healthy-looking pair that injects nothing, which is the
        // one state this pass could not tell from success.
        //
        // For an app whose install never wrote a unit this CREATES one, not
        // enabled and not started. That is deliberate and it is the honest
        // outcome of the same rule: the generated files converge on the record,
        // activation is nobody's business but the user's.
        deps.regenerate(app);
        if (paired) {
          report.rewired.push(app.name);
          continue; // the token itself was fine - do not rotate what works
        }
      }
      provision(deps, app);
      report.provisioned.push(app.name);
      const state = before.get(app.name)?.state ?? "unknown";
      if (state === "running" || state === "starting") {
        try {
          deps.restart(app.name);
          report.restarted.push(app.name);
        } catch (err) {
          report.restartFailed.push(app.name);
          console.error(
            `[app-tokens] "${app.name}" received a new token but could not be restarted to use it:`,
            err,
          );
        }
      }
    } catch (err) {
      report.failed.push(app.name);
      console.error(
        `[app-tokens] "${app.name}" could not be given a token at boot:`,
        err,
      );
    }
  }

  // Hashes whose app is gone. Delete revokes, so this is the leftovers of a
  // delete that failed midway - a credential for a name that will never be
  // issued again.
  const live = new Set(apps.map((a) => a.name));
  for (const name of deps.tokens.names()) {
    if (live.has(name)) continue;
    try {
      deps.tokens.revoke(name);
      report.pruned.push(name);
    } catch (err) {
      console.error(`[app-tokens] stale token for "${name}" not removed:`, err);
    }
  }

  return report;
}

// Mint and deliver, or leave the app honestly tokenless.
//
// The failure to get right here is the one that cannot be repaired: a hash
// whose plaintext was lost. isomux cannot reproduce a token it does not keep,
// so an app holding one could never authenticate - and on the next boot the
// hash would make the pair look repairable when the only fix is a rotation the
// app cannot receive. So a failed delivery takes the hash back, and drops any
// older plaintext with it: an app with no token is a state this pass fixes,
// while an app with a plaintext that matches no hash is a credential nobody
// recognises sitting in a file.
function provision(deps: AppTokenReconcileDeps, app: AppRecord): void {
  const fresh = deps.tokens.mint(app.name, app.userId);
  try {
    deps.provisionToken(app.name, fresh);
  } catch (err) {
    // Both halves of the cleanup are best effort - each can fail for the same
    // reason the write did - and each failure is reported rather than hidden.
    // Whatever survives is a state the next boot recognises and retries.
    try {
      deps.tokens.revoke(app.name);
    } catch (revokeErr) {
      console.error(
        `[app-tokens] "${app.name}" hash could not be revoked after a failed delivery:`,
        revokeErr,
      );
    }
    try {
      deps.removeToken(app.name);
    } catch (removeErr) {
      console.error(
        `[app-tokens] "${app.name}" stale token file could not be removed:`,
        removeErr,
      );
    }
    throw err;
  }
}
