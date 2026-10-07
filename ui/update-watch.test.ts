// ui/update-watch.ts: which update screen a tab shows, driven only by the
// update_status events it receives and its connection state.

import { describe, expect, it } from "bun:test";
import type {
  UpdateOutcomeWire,
  UpdateProgressWire,
  UpdateStatusWire,
} from "../shared/types.ts";
import {
  initialUpdateWatch,
  REQUESTED,
  stepOf,
  updateScreen,
  visibleScreen,
  watchOnClicked,
  watchOnLaunching,
  watchOnHide,
  watchOnStatus,
  type UpdateWatch,
} from "./update-watch.ts";
import { initialState, reducer } from "./store.tsx";
import {
  UpdateProgressWatcher,
  type ReadText,
} from "../server/update-progress.ts";

const OLD = "v2026.9.1";
const NEW = "v2026.9.8";
const A1 = "a".repeat(32);
const A2 = "b".repeat(32);

type ReleaseStatus = Extract<UpdateStatusWire, { mode: "release" }>;

function status(
  version: string,
  progress: UpdateProgressWire | null = null,
  outcome?: UpdateOutcomeWire,
): ReleaseStatus {
  return {
    mode: "release",
    updateAvailable: version !== NEW,
    current: { release: version, version },
    latest: { tag: NEW, publishedAt: null, url: null },
    securityUpdate: null,
    apply: { kind: "host" },
    progress,
    ...(outcome ? { outcome } : {}),
  };
}

const requested: UpdateProgressWire = {
  attempt: null,
  phase: null,
  result: "requested",
};
const run = (
  phase: string,
  result: UpdateProgressWire["result"] = "running",
  attempt = A1,
): UpdateProgressWire => ({ attempt, phase, result });

// Feed statuses in order; return the final watch and the last status.
function feed(
  events: (UpdateStatusWire | "launching" | "clicked")[],
  start: UpdateWatch = initialUpdateWatch,
) {
  let w = start;
  let last: UpdateStatusWire | null = null;
  for (const e of events) {
    if (e === "launching") {
      w = watchOnLaunching(w);
    } else if (e === "clicked") {
      w = watchOnClicked(w);
    } else {
      last = e;
      w = watchOnStatus(w, e);
    }
  }
  return { w, s: last };
}

describe("phases map to three steps", () => {
  it("prepare, install, and everything from the stop on is restart", () => {
    for (const p of ["validate", "fetch", "deps", "image", "assets"]) {
      expect(stepOf(p)).toBe("prepare");
    }
    for (const p of ["checkout", "install", "build"]) {
      expect(stepOf(p)).toBe("install");
    }
    for (const p of ["stop", "start", "readiness", "finalize", "publish"]) {
      expect(stepOf(p)).toBe("restart");
    }
  });
});

