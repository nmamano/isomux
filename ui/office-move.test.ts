// The Settings "Move office" logic (task 78733adf, slice 2c-2): what each
// move-in status shows, when the owner may lock or finish, and when each card
// polls again. The properties:
// - the old office's preflight comes from another release: every part is
//   read on its own, a part that does not parse is unknown, and nothing
//   throws;
// - Lock only when the old office's unit restarts always (its lock refuses
//   otherwise);
// - Finish on a staged copy, or an incomplete one only with the box ticked;
// - the move-in card polls only while a job runs, keeps polling through the
//   restart's errors up to a cap, and reloads on a locked answer;
// - the move-out card keeps polling through the lock and its restart, and
//   reloads on a locked answer.
import { describe, expect, it } from "bun:test";
import {
  MOVE_IN_POLL_MS,
  MOVE_IN_RESTART_CAP_MS,
  MOVE_LIST_MAX,
  MOVE_OUT_POLL_MS,
  finishAllowed,
  listHead,
  lockAllowed,
  moveInPollDecision,
  moveOutPollDecision,
  phaseView,
  preflightView,
} from "./office-move.ts";
import type {
  MoveInPhase,
  MoveInReport,
  MoveInStatus,
  MoveStageCheck,
  OfficeMoveRes,
} from "../shared/office-move.ts";

const OLD = "https://old.example.com";
const BOX = {
  release: "v2026.11.1",
  commit: "a".repeat(40),
  homePath: "/home/isomux",
  stateRoot: "/home/isomux/.isomux",
};

/** A status in one of the phases from preflight on. */
function inPhase(
  phase: MoveInPhase,
  over: Partial<Extract<MoveInStatus, { phase: MoveInPhase }>> = {},
): MoveInStatus {
  return {
    phase,
    oldOrigin: OLD,
    office: BOX,
    oldOfficeLocked: false,
    ...over,
  } as MoveInStatus;
}

const RESULT: MoveStageCheck = {
  complete: true,
  files: 1200,
  bytes: 5_000_000,
  missing: [],
  changed: [],
};

const REPORT: MoveInReport = {
  oldOrigin: OLD,
  office: BOX,
  finishedAt: 1_790_000_000_000,
  by: { kind: "member", id: "u1", name: "Nil" },
  excluded: [{ unit: "claude", entries: 3, bytes: 900 }],
  secretCount: 2,
  missing: [],
  swappedAt: 1_790_000_060_000,
  ownerRenamedTo: null,
  oldOfficeUnitSetAside: null,
  aside: { entries: [".bashrc"], bytes: 4096 },
  units: { restored: [], failed: [] },
  audited: true,
};

/** A preflight as the old office's release answers it. */
function preflight(over: Record<string, unknown> = {}) {
  return {
    finishedAt: 1_790_000_000_000,
    turnsInFlight: [{ agentId: "a1", name: "Scout", roomName: "Lab" }],
    units: [
      {
        name: "tunnel.service",
        fragmentPath: "/home/isomux/.config/systemd/user/tunnel.service",
        unitFileState: "enabled",
        activeState: "active",
        transient: false,
      },
    ],
    restart: { unit: "isomux.service", manager: "user", restart: "always" },
    hostRefs: [
      {
        app: "blog",
        paths: ["apps/blog/.env"],
        truncated: false,
        timedOut: false,
      },
    ],
    sizes: {
      entries: [
        { name: "nil", bytes: 1_000, timedOut: false },
        { name: ".isomux", bytes: 500, timedOut: false },
      ],
      total: 1_500,
    },
    sudoPackages: { packages: ["ffmpeg"] },
    ...over,
  };
}

