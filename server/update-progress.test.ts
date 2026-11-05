// server/update-progress.ts - the progress-file reader behind the update
// screen: strict parsing, the updater's process identity and the requested
// window around a launch, all through the watcher the server runs. Reads go through an
// injected fake /proc and file system. Zero systemd, zero LLM.

import { describe, it, expect } from "bun:test";
import {
  parseProgress,
  progressPathFor,
  UpdateProgressWatcher,
  type ProgressRecord,
  type ReadText,
} from "./update-progress.ts";
import type { UpdateProgressWire } from "../shared/types.ts";

const BOOT = "0f0e0d0c-0b0a-0908-0706-050403020100";
const A1 = "a".repeat(32);
const A2 = "b".repeat(32);
const PATH = "/status/progress.json";

function rec(over: Partial<ProgressRecord> = {}): ProgressRecord {
  return {
    attempt: A1,
    phase: "build",
    result: "running",
    pid: 4242,
    pidStart: "777",
    boot: BOOT,
    ...over,
  };
}

// /proc/<pid>/stat with the given start ticks at field 22.
function procStat(pid: number, ticks: string): string {
  const rest = Array.from({ length: 30 }, (_, i) =>
    i === 18 ? ticks : String(i),
  );
  return `${pid} (bash) S ${rest.join(" ")}`;
}

// A fake file system: path -> text, or an errno code.
function fakeFs(files: Record<string, string | { code: string }>): ReadText {
  return (path) => files[path] ?? { code: "ENOENT" };
}

function liveFs(
  progress: string | null,
  pidStat: string | { code: string } | null = procStat(4242, "777"),
): Record<string, string | { code: string }> {
  const files: Record<string, string | { code: string }> = {
    "/proc/sys/kernel/random/boot_id": `${BOOT}\n`,
    "/proc/1/stat": procStat(1, "1"),
  };
  if (progress !== null) files[PATH] = progress;
  if (pidStat !== null) files["/proc/4242/stat"] = pidStat;
  return files;
}

describe("progressPathFor", () => {
  it("system kind reads the public directory, user kind its STATUS_DIR", () => {
    expect(
      progressPathFor({ state: "parsed", values: { SERVICE_KIND: "system" } }),
    ).toBe("/var/lib/isomux-update-public/progress.json");
    expect(
      progressPathFor({
        state: "parsed",
        values: { SERVICE_KIND: "user", STATUS_DIR: "/tmp/x/status" },
      }),
    ).toBe("/tmp/x/status/progress.json");
    // A container office reads the host directory mounted into it at the
    // same path, where the host's updater publishes (scripts/update.sh
    // progress_path; the mount is pinned in deploy/install-container.test.ts).
    expect(
      progressPathFor({
        state: "parsed",
        values: { DEPLOYMENT_KIND: "container", SERVICE_KIND: "system" },
      }),
    ).toBe("/run/isomux-update/progress.json");
    expect(progressPathFor({ state: "invalid" })).toBeNull();
    expect(progressPathFor({ state: "absent" })).toBeNull();
    expect(
      progressPathFor({ state: "parsed", values: { SERVICE_KIND: "user" } }),
    ).toBeNull();
  });
});