describe("the launching tab on an updater-managed box", () => {
  it("follows requested, each phase, the restart, and ends done", () => {
    let { w, s } = feed([status(OLD), status(OLD, requested), "clicked"]);
    expect(w.clicked).toBe(true);
    expect(updateScreen(w, s, true)).toEqual({ kind: "requested" });

    ({ w, s } = feed([status(OLD, run("validate"))], w));
    expect(w.key).toBe(A1);
    expect(updateScreen(w, s, true)).toEqual({
      kind: "running",
      step: "prepare",
    });
    ({ w, s } = feed([status(OLD, run("build"))], w));
    expect(updateScreen(w, s, true)).toEqual({
      kind: "running",
      step: "install",
    });
    ({ w, s } = feed([status(OLD, run("stop"))], w));
    // The stop drops the connection; the tab keeps the last step.
    expect(updateScreen(w, s, false)).toEqual({
      kind: "running",
      step: "restart",
    });

    // The new server is up but the updater has not confirmed it yet.
    ({ w, s } = feed([status(NEW, run("readiness"))], w));
    expect(updateScreen(w, s, true)).toEqual({
      kind: "running",
      step: "restart",
    });
    ({ w, s } = feed([status(NEW, run("finalize", "ok"))], w));
    expect(updateScreen(w, s, true)).toEqual({
      kind: "done",
      version: NEW,
      clicked: true,
      outcome: null,
    });
  });

  it("a click answered before the requested status still marks the launch", () => {
    const { w, s } = feed([
      status(OLD),
      "clicked",
      status(OLD, requested),
      status(OLD, run("fetch")),
    ]);
    expect(w).toMatchObject({ key: A1, clicked: true, clickPending: false });
    expect(updateScreen(w, s, true)).toMatchObject({ kind: "running" });
  });

  it("a rolled-back update shows the failure and the version it runs", () => {
    const { w, s } = feed([
      status(OLD),
      status(OLD, requested),
      "clicked",
      status(OLD, run("readiness")),
      status(OLD, run("readiness", "failed")),
    ]);
    expect(updateScreen(w, s, true)).toEqual({ kind: "failed", version: OLD });
  });

  it("an attempt that ends ok on the version already loaded shows nothing", () => {
    const { w, s } = feed([
      status(OLD),
      status(OLD, requested),
      status(OLD, run("validate")),
      status(OLD, run("validate", "ok")),
    ]);
    expect(updateScreen(w, s, true)).toEqual({ kind: "none" });
  });

  it("the done screen carries the installer's notes", () => {
    const note: UpdateOutcomeWire = {
      target: NEW,
      at: "2026-10-07T12:00:00Z",
      messages: ["Restored installer-managed firewall rule: 443/tcp."],
    };
    const { w, s } = feed([
      status(OLD),
      status(OLD, run("build")),
      status(NEW, run("finalize", "ok"), note),
    ]);
    expect(updateScreen(w, s, true)).toMatchObject({
      kind: "done",
      outcome: note,
    });
  });
});

describe("every other tab", () => {
  it("adopts a running attempt it did not launch, and is not the launcher", () => {
    const { w, s } = feed([
      status(OLD),
      status(OLD, run("build")),
      status(NEW, run("finalize", "ok")),
    ]);
    expect(updateScreen(w, s, true)).toMatchObject({
      kind: "done",
      clicked: false,
    });
  });

  it("a page loaded after an update never shows its outcome", () => {
    for (const result of ["ok", "failed"] as const) {
      const { w, s } = feed([status(NEW, run("finalize", result))]);
      expect(updateScreen(w, s, true)).toEqual({ kind: "none" });
    }
  });

  it("a page loaded during the readiness poll has nothing to reload", () => {
    const { w, s } = feed([
      status(NEW, run("readiness")),
      status(NEW, run("finalize", "ok")),
    ]);
    expect(updateScreen(w, s, true)).toEqual({ kind: "none" });
  });

  it("a later attempt replaces the one watched", () => {
    const { w } = feed([
      status(OLD),
      status(OLD, run("build", "failed")),
      status(OLD, run("build", "running", A2)),
    ]);
    expect(w.key).toBe(A2);
  });
});

describe("a container office (no progress reaches it)", () => {
  it("requested holds until the server restarts; a new version is done", () => {
    let { w, s } = feed([status(OLD), status(OLD, requested), "clicked"]);
    expect(updateScreen(w, s, true)).toEqual({ kind: "requested" });
    expect(updateScreen(w, s, false)).toEqual({ kind: "requested" });
    ({ w, s } = feed([status(NEW)], w));
    expect(updateScreen(w, s, true)).toEqual({
      kind: "done",
      version: NEW,
      clicked: true,
      outcome: null,
    });
  });

  it("a return on the old version is a failed update", () => {
    const { w, s } = feed([status(OLD), status(OLD, requested), status(OLD)]);
    expect(w.key).toBe(REQUESTED);
    expect(updateScreen(w, s, true)).toEqual({ kind: "failed", version: OLD });
  });
});