describe("preflightView", () => {
  it("reads a whole preflight into its known shapes", () => {
    const v = preflightView(preflight());
    expect(v.finishedAt).toBe(1_790_000_000_000);
    expect(v.turnsInFlight).toEqual({
      kind: "list",
      agents: [{ agentId: "a1", name: "Scout", roomName: "Lab" }],
    });
    expect(v.units.kind).toBe("list");
    expect(
      v.units.kind === "list" ? v.units.units.map((u) => u.name) : null,
    ).toEqual(["tunnel.service"]);
    expect(v.restart).toEqual({
      kind: "set",
      unit: "isomux.service",
      manager: "user",
      restart: "always",
    });
    expect(v.hostRefs.kind).toBe("list");
    expect(
      v.hostRefs.kind === "list" ? v.hostRefs.apps.map((a) => a.paths) : null,
    ).toEqual([["apps/blog/.env"]]);
    expect(v.sizes).toEqual({ kind: "total", bytes: 1_500, partial: false });
    expect(v.sudoPackages).toEqual({ kind: "list", packages: ["ffmpeg"] });
  });

  it("never throws: an empty object, a non-object and a wrong-typed part give unknown parts", () => {
    const allUnknown = {
      turnsInFlight: "unknown",
      units: "unknown",
      restart: "unknown",
      hostRefs: "unknown",
      sizes: "unknown",
      sudoPackages: "unknown",
    } as const;
    const kinds = (
      raw: unknown,
    ): { finishedAt: number | null; kinds: Record<string, string> } => {
      const v = preflightView(raw);
      return {
        finishedAt: v.finishedAt,
        kinds: {
          turnsInFlight: v.turnsInFlight.kind,
          units: v.units.kind,
          restart: v.restart.kind,
          hostRefs: v.hostRefs.kind,
          sizes: v.sizes.kind,
          sudoPackages: v.sudoPackages.kind,
        },
      };
    };
    for (const raw of [{}, null, undefined, "x", 7, [], [preflight()]])
      expect(kinds(raw)).toEqual({ finishedAt: null, kinds: allUnknown });
    expect(
      kinds({
        finishedAt: "yesterday",
        turnsInFlight: "x",
        units: 5,
        restart: { unit: 1 },
        hostRefs: { app: "blog" },
        sizes: { total: "9", entries: [] },
        sudoPackages: { packages: "ffmpeg" },
      }),
    ).toEqual({ finishedAt: null, kinds: allUnknown });
  });

  it("reads each part on its own: one broken part leaves the others known", () => {
    const parts = [
      "turnsInFlight",
      "units",
      "restart",
      "hostRefs",
      "sizes",
      "sudoPackages",
    ] as const;
    for (const broken of parts) {
      const v = preflightView(preflight({ [broken]: { nonsense: true } }));
      const known = parts.filter((p) => v[p].kind !== "unknown");
      expect({ broken, known }).toEqual({
        broken,
        known: parts.filter((p) => p !== broken),
      });
    }
  });

  it("a turn list with one bad item is unknown: no agent with a turn is dropped silently", () => {
    const v = preflightView(
      preflight({
        turnsInFlight: [
          { agentId: "a1", name: "Scout", roomName: null },
          { agentId: 5 },
        ],
      }),
    );
    expect(v.turnsInFlight.kind).toBe("unknown");
  });

  it("units the old office could not list: timed out, or an error with its text", () => {
    expect(
      preflightView(preflight({ units: { timedOut: true } })).units,
    ).toEqual({ kind: "timedOut" });
    expect(
      preflightView(preflight({ units: { error: "systemctl: no bus" } })).units,
    ).toEqual({ kind: "error", error: "systemctl: no bus" });
  });

  it("restart null is none: the old office runs under no service manager the move knows", () => {
    expect(preflightView(preflight({ restart: null })).restart).toEqual({
      kind: "none",
    });
  });

  it("a size that timed out or has no bytes makes the total a lower bound", () => {
    const sizes = (entries: unknown[], total: number) =>
      preflightView(preflight({ sizes: { entries, total } })).sizes;
    expect(
      sizes(
        [
          { name: "nil", bytes: 1_000, timedOut: false },
          { name: "big", bytes: null, timedOut: true },
        ],
        1_000,
      ),
    ).toEqual({ kind: "total", bytes: 1_000, partial: true });
    expect(
      sizes(
        [
          { name: "nil", bytes: 1_000, timedOut: false },
          { name: "odd", bytes: null, timedOut: false },
        ],
        1_000,
      ),
    ).toEqual({ kind: "total", bytes: 1_000, partial: true });
  });

  it("sudo packages the old office could not read are unknown", () => {
    expect(
      preflightView(preflight({ sudoPackages: { unknown: true } })).sudoPackages
        .kind,
    ).toBe("unknown");
  });
});