describe("parseProgress", () => {
  it("accepts exactly the updater's shape", () => {
    expect(parseProgress(JSON.stringify(rec()))).toEqual(rec());
  });

  // The times an updater since task 12dc3a75 writes. An older updater
  // writes none, and its record still parses (the exact-shape case above).
  const timed = rec({
    target: "v2026.11.5",
    started: 1_800_000_000,
    phases: [
      ["validate", 1_800_000_000],
      ["deps", 1_800_000_009],
      ["build", 1_800_000_100],
    ],
  });

  it("accepts the updater's times, and an end once finished", () => {
    expect(parseProgress(JSON.stringify(timed))).toEqual(timed);
    const ended = { ...timed, result: "ok" as const, ended: 1_800_000_240 };
    expect(parseProgress(JSON.stringify(ended))).toEqual(ended);
  });

  it("refuses a malformed time field", () => {
    const phases = timed.phases!;
    const bad: unknown[] = [
      { ...timed, target: "main" },
      { ...timed, target: "v2026.11.5; rm" },
      { ...timed, target: 2026 },
      { ...timed, started: -1 },
      { ...timed, started: 1.5 },
      { ...timed, started: "1800000000" },
      { ...timed, ended: -1 },
      { ...timed, ended: "1" },
      { ...timed, phases: "validate" },
      { ...timed, phases: [["snapshot", 1_800_000_000]] },
      { ...timed, phases: [["validate"]] },
      { ...timed, phases: [["validate", 1_800_000_000, 1]] },
      { ...timed, phases: [["validate", "1800000000"]] },
      { ...timed, phases: [["validate", 1.5]] },
      { ...timed, phases: [{ phase: "validate", at: 1_800_000_000 }] },
      // At most 64 entries.
      { ...timed, phases: Array.from({ length: 65 }, () => phases[0]) },
    ];
    for (const b of bad) {
      expect([b, parseProgress(JSON.stringify(b))]).toEqual([b, null]);
    }
    const most = {
      ...timed,
      phases: Array.from({ length: 64 }, () => phases[0]),
    };
    expect(parseProgress(JSON.stringify(most))).toEqual(most);
  });

  it("refuses anything else", () => {
    const bad: unknown[] = [
      "not json",
      "[]",
      "null",
      { ...rec(), attempt: "A".repeat(32) },
      { ...rec(), attempt: "a".repeat(31) },
      { ...rec(), phase: "snapshot" },
      { ...rec(), phase: "<b>" },
      { ...rec(), result: "requested" },
      { ...rec(), pid: 0 },
      { ...rec(), pid: "1" },
      { ...rec(), pidStart: "12a" },
      { ...rec(), boot: "x" },
    ];
    for (const b of bad) {
      expect(parseProgress(typeof b === "string" ? b : JSON.stringify(b))).toBe(
        null,
      );
    }
  });
});