describe("Hide", () => {
  it("hides the busy screen and the outcome separately", () => {
    let { w, s } = feed([status(OLD), status(OLD, run("build"))]);
    const busy = updateScreen(w, s, true);
    w = watchOnHide(w, busy);
    expect(visibleScreen(w, busy)).toEqual({ kind: "none" });

    ({ w, s } = feed([status(NEW, run("finalize", "ok"))], w));
    const done = updateScreen(w, s, true);
    expect(visibleScreen(w, done)).toMatchObject({ kind: "done" });
    w = watchOnHide(w, done);
    expect(visibleScreen(w, done)).toEqual({ kind: "none" });
  });

  it("a new attempt shows again", () => {
    let { w, s } = feed([status(OLD), status(OLD, run("build"))]);
    w = watchOnHide(w, updateScreen(w, s, true));
    ({ w, s } = feed([status(OLD, run("build", "failed"))], w));
    ({ w, s } = feed([status(OLD, run("fetch", "running", A2))], w));
    expect(visibleScreen(w, updateScreen(w, s, true))).toMatchObject({
      kind: "running",
    });
  });
});

describe("the store", () => {
  it("keeps progress and the outcome from update_status, and watches", () => {
    const note: UpdateOutcomeWire = {
      target: OLD,
      at: "2026-10-07T12:00:00Z",
      messages: ["Memory-pressure protection did not converge completely."],
    };
    const next = reducer(initialState, {
      type: "update_status",
      ...status(OLD, run("build"), note),
    });
    expect(next.updateInfo).toMatchObject({
      progress: run("build"),
      outcome: note,
    });
    expect(next.updateWatch.key).toBe(A1);
    const quiet = reducer(next, { type: "update_status", ...status(OLD) });
    expect(quiet.updateInfo).not.toHaveProperty("outcome");
  });
});

// The server's progress watcher feeding a tab, as the office wires it: every
// change the watcher publishes becomes an update_status for the tab.
function wired(initial: string | null) {
  const PATH = "/status/progress.json";
  const files: Record<string, string | { code: string }> = {};
  if (initial !== null) files[PATH] = initial;
  const read: ReadText = (path) => files[path] ?? { code: "ENOENT" };
  const tabs = { a: initialUpdateWatch, b: initialUpdateWatch };
  let last: UpdateStatusWire = status(OLD);
  const server = new UpdateProgressWatcher(
    PATH,
    (p) => {
      last = status(OLD, p);
      tabs.a = watchOnStatus(tabs.a, last);
      tabs.b = watchOnStatus(tabs.b, last);
    },
    read,
  );
  server.poll();
  tabs.a = watchOnStatus(tabs.a, last);
  tabs.b = watchOnStatus(tabs.b, last);
  return {
    server,
    tabs,
    set: (v: string | { code: string } | null) => {
      if (v === null) delete files[PATH];
      else files[PATH] = v;
    },
    screen: (w: UpdateWatch) => updateScreen(w, last, true),
  };
}
const record = (attempt: string, phase: string, result: string) =>
  JSON.stringify({
    attempt,
    phase,
    result,
    pid: 4242,
    pidStart: "777",
    boot: "0f0e0d0c-0b0a-0908-0706-050403020100",
  });