describe("lockAllowed", () => {
  it("only when the old office's unit has Restart=always", () => {
    const allowed = (restart: unknown) =>
      lockAllowed(preflightView(preflight({ restart })));
    expect({
      always: allowed({
        unit: "isomux.service",
        manager: "user",
        restart: "always",
      }),
      onFailure: allowed({
        unit: "isomux.service",
        manager: "user",
        restart: "on-failure",
      }),
      systemAlways: allowed({
        unit: "isomux.service",
        manager: "system",
        restart: "always",
      }),
      none: allowed(null),
      unknown: allowed("always"),
    }).toEqual({
      always: true,
      onFailure: false,
      systemAlways: true,
      none: false,
      unknown: false,
    });
  });
});

describe("phaseView", () => {
  it("none: the start form, with the blocker the server gives", () => {
    const blocker = {
      code: "office_not_fresh",
      message: "not new",
      extra: { reasons: [{ kind: "apps", count: 2 }] },
    };
    expect(phaseView({ phase: "none", blocker: null })).toEqual({
      kind: "start",
      blocker: null,
    });
    expect(phaseView({ phase: "none", blocker })).toEqual({
      kind: "start",
      blocker,
    });
  });

  it("the steps before the copy are working views with their step", () => {
    expect(phaseView({ phase: "pairing", oldOrigin: OLD })).toMatchObject({
      kind: "working",
      step: "pairing",
      oldOrigin: OLD,
      oldOfficeLocked: false,
    });
    for (const step of [
      "preflight",
      "locking",
      "waiting",
      "manifest",
    ] as const) {
      expect(
        phaseView(inPhase(step, { oldOfficeLocked: step !== "preflight" })),
      ).toMatchObject({
        kind: "working",
        step,
        oldOrigin: OLD,
        oldOfficeLocked: step !== "preflight",
      });
    }
  });

  it("confirm: the preflight read through the guard, the id the lock sends, and Lock gated on Restart=always", () => {
    const always = phaseView(
      inPhase("confirm", { preflightId: "pf-1", preflight: preflight() }),
    );
    expect(always).toMatchObject({
      kind: "confirm",
      preflightId: "pf-1",
      lockAllowed: true,
      oldOfficeLocked: false,
    });
    expect(
      always.kind === "confirm" ? always.preflight.restart.kind : null,
    ).toBe("set");
    const onFailure = phaseView(
      inPhase("confirm", {
        preflightId: "pf-2",
        preflight: preflight({
          restart: {
            unit: "isomux.service",
            manager: "user",
            restart: "on-failure",
          },
        }),
      }),
    );
    expect(onFailure).toMatchObject({ kind: "confirm", lockAllowed: false });
    const empty = phaseView(
      inPhase("confirm", { preflightId: "pf-3", preflight: {} }),
    );
    expect(empty).toMatchObject({ kind: "confirm", lockAllowed: false });
  });

  it("pulling and checking: the copy view, with the fraction by bytes", () => {
    const progress = {
      entries: 100,
      totalBytes: 4_000,
      filesDone: 10,
      bytesDone: 1_000,
      batchesDone: 1,
      batchesTotal: 4,
      retries: 2,
    };
    expect(
      phaseView(inPhase("pulling", { progress, oldOfficeLocked: true })),
    ).toEqual({
      kind: "copying",
      checking: false,
      oldOrigin: OLD,
      progress,
      fraction: 0.25,
      oldOfficeLocked: true,
    });
    expect(
      phaseView(inPhase("checking", { progress, oldOfficeLocked: true })),
    ).toMatchObject({ kind: "copying", checking: true, fraction: 0.25 });
    expect(
      phaseView(inPhase("pulling", { oldOfficeLocked: true })),
    ).toMatchObject({ kind: "copying", progress: null, fraction: null });
  });

  it("staged and incomplete: the check's result and a finish error when there is one", () => {
    const error = { code: "done_failed", message: "no answer" };
    expect(
      phaseView(inPhase("staged", { result: RESULT, oldOfficeLocked: true })),
    ).toEqual({
      kind: "staged",
      oldOrigin: OLD,
      result: RESULT,
      error: null,
      oldOfficeLocked: true,
    });
    const missing = {
      ...RESULT,
      complete: false,
      missing: [{ path: "nil/a.txt", reason: "unreadable" }],
    };
    expect(
      phaseView(
        inPhase("incomplete", {
          result: missing,
          error,
          oldOfficeLocked: true,
        }),
      ),
    ).toEqual({
      kind: "incomplete",
      oldOrigin: OLD,
      result: missing,
      error,
      oldOfficeLocked: true,
    });
  });

  it("failed: the error and whether the pull may run again", () => {
    const error = { code: "batch_failed", message: "a part failed" };
    expect(
      phaseView(
        inPhase("failed", { error, retryable: true, oldOfficeLocked: true }),
      ),
    ).toEqual({
      kind: "failed",
      oldOrigin: OLD,
      error,
      retryable: true,
      oldOfficeLocked: true,
    });
    expect(
      phaseView(inPhase("failed", { error, retryable: false })),
    ).toMatchObject({ kind: "failed", retryable: false });
  });

  it("finishing and swapping: the restart view", () => {
    for (const phase of ["finishing", "swapping"] as const)
      expect(phaseView(inPhase(phase, { oldOfficeLocked: true }))).toEqual({
        kind: "restarting",
        oldOrigin: OLD,
      });
  });

  it("moved: the report and the aside folder's path", () => {
    expect(
      phaseView({
        phase: "moved",
        oldOrigin: OLD,
        office: BOX,
        report: REPORT,
        asidePath: "/home/isomux/.isomux-move-in/aside",
      }),
    ).toEqual({
      kind: "report",
      oldOrigin: OLD,
      report: REPORT,
      asidePath: "/home/isomux/.isomux-move-in/aside",
    });
  });
});

