// Settings > Office > Move office (task 78733adf, slice 2c-2). The pane has a
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
//   report when it comes, and says so when the office does not come back.
//
// Controls are found by data-testid (copy is not asserted).
import { afterEach, beforeEach, expect, it, jest, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const browser = await import("../reload-browser.ts");
const { OfficeMovePane } = await import("./OfficeMovePane.tsx");
const { MOVE_IN_POLL_MS, MOVE_OUT_POLL_MS, MOVE_IN_RESTART_CAP_MS } =
  await import("../office-move.ts");
import type {
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
    return writeAnswers[key];
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
