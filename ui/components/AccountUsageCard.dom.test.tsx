// Task 3e70b6d4: the account usage card. It shows the list at once,
// reads each loading row on its own, places rows by weekly headroom as they
// arrive without moving the placed ones, and reads all again on Refresh.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import type {
  AccountUsageListRes,
  AccountUsageRowWire,
} from "../../shared/contract-shapes.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { AccountUsageCard } = await import("./AccountUsageCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { getAccountUsageLayout, setAccountUsageLayout } =
  await import("../device-settings.ts");
const { accountUsageRowShape } = await import("../../shared/account-usage.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const DAY = 24 * 60 * 60 * 1000;
const LIST = "/api/office/account-usage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Half the week passed for each weekly window: headroom = 50 - used.
function row(
  id: string,
  state: AccountUsageRowWire["state"],
  weeklyUsed?: number,
): AccountUsageRowWire {
  const now = Date.now();
  return {
    id,
    provider: "claude",
    owners: [{ kind: "member", username: `${id}-owner` }],
    accountLabel: `${id}@example.test`,
    identity: null,
    members: [],
    state,
    plan: state === "usage" ? "Max" : null,
    windows:
      weeklyUsed === undefined
        ? []
        : [
            {
              label: "W",
              usedPercent: weeklyUsed,
              resetsAtMs: now + 3.5 * DAY,
            },
            { label: "5", usedPercent: 3, resetsAtMs: now + 3600_000 },
          ],
    weeklyIndex: weeklyUsed === undefined ? null : 0,
    observedAtMs: weeklyUsed === undefined ? null : now - 30_000,
  };
}

// Who looks at the card (task faf036ad): an owner sees every account, a
// member the office's and their own.
const OWNER_VIEWER = { username: "morgan", owner: true };
const MEMBER_VIEWER = { username: "stephen", owner: false };

const requests: string[] = [];
const rowReads = new Map<
  string,
  ReturnType<typeof deferred<AccountUsageRowWire>>
>();
let listAnswer: AccountUsageListRes | Promise<AccountUsageListRes> = {
  rows: [],
};
setApiShim(async (method, path) => {
  requests.push(`${method} ${path}`);
  if (method !== "GET") throw new Error(`no shim for ${method} ${path}`);
  const url = new URL(path, "http://office.test");
  if (url.pathname === LIST) return listAnswer;
  if (url.pathname.startsWith(`${LIST}/`)) {
    const id = decodeURIComponent(url.pathname.slice(LIST.length + 1));
    const read = deferred<AccountUsageRowWire>();
    rowReads.set(id, read);
    return read.promise;
  }
  throw new Error(`no shim for ${method} ${path}`);
});
afterAll(() => setApiShim(null));

const rowsOf = (view: { container: HTMLElement }) =>
  [...view.container.querySelectorAll("[data-account-row]")].map((el) => ({
    id: el.getAttribute("data-account-row"),
    loading: el.hasAttribute("data-loading"),
  }));
const rowEl = (view: { container: HTMLElement }, id: string) =>
  view.container.querySelector(`[data-account-row="${id}"]`)!;
// The card's sections in order (not the held ones), each with the ids of its
// rows in order.
const sectionsOf = (view: { container: HTMLElement }) =>
  [...view.container.querySelectorAll("[data-account-usage-section]")]
    .filter((el) => el.closest("[data-reserved]") === null)
    .map((el) => ({
      section: el.getAttribute("data-account-usage-section"),
      rows: [...el.querySelectorAll("[data-account-row]")].map((r) =>
        r.getAttribute("data-account-row"),
      ),
    }));

it("shows the list at once, reads only the loading rows, and puts each in by headroom without moving the placed ones", async () => {
  requests.length = 0;
  listAnswer = {
    rows: [
      row("tight", "usage", 60),
      row("late", "loading"),
      row("broken", "failed"),
    ],
  };
  const view = render(
    onLanguage(null, createElement(AccountUsageCard, { viewer: OWNER_VIEWER })),
  );
  await act(async () => {});
  expect(requests).toEqual([`GET ${LIST}`, `GET ${LIST}/late`]);
  // The placed rows in headroom order; the loading row after them, loading.
  expect(rowsOf(view)).toEqual([
    { id: "tight", loading: false },
    { id: "broken", loading: false },
    { id: "late", loading: true },
  ]);
  const tight = rowEl(view, "tight").textContent ?? "";
  expect(tight).toContain("tight@example.test");
  expect(tight).toContain("tight-owner");
  expect(tight).toContain("60");

  // late has more headroom than tight: it goes in above it, and the others
  // keep their place.
  await act(async () =>
    rowReads.get("late")!.resolve(row("late", "usage", 10)),
  );
  expect(rowsOf(view)).toEqual([
    { id: "late", loading: false },
    { id: "tight", loading: false },
    { id: "broken", loading: false },
  ]);
  view.unmount();
});

it("reads every account again from Refresh, and asks nothing on its own after", async () => {
  requests.length = 0;
  listAnswer = { rows: [row("a", "usage", 20)] };
  const view = render(
    onLanguage(null, createElement(AccountUsageCard, { viewer: OWNER_VIEWER })),
  );
  await act(async () => {});
  expect(requests).toEqual([`GET ${LIST}`]);
  const refresh = view.container.querySelector("[data-account-usage-refresh]")!;
  listAnswer = { rows: [row("a", "loading")] };
  await act(async () => fireEvent.click(refresh));
  expect(requests).toEqual([
    `GET ${LIST}`,
    `GET ${LIST}?refresh=1`,
    `GET ${LIST}/a`,
  ]);
  expect(rowsOf(view)).toEqual([{ id: "a", loading: true }]);
  await act(async () => rowReads.get("a")!.resolve(row("a", "usage", 25)));
  expect(rowsOf(view)).toEqual([{ id: "a", loading: false }]);
  // No polling.
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(requests).toHaveLength(3);
  view.unmount();
});

// The card-level held block: the rows drawn last on this device, dimmed.
const heldRows = (view: { container: HTMLElement }) =>
  view.container.querySelectorAll("[data-reserved] [data-held-row]").length;
const refreshDisabled = (view: { container: HTMLElement }) =>
  (
    view.container.querySelector(
      "[data-account-usage-refresh]",
    ) as HTMLButtonElement
  ).disabled;

it("holds the rows drawn last while the list loads, then draws the real ones and remembers their layout", async () => {
  requests.length = 0;
  const now = Date.now();
  setAccountUsageLayout(
    [
      { ...row("a", "usage", 20), owners: [{ kind: "office" as const }] },
      row("b", "failed"),
      row("c", "usage", 70),
    ].map((r) => accountUsageRowShape(r, now)!),
  );
  const list = deferred<AccountUsageListRes>();
  listAnswer = list.promise;
  const view = render(
    onLanguage(null, createElement(AccountUsageCard, { viewer: OWNER_VIEWER })),
  );
  await act(async () => {});
  expect({
    held: heldRows(view),
    rows: rowsOf(view).length,
    refreshDisabled: refreshDisabled(view),
  }).toEqual({ held: 3, rows: 0, refreshDisabled: true });
  // The held rows keep their sections: one office row, then two others.
  expect(
    [
      ...view.container.querySelectorAll(
        "[data-reserved] [data-account-usage-section]",
      ),
    ].map((el) => el.querySelectorAll("[data-held-row]").length),
  ).toEqual([1, 2]);

  await act(async () =>
    list.resolve({ rows: [row("x", "usage", 10), row("y", "no_limit")] }),
  );
  expect({
    held: heldRows(view),
    rows: rowsOf(view),
    refreshDisabled: refreshDisabled(view),
    layout: getAccountUsageLayout(),
  }).toEqual({
    held: 0,
    rows: [
      { id: "x", loading: false },
      { id: "y", loading: false },
    ],
    refreshDisabled: false,
    layout: [
      { state: "usage", office: false, email: true },
      { state: "no_limit", office: false, email: true },
    ],
  });
  view.unmount();
});

// Task faf036ad: a member reads the card too; the server gives them the
// office's accounts and their own.
it("reads a member's card, with the office's accounts first and the member's own after, named as theirs", async () => {
  requests.length = 0;
  listAnswer = {
    rows: [
      {
        ...row("mine", "usage", 20),
        owners: [{ kind: "member", username: MEMBER_VIEWER.username }],
        accountLabel: "s@example.test",
      },
      {
        ...row("office", "usage", 30),
        owners: [{ kind: "office" }],
        accountLabel: null,
      },
    ],
  };
  const view = render(
    onLanguage(
      null,
      createElement(AccountUsageCard, { viewer: MEMBER_VIEWER }),
    ),
  );
  await act(async () => {});
  expect({
    requests,
    sections: sectionsOf(view),
    refreshDisabled: refreshDisabled(view),
  }).toEqual({
    requests: [`GET ${LIST}`],
    sections: [
      { section: "office", rows: ["office"] },
      { section: "yours", rows: ["mine"] },
    ],
    refreshDisabled: false,
  });
  // The member's own row carries their name marked as theirs (task
  // c69897f5); the office row does not; the email stays.
  const own = translatorFor("en").t("accountUsage.you", {
    name: MEMBER_VIEWER.username,
  });
  const mine = rowEl(view, "mine").textContent ?? "";
  const office = rowEl(view, "office").textContent ?? "";
  expect([
    own.includes(MEMBER_VIEWER.username),
    mine.includes(own),
    office.includes(own),
    mine.includes("s@example.test"),
  ]).toEqual([true, true, false, true]);
  view.unmount();
});

// The server merges rows of one account only when both readings are in at
// the list; after a restart or a Refresh every row loads on its own, so the
// card merges a row that arrives with the identity of a row it shows.
it("folds a row that arrives with a shown row's identity into that row, with both owners and members", async () => {
  requests.length = 0;
  listAnswer = {
    rows: [
      {
        ...row("office", "usage", 20),
        owners: [{ kind: "office" }],
        identity: "account-1",
        members: ["cy"],
      },
      row("ana", "loading"),
      row("dee", "loading"),
    ],
  };
  const view = render(
    onLanguage(null, createElement(AccountUsageCard, { viewer: OWNER_VIEWER })),
  );
  await act(async () => {});
  await act(async () =>
    rowReads.get("ana")!.resolve({
      ...row("ana", "usage", 20),
      identity: "account-1",
      members: ["ana"],
    }),
  );
  // Another account (no identity: a failed read) stays its own row.
  await act(async () => rowReads.get("dee")!.resolve(row("dee", "failed")));
  expect(rowsOf(view)).toEqual([
    { id: "office", loading: false },
    { id: "dee", loading: false },
  ]);
  // Both owners name the row; the members on it are in its details.
  await act(async () => fireEvent.click(rowEl(view, "office")));
  const details =
    rowEl(view, "office").querySelector("[data-account-row-details]")
      ?.textContent ?? "";
  const office = rowEl(view, "office").textContent ?? "";
  expect({
    owner: office.includes("ana-owner"),
    members: ["ana", "cy"].map((name) => details.includes(name)),
  }).toEqual({ owner: true, members: [true, true] });
  view.unmount();
});

// Task faf036ad: the office's sign-ins on top, Claude before Codex, then the
// members' accounts by headroom.
it("draws an owner's card with the office's accounts first, Claude before Codex, then the members' accounts", async () => {
  requests.length = 0;
  listAnswer = {
    rows: [
      row("ana", "usage", 20),
      {
        ...row("office-codex", "usage", 10),
        provider: "codex",
        owners: [{ kind: "office" }],
      },
      row("ben", "usage", 45),
      { ...row("office-claude", "usage", 40), owners: [{ kind: "office" }] },
    ],
  };
  const view = render(
    onLanguage(null, createElement(AccountUsageCard, { viewer: OWNER_VIEWER })),
  );
  await act(async () => {});
  expect(sectionsOf(view)).toEqual([
    { section: "office", rows: ["office-claude", "office-codex"] },
    // ana has more headroom than ben.
    { section: "members", rows: ["ana", "ben"] },
  ]);
  view.unmount();
});

it("opens a row's details on a click and closes them on the next", async () => {
  listAnswer = { rows: [row("a", "usage", 20)] };
  const view = render(
    onLanguage(null, createElement(AccountUsageCard, { viewer: OWNER_VIEWER })),
  );
  await act(async () => {});
  const details = () =>
    rowEl(view, "a").querySelector("[data-account-row-details]") !== null;
  const opened: boolean[] = [details()];
  await act(async () => fireEvent.click(rowEl(view, "a")));
  opened.push(details());
  await act(async () => fireEvent.click(rowEl(view, "a")));
  opened.push(details());
  expect(opened).toEqual([false, true, false]);
  view.unmount();
});

it("marks a row whose weekly use is ahead of the week passed", async () => {
  // Half the week has passed for both.
  listAnswer = {
    rows: [row("ahead", "usage", 80), row("behind", "usage", 20)],
  };
  const view = render(
    onLanguage(null, createElement(AccountUsageCard, { viewer: OWNER_VIEWER })),
  );
  await act(async () => {});
  expect(
    ["ahead", "behind"].map((id) =>
      rowEl(view, id).hasAttribute("data-over-pace"),
    ),
  ).toEqual([true, false]);
  view.unmount();
});

// A weekly window with no reset time has no week-passed share: the row gives
// the used share alone, with no tick and no pace mark.
it("gives a weekly window with no reset time its used share only", async () => {
  listAnswer = {
    rows: [
      {
        ...row("noreset", "usage", 30),
        windows: [{ label: "W", usedPercent: 30, resetsAtMs: null }],
      },
    ],
  };
  const view = render(
    onLanguage(null, createElement(AccountUsageCard, { viewer: OWNER_VIEWER })),
  );
  await act(async () => {});
  const el = rowEl(view, "noreset");
  const text = el.textContent ?? "";
  expect({
    percents: text.split("%").length - 1,
    tick: el.querySelector("[data-week-passed]") !== null,
    overPace: el.hasAttribute("data-over-pace"),
  }).toEqual({ percents: 1, tick: false, overPace: false });
  view.unmount();
});
