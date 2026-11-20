// Task 3e70b6d4: the owners' account usage card. It shows the list at once,
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
    plan: state === "usage" ? "max" : null,
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

it("shows the list at once, reads only the loading rows, and puts each in by headroom without moving the placed ones", async () => {
  requests.length = 0;
  listAnswer = {
    rows: [
      row("tight", "usage", 60),
      row("late", "loading"),
      row("broken", "failed"),
    ],
  };
  const view = render(onLanguage(null, createElement(AccountUsageCard)));
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
  const view = render(onLanguage(null, createElement(AccountUsageCard)));
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
  view.container.querySelector("[data-account-usage] > [data-reserved]")
    ?.children.length ?? 0;
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
    [row("a", "usage", 20), row("b", "failed"), row("c", "usage", 70)].map(
      (r) => accountUsageRowShape(r, now)!,
    ),
  );
  const list = deferred<AccountUsageListRes>();
  listAnswer = list.promise;
  const view = render(onLanguage(null, createElement(AccountUsageCard)));
  await act(async () => {});
  expect({
    held: heldRows(view),
    rows: rowsOf(view).length,
    refreshDisabled: refreshDisabled(view),
  }).toEqual({ held: 3, rows: 0, refreshDisabled: true });

  await act(async () =>
    list.resolve({ rows: [row("x", "usage", 10), row("y", "no_limit")] }),
  );
  expect({
    held: heldRows(view),
    rows: rowsOf(view),
    refreshDisabled: refreshDisabled(view),
    layout: getAccountUsageLayout().map((shape) => shape.state),
  }).toEqual({
    held: 0,
    rows: [
      { id: "x", loading: false },
      { id: "y", loading: false },
    ],
    refreshDisabled: false,
    layout: ["usage", "no_limit"],
  });
  view.unmount();
});

it("draws a member's card with Refresh disabled, no rows and no held rows, and reads nothing", async () => {
  requests.length = 0;
  const now = Date.now();
  // An owner's layout left on this device.
  setAccountUsageLayout(
    [row("a", "usage", 20), row("b", "usage", 30)].map((r) =>
      accountUsageRowShape(r, now)!,
    ),
  );
  const view = render(
    onLanguage(null, createElement(AccountUsageCard, { readOnly: true })),
  );
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  expect({
    card: view.container.querySelector("[data-account-usage]") !== null,
    held: heldRows(view),
    rows: rowsOf(view).length,
    refreshDisabled: refreshDisabled(view),
    requests: requests.length,
  }).toEqual({
    card: true,
    held: 0,
    rows: 0,
    refreshDisabled: true,
    requests: 0,
  });
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
  const view = render(onLanguage(null, createElement(AccountUsageCard)));
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
  const office = rowEl(view, "office").textContent ?? "";
  expect(
    ["ana-owner", "ana", "cy"].map((name) => office.includes(name)),
  ).toEqual([true, true, true]);
  view.unmount();
});