describe("UpdateProgressWatcher", () => {
  function watcher(files: Record<string, string | { code: string }>) {
    const seen: (UpdateProgressWire | null)[] = [];
    const w = new UpdateProgressWatcher(
      PATH,
      (p) => seen.push(p),
      fakeFs(files),
    );
    return { w, seen };
  }
  const withTicks = (ticks: string) => procStat(4242, ticks);

  it("publishes only on change", () => {
    const files = liveFs(JSON.stringify(rec()), withTicks("777"));
    const { w, seen } = watcher(files);
    w.poll();
    w.poll();
    expect(seen).toEqual([
      { attempt: A1, phase: "build", result: "running", started: null },
    ]);
    files[PATH] = JSON.stringify(rec({ phase: "stop" }));
    w.poll();
    expect(seen.at(-1)?.phase).toBe("stop");
  });

  // Only a proven death turns a running record into failed: a read the server
  // may not make proves nothing.
  it("shows a running record as failed only when the updater is proven dead", () => {
    const running = JSON.stringify(rec());
    const rebooted = liveFs(running, withTicks("777"));
    rebooted["/proc/sys/kernel/random/boot_id"] = "f".repeat(8) + BOOT.slice(8);
    // hidepid: pid 1 is hidden as well, so absence is no evidence.
    const hidden = liveFs(running, null);
    delete hidden["/proc/1/stat"];
    const noBoot = liveFs(running, withTicks("777"));
    delete noBoot["/proc/sys/kernel/random/boot_id"];
    const cases: [string, Record<string, string | { code: string }>, string][] =
      [
        ["alive", liveFs(running, withTicks("777")), "running"],
        // Field 22 counts after the LAST ')' of the command name.
        [
          "a command name with spaces and parentheses",
          liveFs(
            running,
            "4242 (a) b (c)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 19 20",
          ),
          "running",
        ],
        ["rebooted", rebooted, "failed"],
        ["pid gone", liveFs(running, null), "failed"],
        ["pid reused", liveFs(running, withTicks("778")), "failed"],
        ["stat not readable", liveFs(running, { code: "EACCES" }), "running"],
        ["hidepid", hidden, "running"],
        ["no boot id", noBoot, "running"],
        [
          "a stat line with no command name",
          liveFs(running, "garbage"),
          "running",
        ],
      ];
    for (const [label, files, result] of cases) {
      const { w } = watcher(files);
      w.poll();
      expect([label, w.current()?.result]).toEqual([label, result]);
    }
  });

  it("checks the updater's identity even when the file did not change", () => {
    const files = liveFs(JSON.stringify(rec()), withTicks("777"));
    const { w, seen } = watcher(files);
    w.poll();
    delete files["/proc/4242/stat"];
    w.poll();
    expect(seen.at(-1)).toEqual({
      attempt: A1,
      phase: "build",
      result: "failed",
      started: null,
    });
  });

  it("an accepted launch shows requested until a new attempt appears", () => {
    const files = liveFs(
      JSON.stringify(rec({ result: "ok", phase: "finalize" })),
    );
    const { w, seen } = watcher(files);
    w.poll();
    const before = w.beforeTrigger();
    expect(before).toEqual({ priorAttempt: A1, liveAttempt: false });
    w.triggerAccepted(before);
    expect(seen.at(-1)?.result).toBe("requested");
    w.poll();
    expect(w.current()?.result).toBe("requested");
    files[PATH] = JSON.stringify(rec({ attempt: A2, phase: "validate" }));
    files["/proc/4242/stat"] = withTicks("777");
    w.poll();
    expect(w.current()).toEqual({
      attempt: A2,
      phase: "validate",
      result: "running",
      started: null,
    });
    // The requested window is over: the old attempt does not bring it back.
    files[PATH] = JSON.stringify(rec({ attempt: A2, result: "ok" }));
    w.poll();
    expect(w.current()?.result).toBe("ok");
  });

  it("an updater faster than the launch call is not mistaken for the old attempt", () => {
    const files = liveFs(null);
    const { w } = watcher(files);
    w.poll();
    const before = w.beforeTrigger();
    // The updater runs and finishes while the launch call is still out.
    files[PATH] = JSON.stringify(rec({ attempt: A2, result: "failed" }));
    w.triggerAccepted(before);
    expect(w.current()).toEqual({
      attempt: A2,
      phase: "build",
      result: "failed",
      started: null,
    });
  });

  it("a launch accepted while an attempt runs leaves the running attempt shown", () => {
    const files = liveFs(JSON.stringify(rec()), withTicks("777"));
    const { w } = watcher(files);
    w.poll();
    const before = w.beforeTrigger();
    expect(before.liveAttempt).toBe(true);
    w.triggerAccepted(before);
    expect(w.current()?.result).toBe("running");
    // The loser of the flock writes nothing; the running attempt finishes.
    files[PATH] = JSON.stringify(rec({ result: "ok", phase: "finalize" }));
    w.poll();
    expect(w.current()?.result).toBe("ok");
  });

  it("a file that goes missing or unreadable during a request keeps it requested", () => {
    const files = liveFs(
      JSON.stringify(rec({ result: "ok", phase: "finalize" })),
    );
    const { w } = watcher(files);
    w.poll();
    w.triggerAccepted(w.beforeTrigger());
    for (const gone of [{ code: "EACCES" }, { code: "ENOENT" }, "{"]) {
      files[PATH] = gone;
      w.poll();
      expect(w.current()?.result).toBe("requested");
    }
    files[PATH] = JSON.stringify(rec({ attempt: A2, phase: "validate" }));
    files["/proc/4242/stat"] = withTicks("777");
    w.poll();
    expect(w.current()?.attempt).toBe(A2);
  });

  it("sends the attempt's start in epoch ms, null from an older updater", () => {
    const files = liveFs(
      JSON.stringify(
        rec({ target: "v2026.11.5", started: 1_800_000_000, phases: [] }),
      ),
    );
    const { w } = watcher(files);
    w.poll();
    expect(w.current()).toEqual({
      attempt: A1,
      phase: "build",
      result: "running",
      started: 1_800_000_000_000,
    });
    // An older updater's finished record: no start.
    files[PATH] = JSON.stringify(
      rec({ attempt: A2, phase: "finalize", result: "ok" }),
    );
    w.poll();
    expect(w.current()?.attempt).toBe(A2);
    expect(w.current()?.started).toBeNull();
    w.triggerAccepted(w.beforeTrigger());
    // Requested: no attempt yet, so no start.
    const requested = w.current();
    expect(requested?.result).toBe("requested");
    expect(requested?.started ?? null).toBeNull();
  });

  it("an unreadable or malformed file is no record", () => {
    const files = liveFs("{");
    const { w } = watcher(files);
    w.poll();
    expect(w.current()).toBeNull();
    files[PATH] = { code: "EACCES" };
    w.poll();
    expect(w.current()).toBeNull();
  });
});

