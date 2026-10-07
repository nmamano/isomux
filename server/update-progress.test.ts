// server/update-progress.ts - the progress-file reader behind the update
// screen: strict parsing, the updater's process identity, the wire state the
// tabs see, and the requested window around a launch. Reads go through an
// injected fake /proc and file system. Zero systemd, zero LLM.

import { describe, it, expect } from "bun:test";
import {
  parseProgress,
  progressPathFor,
  progressWire,
  startTicks,
  updaterLiveness,
  UpdateProgressWatcher,
  type ProgressRecord,
  type ReadText,
} from "./update-progress.ts";
import { withProgress, computeReleaseStatus } from "./update-checker.ts";
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

describe("startTicks", () => {
  it("counts fields after the last parenthesis of the command name", () => {
    const line =
      "4242 (a) b (c)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 19 20";
    expect(startTicks(line)).toBe("777");
    expect(startTicks("garbage")).toBeNull();
  });
});

describe("updaterLiveness", () => {
  const withTicks = (ticks: string) => procStat(4242, ticks);

  it("alive when pid, start ticks and boot all match", () => {
    expect(
      updaterLiveness(rec(), fakeFs(liveFs(null, withTicks("777")))),
    ).toBe("alive");
  });

  it("dead when the box rebooted, the pid is gone, or the pid was reused", () => {
    const rebooted = liveFs(null, withTicks("777"));
    rebooted["/proc/sys/kernel/random/boot_id"] = "f".repeat(8) + BOOT.slice(8);
    expect(updaterLiveness(rec(), fakeFs(rebooted))).toBe("dead");
    expect(updaterLiveness(rec(), fakeFs(liveFs(null, null)))).toBe("dead");
    expect(
      updaterLiveness(rec(), fakeFs(liveFs(null, withTicks("778")))),
    ).toBe("dead");
  });

  it("a read it may not make proves nothing", () => {
    expect(
      updaterLiveness(rec(), fakeFs(liveFs(null, { code: "EACCES" }))),
    ).toBe("unknown");
    // hidepid: pid 1 is hidden as well, so absence is no evidence.
    const hidden = liveFs(null, null);
    delete hidden["/proc/1/stat"];
    expect(updaterLiveness(rec(), fakeFs(hidden))).toBe("unknown");
    const noBoot = liveFs(null, withTicks("777"));
    delete noBoot["/proc/sys/kernel/random/boot_id"];
    expect(updaterLiveness(rec(), fakeFs(noBoot))).toBe("unknown");
  });
});

describe("progressWire", () => {
  it("passes phase and result through, with no process fields", () => {
    expect(progressWire(rec(), "alive", null)).toEqual({
      attempt: A1,
      phase: "build",
      result: "running",
    });
  });

  it("a dead updater's running record reads as failed", () => {
    expect(progressWire(rec(), "dead", null)?.result).toBe("failed");
    expect(progressWire(rec(), "unknown", null)?.result).toBe("running");
  });

  it("requested holds while the file names the attempt from before", () => {
    const requested = { priorAttempt: A1 };
    expect(progressWire(rec({ result: "ok" }), "unknown", requested)).toEqual({
      attempt: null,
      phase: null,
      result: "requested",
    });
    expect(
      progressWire(rec({ attempt: A2, phase: "validate" }), "alive", requested),
    ).toEqual({ attempt: A2, phase: "validate", result: "running" });
    expect(progressWire(null, "unknown", { priorAttempt: null })?.result).toBe(
      "requested",
    );
    // No record names no new attempt.
    expect(progressWire(null, "unknown", requested)?.result).toBe("requested");
  });

  it("no record is no progress", () => {
    expect(progressWire(null, "unknown", null)).toBeNull();
  });
});

describe("UpdateProgressWatcher", () => {
  function watcher(files: Record<string, string | { code: string }>) {
    const seen: (UpdateProgressWire | null)[] = [];
    const w = new UpdateProgressWatcher(PATH, (p) => seen.push(p), fakeFs(files));
    return { w, seen };
  }
  const withTicks = (ticks: string) => procStat(4242, ticks);

  it("publishes only on change", () => {
    const files = liveFs(JSON.stringify(rec()), withTicks("777"));
    const { w, seen } = watcher(files);
    w.poll();
    w.poll();
    expect(seen).toEqual([{ attempt: A1, phase: "build", result: "running" }]);
    files[PATH] = JSON.stringify(rec({ phase: "stop" }));
    w.poll();
    expect(seen.at(-1)?.phase).toBe("stop");
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
    });
  });

  it("an accepted launch shows requested until a new attempt appears", () => {
    const files = liveFs(JSON.stringify(rec({ result: "ok", phase: "finalize" })));
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
    const files = liveFs(JSON.stringify(rec({ result: "ok", phase: "finalize" })));
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

describe("withProgress", () => {
  it("a release check result keeps the current progress", () => {
    const p: UpdateProgressWire = {
      attempt: A1,
      phase: "build",
      result: "running",
    };
    const fresh = computeReleaseStatus(
      { release: "v2026.7.19", version: "v2026.7.19" },
      { tag: "v2026.7.20", publishedAt: null, url: null },
    );
    expect(withProgress(fresh, p)).toMatchObject({ progress: p });
    expect(
      withProgress(
        {
          mode: "commit",
          updateAvailable: false,
          current: { release: null, sha: "x" },
          latest: null,
          releaseStanding: "unknown",
          mainAhead: 0,
        },
        p,
      ),
    ).not.toHaveProperty("progress");
  });
});