describe("finishAllowed", () => {
  it("a staged copy always; an incomplete one only with the box ticked; nothing else", () => {
    const staged = phaseView(inPhase("staged", { result: RESULT }));
    const stagedAfterError = phaseView(
      inPhase("staged", {
        result: RESULT,
        error: { code: "done_failed", message: "lost" },
      }),
    );
    const incomplete = phaseView(
      inPhase("incomplete", { result: { ...RESULT, complete: false } }),
    );
    const others = [
      phaseView({ phase: "none", blocker: null }),
      phaseView(inPhase("confirm", { preflightId: "p", preflight: {} })),
      phaseView(inPhase("pulling")),
      phaseView(
        inPhase("failed", {
          error: { code: "x", message: "x" },
          retryable: true,
        }),
      ),
      phaseView(inPhase("swapping")),
    ];
    expect({
      staged: [finishAllowed(staged, false), finishAllowed(staged, true)],
      stagedAfterError: finishAllowed(stagedAfterError, false),
      incomplete: [
        finishAllowed(incomplete, false),
        finishAllowed(incomplete, true),
      ],
      others: others.map((v) => finishAllowed(v, true)),
    }).toEqual({
      staged: [true, true],
      stagedAfterError: true,
      incomplete: [false, true],
      others: others.map(() => false),
    });
  });
});