// A container office: the updater runs on the host, in another pid
// namespace, so its pid proves nothing there. Only the boot id can prove it
// dead (the host rebooted); otherwise the record stays as written.
describe("UpdateProgressWatcher in a container office", () => {
  it("only a boot change proves the host's updater dead", () => {
    const running = JSON.stringify(rec());
    const rebooted = liveFs(running, null);
    rebooted["/proc/sys/kernel/random/boot_id"] = "f".repeat(8) + BOOT.slice(8);
    const noBoot = liveFs(running, null);
    delete noBoot["/proc/sys/kernel/random/boot_id"];
    const cases: [string, Record<string, string | { code: string }>, string][] =
      [
        // The container's own pid 1 is visible; the host pid is not.
        ["pid not in this namespace", liveFs(running, null), "running"],
        [
          "another process holds the pid here",
          liveFs(running, procStat(4242, "5")),
          "running",
        ],
        ["rebooted", rebooted, "failed"],
        ["no boot id", noBoot, "running"],
      ];
    for (const [label, files, result] of cases) {
      const w = new UpdateProgressWatcher(PATH, () => {}, fakeFs(files), {
        updaterInOtherPidNamespace: true,
      });
      w.poll();
      expect([label, w.current()?.result]).toEqual([label, result]);
      // The same files on a host office: a missing or reused pid is death,
      // so the cases above test the option, not the fixture.
      const host = new UpdateProgressWatcher(PATH, () => {}, fakeFs(files));
      host.poll();
      if (label !== "no boot id") {
        expect([label, host.current()?.result]).toEqual([label, "failed"]);
      }
    }
  });
});

// Each finished attempt reaches onFinished once (the server audits it from
// there). Which attempts were audited before a restart is the audit log's
// job (server/update-checker.ts auditFinishedUpdate), not the watcher's.
describe("UpdateProgressWatcher onFinished", () => {
  const T0 = 1_800_000_000;
  const timedRec = (over: Partial<ProgressRecord> = {}) =>
    rec({
      target: "v2026.11.5",
      started: T0,
      phases: [
        ["validate", T0],
        ["build", T0 + 30],
      ],
      ...over,
    });
  function watcher(
    files: Record<string, string | { code: string }>,
    onFinished: (r: ProgressRecord) => void,
  ) {
    const seen: (UpdateProgressWire | null)[] = [];
    const w = new UpdateProgressWatcher(
      PATH,
      (p) => seen.push(p),
      fakeFs(files),
      { onFinished },
    );
    return { w, seen };
  }

  it("reports each finished attempt once, as written", () => {
    const finished: ProgressRecord[] = [];
    const files = liveFs(JSON.stringify(timedRec()));
    const { w } = watcher(files, (r) => finished.push(r));
    w.poll();
    expect(finished).toEqual([]);
    const ok = timedRec({ phase: "finalize", result: "ok", ended: T0 + 240 });
    files[PATH] = JSON.stringify(ok);
    w.poll();
    w.poll();
    expect(finished).toEqual([ok]);
    const failed = timedRec({
      attempt: A2,
      phase: "readiness",
      result: "failed",
      ended: T0 + 900,
    });
    files[PATH] = JSON.stringify(failed);
    w.poll();
    w.poll();
    expect(finished).toEqual([ok, failed]);
  });

  it("a record already finished at the first poll is reported", () => {
    // The new server's first look at the file the updater finished.
    const finished: ProgressRecord[] = [];
    const ok = timedRec({ phase: "finalize", result: "ok", ended: T0 + 240 });
    const { w } = watcher(liveFs(JSON.stringify(ok)), (r) => finished.push(r));
    w.start();
    w.stop();
    expect(finished).toEqual([ok]);
  });

  it("a running record whose updater is dead is reported as failed", () => {
    const finished: ProgressRecord[] = [];
    const files = liveFs(JSON.stringify(timedRec()));
    const { w } = watcher(files, (r) => finished.push(r));
    w.poll();
    expect(finished).toEqual([]);
    delete files["/proc/4242/stat"];
    w.poll();
    w.poll();
    // No end: the updater never wrote one.
    expect(finished).toEqual([{ ...timedRec(), result: "failed" }]);
  });

  it("an older updater's record, or one still running, is never reported", () => {
    const finished: ProgressRecord[] = [];
    const files = liveFs(JSON.stringify(timedRec()));
    const { w } = watcher(files, (r) => finished.push(r));
    w.poll();
    files[PATH] = JSON.stringify(
      rec({ attempt: A2, phase: "finalize", result: "ok" }),
    );
    w.poll();
    expect(w.current()?.result).toBe("ok");
    expect(finished).toEqual([]);
  });

  it("a throwing onFinished keeps the watcher publishing", () => {
    let calls = 0;
    const files = liveFs(JSON.stringify(timedRec()));
    const { w, seen } = watcher(files, () => {
      calls++;
      throw new Error("audit write failed");
    });
    w.poll();
    files[PATH] = JSON.stringify(
      timedRec({ phase: "finalize", result: "ok", ended: T0 + 240 }),
    );
    w.poll();
    expect(calls).toBeGreaterThan(0);
    expect(seen.at(-1)?.result).toBe("ok");
    files[PATH] = JSON.stringify(timedRec({ attempt: A2 }));
    w.poll();
    expect(seen.at(-1)?.attempt).toBe(A2);
  });
});
