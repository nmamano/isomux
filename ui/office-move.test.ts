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
//   reloads on a locked answer;
// - the live pass (slice 4): the confirm view carries it, Copy again only
//   after a pass that ended, the copied bytes count what an earlier pass
//   kept, and the confirm card polls while the pass runs.
// - the folders outside the home (slice 5b-2): the card lists the server's
//   checks (the list the lock checks and the pass moves) with the
//   preflight's sizes; Lock waits and the card polls while one cannot land,
//   in confirm and after a pass failed for it.
import { describe, expect, it } from "bun:test";
import {
  MOVE_IN_POLL_MS,
  MOVE_IN_RESTART_CAP_MS,
  MOVE_LIST_MAX,
  MOVE_OUT_POLL_MS,
  copiedBytes,
  copyFraction,
  finishAllowed,
  LEFT_BEHIND_ORDER,
  leftBehindLines,
  listHead,
  lockAllowed,
  memberLines,
  membersBlocked,
  moveInPollDecision,
  moveOutPollDecision,
  outsideBlocked,
  outsideLines,
  phaseView,
  preflightView,
} from "./office-move.ts";
import type {
  MoveInFolderCheck,
  MoveInLive,
  MoveInLivePhase,
  MoveInMemberHere,
  MoveInPhase,
  MoveInProgress,
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
      outside: [],
      members: [],
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

// Slice 3: members with their own OS user stay on the old box until slice 5,
// so the old office's lock refuses while any member has one.
describe("preflightView memberOsUsers and the lock", () => {
  const read = (memberOsUsers: unknown) =>
    preflightView(
      memberOsUsers === undefined ? preflight() : preflight({ memberOsUsers }),
    ).memberOsUsers;

  it("reads none, the names, broken, or unknown for an old office without the part or with another shape", () => {
    expect({
      none: read({ names: [] }),
      list: read({ names: ["Mia", "Sam"] }),
      broken: read({ broken: true }),
      absent: read(undefined),
      wrongNames: read({ names: "Mia" }),
      badItem: read({ names: ["Mia", 5] }),
      other: read("yes"),
    }).toEqual({
      none: { kind: "none" },
      list: { kind: "list", names: ["Mia", "Sam"], members: null },
      broken: { kind: "broken" },
      absent: { kind: "unknown" },
      wrongNames: { kind: "unknown" },
      badItem: { kind: "unknown" },
      other: { kind: "unknown" },
    });
  });

  it("Lock waits while a member has their own OS user or the record does not read; an old office that does not say (unknown) does not block it", () => {
    const allowed = (memberOsUsers: unknown) =>
      lockAllowed(
        preflightView(
          memberOsUsers === undefined
            ? preflight()
            : preflight({ memberOsUsers }),
        ),
      );
    expect({
      none: allowed({ names: [] }),
      list: allowed({ names: ["Mia"] }),
      broken: allowed({ broken: true }),
      unknown: allowed(undefined),
    }).toEqual({ none: true, list: false, broken: false, unknown: true });
    // Restart= still gates on its own.
    expect(
      lockAllowed(
        preflightView(
          preflight({
            memberOsUsers: { names: [] },
            restart: {
              unit: "isomux.service",
              manager: "user",
              restart: "on-failure",
            },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      phaseView(
        inPhase("confirm", {
          preflightId: "p",
          preflight: preflight({ memberOsUsers: { names: ["Mia"] } }),
        }),
      ),
    ).toMatchObject({ kind: "confirm", lockAllowed: false });
  });
});

// Slice 3: the report's "left behind" list, from the old office's excluded
// units, so an old office of an older release still reports what it left.
describe("leftBehindLines", () => {
  const unit = (u: string, entries = 1) => ({ unit: u, entries, bytes: 10 });
  const named = LEFT_BEHIND_ORDER.filter((o) => o.kind !== null);

  it("one line per named unit with entries, in LEFT_BEHIND_ORDER, whatever the order received; app-sessions and empty units give none", () => {
    const excluded = [...LEFT_BEHIND_ORDER]
      .reverse()
      .map((o) => unit(o.unit, 2));
    expect(
      leftBehindLines({ excluded, secretCount: 0 }).map((l): string => l.kind),
    ).toEqual(named.map((o) => o.kind as string));
    expect(
      leftBehindLines({
        excluded: [unit("app-sessions", 5), unit("invites", 0)],
        secretCount: 0,
      }),
    ).toEqual([]);
  });

  it("a unit this release does not name (an older old office) comes after the named ones, in the order received, with its count", () => {
    expect(
      leftBehindLines({
        excluded: [
          unit("ssh", 3),
          unit("browser-sessions", 2),
          unit("claude-login", 1),
          unit("personal-environment", 0),
        ],
        secretCount: 0,
      }),
    ).toEqual([
      { kind: "signIn" },
      { kind: "unit", unit: "ssh", entries: 3 },
      { kind: "unit", unit: "claude-login", entries: 1 },
    ]);
  });

  it("secrets to set again, last, only when the old office left the secret store out and had secrets; the store itself gives no unit line", () => {
    const lines = (
      excluded: { unit: string; entries: number; bytes: number }[],
      secretCount: number,
    ) => leftBehindLines({ excluded, secretCount });
    expect({
      leftOut: lines([unit("secret-store", 4), unit("invites", 1)], 3),
      leftOutNoSecrets: lines([unit("secret-store", 4)], 0),
      moved: lines([unit("invites", 1)], 3),
    }).toEqual({
      leftOut: [{ kind: "invites" }, { kind: "secrets", count: 3 }],
      leftOutNoSecrets: [],
      moved: [{ kind: "invites" }],
    });
  });
});

describe("the live pass (slice 4)", () => {
  const LIVE_PHASES: MoveInLivePhase[] = [
    "manifest",
    "copying",
    "ready",
    "stopped",
    "failed",
    "unsupported",
  ];
  const progress = (over: Partial<MoveInProgress> = {}): MoveInProgress => ({
    entries: 100,
    totalBytes: 8_000,
    filesDone: 10,
    bytesDone: 1_000,
    batchesDone: 1,
    batchesTotal: 4,
    retries: 0,
    ...over,
  });
  const confirmWith = (live?: MoveInLive) =>
    phaseView(
      inPhase("confirm", {
        preflightId: "pf-1",
        preflight: preflight(),
        ...(live ? { live } : {}),
      }),
    );
  const liveOf = (v: ReturnType<typeof phaseView>) =>
    v.kind === "confirm" ? v.live : "not confirm";

  it("copiedBytes: the bytes fetched in this pass plus the bytes kept from the last one", () => {
    expect({
      none: copiedBytes(progress()),
      zero: copiedBytes(progress({ filesKept: 0, bytesKept: 0 })),
      kept: copiedBytes(progress({ filesKept: 40, bytesKept: 3_000 })),
    }).toEqual({ none: 1_000, zero: 1_000, kept: 4_000 });
  });

  it("copyFraction: the copied bytes over the total, at most 1, null when the total is not known", () => {
    expect({
      plain: copyFraction(progress()),
      kept: copyFraction(progress({ bytesKept: 3_000 })),
      over: copyFraction(progress({ bytesDone: 6_000, bytesKept: 3_000 })),
      noTotal: copyFraction(progress({ totalBytes: 0, bytesDone: 0 })),
      noTotalKept: copyFraction(progress({ totalBytes: 0, bytesKept: 5 })),
    }).toEqual({
      plain: 0.125,
      kept: 0.5,
      over: 1,
      noTotal: null,
      noTotalKept: null,
    });
  });

  it("the confirm view carries the live pass as the status gives it, with its fraction; null when the status has none", () => {
    expect(liveOf(confirmWith())).toBeNull();
    const p = progress({ filesKept: 40, bytesKept: 3_000 });
    expect(
      liveOf(confirmWith({ phase: "copying", startedAt: 1, progress: p })),
    ).toEqual({
      phase: "copying",
      finishedAt: null,
      error: null,
      progress: p,
      fraction: 0.5,
      copyAgain: false,
    });
    const error = { code: "batch_failed", message: "a part failed" };
    expect(
      liveOf(
        confirmWith({ phase: "failed", startedAt: 1, finishedAt: 9, error }),
      ),
    ).toEqual({
      phase: "failed",
      finishedAt: 9,
      error,
      progress: null,
      fraction: null,
      copyAgain: true,
    });
    // The rest of the confirm view does not change with the live pass.
    expect(
      confirmWith({ phase: "copying", startedAt: 1, progress: p }),
    ).toMatchObject({
      kind: "confirm",
      preflightId: "pf-1",
      lockAllowed: true,
      oldOfficeLocked: false,
    });
  });

  it("Copy again only after a pass that ended: ready, stopped, failed", () => {
    const copyAgain = Object.fromEntries(
      LIVE_PHASES.map((phase) => {
        const live = liveOf(confirmWith({ phase, startedAt: 1 }));
        return [phase, live && live !== "not confirm" ? live.copyAgain : live];
      }),
    );
    expect(copyAgain).toEqual({
      manifest: false,
      copying: false,
      ready: true,
      stopped: true,
      failed: true,
      unsupported: false,
    });
  });

  it("the final pass's copy view counts the kept bytes in its fraction", () => {
    const p = progress({ filesKept: 40, bytesKept: 3_000 });
    expect(
      phaseView(inPhase("pulling", { progress: p, oldOfficeLocked: true })),
    ).toMatchObject({ kind: "copying", progress: p, fraction: 0.5 });
    expect(
      phaseView(
        inPhase("pulling", {
          progress: progress({ bytesDone: 6_000, bytesKept: 3_000 }),
          oldOfficeLocked: true,
        }),
      ),
    ).toMatchObject({ kind: "copying", fraction: 1 });
  });

  it("the confirm card polls while the live pass lists or copies, and stops on every other live phase and with no live pass", () => {
    const quiet = { restartingSince: null, now: 1_000_000 };
    const decisions = Object.fromEntries(
      LIVE_PHASES.map((phase) => [
        phase,
        moveInPollDecision(
          {
            kind: "status",
            status: inPhase("confirm", {
              preflightId: "p",
              preflight: {},
              live: { phase, startedAt: 1 },
            }),
          },
          quiet,
        ),
      ]),
    );
    const wait = { kind: "wait" as const, ms: MOVE_IN_POLL_MS };
    const stop = { kind: "stop" as const };
    expect(decisions).toEqual({
      manifest: wait,
      copying: wait,
      ready: stop,
      stopped: stop,
      failed: stop,
      unsupported: stop,
    });
    expect(
      moveInPollDecision(
        {
          kind: "status",
          status: inPhase("confirm", { preflightId: "p", preflight: {} }),
        },
        quiet,
      ),
    ).toEqual(stop);
  });
});

describe("folders outside the home (slice 5b-2)", () => {
  const P = "/srv/data";
  const Q = "/opt/tools";
  const R = "/var/lib/extra";
  /** The old office's outsideFolders part, as its release answers it. */
  const outsideFolders = {
    move: [
      { path: P, mode: 0o750, bytes: 2_000, timedOut: false },
      { path: Q, mode: 0o755, bytes: null, timedOut: true },
    ],
    left: [
      { path: "/tmp/scratch", reason: "temp" },
      { path: "/home/other/x", reason: "owner" },
    ],
  };
  const ok = (path: string, create: string[] = []): MoveInFolderCheck => ({
    path,
    ok: true,
    create,
  });
  const blocked = (path: string): MoveInFolderCheck => ({
    path,
    ok: false,
    reason: "not_empty",
    at: path,
    command: `rm -rf -- ${path}/*`,
  });
  const confirmWith = (checks: MoveInFolderCheck[] | undefined, pf = {}) =>
    inPhase("confirm", {
      preflightId: "pf-1",
      preflight: preflight({ outsideFolders, ...pf }),
      ...(checks ? { outsideChecks: checks } : {}),
    });
  const failedWith = (code: string, checks?: MoveInFolderCheck[]) =>
    inPhase("failed", {
      error: { code, message: "m" },
      retryable: true,
      oldOfficeLocked: true,
      ...(checks ? { outsideChecks: checks } : {}),
    });

  it("preflightView reads the part: the folders that move with their size, and the folders left with their reason", () => {
    expect(preflightView(preflight({ outsideFolders })).outside).toEqual({
      kind: "list",
      move: [
        { path: P, bytes: 2_000, timedOut: false },
        { path: Q, bytes: null, timedOut: true },
      ],
      left: outsideFolders.left,
    });
    // Empty lists are known, not unknown.
    expect(
      preflightView(preflight({ outsideFolders: { move: [], left: [] } }))
        .outside,
    ).toEqual({ kind: "list", move: [], left: [] });
  });

  it("an old office without the part is unknown; so is a part with a bad item (known whole or not at all); the other parts stay known", () => {
    expect(preflightView(preflight()).outside.kind).toBe("unknown");
    const bad = [
      "x",
      { move: "x", left: [] },
      { move: [], left: null },
      { move: [{ path: 7, bytes: 1, timedOut: false }], left: [] },
      { move: [{ path: P, bytes: "1", timedOut: false }], left: [] },
      { move: [], left: [{ path: P }] },
      { move: [], left: [{ reason: "temp" }] },
    ];
    for (const outside of bad) {
      const v = preflightView(preflight({ outsideFolders: outside }));
      expect({ outside, kind: v.outside.kind, sizes: v.sizes.kind }).toEqual({
        outside,
        kind: "unknown",
        sizes: "total",
      });
    }
  });

  it("a left reason this release does not name keeps the folder, with its reason string", () => {
    const v = preflightView(
      preflight({
        outsideFolders: {
          move: [],
          left: [
            { path: "/mnt/quota", reason: "quota" },
            { path: "/tmp/t", reason: "temp" },
          ],
        },
      }),
    );
    expect(v.outside).toEqual({
      kind: "list",
      move: [],
      left: [
        { path: "/mnt/quota", reason: "quota" },
        { path: "/tmp/t", reason: "temp" },
      ],
    });
  });

  it("outsideLines: one line per check in the checks' order, the size joined by path; a check with no preflight match, or no preflight, has no size", () => {
    const pf = preflightView(preflight({ outsideFolders }));
    // The checks' order, not the preflight's; R has no preflight entry.
    const checks = [ok(Q), blocked(R), ok(P, [P])];
    expect(outsideLines(pf, checks)).toEqual([
      { path: Q, bytes: null, timedOut: true, check: checks[0] },
      { path: R, bytes: null, timedOut: false, check: checks[1] },
      { path: P, bytes: 2_000, timedOut: false, check: checks[2] },
    ]);
    // A preflight folder with no check gives no line: the server does not
    // move it.
    expect(outsideLines(pf, [ok(P)]).map((l) => l.path)).toEqual([P]);
    expect(outsideLines(pf, undefined)).toEqual([]);
    expect(outsideLines(null, [ok(P)])).toEqual([
      { path: P, bytes: null, timedOut: false, check: ok(P) },
    ]);
    const unknownPf = preflightView(preflight());
    expect(outsideLines(unknownPf, [ok(P)])).toEqual([
      { path: P, bytes: null, timedOut: false, check: ok(P) },
    ]);
  });

  it("outsideBlocked: any line whose check is not ok; none or no lines is not blocked", () => {
    const line = (c: MoveInFolderCheck) => ({
      path: c.path,
      bytes: 1,
      timedOut: false,
      check: c,
    });
    expect(outsideBlocked([])).toBe(false);
    expect(outsideBlocked([line(ok(P)), line(ok(Q, [Q]))])).toBe(false);
    expect(outsideBlocked([line(ok(P)), line(blocked(Q))])).toBe(true);
    expect(outsideBlocked([line(blocked(P)), line(ok(Q))])).toBe(true);
  });

  it("confirm: the lines from the status's checks, and Lock waits while one is blocked; with Restart=always and no checks, Lock is allowed", () => {
    const clear = phaseView(confirmWith([ok(P), ok(Q)]));
    expect(clear).toMatchObject({ kind: "confirm", lockAllowed: true });
    expect(
      clear.kind === "confirm" ? clear.outside.map((l) => l.bytes) : null,
    ).toEqual([2_000, null]);
    const one = phaseView(confirmWith([ok(P), blocked(Q)]));
    expect(one).toMatchObject({ kind: "confirm", lockAllowed: false });
    expect(
      one.kind === "confirm" ? one.outside.map((l) => l.check.ok) : null,
    ).toEqual([true, false]);
    // An old office before 5b: no part, no checks.
    const old = phaseView(
      inPhase("confirm", { preflightId: "pf-1", preflight: preflight() }),
    );
    expect(old).toMatchObject({
      kind: "confirm",
      lockAllowed: true,
      outside: [],
    });
    // Blocked folders do not unlock a Lock the restart policy holds.
    const off = phaseView(
      confirmWith([ok(P)], {
        restart: {
          unit: "isomux.service",
          manager: "user",
          restart: "on-failure",
        },
      }),
    );
    expect(off).toMatchObject({ kind: "confirm", lockAllowed: false });
  });

  it("failed: the lines from the status's checks with no size; none when the status carries none", () => {
    const f = phaseView(failedWith("outside_folders_blocked", [blocked(P)]));
    expect(f).toMatchObject({ kind: "failed", retryable: true });
    expect(
      f.kind === "failed"
        ? f.outside.map((l) => [l.path, l.bytes, l.check.ok])
        : null,
    ).toEqual([[P, null, false]]);
    expect(phaseView(failedWith("batch_failed"))).toMatchObject({
      kind: "failed",
      outside: [],
    });
  });

  it("the poll: confirm waits while a folder is blocked and stops when all can land; failed with outside_folders_blocked the same; another failure stops", () => {
    const quiet = { restartingSince: null, now: 1_000_000 };
    const d = (s: MoveInStatus) =>
      moveInPollDecision({ kind: "status", status: s }, quiet);
    const wait = { kind: "wait" as const, ms: MOVE_IN_POLL_MS };
    const stop = { kind: "stop" as const };
    expect({
      confirmBlocked: d(confirmWith([ok(P), blocked(Q)])),
      confirmClear: d(confirmWith([ok(P), ok(Q)])),
      confirmNone: d(confirmWith(undefined)),
      failedBlocked: d(failedWith("outside_folders_blocked", [blocked(P)])),
      failedClear: d(failedWith("outside_folders_blocked", [ok(P)])),
      failedOther: d(failedWith("batch_failed")),
    }).toEqual({
      confirmBlocked: wait,
      confirmClear: stop,
      confirmNone: stop,
      failedBlocked: wait,
      failedClear: stop,
      failedOther: stop,
    });
  });
});

// Slice 5c-3 (task 78733adf): the members with their own OS user. Their
// homes move when the old office lists each of them with no block (5c-1+)
// and this office's check has each of them, and only them, with no block.
// The card's rule is never looser than the server's lock (C1).
describe("members with their own OS user (slice 5c-3)", () => {
  const mia = {
    userId: "u-mia",
    name: "Mia",
    osUser: "isomux-mia",
    home: "/home/isomux-mia",
    block: null,
    units: [],
  };
  const sam = {
    userId: "u-sam",
    name: "Sam",
    osUser: "isomux-sam",
    home: "/home/isomux-sam",
    block: null,
    units: [],
  };
  const here = (
    m: { userId: string; name: string; osUser: string; home: string },
    block: MoveInMemberHere["block"] = null,
  ): MoveInMemberHere => ({
    userId: m.userId,
    name: m.name,
    osUser: m.osUser,
    oldHome: m.home,
    home: m.home,
    block,
  });
  const pfWith = (members: unknown[], pf: Record<string, unknown> = {}) =>
    preflightView(
      preflight({
        memberOsUsers: {
          names: members.map((m) => (m as { name: string }).name),
          members,
        },
        ...pf,
      }),
    );
  const confirmWith = (
    members: unknown[],
    checks: MoveInMemberHere[] | undefined,
    pf: Record<string, unknown> = {},
  ) =>
    inPhase("confirm", {
      preflightId: "pf-1",
      preflight: preflight({
        memberOsUsers: {
          names: members.map((m) => (m as { name: string }).name),
          members,
        },
        ...pf,
      }),
      ...(checks ? { membersHere: checks } : {}),
    });

  it("preflightView keeps each member with her block as sent, an unknown code too, and her detail as data", () => {
    const read = pfWith([
      mia,
      { ...sam, block: "a_code_from_a_later_release", detail: "text" },
    ]).memberOsUsers;
    expect(read.kind).toBe("list");
    if (read.kind !== "list") return;
    expect(read.members).toEqual([
      {
        userId: "u-mia",
        name: "Mia",
        osUser: "isomux-mia",
        home: "/home/isomux-mia",
        block: null,
        detail: null,
      },
      {
        userId: "u-sam",
        name: "Sam",
        osUser: "isomux-sam",
        home: "/home/isomux-sam",
        block: "a_code_from_a_later_release",
        detail: "text",
      },
    ]);
    // An older release sends names only.
    const old = preflightView(
      preflight({ memberOsUsers: { names: ["Mia"] } }),
    ).memberOsUsers;
    expect(old).toEqual({ kind: "list", names: ["Mia"], members: null });
  });

  it("memberLines: one per preflight member in its order, this office's check joined by id; a check for a member the preflight does not list is a line too", () => {
    const pf = pfWith([sam, mia]);
    const stranger = { ...mia, userId: "u-x", name: "X", osUser: "isomux-x" };
    const lines = memberLines(pf, [here(mia), here(stranger)]);
    expect(lines.map((l) => [l.userId, l.here?.userId ?? null])).toEqual([
      ["u-sam", null],
      ["u-mia", "u-mia"],
      ["u-x", "u-x"],
    ]);
    expect(lines[1]).toMatchObject({
      name: "Mia",
      osUser: "isomux-mia",
      oldHome: "/home/isomux-mia",
      oldBlock: null,
    });
    // With no preflight (a failure), one line per check, no old block.
    const failed = memberLines(null, [here(mia, "name_taken")]);
    expect(failed.map((l) => [l.userId, l.oldBlock, l.here?.block])).toEqual([
      ["u-mia", null, "name_taken"],
    ]);
    expect(memberLines(null, undefined)).toEqual([]);
  });

  it("membersBlocked: an old block, a block here, or no check here; none or all clear is not blocked", () => {
    const pf = pfWith([mia, sam]);
    expect(membersBlocked([])).toBe(false);
    expect(membersBlocked(memberLines(pf, [here(mia), here(sam)]))).toBe(false);
    expect(membersBlocked(memberLines(pf, [here(mia)]))).toBe(true);
    expect(
      membersBlocked(memberLines(pf, [here(mia), here(sam, "home_exists")])),
    ).toBe(true);
    expect(
      membersBlocked(
        memberLines(pfWith([mia, { ...sam, block: "busy" }]), [
          here(mia),
          here(sam),
        ]),
      ),
    ).toBe(true);
  });

  it("lockAllowed: only every listed member clear on both offices, and only them; an older release, a block, a missing or an extra check refuse", () => {
    const pf = pfWith([mia, sam]);
    expect(lockAllowed(pf, [here(mia), here(sam)])).toBe(true);
    // The order of the checks does not matter.
    expect(lockAllowed(pf, [here(sam), here(mia)])).toBe(true);
    expect(lockAllowed(pf, [here(mia)])).toBe(false);
    expect(lockAllowed(pf, undefined)).toBe(false);
    expect(lockAllowed(pf, [here(mia), here(sam, "other_home")])).toBe(false);
    expect(
      lockAllowed(pf, [
        here(mia),
        here(sam),
        here({ ...mia, userId: "u-x", name: "X", osUser: "isomux-x" }),
      ]),
    ).toBe(false);
    expect(
      lockAllowed(pfWith([mia, { ...sam, block: "runner_down" }]), [
        here(mia),
        here(sam),
      ]),
    ).toBe(false);
    // An older release: names, no members.
    expect(
      lockAllowed(
        preflightView(preflight({ memberOsUsers: { names: ["Mia"] } })),
        [here(mia)],
      ),
    ).toBe(false);
    // No member: as before, with or without checks.
    expect(
      lockAllowed(preflightView(preflight({ memberOsUsers: { names: [] } }))),
    ).toBe(true);
    // Restart= still gates on its own, with every member clear.
    expect(
      lockAllowed(
        pfWith([mia], {
          restart: {
            unit: "isomux.service",
            manager: "user",
            restart: "on-failure",
          },
        }),
        [here(mia)],
      ),
    ).toBe(false);
  });

  it("phaseView confirm: the member lines from the preflight and the status's checks, and Lock follows lockAllowed", () => {
    const clear = phaseView(confirmWith([mia], [here(mia)]));
    expect(clear).toMatchObject({ kind: "confirm", lockAllowed: true });
    expect(
      clear.kind === "confirm" ? clear.members.map((l) => l.userId) : null,
    ).toEqual(["u-mia"]);
    const blocked = phaseView(confirmWith([mia], [here(mia, "name_taken")]));
    expect(blocked).toMatchObject({ kind: "confirm", lockAllowed: false });
    expect(
      blocked.kind === "confirm" ? blocked.members[0].here?.block : null,
    ).toBe("name_taken");
  });

  it("phaseView failed: the lines of a member_homes_blocked failure from the status's checks; none for another failure", () => {
    const failed = (code: string) =>
      phaseView(
        inPhase("failed", {
          error: { code, message: "m" },
          retryable: true,
          oldOfficeLocked: true,
          membersHere: [here(mia, "home_exists"), here(sam)],
        }),
      );
    const v = failed("member_homes_blocked");
    expect(
      v.kind === "failed"
        ? v.members.map((l) => [l.userId, l.here?.block ?? null])
        : null,
    ).toEqual([
      ["u-mia", "home_exists"],
      ["u-sam", null],
    ]);
    const other = failed("no_space");
    expect(other.kind === "failed" ? other.members.length : -1).toBe(0);
  });

  it("moveInPollDecision polls in confirm while a member is blocked, and after a member_homes_blocked failure while a check here still blocks", () => {
    const quiet = { restartingSince: null, now: 1_000_000 };
    const decide = (s: MoveInStatus) =>
      moveInPollDecision({ kind: "status", status: s }, quiet).kind;
    expect(decide(confirmWith([mia], [here(mia, "name_taken")]))).toBe("wait");
    expect(decide(confirmWith([mia], [here(mia)]))).toBe("stop");
    const failed = (checks: MoveInMemberHere[]) =>
      inPhase("failed", {
        error: { code: "member_homes_blocked", message: "m" },
        retryable: true,
        oldOfficeLocked: true,
        membersHere: checks,
      });
    expect(decide(failed([here(mia, "home_exists")]))).toBe("wait");
    expect(decide(failed([here(mia)]))).toBe("stop");
  });
});
