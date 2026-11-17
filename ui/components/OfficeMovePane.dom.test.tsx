// Settings > Housekeeping > Move office (task 78733adf, slice 2c-2). The pane has a
// move-out card (this office to another machine) and a move-in card (an
// office to this machine). The properties:
// - card order: the move-in card is first on a new office and whenever a
//   move-in runs or is done; the move-out card first otherwise;
// - the move code shows once, right after the mint, and is kept nowhere;
// - a poll that a locked office answers reloads the page (the old office
//   after its lock, a failed swap on the new one); a plain error does not;
// - start sends the trimmed code; Lock sends the preflight id it shows, and
//   is disabled when the old office's unit does not restart always;
// - a cancel asks first, and says the old office stays locked when it does
//   (the status before, the DELETE answer after);
// - the delete of the aside folder shows the folder and its entries first,
//   and runs on the second click;
// - Finish asks first, and on an incomplete copy needs the box ticked;
// - through the restart the pane keeps polling with no error, shows the
//   report when it comes, and says so when the office does not come back;
// - the live pass (slice 4): the confirm card shows it by phase, Copy again
//   only after a pass that ended, and Lock stays usable while it copies; the
//   final copy counts what the live pass kept; a lock error goes away when a
//   new check comes; the move-out card says when the new machine started
//   copying.
// - the folders outside the home (slice 5b-2): the confirm card lists each
//   with its check, a blocked one with its reason and root command, and the
//   folders left; Lock waits and the card polls while one is blocked, also
//   after a lock refused for it and on a pass failed for it; the size counts
//   them; the report lists what moved and what stayed.
// - the members with their own OS user (slice 5c-3): the confirm card lists
//   each with the office that blocks her and why (this office's English
//   detail never shows); Lock waits and the card polls while one is
//   blocked; a pass failed for them shows them; the report lists each enable
//   command.
//
// Controls are found by data-testid (copy is not asserted).
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  spyOn,
} from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { asData, sentenceValues } from "../test-support/data-values.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const heldShape = await import("../test-support/held-shape.ts");
const { setApiShim, ApiError } = await import("../api.ts");
const browser = await import("../reload-browser.ts");
const { OfficeMovePane } = await import("./OfficeMovePane.tsx");
const {
  MOVE_IN_POLL_MS,
  MOVE_OUT_POLL_MS,
  MOVE_IN_RESTART_CAP_MS,
  MOVE_LIST_MAX,
} = await import("../office-move.ts");
const { absoluteTime } = await import("../../shared/i18n/time.ts");
const { formatBytes } = await import("../../shared/i18n/number.ts");
import type {
  MoveInFolderCheck,
  MoveInMemberHere,
  MoveInLive,
  MoveInLivePhase,
  MoveInProgress,
  MintMoveCodeRes,
  MoveInCancelRes,
  MoveInPhase,
  MoveInReport,
  MoveInStatus,
  MoveStageCheck,
  OfficeMoveRes,
} from "../../shared/office-move.ts";

const OLD = "https://old.example.com";
const BOX = {
  release: "v2026.11.1",
  commit: "a".repeat(40),
  homePath: "/home/isomux",
  stateRoot: "/home/isomux/.isomux",
};
const NOT_FRESH = {
  code: "office_not_fresh",
  message: "not new",
  extra: { reasons: [{ kind: "apps", count: 2 }] },
};
const RESULT: MoveStageCheck = {
  complete: true,
  files: 1200,
  bytes: 5_000_000,
  missing: [],
  changed: [],
};
const ASIDE = "/home/isomux/.isomux-move-in/aside";

function inPhase(
  phase: MoveInPhase,
  over: Record<string, unknown> = {},
): MoveInStatus {
  return {
    phase,
    oldOrigin: OLD,
    office: BOX,
    oldOfficeLocked: false,
    ...over,
  } as MoveInStatus;
}

function preflight(restart: string | null = "always") {
  return {
    finishedAt: Date.now(),
    turnsInFlight: [],
    units: [],
    restart:
      restart === null
        ? null
        : { unit: "isomux.service", manager: "user", restart },
    hostRefs: [],
    sizes: {
      entries: [{ name: "nil", bytes: 10, timedOut: false }],
      total: 10,
    },
    sudoPackages: { packages: [] },
  };
}

function moved(entries: string[]): MoveInStatus {
  const report: MoveInReport = {
    oldOrigin: OLD,
    office: BOX,
    finishedAt: 1_790_000_000_000,
    by: { kind: "member", id: "u1", name: "Morgan" },
    excluded: [],
    secretCount: 0,
    missing: [],
    swappedAt: 1_790_000_060_000,
    ownerRenamedTo: null,
    oldOfficeUnitSetAside: null,
    aside: { entries, bytes: 4096 },
    units: { restored: [], failed: [] },
    audited: true,
  };
  return {
    phase: "moved",
    oldOrigin: OLD,
    office: BOX,
    report,
    asidePath: ASIDE,
  };
}

// What the next GETs answer: the head of each queue, the last one repeats.
type Answer<T> = T | { fail: "plain" | "locked" };
let outAnswers: Answer<OfficeMoveRes>[] = [];
let inAnswers: Answer<MoveInStatus>[] = [];
let outReads = 0;
let inReads = 0;
let writes: { method: string; path: string; body: unknown }[] = [];
// The answer of the next write, by "METHOD path".
let writeAnswers: Record<string, unknown> = {};

function next<T>(queue: Answer<T>[]): T {
  const a = queue.length > 1 ? queue.shift()! : queue[0];
  if (a === undefined) throw new Error("no answer queued");
  if (typeof a === "object" && a !== null && "fail" in a) {
    if (a.fail === "locked")
      throw new ApiError(
        503,
        "http_503",
        "Service Unavailable",
        undefined,
        true,
      );
    throw new TypeError("Failed to fetch");
  }
  return a as T;
}

let reload: ReturnType<typeof spyOn<typeof browser, "reloadBrowser">> | null =
  null;
beforeEach(() => {
  // A loaded move-in card saves its layout for the next visit (task
  // 69c5f413): each case starts on a device that never loaded it.
  window.localStorage.clear();
  outAnswers = [{ state: "none" }];
  inAnswers = [{ phase: "none", blocker: NOT_FRESH }];
  outReads = 0;
  inReads = 0;
  writes = [];
  writeAnswers = {};
  reload = spyOn(browser, "reloadBrowser").mockImplementation(() => {});
  setApiShim(async (method, path, body) => {
    if (method === "GET" && path === "/api/office/move") {
      outReads++;
      return next(outAnswers);
    }
    if (method === "GET" && path === "/api/office/move-in") {
      inReads++;
      return next(inAnswers);
    }
    writes.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in writeAnswers)) throw new Error(`unexpected ${key}`);
    const answer = writeAnswers[key];
    if (answer instanceof Error) throw answer;
    return answer;
  });
});
afterEach(() => {
  jest.useRealTimers();
  reload?.mockRestore();
  reload = null;
  setApiShim(null);
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {});
};