describe("moveInPollDecision", () => {
  const quiet = { restartingSince: null, now: 1_000_000 };
  const status = (s: MoveInStatus) => ({ kind: "status" as const, status: s });

  it("polls every MOVE_IN_POLL_MS while a job runs, and stops in every phase that waits for the owner or is done", () => {
    const jobs: MoveInStatus[] = [
      { phase: "pairing", oldOrigin: OLD },
      ...(
        [
          "preflight",
          "locking",
          "waiting",
          "manifest",
          "pulling",
          "checking",
          "finishing",
          "swapping",
        ] as const
      ).map((p) => inPhase(p)),
    ];
    const waits: MoveInStatus[] = [
      { phase: "none", blocker: null },
      inPhase("confirm", { preflightId: "p", preflight: {} }),
      inPhase("staged", { result: RESULT }),
      inPhase("incomplete", { result: RESULT }),
      inPhase("failed", { error: { code: "x", message: "x" } }),
      {
        phase: "moved",
        oldOrigin: OLD,
        office: BOX,
        report: REPORT,
        asidePath: "/a",
      },
    ];
    for (const s of jobs)
      expect({
        phase: s.phase,
        d: moveInPollDecision(status(s), quiet),
      }).toEqual({ phase: s.phase, d: { kind: "wait", ms: MOVE_IN_POLL_MS } });
    for (const s of waits)
      expect({
        phase: s.phase,
        d: moveInPollDecision(status(s), quiet),
      }).toEqual({ phase: s.phase, d: { kind: "stop" } });
  });

  it("keeps polling through the restart's errors until the cap, then gives up", () => {
    const since = 5_000_000;
    const err = { kind: "error" as const, error: new Error("fetch failed") };
    expect(
      moveInPollDecision(err, {
        restartingSince: since,
        now: since + MOVE_IN_RESTART_CAP_MS - 1,
      }),
    ).toEqual({ kind: "wait", ms: MOVE_IN_POLL_MS });
    expect(
      moveInPollDecision(err, {
        restartingSince: since,
        now: since + MOVE_IN_RESTART_CAP_MS,
      }),
    ).toEqual({ kind: "lost" });
    // The report after the restart stops the poll, however long it took.
    expect(
      moveInPollDecision(
        status({
          phase: "moved",
          oldOrigin: OLD,
          office: BOX,
          report: REPORT,
          asidePath: "/a",
        }),
        { restartingSince: since, now: since + MOVE_IN_RESTART_CAP_MS * 2 },
      ),
    ).toEqual({ kind: "stop" });
  });

  it("an error outside a restart does not stop the poll", () => {
    expect(
      moveInPollDecision({ kind: "error", error: new Error("x") }, quiet),
    ).toEqual({ kind: "wait", ms: MOVE_IN_POLL_MS });
  });

  it("a locked answer reloads the page, in a restart or not", () => {
    expect(moveInPollDecision({ kind: "locked" }, quiet)).toEqual({
      kind: "reload",
    });
    expect(
      moveInPollDecision(
        { kind: "locked" },
        { restartingSince: 1, now: 1 + MOVE_IN_RESTART_CAP_MS * 2 },
      ),
    ).toEqual({ kind: "reload" });
  });
});

describe("moveOutPollDecision", () => {
  const status = (s: OfficeMoveRes) => ({ kind: "status" as const, status: s });

  it("polls every MOVE_OUT_POLL_MS while a code waits, a pairing runs or the lock is on its way; stops with no move", () => {
    const decide = (state: OfficeMoveRes["state"]) =>
      moveOutPollDecision(status({ state }));
    expect({
      none: decide("none"),
      code: decide("code"),
      paired: decide("paired"),
      // Locked, not restarted yet: the next poll gets the MOVE page.
      move: decide("move"),
    }).toEqual({
      none: { kind: "stop" },
      code: { kind: "wait", ms: MOVE_OUT_POLL_MS },
      paired: { kind: "wait", ms: MOVE_OUT_POLL_MS },
      move: { kind: "wait", ms: MOVE_OUT_POLL_MS },
    });
  });

  it("an error (the restart into the MOVE server) keeps polling; a locked answer reloads", () => {
    expect(
      moveOutPollDecision({ kind: "error", error: new Error("refused") }),
    ).toEqual({ kind: "wait", ms: MOVE_OUT_POLL_MS });
    expect(moveOutPollDecision({ kind: "locked" })).toEqual({
      kind: "reload",
    });
  });
});

describe("listHead", () => {
  it("the first MOVE_LIST_MAX items in order, and how many more", () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
    expect(listHead([])).toEqual({ shown: [], more: 0 });
    expect(listHead(items(MOVE_LIST_MAX))).toEqual({
      shown: items(MOVE_LIST_MAX),
      more: 0,
    });
    const head = listHead(items(MOVE_LIST_MAX + 7));
    expect(head.shown).toEqual(items(MOVE_LIST_MAX));
    expect(head.more).toBe(7);
  });
});
