// In-UI update trigger (release-channel, internal-docs/release-design.md →
// "Update trigger", recommendation B). Turns an owner's button click into a
// DETACHED launch of the installed updater - detached because scripts/update.sh
// restarts the isomux service, so a child of this server process would be
// killed mid-update by its own stop step.
//
// The launch shape depends on the box (SERVICE_KIND in update.conf):
//
// - system (installer-built VPS): the server runs unprivileged, the updater
//   needs root. `systemctl start --no-block isomux-update@<tag>.service` asks
//   pid1 to start the ROOT-OWNED template unit deploy/install.sh installed
//   (ExecStart=<UPDATER_PATH> %i); a polkit rule grants the service user
//   exactly that unit-name pattern with verb=start and nothing else. --no-block
//   because systemctl otherwise waits for oneshot units to finish - the whole
//   point is to return before the restart hits us. CONCURRENCY: template
//   instances for different tags are DIFFERENT units, so two triggers can
//   both be accepted (202) - update.sh's flock is the real guard, and the
//   loser fails fast into the updater's status file, not into this response.
// - user (dev-style box that still has an update.conf): same user, no
//   escalation - `systemd-run --user` runs the installed updater as a
//   transient unit under the user manager, which survives the service restart.
//   The fixed unit name makes a second trigger collide at systemd while one
//   is running (--collect garbage-collects the unit when it finishes);
//   update.sh's flock is the backstop.
// - no update.conf at all (e.g. Nil's office - the installer never ran):
//   not updater-managed; the trigger refuses and the UI never offers the
//   button (the checker isn't in release mode without the conf).
//
// The tag is validated against the same CalVer shape scripts/update.sh
// enforces, BEFORE it ever reaches an argv. Plan building is pure and fully
// unit-tested; the spawn seam is injected so no test ever executes a real
// systemctl/systemd-run.

import { CALVER_RELEASE_RE } from "./version.ts";
import {
  readUpdateConf,
  updateConfPath,
  type UpdateConfRead,
} from "./update-conf.ts";

export type TriggerPlan =
  | { ok: true; argv: string[]; via: "system" | "user" }
  | { ok: false; status: 400 | 409; code: string; message: string };

export function buildTriggerPlan(
  conf: UpdateConfRead,
  tag: string,
): TriggerPlan {
  if (conf.state === "absent") {
    return {
      ok: false,
      status: 409,
      code: "not_managed",
      message: `this box is not updater-managed (no ${updateConfPath()}); update it manually`,
    };
  }
  if (!CALVER_RELEASE_RE.test(tag)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_tag",
      message: "not a CalVer release tag (vYYYY.M.D[.N])",
    };
  }
  if (conf.state === "invalid") {
    return {
      ok: false,
      status: 409,
      code: "bad_conf",
      message:
        "update.conf is unreadable or malformed; fix it (or re-run the installer) before triggering updates",
    };
  }
  const kind = conf.values.SERVICE_KIND;
  if (kind === "system") {
    return {
      ok: true,
      via: "system",
      argv: [
        "systemctl",
        "start",
        "--no-block",
        `isomux-update@${tag}.service`,
      ],
    };
  }
  if (kind === "user") {
    const updater = conf.values.UPDATER_PATH;
    if (!updater) {
      return {
        ok: false,
        status: 409,
        code: "no_updater",
        message:
          "update.conf has no UPDATER_PATH; the in-UI trigger needs an installed updater copy",
      };
    }
    return {
      ok: true,
      via: "user",
      argv: [
        "systemd-run",
        "--user",
        "--collect",
        "--unit=isomux-update",
        updater,
        tag,
      ],
    };
  }
  return {
    ok: false,
    status: 409,
    code: "bad_conf",
    message: `update.conf SERVICE_KIND must be system or user (got: ${kind ?? "unset"})`,
  };
}

// Launch seam. The command itself only ENQUEUES the update (both shapes return
// once systemd has accepted the job), so a short timeout is generous; progress
// and outcome live in the updater's own status file / the restart the client
// experiences. Non-zero exit surfaces stderr - that's where "polkit denied"
// or "unit already running" land.
export async function runTrigger(
  argv: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
    const timeout = setTimeout(() => proc.kill(), 15_000);
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timeout);
    if (code !== 0) {
      return {
        ok: false,
        message: stderr.trim() || `${argv[0]} exited with code ${code}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// The production trigger: read the conf fresh (it can appear or change without
// a server restart), plan, launch.
export async function triggerUpdate(
  tag: string,
  run: typeof runTrigger = runTrigger,
): Promise<
  | { ok: true; via: "system" | "user"; tag: string }
  | { ok: false; status: 400 | 409 | 500; code: string; message: string }
> {
  const plan = buildTriggerPlan(readUpdateConf(), tag);
  if (!plan.ok) return plan;
  const r = await run(plan.argv);
  if (!r.ok) {
    return {
      ok: false,
      status: 500,
      code: "trigger_failed",
      message: `could not launch the update: ${r.message}`,
    };
  }
  return { ok: true, via: plan.via, tag };
}