async function mount() {
  const view = render(onLanguage("en", createElement(OfficeMovePane)));
  await settle();
  const q = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const all = (id: string) =>
    view.container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`);
  const inView = () => q("move-in")?.dataset.view ?? null;
  return { view, q, all, inView };
}

async function click(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
  await settle();
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

const writesTo = (path: string) => writes.filter((w) => w.path === path);

it("puts the move-in card first on a new office and while a move-in runs or is done; the move-out card first otherwise", async () => {
  const order = async (status: MoveInStatus) => {
    inAnswers = [status];
    const m = await mount();
    const out = m.q("move-out");
    const inCard = m.q("move-in");
    expect(out).not.toBeNull();
    expect(inCard).not.toBeNull();
    const inFirst =
      (inCard!.compareDocumentPosition(out!) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0;
    m.view.unmount();
    return inFirst;
  };
  expect({
    notFresh: await order({ phase: "none", blocker: NOT_FRESH }),
    fresh: await order({ phase: "none", blocker: null }),
    copying: await order(inPhase("pulling", { oldOfficeLocked: true })),
    moved: await order(moved([".bashrc"])),
  }).toEqual({ notFresh: false, fresh: true, copying: true, moved: true });
});

it("shows the move code once, right after the mint, with the loopback warning when the address is loopback; keeps it nowhere", async () => {
  const CODE = "isomux-move:SECRET-c0de-77";
  const mint = (loopbackOrigin: boolean): MintMoveCodeRes => ({
    code: CODE,
    origin: "https://office.example.com",
    expiresAt: Date.now() + 15 * 60_000,
    loopbackOrigin,
  });
  writeAnswers["POST /api/office/move/code"] = mint(false);
  const m = await mount();
  expect(m.q("move-code")).toBeNull();
  outAnswers = [{ state: "code", expiresAt: Date.now() + 15 * 60_000 }];
  await click(m.q("move-mint"));
  expect(writesTo("/api/office/move/code").length).toBe(1);
  expect(m.q("move-code")?.textContent ?? "").toContain(CODE);
  expect(m.q("move-loopback-warning")).toBeNull();
  const stored = [
    ...Object.values({ ...localStorage }),
    ...Object.values({ ...sessionStorage }),
  ].join("\n");
  expect(stored.includes(CODE)).toBe(false);
  m.view.unmount();

  // Back on the pane: the code waits on the old office, but it is not shown.
  const again = await mount();
  expect(again.q("move-out")).not.toBeNull();
  expect(again.q("move-code")).toBeNull();
  expect(again.view.container.textContent?.includes(CODE)).toBe(false);
  again.view.unmount();

  // A mint whose origin is loopback warns that the new machine cannot reach it.
  outAnswers = [{ state: "none" }];
  writeAnswers["POST /api/office/move/code"] = mint(true);
  const loop = await mount();
  await click(loop.q("move-mint"));
  expect(loop.q("move-code")?.textContent ?? "").toContain(CODE);
  expect(loop.q("move-loopback-warning")).not.toBeNull();
});

it("the move-out card polls while paired; a plain error keeps polling, a locked answer reloads the page", async () => {
  jest.useFakeTimers();
  outAnswers = [
    { state: "paired", pairedAt: 1 },
    { fail: "plain" },
    { fail: "locked" },
  ];
  const m = await mount();
  expect(m.q("move-out")).not.toBeNull();
  expect(outReads).toBe(1);
  await advance(MOVE_OUT_POLL_MS);
  expect({ reads: outReads, reloads: reload!.mock.calls.length }).toEqual({
    reads: 2,
    reloads: 0,
  });
  await advance(MOVE_OUT_POLL_MS);
  expect({ reads: outReads, reloads: reload!.mock.calls.length }).toEqual({
    reads: 3,
    reloads: 1,
  });
});

it("a new office with a blocker shows it and no code field", async () => {
  inAnswers = [{ phase: "none", blocker: NOT_FRESH }];
  const blocked = await mount();
  expect(blocked.q("move-blocker")).not.toBeNull();
  expect(blocked.q("move-in-code")).toBeNull();
  blocked.view.unmount();
  inAnswers = [{ phase: "none", blocker: null }];
  const ready = await mount();
  expect(ready.q("move-blocker")).toBeNull();
  expect(ready.q("move-in-code")).not.toBeNull();
});

it("start sends the trimmed code; Lock sends the preflight id the confirm view shows", async () => {
  inAnswers = [{ phase: "none", blocker: null }];
  writeAnswers["POST /api/office/move-in"] = inPhase("confirm", {
    preflightId: "pf-1",
    preflight: preflight("always"),
  });
  writeAnswers["POST /api/office/move-in/lock"] = inPhase("locking", {
    preflightId: "pf-1",
  });
  const m = await mount();
  const input = m.q("move-in-code") as HTMLInputElement;
  expect(input.getAttribute("autocomplete")).toBe("off");
  await act(async () => {
    fireEvent.change(input, { target: { value: "  isomux-move:ABC-123 \n" } });
  });
  inAnswers = [
    inPhase("confirm", { preflightId: "pf-1", preflight: preflight("always") }),
  ];
  await click(m.q("move-in-start"));
  expect(writesTo("/api/office/move-in").map((w) => w.body)).toEqual([
    { code: "isomux-move:ABC-123" },
  ]);
  expect(m.inView()).toBe("confirm");
  const lock = m.q("move-lock") as HTMLButtonElement;
  expect(lock.disabled).toBe(false);
  await click(lock);
  expect(writesTo("/api/office/move-in/lock").map((w) => w.body)).toEqual([
    { preflightId: "pf-1" },
  ]);
});

it("Lock is disabled when the old office's unit does not restart always, and sends nothing", async () => {
  for (const restart of ["on-failure", null]) {
    inAnswers = [
      inPhase("confirm", {
        preflightId: "pf-9",
        preflight: preflight(restart),
      }),
    ];
    const m = await mount();
    expect(m.inView()).toBe("confirm");
    const lock = m.q("move-lock") as HTMLButtonElement;
    expect({ restart, disabled: lock.disabled }).toEqual({
      restart,
      disabled: true,
    });
    await click(lock);
    m.view.unmount();
  }
  expect(writesTo("/api/office/move-in/lock").length).toBe(0);
});

it("a cancel asks first; it says the old office stays locked when the status says so, and after, when the DELETE answer says so", async () => {
  const cancel = async (
    status: MoveInStatus,
    answer: MoveInCancelRes,
  ): Promise<{ armedNote: boolean; deletes: number; afterNote: boolean }> => {
    inAnswers = [status];
    writes = [];
    writeAnswers["DELETE /api/office/move-in"] = answer;
    const m = await mount();
    await click(m.q("move-in-cancel"));
    const armedNote = m.q("move-locked-note") !== null;
    const before = writesTo("/api/office/move-in").length;
    expect(before).toBe(0);
    inAnswers = [{ phase: "none", blocker: null }];
    await click(m.q("move-in-cancel"));
    const deletes = writesTo("/api/office/move-in").filter(
      (w) => w.method === "DELETE",
    ).length;
    const afterNote = m.q("move-locked-note") !== null;
    m.view.unmount();
    return { armedNote, deletes, afterNote };
  };
  expect(
    await cancel(inPhase("staged", { result: RESULT, oldOfficeLocked: true }), {
      cancelled: true,
      oldOfficeLocked: true,
      message: "The old office stays locked.",
    }),
  ).toEqual({ armedNote: true, deletes: 1, afterNote: true });
  expect(
    await cancel(
      inPhase("confirm", {
        preflightId: "pf-1",
        preflight: preflight(),
        oldOfficeLocked: false,
      }),
      { cancelled: true, oldOfficeLocked: false },
    ),
  ).toEqual({ armedNote: false, deletes: 1, afterNote: false });
});

it("the delete of the aside folder shows the folder and its first entries, and runs on the second click", async () => {
  const entries = Array.from({ length: 55 }, (_, i) => `entry-${i}`);
  inAnswers = [moved(entries)];
  writeAnswers["DELETE /api/office/move-in"] = {
    cancelled: true,
    oldOfficeLocked: false,
  };
  const m = await mount();
  expect(m.inView()).toBe("report");
  await click(m.q("move-aside-delete"));
  expect(writesTo("/api/office/move-in").length).toBe(0);
  expect(m.q("move-aside-path")?.textContent ?? "").toContain(ASIDE);
  const shown = [...m.all("move-aside-entry")].map((e) => e.textContent ?? "");
  expect(shown.length).toBe(50);
  expect(shown.every((text, i) => text.includes(`entry-${i}`))).toBe(true);
  expect(m.q("move-aside-more")?.textContent ?? "").toContain("5");
  inAnswers = [{ phase: "none", blocker: NOT_FRESH }];
  await click(m.q("move-aside-delete"));
  expect(
    writesTo("/api/office/move-in").filter((w) => w.method === "DELETE").length,
  ).toBe(1);
});

it("Finish asks first; an incomplete copy needs the box ticked and sends acceptMissing", async () => {
  writeAnswers["POST /api/office/move-in/finish"] = inPhase("swapping", {
    oldOfficeLocked: true,
  });
  const incomplete = {
    ...RESULT,
    complete: false,
    missing: [{ path: "nil/a.txt", reason: "unreadable" }],
  };
  inAnswers = [
    inPhase("incomplete", { result: incomplete, oldOfficeLocked: true }),
  ];
  const m = await mount();
  expect(m.inView()).toBe("incomplete");
  expect((m.q("move-finish") as HTMLButtonElement).disabled).toBe(true);
  await click(m.q("move-finish"));
  await click(m.q("move-accept-missing"));
  expect((m.q("move-finish") as HTMLButtonElement).disabled).toBe(false);
  await click(m.q("move-finish"));
  expect(writesTo("/api/office/move-in/finish").length).toBe(0);
  inAnswers = [inPhase("swapping", { oldOfficeLocked: true })];
  await click(m.q("move-finish"));
  expect(writesTo("/api/office/move-in/finish").map((w) => w.body)).toEqual([
    { acceptMissing: true },
  ]);
  m.view.unmount();

  writes = [];
  inAnswers = [inPhase("staged", { result: RESULT, oldOfficeLocked: true })];
  const s = await mount();
  await click(s.q("move-finish"));
  expect(writesTo("/api/office/move-in/finish").length).toBe(0);
  inAnswers = [inPhase("swapping", { oldOfficeLocked: true })];
  await click(s.q("move-finish"));
  const bodies = writesTo("/api/office/move-in/finish").map(
    (w) => (w.body as { acceptMissing?: boolean } | undefined)?.acceptMissing,
  );
  expect(bodies.length).toBe(1);
  expect(bodies[0] ?? false).toBe(false);
});

it("through the restart: polls with no error shown, then shows the report", async () => {
  jest.useFakeTimers();
  inAnswers = [
    inPhase("swapping", { oldOfficeLocked: true }),
    { fail: "plain" },
    { fail: "plain" },
    moved([".bashrc"]),
  ];
  const m = await mount();
  expect(m.inView()).toBe("restarting");
  for (let i = 0; i < 2; i++) {
    await advance(MOVE_IN_POLL_MS);
    expect({ view: m.inView(), error: m.q("move-error") }).toEqual({
      view: "restarting",
      error: null,
    });
  }
  await advance(MOVE_IN_POLL_MS);
  expect(m.inView()).toBe("report");
  const reads = inReads;
  await advance(MOVE_IN_POLL_MS * 3);
  expect(inReads).toBe(reads);
  expect(reload!.mock.calls.length).toBe(0);
});

it("through the restart: a locked answer (a failed swap) reloads; no answer for the cap says the office has not come back", async () => {
  jest.useFakeTimers();
  inAnswers = [
    inPhase("swapping", { oldOfficeLocked: true }),
    { fail: "locked" },
  ];
  const locked = await mount();
  await advance(MOVE_IN_POLL_MS);
  expect(reload!.mock.calls.length).toBe(1);
  locked.view.unmount();

  inAnswers = [
    inPhase("swapping", { oldOfficeLocked: true }),
    { fail: "plain" },
  ];
  // The cap counts from when the pane first saw the restart (the mount).
  const lost = await mount();
  await advance(MOVE_IN_RESTART_CAP_MS - 2 * MOVE_IN_POLL_MS);
  await advance(MOVE_IN_POLL_MS);
  expect({ view: lost.inView(), lost: lost.q("move-lost") }).toEqual({
    view: "restarting",
    lost: null,
  });
  for (let i = 0; i < 3; i++) await advance(MOVE_IN_POLL_MS);
  expect(lost.q("move-lost")).not.toBeNull();
  expect(reload!.mock.calls.length).toBe(1);
});

it("before the first status, the start controls show disabled", async () => {
  // Hold every GET until the check is done.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  setApiShim(async (method, path) => {
    await held;
    if (path === "/api/office/move") return { state: "none" };
    if (path === "/api/office/move-in") return { phase: "none", blocker: null };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const m = await mount();
  const mintBtn = m.q("move-mint") as HTMLButtonElement | null;
  const code = m.q("move-in-code") as HTMLInputElement | null;
  const start = m.q("move-in-start") as HTMLButtonElement | null;
  expect({
    mint: mintBtn?.disabled ?? "absent",
    code: code?.disabled ?? "absent",
    start: start?.disabled ?? "absent",
  }).toEqual({ mint: true, code: true, start: true });
  release();
  await settle();
  expect((m.q("move-mint") as HTMLButtonElement).disabled).toBe(false);
  expect((m.q("move-in-code") as HTMLInputElement).disabled).toBe(false);
});

it("a poll error outside the restart shows on the card, and the next status clears it", async () => {
  jest.useFakeTimers();
  outAnswers = [{ fail: "plain" }, { state: "none" }];
  inAnswers = [
    inPhase("pulling", { oldOfficeLocked: true }),
    { fail: "plain" },
    inPhase("pulling", { oldOfficeLocked: true }),
  ];
  const m = await mount();
  const errorIn = (card: string) =>
    m.q(card)?.querySelector('[data-testid="move-error"]') ?? null;
  // The move-out card's first read failed; the move-in card's first read
  // answered.
  expect({
    out: errorIn("move-out") !== null,
    in: errorIn("move-in") !== null,
  }).toEqual({ out: true, in: false });
  // A move-in poll fails: its card shows it; the move-out card's error stays
  // until its own next poll.
  await advance(MOVE_IN_POLL_MS);
  expect({
    out: errorIn("move-out") !== null,
    in: errorIn("move-in") !== null,
  }).toEqual({ out: true, in: true });
  expect(m.inView()).toBe("copying");
  await advance(MOVE_OUT_POLL_MS);
  expect({
    out: errorIn("move-out") !== null,
    in: errorIn("move-in") !== null,
  }).toEqual({ out: false, in: false });
});

// ---- the live pass (slice 4) ----

const LIVE_PHASES: MoveInLivePhase[] = [
  "manifest",
  "copying",
  "ready",
  "stopped",
  "failed",
  "unsupported",
];
const LIVE_ERROR = { code: "batch_failed", message: "LIVE-PASS-ERROR-77" };
const progressOf = (over: Partial<MoveInProgress> = {}): MoveInProgress => ({
  entries: 100,
  totalBytes: 8_000_000,
  filesDone: 10,
  bytesDone: 1_000_000,
  batchesDone: 1,
  batchesTotal: 4,
  retries: 0,
  ...over,
});
function liveOf(phase: MoveInLivePhase): MoveInLive {
  return {
    phase,
    startedAt: Date.now() - 60_000,
    ...(["ready", "stopped", "failed"].includes(phase)
      ? { finishedAt: Date.now() - 1_000 }
      : {}),
    ...(phase === "failed" ? { error: LIVE_ERROR } : {}),
    ...(phase === "copying"
      ? { progress: progressOf({ filesKept: 40, bytesKept: 3_000_000 }) }
      : {}),
  };
}
const confirmLive = (preflightId: string, live?: MoveInLive) =>
  inPhase("confirm", {
    preflightId,
    preflight: preflight("always"),
    ...(live ? { live } : {}),
  });

it("the confirm card shows the live pass by phase, Copy again only after a pass that ended, and Lock stays usable while it copies", async () => {
  const seen: Record<string, unknown> = {};
  for (const phase of [...LIVE_PHASES, "none"] as const) {
    inAnswers = [
      confirmLive("pf-1", phase === "none" ? undefined : liveOf(phase)),
    ];
    const m = await mount();
    expect(m.inView()).toBe("confirm");
    const live = m.q("move-live");
    const bar = live?.querySelector("progress") ?? null;
    seen[phase] = {
      live: live?.dataset.phase ?? null,
      copyAgain: m.q("move-copy-again") !== null,
      lockDisabled: (m.q("move-lock") as HTMLButtonElement).disabled,
      bar: bar?.getAttribute("value") ?? null,
      // The copied size: this pass plus the bytes an earlier pass kept.
      copied: (live?.textContent ?? "").includes(formatBytes("en", 4_000_000)!),
      liveError: (m.q("move-in")?.textContent ?? "").includes(
        LIVE_ERROR.message,
      ),
    };
    m.view.unmount();
  }
  const row = (live: string | null, copyAgain: boolean) => ({
    live,
    copyAgain,
    lockDisabled: false,
    bar: live === "copying" ? "0.5" : null,
    copied: live === "copying",
    liveError: live === "failed",
  });
  expect(seen).toEqual({
    manifest: row("manifest", false),
    copying: row("copying", false),
    ready: row("ready", true),
    stopped: row("stopped", true),
    failed: row("failed", true),
    unsupported: row("unsupported", false),
    none: row(null, false),
  });
});

it("a ready pass says when it copied in one line, and says nothing without a time", async () => {
  const seen: Record<string, unknown> = {};
  for (const withTime of [true, false]) {
    const live = liveOf("ready");
    if (!withTime) delete live.finishedAt;
    inAnswers = [confirmLive("pf-1", live)];
    const m = await mount();
    const block = m.q("move-live");
    expect(block?.dataset.phase).toBe("ready");
    const lines = [...(block?.querySelectorAll("p") ?? [])].map(
      (p) => p.textContent ?? "",
    );
    seen[String(withTime)] = {
      lines: lines.length,
      time:
        live.finishedAt !== undefined &&
        lines.some((l) => l.includes(absoluteTime("en", live.finishedAt!))),
    };
    m.view.unmount();
  }
  expect(seen).toEqual({
    true: { lines: 1, time: true },
    false: { lines: 0, time: false },
  });
});

it("Lock while the live pass copies sends the shown preflight id; Copy again posts the live pass and shows the status after it", async () => {
  inAnswers = [confirmLive("pf-1", liveOf("copying"))];
  writeAnswers["POST /api/office/move-in/lock"] = inPhase("locking", {
    preflightId: "pf-1",
  });
  const copying = await mount();
  inAnswers = [inPhase("locking", { oldOfficeLocked: true })];
  await click(copying.q("move-lock"));
  expect(writesTo("/api/office/move-in/lock").map((w) => w.body)).toEqual([
    { preflightId: "pf-1" },
  ]);
  copying.view.unmount();

  writes = [];
  inAnswers = [confirmLive("pf-1", liveOf("ready"))];
  writeAnswers["POST /api/office/move-in/live"] = confirmLive(
    "pf-1",
    liveOf("manifest"),
  );
  const m = await mount();
  const reads = inReads;
  inAnswers = [confirmLive("pf-1", liveOf("manifest"))];
  await click(m.q("move-copy-again"));
  expect(writes.map((w) => ({ method: w.method, path: w.path }))).toEqual([
    { method: "POST", path: "/api/office/move-in/live" },
  ]);
  expect(inReads).toBeGreaterThan(reads);
  expect({
    live: m.q("move-live")?.dataset.phase ?? null,
    copyAgain: m.q("move-copy-again") !== null,
  }).toEqual({ live: "manifest", copyAgain: false });
});

it("the final copy counts the bytes the live pass kept, and says how many files it kept only when there are some", async () => {
  const card = async (progress: MoveInProgress) => {
    inAnswers = [inPhase("pulling", { progress, oldOfficeLocked: true })];
    const m = await mount();
    expect(m.inView()).toBe("copying");
    const kept = m.q("move-kept");
    const text = m.q("move-in")?.textContent ?? "";
    const keptText = kept?.textContent ?? "";
    const out = {
      kept: kept !== null,
      keptCount: keptText.includes("40"),
      // The copied size outside the kept line: this pass plus the kept bytes.
      copied: text
        .replace(keptText, "")
        .includes(formatBytes("en", 4_000_000)!),
      bar:
        m.q("move-in")?.querySelector("progress")?.getAttribute("value") ??
        null,
    };
    m.view.unmount();
    return out;
  };
  expect(
    await card(progressOf({ filesKept: 40, bytesKept: 3_000_000 })),
  ).toEqual({ kept: true, keptCount: true, copied: true, bar: "0.5" });
  expect(await card(progressOf({ filesKept: 0, bytesKept: 0 }))).toMatchObject({
    kept: false,
  });
  expect(await card(progressOf())).toMatchObject({ kept: false });
});

it("a lock error goes away when a status brings a new check, whatever its code, and stays while the check is the same", async () => {
  // The new check is already there when the refresh after the error reads.
  writeAnswers["POST /api/office/move-in/lock"] = new ApiError(
    409,
    "preflight_stale",
    "LOCK-REFUSED",
    { code: "preflight_stale" },
  );
  inAnswers = [confirmLive("pf-1")];
  const early = await mount();
  inAnswers = [confirmLive("pf-2")];
  await click(early.q("move-lock"));
  expect(writesTo("/api/office/move-in/lock").length).toBe(1);
  expect({
    view: early.inView(),
    error: early.q("move-error") !== null,
  }).toEqual({ view: "confirm", error: false });
  early.view.unmount();

  jest.useFakeTimers();
  for (const code of ["preflight_stale", "not_confirming"]) {
    writes = [];
    writeAnswers["POST /api/office/move-in/lock"] = new ApiError(
      409,
      code,
      "LOCK-REFUSED",
      { code },
    );
    // The live pass copies, so the confirm card polls.
    inAnswers = [confirmLive("pf-1", liveOf("copying"))];
    const m = await mount();
    await click(m.q("move-lock"));
    expect(writesTo("/api/office/move-in/lock").length).toBe(1);
    const shown = () => m.q("move-error") !== null;
    // The refresh after the write and the next poll: the same check.
    const reads = inReads;
    const sameId: boolean[] = [shown()];
    await advance(MOVE_IN_POLL_MS);
    sameId.push(shown());
    expect({ code, view: m.inView(), sameId, polled: inReads > reads }).toEqual(
      { code, view: "confirm", sameId: [true, true], polled: true },
    );
    // The live pass ends, the new office checks again: a new id.
    inAnswers = [inPhase("preflight"), confirmLive("pf-2", liveOf("ready"))];
    await advance(MOVE_IN_POLL_MS);
    expect(m.inView()).toBe("working");
    await advance(MOVE_IN_POLL_MS);
    expect({ code, view: m.inView(), error: shown() }).toEqual({
      code,
      view: "confirm",
      error: false,
    });
    m.view.unmount();
  }
});

it("a lock error goes away on a new check even when a poll moved the card on while the lock was in flight", async () => {
  jest.useFakeTimers();
  inAnswers = [confirmLive("pf-1", liveOf("copying"))];
  const m = await mount();
  let refuse: (e: Error) => void = () => {};
  writeAnswers["POST /api/office/move-in/lock"] = new Promise((_, reject) => {
    refuse = reject;
  });
  // The live pass ends while the owner presses Lock: the new office checks
  // again, and a poll shows that before the lock answers.
  inAnswers = [inPhase("preflight")];
  await click(m.q("move-lock"));
  await advance(MOVE_IN_POLL_MS);
  expect(m.inView()).toBe("working");
  inAnswers = [confirmLive("pf-2", liveOf("ready"))];
  await act(async () => {
    refuse(
      new ApiError(409, "not_confirming", "LOCK-REFUSED", {
        code: "not_confirming",
      }),
    );
  });
  await settle();
  expect(writesTo("/api/office/move-in/lock").map((w) => w.body)).toEqual([
    { preflightId: "pf-1" },
  ]);
  expect({ view: m.inView(), error: m.q("move-error") !== null }).toEqual({
    view: "confirm",
    error: false,
  });
});

it("the move-out card says when the new machine started copying, only while paired", async () => {
  const servedAt = 1_790_000_000_000;
  const served = async (status: OfficeMoveRes) => {
    outAnswers = [status];
    const m = await mount();
    const line = m.q("move-out-served");
    const out =
      line === null
        ? null
        : (line.textContent ?? "").includes(absoluteTime("en", servedAt));
    m.view.unmount();
    return out;
  };
  expect({
    paired: await served({ state: "paired", pairedAt: 1, servedAt }),
    pairedNotServed: await served({ state: "paired", pairedAt: 1 }),
    code: await served({
      state: "code",
      expiresAt: Date.now() + 60_000,
      servedAt,
    }),
    none: await served({ state: "none" }),
  }).toEqual({ paired: true, pairedNotServed: null, code: null, none: null });
});

// Slice 5b-2: the folders outside the home. Structure the tests read:
// move-outside and move-outside-left (confirm), move-report-outside-moved
// and move-report-outside-left (report) are lists whose items carry
// data-path; move-outside-blocked (the reason) and move-outside-command (the
// root command) sit inside the blocked folder's item.
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { sizeText } = await import("./StoragePane.tsx");

const OUT_P = "/srv/data";
const OUT_Q = "/opt/tools";
const ROOT_CMD = "chown isomux:isomux /opt/tools";
const okCheck = (path: string, create: string[] = []): MoveInFolderCheck => ({
  path,
  ok: true,
  create,
});
const blockedCheck = (path: string, command?: string): MoveInFolderCheck => ({
  path,
  ok: false,
  reason: "owner",
  at: path,
  ...(command ? { command } : {}),
});
function outsidePreflight(
  qBytes: number | null = 3_000,
  left: { path: string; reason: string }[] = [
    { path: "/tmp/scratch", reason: "temp" },
    { path: "/mnt/quota", reason: "quota" },
  ],
) {
  return {
    ...preflight("always"),
    outsideFolders: {
      move: [
        { path: OUT_P, mode: 0o750, bytes: 2_000, timedOut: false },
        { path: OUT_Q, mode: 0o755, bytes: qBytes, timedOut: qBytes === null },
      ],
      left,
    },
  };
}
const confirmOutside = (
  checks: MoveInFolderCheck[],
  pf: Record<string, unknown> = outsidePreflight(),
) =>
  inPhase("confirm", {
    preflightId: "pf-1",
    preflight: pf,
    outsideChecks: checks,
  });
const failedOutside = (checks: MoveInFolderCheck[]) =>
  inPhase("failed", {
    error: { code: "outside_folders_blocked", message: "BLOCKED" },
    retryable: true,
    oldOfficeLocked: true,
    outsideChecks: checks,
  });
const pathsIn = (list: HTMLElement | null) =>
  list
    ? [...list.querySelectorAll<HTMLElement>("[data-path]")].map(
        (e) => e.dataset.path,
      )
    : null;
/** The data-path of the item each element of `id` sits in. */
const itemsOf = (m: Awaited<ReturnType<typeof mount>>, id: string) =>
  [...m.all(id)].map(
    (e) => e.closest<HTMLElement>("[data-path]")?.dataset.path ?? null,
  );

it("slice 5b-2: the confirm card lists the folders outside the home; a blocked one says why and shows its root command, Lock waits and sends nothing; the folders left are listed", async () => {
  inAnswers = [
    confirmOutside([okCheck(OUT_P, [OUT_P]), blockedCheck(OUT_Q, ROOT_CMD)]),
  ];
  const m = await mount();
  expect(m.inView()).toBe("confirm");
  expect(pathsIn(m.q("move-outside"))).toEqual([OUT_P, OUT_Q]);
  expect(itemsOf(m, "move-outside-blocked")).toEqual([OUT_Q]);
  expect(itemsOf(m, "move-outside-command")).toEqual([OUT_Q]);
  expect(m.q("move-outside-command")?.textContent ?? "").toContain(ROOT_CMD);
  // A reason this release does not name keeps its folder.
  expect(pathsIn(m.q("move-outside-left"))).toEqual([
    "/tmp/scratch",
    "/mnt/quota",
  ]);
  const lock = m.q("move-lock") as HTMLButtonElement;
  expect(lock.disabled).toBe(true);
  await click(lock);
  expect(writesTo("/api/office/move-in/lock").length).toBe(0);
  m.view.unmount();

  // Every folder can land: no reason, no command, Lock on. A blocked folder
  // with no command shows its reason only. No folders left: no left list.
  for (const [checks, blocked] of [
    [[okCheck(OUT_P), okCheck(OUT_Q, [OUT_Q])], []],
    [[okCheck(OUT_P), blockedCheck(OUT_Q)], [OUT_Q]],
  ] as const) {
    inAnswers = [confirmOutside([...checks], outsidePreflight(3_000, []))];
    const c = await mount();
    expect({
      blocked: itemsOf(c, "move-outside-blocked"),
      commands: c.all("move-outside-command").length,
      lockDisabled: (c.q("move-lock") as HTMLButtonElement).disabled,
      left: c.q("move-outside-left") !== null,
    }).toEqual({
      blocked: [...blocked],
      commands: 0,
      lockDisabled: blocked.length > 0,
      left: false,
    });
    c.view.unmount();
  }
});

it("slice 5b-2: an old office before 5b sends no folders outside the home: no folder lists, and Lock is on", async () => {
  inAnswers = [
    inPhase("confirm", { preflightId: "pf-1", preflight: preflight("always") }),
  ];
  const m = await mount();
  expect({
    outside: m.q("move-outside") !== null,
    left: m.q("move-outside-left") !== null,
    lockDisabled: (m.q("move-lock") as HTMLButtonElement).disabled,
  }).toEqual({ outside: false, left: false, lockDisabled: false });
});

it("slice 5b-2: the size line adds the folders outside the home to the home; a folder with no size makes it a lower bound", async () => {
  const { t } = translatorFor("en");
  const line = (
    key: "officeMove.in.confirm.size" | "officeMove.in.confirm.sizeAtLeast",
    bytes: number,
  ) => t(key, { size: sizeText("en", t, bytes) });
  // Home 10 + 2000 + 3000.
  inAnswers = [confirmOutside([okCheck(OUT_P), okCheck(OUT_Q)])];
  const known = await mount();
  const knownText = known.q("move-in")?.textContent ?? "";
  expect({
    size: knownText.includes(line("officeMove.in.confirm.size", 5_010)),
    homeOnly: knownText.includes(line("officeMove.in.confirm.size", 10)),
  }).toEqual({ size: true, homeOnly: false });
  known.view.unmount();
  inAnswers = [
    confirmOutside([okCheck(OUT_P), okCheck(OUT_Q)], outsidePreflight(null)),
  ];
  const partial = await mount();
  expect(
    (partial.q("move-in")?.textContent ?? "").includes(
      line("officeMove.in.confirm.sizeAtLeast", 2_010),
    ),
  ).toBe(true);
});

it("slice 5b-2: while a folder is blocked the confirm card polls; when the owner clears it, Lock turns on and the poll stops", async () => {
  jest.useFakeTimers();
  inAnswers = [
    confirmOutside([okCheck(OUT_P), blockedCheck(OUT_Q, ROOT_CMD)]),
    confirmOutside([okCheck(OUT_P), okCheck(OUT_Q)]),
  ];
  const m = await mount();
  expect((m.q("move-lock") as HTMLButtonElement).disabled).toBe(true);
  await advance(MOVE_IN_POLL_MS);
  expect({
    blocked: m.all("move-outside-blocked").length,
    lockDisabled: (m.q("move-lock") as HTMLButtonElement).disabled,
  }).toEqual({ blocked: 0, lockDisabled: false });
  const reads = inReads;
  await advance(MOVE_IN_POLL_MS * 3);
  expect(inReads).toBe(reads);
});

it("slice 5b-2: a lock refused with outside_folders_blocked shows the checks the refresh brings and polls until they clear, Lock first; folders_changed puts Check again first", async () => {
  const before = (a: HTMLElement | null, b: HTMLElement | null) =>
    a !== null &&
    b !== null &&
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  jest.useFakeTimers();
  writeAnswers["POST /api/office/move-in/lock"] = new ApiError(
    409,
    "outside_folders_blocked",
    "BLOCKED",
    { code: "outside_folders_blocked" },
  );
  inAnswers = [confirmOutside([okCheck(OUT_P), okCheck(OUT_Q)])];
  const m = await mount();
  inAnswers = [
    confirmOutside([okCheck(OUT_P), blockedCheck(OUT_Q, ROOT_CMD)]),
    confirmOutside([okCheck(OUT_P), okCheck(OUT_Q)]),
  ];
  await click(m.q("move-lock"));
  expect(writesTo("/api/office/move-in/lock").length).toBe(1);
  expect({
    commands: itemsOf(m, "move-outside-command"),
    lockDisabled: (m.q("move-lock") as HTMLButtonElement).disabled,
    lockFirst: before(m.q("move-lock"), m.q("move-check-again")),
  }).toEqual({ commands: [OUT_Q], lockDisabled: true, lockFirst: true });
  await advance(MOVE_IN_POLL_MS);
  expect({
    blocked: m.all("move-outside-blocked").length,
    lockDisabled: (m.q("move-lock") as HTMLButtonElement).disabled,
  }).toEqual({ blocked: 0, lockDisabled: false });
  m.view.unmount();

  // The old office's folder list changed since its check: a new check first.
  writes = [];
  writeAnswers["POST /api/office/move-in/lock"] = new ApiError(
    409,
    "folders_changed",
    "CHANGED",
    { code: "folders_changed" },
  );
  inAnswers = [confirmOutside([okCheck(OUT_P), okCheck(OUT_Q)])];
  const c = await mount();
  expect(before(c.q("move-lock"), c.q("move-check-again"))).toBe(true);
  await click(c.q("move-lock"));
  expect(writesTo("/api/office/move-in/lock").length).toBe(1);
  expect(before(c.q("move-check-again"), c.q("move-lock"))).toBe(true);
});

it("slice 5b-2: a pass failed for a folder: the failed card shows the blocked folder with its command and Try again, and polls until it clears", async () => {
  jest.useFakeTimers();
  inAnswers = [
    failedOutside([okCheck(OUT_P), blockedCheck(OUT_Q, ROOT_CMD)]),
    failedOutside([okCheck(OUT_P), okCheck(OUT_Q)]),
  ];
  const m = await mount();
  expect(m.inView()).toBe("failed");
  expect({
    blocked: itemsOf(m, "move-outside-blocked"),
    commands: itemsOf(m, "move-outside-command"),
    command: (m.q("move-outside-command")?.textContent ?? "").includes(
      ROOT_CMD,
    ),
    retry: m.q("move-retry") !== null,
  }).toEqual({
    blocked: [OUT_Q],
    commands: [OUT_Q],
    command: true,
    retry: true,
  });
  await advance(MOVE_IN_POLL_MS);
  expect({
    view: m.inView(),
    blocked: m.all("move-outside-blocked").length,
    retry: m.q("move-retry") !== null,
  }).toEqual({ view: "failed", blocked: 0, retry: true });
  const reads = inReads;
  await advance(MOVE_IN_POLL_MS * 3);
  expect(inReads).toBe(reads);
});

it("slice 5b-2: the report lists the folders outside the home that moved and those that stayed; a report of an earlier release has neither list", async () => {
  const base = moved([".bashrc"]) as Extract<MoveInStatus, { phase: "moved" }>;
  inAnswers = [
    {
      ...base,
      report: {
        ...base.report,
        outsideMoved: [OUT_P, OUT_Q],
        outsideLeft: [
          { path: "/tmp/scratch", reason: "temp" },
          { path: "/home/other/x", reason: "owner" },
        ],
      },
    },
  ];
  const m = await mount();
  expect(m.inView()).toBe("report");
  expect({
    moved: pathsIn(m.q("move-report-outside-moved")),
    left: pathsIn(m.q("move-report-outside-left")),
  }).toEqual({
    moved: [OUT_P, OUT_Q],
    left: ["/tmp/scratch", "/home/other/x"],
  });
  m.view.unmount();
  inAnswers = [base];
  const old = await mount();
  expect({
    moved: old.q("move-report-outside-moved") !== null,
    left: old.q("move-report-outside-left") !== null,
  }).toEqual({ moved: false, left: false });
});

it("slice 5b-2: the list cap never hides a folder that cannot land: with more folders than the cap, the blocked one past it still shows its reason and command", async () => {
  const many = Array.from({ length: MOVE_LIST_MAX + 10 }, (_, i) =>
    okCheck(`/srv/f${String(i).padStart(3, "0")}`),
  );
  const last = "/srv/zz-blocked";
  inAnswers = [
    confirmOutside([...many, blockedCheck(last, ROOT_CMD)], {
      ...preflight("always"),
      outsideFolders: {
        move: [...many, { path: last }].map((c) => ({
          path: c.path,
          mode: 0o755,
          bytes: 1,
          timedOut: false,
        })),
        left: [],
      },
    }),
  ];
  const m = await mount();
  expect({
    blocked: itemsOf(m, "move-outside-blocked"),
    commands: itemsOf(m, "move-outside-command"),
    lockDisabled: (m.q("move-lock") as HTMLButtonElement).disabled,
  }).toEqual({ blocked: [last], commands: [last], lockDisabled: true });
});

it("slice 5b-2: the failed card with folder checks shows the folders, not the server's message, also after the owner's fix; with no checks, the message", async () => {
  const says = (m: Awaited<ReturnType<typeof mount>>, msg: string) =>
    (m.q("move-in")?.textContent ?? "").includes(msg);
  // failedOutside's server message is "BLOCKED".
  for (const checks of [
    [okCheck(OUT_P), blockedCheck(OUT_Q, ROOT_CMD)],
    [okCheck(OUT_P), okCheck(OUT_Q)],
  ]) {
    inAnswers = [failedOutside(checks)];
    const m = await mount();
    expect({
      view: m.inView(),
      blocked: itemsOf(m, "move-outside-blocked").length,
      message: says(m, "BLOCKED"),
    }).toEqual({
      view: "failed",
      blocked: checks.some((c) => !c.ok) ? 1 : 0,
      message: false,
    });
    m.view.unmount();
  }
  inAnswers = [
    inPhase("failed", {
      error: { code: "batch_failed", message: "A PART FAILED" },
      retryable: true,
    }),
  ];
  const other = await mount();
  expect(says(other, "A PART FAILED")).toBe(true);
});

// ---- slice 5c-3: members with their own OS user ----
//
// move-members (confirm, failed) and move-report-members (report) are lists
// whose items carry data-user-id; move-member-blocked carries data-side
// (old or here) and data-block (the code, or "unknown" for a code this
// release does not name).

const MIA = {
  userId: "u-mia",
  name: "Mia",
  osUser: "isomux-mia",
  home: "/home/isomux-mia",
  block: null as string | null,
  units: [],
};
const SAM = {
  userId: "u-sam",
  name: "Sam",
  osUser: "isomux-sam",
  home: "/home/isomux-sam",
  block: null as string | null,
  units: [],
};
// Text that must never reach the card: this office's `detail` is the
// server's English (C2).
const HERE_DETAIL = "HERE-DETAIL-NEVER-SHOWN";
// Nor the old office's detail (connect ENOENT ...): the card shows the
// reason only (task 29b5ba13).
const OLD_DETAIL = "OLD-DETAIL-NEVER-SHOWN";
const UNKNOWN_CODE = "a_code_from_a_later_release";
const hereOf = (
  m: typeof MIA,
  block: MoveInMemberHere["block"] = null,
): MoveInMemberHere => ({
  userId: m.userId,
  name: m.name,
  osUser: m.osUser,
  oldHome: m.home,
  home: block === "other_home" ? `/srv/${m.osUser}` : m.home,
  block,
  ...(block ? { detail: HERE_DETAIL } : {}),
});
function membersPreflight(members: unknown[]) {
  return {
    ...preflight("always"),
    memberOsUsers: {
      names: members.map((m) => (m as { name: string }).name),
      members,
    },
  };
}
const confirmMembers = (members: unknown[], checks: MoveInMemberHere[]) =>
  inPhase("confirm", {
    preflightId: "pf-1",
    preflight: membersPreflight(members),
    membersHere: checks,
  });
const usersIn = (list: HTMLElement | null) =>
  list
    ? [...list.querySelectorAll<HTMLElement>("[data-user-id]")].map(
        (e) => e.dataset.userId,
      )
    : null;
const blocksOf = (m: Awaited<ReturnType<typeof mount>>) =>
  [...m.all("move-member-blocked")].map((e) => [
    e.closest<HTMLElement>("[data-user-id]")?.dataset.userId ?? null,
    e.dataset.side ?? null,
    e.dataset.block ?? null,
  ]);

it("slice 5c-3: the confirm card lists each member; a blocked one says which office blocks her and why, with the reason only: neither office's detail shows; Lock waits and sends nothing", async () => {
  const LEE = { ...SAM, userId: "u-lee", name: "Lee", osUser: "isomux-lee" };
  inAnswers = [
    confirmMembers(
      [
        MIA,
        { ...SAM, block: UNKNOWN_CODE, detail: OLD_DETAIL },
        {
          ...LEE,
          home: "/home/isomux-lee",
          block: "bad_home",
          detail: OLD_DETAIL,
        },
      ],
      [hereOf(MIA, "home_exists"), hereOf(SAM), hereOf(LEE)],
    ),
  ];
  const m = await mount();
  expect(m.inView()).toBe("confirm");
  expect(usersIn(m.q("move-members"))).toEqual(["u-mia", "u-sam", "u-lee"]);
  expect(blocksOf(m)).toEqual([
    ["u-mia", "here", "home_exists"],
    ["u-sam", "old", "unknown"],
    ["u-lee", "old", "bad_home"],
  ]);
  expect(m.all("move-member-detail").length).toBe(0);
  // Each old-side line is its reason and nothing more.
  const { t } = translatorFor("en");
  const oldLines = [...m.all("move-member-blocked")]
    .filter((e) => e.dataset.side === "old")
    .map((e) => e.textContent);
  expect(oldLines).toEqual([
    t("officeMove.in.members.old.unknown"),
    t("officeMove.in.members.old.badHome"),
  ]);
  const text = m.q("move-in")?.textContent ?? "";
  expect(text.includes(HERE_DETAIL)).toBe(false);
  expect(text.includes(OLD_DETAIL)).toBe(false);
  expect(text.includes(UNKNOWN_CODE)).toBe(false);
  // The structured fields carry this office's reason: her home here.
  expect(text.includes("/home/isomux-mia")).toBe(true);
  // The pre-5c-1 warning is not shown with the list.
  expect(m.q("move-member-os-users")).toBeNull();
  const lock = m.q("move-lock") as HTMLButtonElement;
  expect(lock.disabled).toBe(true);
  await click(lock);
  expect(writesTo("/api/office/move-in/lock").length).toBe(0);
  m.view.unmount();

  // Every member clear on both offices: no reason, Lock on.
  inAnswers = [confirmMembers([MIA, SAM], [hereOf(MIA), hereOf(SAM)])];
  const c = await mount();
  expect({
    users: usersIn(c.q("move-members")),
    blocked: c.all("move-member-blocked").length,
    lockDisabled: (c.q("move-lock") as HTMLButtonElement).disabled,
  }).toEqual({ users: ["u-mia", "u-sam"], blocked: 0, lockDisabled: false });
});

it("slice 5c-3: other_home names both homes from the fields; a member with no check here holds Lock", async () => {
  inAnswers = [confirmMembers([MIA, SAM], [hereOf(MIA, "other_home")])];
  const m = await mount();
  const reason = [...m.all("move-member-blocked")].find(
    (e) => e.dataset.block === "other_home",
  );
  expect(reason?.textContent ?? "").toContain("/srv/isomux-mia");
  expect(reason?.textContent ?? "").toContain("/home/isomux-mia");
  expect((m.q("move-lock") as HTMLButtonElement).disabled).toBe(true);
});

it("slice 5c-3: an old office of an earlier release names its members but cannot move them: the warning stays, no list, and Lock waits", async () => {
  inAnswers = [
    inPhase("confirm", {
      preflightId: "pf-1",
      preflight: {
        ...preflight("always"),
        memberOsUsers: { names: ["Mia"] },
      },
    }),
  ];
  const m = await mount();
  expect({
    warning: m.q("move-member-os-users") !== null,
    list: m.q("move-members") !== null,
    lockDisabled: (m.q("move-lock") as HTMLButtonElement).disabled,
  }).toEqual({ warning: true, list: false, lockDisabled: true });
});

it("slice 5c-3: while a member is blocked the confirm card polls; when the owner clears it, Lock turns on and the poll stops", async () => {
  jest.useFakeTimers();
  inAnswers = [
    confirmMembers([MIA], [hereOf(MIA, "name_taken")]),
    confirmMembers([MIA], [hereOf(MIA)]),
  ];
  const m = await mount();
  expect((m.q("move-lock") as HTMLButtonElement).disabled).toBe(true);
  await advance(MOVE_IN_POLL_MS);
  expect({
    blocked: m.all("move-member-blocked").length,
    lockDisabled: (m.q("move-lock") as HTMLButtonElement).disabled,
  }).toEqual({ blocked: 0, lockDisabled: false });
  const reads = inReads;
  await advance(MOVE_IN_POLL_MS * 3);
  expect(inReads).toBe(reads);
});

it("slice 5c-3: a pass failed for a member: the failed card shows the blocked member in place of the server's message, with Try again", async () => {
  inAnswers = [
    inPhase("failed", {
      error: { code: "member_homes_blocked", message: "SERVER-MEMBERS-MSG" },
      retryable: true,
      oldOfficeLocked: true,
      membersHere: [hereOf(MIA, "name_taken"), hereOf(SAM)],
    }),
  ];
  const m = await mount();
  expect(m.inView()).toBe("failed");
  expect({
    users: usersIn(m.q("move-members")),
    blocked: blocksOf(m),
    retry: m.q("move-retry") !== null,
  }).toEqual({
    users: ["u-mia", "u-sam"],
    blocked: [["u-mia", "here", "name_taken"]],
    retry: true,
  });
  const text = m.q("move-in")?.textContent ?? "";
  expect(text.includes("SERVER-MEMBERS-MSG")).toBe(false);
  expect(text.includes(HERE_DETAIL)).toBe(false);
});

it("slice 5c-3: the report lists each member with the enable command and its copy button; a member with no command shows her name and the pointer to the Members page; an earlier report has no list", async () => {
  const CMD = "sudo /opt/isomux/deploy/isomux-member-user.sh enable u-mia";
  const base = moved([".bashrc"]) as Extract<MoveInStatus, { phase: "moved" }>;
  inAnswers = [
    {
      ...base,
      report: {
        ...base.report,
        members: [
          { userId: "u-mia", name: "Mia", osUser: "isomux-mia", command: CMD },
          { userId: "u-sam", name: "Sam", osUser: "isomux-sam", command: null },
        ],
      },
    },
  ];
  const m = await mount();
  expect(m.inView()).toBe("report");
  expect(usersIn(m.q("move-report-members"))).toEqual(["u-mia", "u-sam"]);
  const item = (id: string) =>
    m
      .q("move-report-members")
      ?.querySelector<HTMLElement>(`[data-user-id="${id}"]`) ?? null;
  const command = item("u-mia")?.querySelector<HTMLElement>(
    '[data-testid="move-member-command"]',
  );
  expect(command?.textContent ?? "").toContain(CMD);
  expect(item("u-mia")?.querySelectorAll("button").length ?? 0).toBeGreaterThan(
    0,
  );
  expect({
    // A boolean, never the node: a failed toEqual on a DOM node serialises
    // it and never ends.
    samCommand:
      item("u-sam")?.querySelector('[data-testid="move-member-command"]') !==
      null,
    samPointer:
      item("u-sam")?.querySelector('[data-testid="move-member-settings"]') !==
      null,
    samName: (item("u-sam")?.textContent ?? "").includes("Sam"),
  }).toEqual({ samCommand: false, samPointer: true, samName: true });
  m.view.unmount();
  inAnswers = [base];
  const old = await mount();
  expect(old.q("move-report-members")).toBeNull();
});

// ---- values in sentences (task b30036d9) ----
//
// A name, a path, a host or a service inside a sentence is a value (AGENTS.md
// "UI rules"): each one sits whole in its own Data element, list items one
// each with plain separators, while times, sizes and free-text reasons stay
// words of the sentence. sentenceValues reads the line that holds the first
// value given.

/** `lines` with each list of values read by `read`, keyed as `lines`. */
const each = <R,>(
  lines: Record<string, string[]>,
  read: (values: string[], key: string) => R,
) =>
  Object.fromEntries(
    Object.entries(lines).map(([key, values]) => [key, read(values, key)]),
  );

it("the confirm card shows each name, host, service and path in its sentences as a value", async () => {
  inAnswers = [
    inPhase("confirm", {
      preflightId: "pf-1",
      preflight: {
        ...outsidePreflight(),
        restart: {
          unit: "old-isomux.service",
          manager: "user",
          restart: "on-failure",
        },
        turnsInFlight: [
          { agentId: "a1", name: "Agent Ada", roomName: "Room Rho" },
          { agentId: "a2", name: "Agent Bo", roomName: null },
        ],
        units: ["unit-one.service", "unit-two.service"].map((name) => ({
          name,
          unitFileState: "enabled",
          activeState: "active",
          transient: false,
        })),
        sudoPackages: { packages: ["pkg-alpha", "pkg-beta"] },
        memberOsUsers: { names: ["Old Mia", "Old Sam"] },
      },
      outsideChecks: [
        okCheck(OUT_P),
        { path: OUT_Q, ok: false, reason: "unsafe_parent", at: "/opt/at-dir" },
      ],
    }),
  ];
  const m = await mount();
  expect(m.inView()).toBe("confirm");
  const card = m.q("move-in")!;
  const lines = {
    from: [OLD],
    restartOff: ["old-isomux.service"],
    memberOsUsers: ["Old Mia", "Old Sam"],
    turns: ["Agent Ada", "Room Rho", "Agent Bo"],
    units: ["unit-one.service", "unit-two.service"],
    sudo: ["pkg-alpha", "pkg-beta"],
    outsideReason: ["/opt/at-dir"],
  };
  expect(each(lines, (values) => sentenceValues(card, values))).toEqual(
    each(lines, asData),
  );
});

it("each reason this office gives for a member names the home or OS user as a value", async () => {
  const LEE = {
    ...SAM,
    userId: "u-lee",
    name: "Lee",
    osUser: "isomux-lee",
    home: "/home/isomux-lee",
  };
  inAnswers = [
    confirmMembers(
      [MIA, SAM, LEE],
      [
        hereOf(MIA, "other_home"),
        hereOf(SAM, "name_taken"),
        hereOf(LEE, "home_exists"),
      ],
    ),
  ];
  const m = await mount();
  const reason = (block: string) =>
    [...m.all("move-member-blocked")].find((e) => e.dataset.block === block);
  const lines = {
    other_home: ["/srv/isomux-mia", "/home/isomux-mia"],
    name_taken: ["isomux-sam"],
    home_exists: ["/home/isomux-lee"],
  };
  expect(
    each(lines, (values, block) => {
      const el = reason(block);
      return el ? sentenceValues(el, values) : null;
    }),
  ).toEqual(each(lines, asData));
});

it("the report shows the old office, the members, the services and the set-aside folder in its sentences as values", async () => {
  const base = moved([".bashrc"]) as Extract<MoveInStatus, { phase: "moved" }>;
  inAnswers = [
    {
      ...base,
      report: {
        ...base.report,
        by: { kind: "member", id: "u1", name: "Morgan Mover" },
        ownerRenamedTo: "Renamed Owner",
        oldOfficeUnitSetAside: "isomux-old.service",
        units: {
          restored: ["app-one.service", "app-two.service"],
          failed: [{ name: "app-three.service", reason: "exit code 1" }],
        },
      },
    },
  ];
  const m = await mount();
  expect(m.inView()).toBe("report");
  const card = m.q("move-in")!;
  const lines = {
    from: [OLD, "Morgan Mover"],
    renamed: ["Renamed Owner"],
    unitSetAside: ["isomux-old.service"],
    unitsRestored: ["app-one.service", "app-two.service"],
    unitFailed: ["app-three.service"],
    aside: [ASIDE],
  };
  expect(each(lines, (values) => sentenceValues(card, values))).toEqual(
    each(lines, asData),
  );
  // The aside path keeps its test id.
  expect(m.q("move-aside-path")?.textContent).toBe(ASIDE);
});

it("the loopback warning names the address as a value", async () => {
  const ORIGIN = "http://127.0.0.1:4000";
  writeAnswers["POST /api/office/move/code"] = {
    code: "isomux-move:c0de",
    origin: ORIGIN,
    expiresAt: Date.now() + 15 * 60_000,
    loopbackOrigin: true,
  } satisfies MintMoveCodeRes;
  const m = await mount();
  outAnswers = [{ state: "code", expiresAt: Date.now() + 15 * 60_000 }];
  await click(m.q("move-mint"));
  const warning = m.q("move-loopback-warning");
  expect(warning).not.toBeNull();
  expect(sentenceValues(warning!, [ORIGIN])).toEqual(asData([ORIGIN]));
});

// Task 69c5f413, the UI rule that a view keeps its layout while it loads:
// until the move-in status answers, the pane holds the move-in card it showed
// last on this device, in its place in the card order. On a device that
// never loaded it, it guesses from what the office shows the reader: one
// member and no apps or tasks is a new office (the start form, the move-in
// card first); else the office is not new, with a reason for each of those.
// happy-dom lays nothing out: blockShape compares the block tree held with
// the tree once the status answered.
describe("Move office while the move-in status loads", () => {
  const { blockShape, deferred } = heldShape;
  const APP = { name: "app-1" } as never;
  const TASK = { id: "task-1", title: "Task" } as never;
  const SECOND_USER = [
    "second",
    { id: "u2", name: "Second", role: "member" },
  ] as never;

  // The move-in GET answers when the returned function runs; the move-out
  // GET at once.
  function holdMoveIn(answer: MoveInStatus) {
    const read = deferred<MoveInStatus>();
    setApiShim(async (method, path) => {
      if (method === "GET" && path === "/api/office/move")
        return { state: "none" };
      if (method === "GET" && path === "/api/office/move-in")
        return read.promise;
      throw new Error(`unexpected ${method} ${path}`);
    });
    return () => read.resolve(answer);
  }

  async function mountOn(over: Record<string, unknown>) {
    const view = render(
      onLanguage("en", createElement(OfficeMovePane), over as never),
    );
    await settle();
    return view;
  }

  const inFirst = (root: Element) => {
    const out = root.querySelector('[data-testid="move-out"]')!;
    const inCard = root.querySelector('[data-testid="move-in"]')!;
    return (
      (inCard.compareDocumentPosition(out) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0
    );
  };

  // Shape and order held, then once the status answered.
  async function heldThenShown(
    answer: () => void,
    view: ReturnType<typeof render>,
  ) {
    const root = view.container;
    const held = { shape: blockShape(root), inFirst: inFirst(root) };
    await act(async () => answer());
    await settle();
    expect(
      root.querySelector<HTMLElement>('[data-testid="move-in"]')!.dataset.view,
    ).toBe("start");
    return {
      held,
      shown: { shape: blockShape(root), inFirst: inFirst(root) },
    };
  }

  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("holds the start form, the move-in card first, for an office that looks new", async () => {
    const answer = holdMoveIn({ phase: "none", blocker: null });
    const view = await mountOn({});
    const code = view.container.querySelector<HTMLInputElement>(
      '[data-testid="move-in-code"]',
    );
    expect(code?.disabled).toBe(true);
    const { held, shown } = await heldThenShown(answer, view);
    expect(shown.inFirst).toBe(true);
    expect(held).toEqual(shown);
  });

  it("holds the not-new line with a reason per sign the office shows, the move-out card first", async () => {
    const reasons = [
      { kind: "users", count: 1 },
      { kind: "apps", count: 1 },
      { kind: "tasks", count: 1 },
    ];
    for (const [over, count] of [
      [{ apps: [APP] }, 1],
      [{ tasks: [TASK] }, 1],
      [{ users: new Map([...stateWithSelfUser(null).users, SECOND_USER]) }, 1],
      [{ apps: [APP], tasks: [TASK] }, 2],
    ] as const) {
      window.localStorage.clear();
      const answer = holdMoveIn({
        phase: "none",
        blocker: { ...NOT_FRESH, extra: { reasons: reasons.slice(0, count) } },
      });
      const view = await mountOn(over);
      const card = view.container.querySelector('[data-testid="move-in"]')!;
      expect(
        card.closest('[aria-busy="true"]') ??
          card.querySelector('[aria-busy="true"]'),
      ).not.toBeNull();
      expect(
        view.container.querySelector('[data-testid="move-in-code"]'),
      ).toBeNull();
      const root = view.container;
      const held = { shape: blockShape(root), inFirst: inFirst(root) };
      await act(async () => answer());
      await settle();
      expect(card.querySelector('[data-testid="move-blocker"]')).not.toBeNull();
      expect(
        root.querySelectorAll('[data-testid="move-blocker"] li').length,
      ).toBe(count);
      const shown = { shape: blockShape(root), inFirst: inFirst(root) };
      expect(shown.inFirst).toBe(false);
      expect({ over: Object.keys(over), ...held }).toEqual({
        over: Object.keys(over),
        ...shown,
      });
      cleanup();
    }
  });

  it("holds the move-in card this device saw last, over the guess", async () => {
    const notNew: MoveInStatus = {
      phase: "none",
      blocker: {
        ...NOT_FRESH,
        extra: {
          reasons: [
            { kind: "users", count: 2 },
            { kind: "agents", count: 4 },
            { kind: "tasks", count: 9 },
          ],
        },
      },
    } as MoveInStatus;
    // The first load, in an office that looks new to the reader.
    let answer = holdMoveIn(notNew);
    let view = await mountOn({});
    await act(async () => answer());
    await settle();
    expect(
      view.container.querySelectorAll('[data-testid="move-blocker"] li').length,
    ).toBe(3);
    view.unmount();

    answer = holdMoveIn(notNew);
    view = await mountOn({});
    const root = view.container;
    expect(root.querySelector('[data-testid="move-in-code"]')).toBeNull();
    const held = { shape: blockShape(root), inFirst: inFirst(root) };
    await act(async () => answer());
    await settle();
    expect(held).toEqual({ shape: blockShape(root), inFirst: inFirst(root) });

    // And back: a load that showed the start form holds it next time.
    view.unmount();
    answer = holdMoveIn({ phase: "none", blocker: null });
    view = await mountOn({ apps: [APP] });
    await act(async () => answer());
    await settle();
    view.unmount();
    answer = holdMoveIn({ phase: "none", blocker: null });
    view = await mountOn({ apps: [APP] });
    const again = view.container;
    const heldStart = { shape: blockShape(again), inFirst: inFirst(again) };
    expect(heldStart.inFirst).toBe(true);
    await act(async () => answer());
    await settle();
    expect(heldStart).toEqual({
      shape: blockShape(again),
      inFirst: inFirst(again),
    });
  });
});
