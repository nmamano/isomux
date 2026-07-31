// server/update-trigger.ts - plan building for the three box shapes (system /
// user / not managed) and the triggerUpdate composition with an INJECTED
// runner. NOTHING here may ever execute a real systemctl or systemd-run: plan
// tests assert argv without running it, and the one real-spawn test for
// runTrigger uses plain /bin/sh. Zero systemd, zero LLM.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildTriggerPlan,
  runTrigger,
  triggerUpdate,
} from "./update-trigger.ts";

const TAG = "v2026.7.19";

const parsed = (values: Record<string, string>) =>
  ({ state: "parsed", values }) as const;

describe("buildTriggerPlan", () => {
  it("no conf -> 409 not_managed", () => {
    const p = buildTriggerPlan({ state: "absent" }, TAG);
    expect(p).toMatchObject({ ok: false, status: 409, code: "not_managed" });
  });

  it("bad tag -> 400 before anything touches an argv", () => {
    for (const tag of [
      "main",
      "v1.0",
      "v2026.7.19; rm -rf /",
      "",
      "v2026.7.19 x",
    ]) {
      const p = buildTriggerPlan(parsed({ SERVICE_KIND: "system" }), tag);
      expect(p).toMatchObject({ ok: false, status: 400, code: "invalid_tag" });
    }
  });

  it("present-but-damaged conf -> 409 bad_conf, NOT not_managed", () => {
    const p = buildTriggerPlan({ state: "invalid" }, TAG);
    expect(p).toMatchObject({ ok: false, status: 409, code: "bad_conf" });
  });

  it("system kind -> systemctl start --no-block of the template instance", () => {
    const p = buildTriggerPlan(parsed({ SERVICE_KIND: "system" }), TAG);
    expect(p).toEqual({
      ok: true,
      via: "system",
      argv: [
        "systemctl",
        "start",
        "--no-block",
        "isomux-update@v2026.7.19.service",
      ],
    });
  });

  it("user kind -> systemd-run --user of UPDATER_PATH", () => {
    const p = buildTriggerPlan(
      parsed({
        SERVICE_KIND: "user",
        UPDATER_PATH: "/home/x/bin/isomux-update",
      }),
      TAG,
    );
    expect(p).toEqual({
      ok: true,
      via: "user",
      argv: [
        "systemd-run",
        "--user",
        "--collect",
        "--unit=isomux-update",
        "/home/x/bin/isomux-update",
        TAG,
      ],
    });
  });

  it("user kind without UPDATER_PATH -> 409 no_updater", () => {
    const p = buildTriggerPlan(parsed({ SERVICE_KIND: "user" }), TAG);
    expect(p).toMatchObject({ ok: false, status: 409, code: "no_updater" });
  });

  it("unknown SERVICE_KIND -> 409 bad_conf", () => {
    const p = buildTriggerPlan(parsed({ SERVICE_KIND: "root" }), TAG);
    expect(p).toMatchObject({ ok: false, status: 409, code: "bad_conf" });
  });
});

describe("runTrigger", () => {
  it("zero exit -> ok; non-zero exit -> stderr surfaced", async () => {
    expect(await runTrigger(["/bin/sh", "-c", "exit 0"])).toEqual({ ok: true });
    const r = await runTrigger(["/bin/sh", "-c", "echo denied >&2; exit 1"]);
    expect(r).toEqual({ ok: false, message: "denied" });
  });

  it("unspawnable binary -> ok:false, not a throw", async () => {
    const r = await runTrigger(["/nonexistent-binary-xyz"]);
    expect(r.ok).toBe(false);
  });
});

describe("triggerUpdate (conf via ISOMUX_UPDATE_CONF, runner injected)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isomux-trigger-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ISOMUX_UPDATE_CONF;
  });

  it("managed user box: plans, runs the injected runner, reports via", async () => {
    const conf = join(dir, "update.conf");
    writeFileSync(conf, "SERVICE_KIND=user\nUPDATER_PATH=/x/isomux-update\n");
    process.env.ISOMUX_UPDATE_CONF = conf;
    const calls: string[][] = [];
    const r = await triggerUpdate(TAG, async (argv) => {
      calls.push(argv);
      return { ok: true };
    });
    expect(r).toEqual({ ok: true, via: "user", tag: TAG });
    expect(calls).toEqual([
      [
        "systemd-run",
        "--user",
        "--collect",
        "--unit=isomux-update",
        "/x/isomux-update",
        TAG,
      ],
    ]);
  });

  it("runner failure -> 500 trigger_failed with the runner's message", async () => {
    const conf = join(dir, "update.conf");
    writeFileSync(conf, "SERVICE_KIND=system\n");
    process.env.ISOMUX_UPDATE_CONF = conf;
    const r = await triggerUpdate(TAG, async () => ({
      ok: false,
      message: "Interactive authentication required.",
    }));
    expect(r).toMatchObject({ ok: false, status: 500, code: "trigger_failed" });
    if (!r.ok) {
      expect(r.message).toContain("Interactive authentication required.");
    }
  });

  it("unmanaged box: refuses without ever calling the runner", async () => {
    process.env.ISOMUX_UPDATE_CONF = join(dir, "missing.conf");
    let ran = false;
    const r = await triggerUpdate(TAG, async () => {
      ran = true;
      return { ok: true };
    });
    expect(r).toMatchObject({ ok: false, status: 409, code: "not_managed" });
    expect(ran).toBe(false);
  });

  it("present-but-damaged conf: bad_conf, runner never called", async () => {
    const conf = join(dir, "update.conf");
    writeFileSync(conf, "not a key value line\n");
    process.env.ISOMUX_UPDATE_CONF = conf;
    let ran = false;
    const r = await triggerUpdate(TAG, async () => {
      ran = true;
      return { ok: true };
    });
    expect(r).toMatchObject({ ok: false, status: 409, code: "bad_conf" });
    expect(ran).toBe(false);
  });
});