describe("an updater that fails before the launch call returns", () => {
  for (const order of ["status first", "answer first"] as const) {
    it(`still shows the failure in every tab (${order})`, () => {
      const r = wired(record(A1, "finalize", "ok"));
      r.tabs.a = watchOnLaunching(r.tabs.a);
      const before = r.server.beforeTrigger();
      r.set(record(A2, "validate", "failed"));
      if (order === "answer first") r.tabs.a = watchOnClicked(r.tabs.a);
      r.server.triggerAccepted(before);
      if (order === "status first") r.tabs.a = watchOnClicked(r.tabs.a);
      for (const w of [r.tabs.a, r.tabs.b]) {
        expect(w.key).toBe(A2);
        expect(r.screen(w)).toEqual({ kind: "failed", version: OLD });
      }
      expect(r.tabs.a.clicked).toBe(true);
      expect(r.tabs.b.clicked).toBe(false);
    });
  }

  it("a launch while an old outcome shows waits for the new attempt", () => {
    // The tab still shows A1's failure when its next launch is accepted.
    let { w } = feed([status(OLD), status(OLD, run("build", "failed"))]);
    expect(w.key).toBe(A1);
    w = watchOnClicked(watchOnLaunching(w));
    expect(w).toMatchObject({ clicked: false, clickPending: true });
    ({ w } = feed([status(OLD, run("fetch", "running", A2))], w));
    expect(w).toMatchObject({ key: A2, clicked: true });
  });
});

describe("a progress file the server cannot read", () => {
  it("keeps a request waiting instead of reporting a restart", () => {
    const r = wired(record(A1, "finalize", "ok"));
    r.server.triggerAccepted(r.server.beforeTrigger());
    expect(r.screen(r.tabs.a)).toEqual({ kind: "requested" });
    for (const gone of [{ code: "EACCES" }, null, "{"]) {
      r.set(gone);
      r.server.poll();
      expect(r.screen(r.tabs.a)).toEqual({ kind: "requested" });
    }
  });

  it("keeps a running attempt on its last step", () => {
    let { w, s } = feed([status(OLD), status(OLD, run("build"))]);
    ({ w, s } = feed([status(OLD)], w));
    expect(updateScreen(w, s, true)).toEqual({
      kind: "running",
      step: "install",
    });
  });
});

describe("unknown versions", () => {
  const unknown: ReleaseStatus = {
    ...status(OLD),
    current: { release: null, version: null },
  };

  it("no progress and an unknown returned version is no result", () => {
    const { w, s } = feed([
      status(OLD),
      status(OLD, requested),
      "clicked",
      unknown,
    ]);
    expect(updateScreen(w, s, true)).toEqual({ kind: "requested" });
  });

  it("no progress and an unknown baseline is no result", () => {
    const { w, s } = feed([
      { ...unknown, progress: requested },
      "clicked",
      status(NEW),
    ]);
    expect(updateScreen(w, s, true)).toEqual({ kind: "requested" });
  });

  it("the updater's ok with an unknown version is done without a reload", () => {
    for (const [first, end] of [
      [status(OLD), { ...unknown, progress: run("finalize", "ok") }],
      [unknown, status(NEW, run("finalize", "ok"))],
    ] as const) {
      const { w, s } = feed([first, status(OLD, requested), "clicked", end]);
      expect(w.clicked).toBe(true);
      expect(updateScreen(w, s, true)).toMatchObject({
        kind: "done",
        clicked: false,
      });
    }
  });
});

describe("while disconnected", () => {
  it("a running attempt keeps its last phase; a request keeps waiting", () => {
    let { w, s } = feed([status(OLD), status(OLD, run("build"))]);
    // A lost connection is no evidence the updater reached the restart.
    expect(updateScreen(w, s, false)).toEqual({
      kind: "running",
      step: "install",
    });
    ({ w, s } = feed([status(OLD), status(OLD, requested)]));
    // The status a disconnected tab holds is the last requested one; no
    // result comes from it.
    expect(updateScreen(w, s, false)).toEqual({ kind: "requested" });
  });
});

describe("late-joining tabs", () => {
  it("a page loaded after a container restart shows nothing", () => {
    const { w, s } = feed([status(NEW)]);
    expect(updateScreen(w, s, true)).toEqual({ kind: "none" });
  });

  it("an attempt that first appears while the page is open is adopted", () => {
    const { w, s } = feed([status(OLD), status(OLD, run("fetch", "failed"))]);
    expect(updateScreen(w, s, true)).toEqual({ kind: "failed", version: OLD });
  });
});
