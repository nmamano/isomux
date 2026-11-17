// The Apps page keeps its layout while the list loads (task 29594d38, the UI
// rule in AGENTS.md): before GET /api/apps answers, the page draws the filter
// bar (its controls disabled) and, per section, the header and as many blank
// rows as it showed when it last loaded on this device (or the empty box for
// none). So nothing below the header moves when the answer arrives.
//
// happy-dom lays nothing out: pageShape compares the block and control tree
// drawn while the read waits with the tree drawn once it answered, each row
// (held or real) counted as one ROW. The row geometry itself is checked by
// scripts/loading-check.sh in a real browser.
//
// Seam: AppsView over setApiShim, with the real store reducer, so the answer
// reaches the view through the apps_loaded action.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { blockShape } from "../test-support/held-shape.ts";

setUpDomTestFile();

const { act, cleanup, render } = await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { AppsView } = await import("./AppsView.tsx");
const { setApiShim } = await import("../api.ts");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { getAppsLayout, setAppsLayout } = await import("../device-settings.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type AppState = import("../store.tsx").AppState;
type AppListWire = import("../../shared/types.ts").AppListWire;
type AppsLayout = import("../device-settings.ts").AppsLayout;
type Section = "running" | "stopped" | "archived";

const en = translatorFor("en");
const loading = en.t("common.loading");
// stateWithSelfUser's self user.
const SELF = "u1";

function app(
  name: string,
  section: Section,
  userId: string = SELF,
): AppListWire {
  return {
    name,
    port: 21000,
    userId,
    username: userId,
    createdByAgentId: "agent",
    createdAt: 1,
    state: section === "running" ? "running" : "stopped",
    ...(section === "archived" ? { archived: true } : {}),
    restartCount: 0,
    canManage: false,
  };
}

function appsFor(layout: Omit<AppsLayout, "filters">): AppListWire[] {
  return (["running", "stopped", "archived"] as const).flatMap((section) =>
    Array.from({ length: layout[section] }, (_, i) =>
      app(`${section}-${i}`, section),
    ),
  );
}

// Each GET /api/apps waits until `answer` or `fail` settles the oldest read in
// flight. Every other request is recorded and refused.
let listGets = 0;
let others: string[] = [];
function serve(list: AppListWire[]) {
  const reads: {
    resolve: (v: AppListWire[]) => void;
    reject: (e: Error) => void;
  }[] = [];
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/apps") {
      listGets++;
      return new Promise<AppListWire[]>((resolve, reject) =>
        reads.push({ resolve, reject }),
      );
    }
    others.push(`${method} ${path}`);
    throw new Error(`no shim for ${method} ${path}`);
  });
  return {
    answer: async () => {
      await act(async () => reads.shift()!.resolve(list));
      await settle();
    },
    fail: async () => {
      await act(async () => reads.shift()!.reject(new Error("network down")));
      await settle();
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(over: Partial<AppState> = {}) {
  function Harness() {
    const [state, dispatch] = useReducer(
      reducer,
      stateWithSelfUser("en", { hydrationEpoch: 1, ...over }),
    );
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(
          LanguageProvider,
          null,
          createElement(AppsView, { onClose: () => {} }),
        ),
      ),
    );
  }
  return render(createElement(Harness));
}

const isRow = (el: Element) =>
  el.hasAttribute("data-app-row") || el.hasAttribute("data-app-held-row");
// blockShape with each row, held or real, as one ROW: a held row is blank
// where a real one has links, buttons and a menu.
function pageShape(root: Element): string {
  if (isRow(root)) return "ROW";
  const inner = [...root.children].map(pageShape).join("");
  // blockShape of the bare element says whether its tag is a block.
  const isBlock = blockShape(root.cloneNode(false) as Element) !== "";
  return isBlock ? `${root.tagName}(${inner})` : inner;
}

const busy = (root: Element) =>
  root.querySelectorAll('[aria-busy="true"]').length;
const realRows = (root: Element) =>
  root.querySelectorAll("[data-app-row]").length;
const heldRows = (root: Element) =>
  root.querySelectorAll("[data-app-held-row]").length;
const rowsIn = (root: Element, section: Section) =>
  [
    ...(root
      .querySelector(`[data-app-section="${section}"]`)
      ?.querySelectorAll("[data-app-row], [data-app-held-row]") ?? []),
  ].length;
const sectionShown = (root: Element, section: Section) =>
  root.querySelector(`[data-app-section="${section}"]`) !== null;
const filterBar = (root: Element) => root.querySelector("[data-app-filters]");
const filterControls = (root: Element) => [
  ...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    "[data-app-filters] input, [data-app-filters] select",
  ),
];
// The list's scroll box: the page's last child while no dialog is open.
const listBox = (root: Element) =>
  root.querySelector("[data-apps-page]")!.lastElementChild!;
const archivedToggle = (root: Element) =>
  root.querySelector<HTMLButtonElement>(
    '[data-app-section="archived"] button[aria-expanded]',
  );

beforeEach(() => {
  window.localStorage.clear();
  listGets = 0;
  others = [];
});
afterEach(() => cleanup());
afterAll(() => setApiShim(null));

const LAYOUTS: { name: string; stored: AppsLayout | null }[] = [
  { name: "first visit", stored: null },
  {
    name: "no apps",
    stored: { filters: false, running: 0, stopped: 0, archived: 0 },
  },
  {
    name: "all three sections",
    stored: { filters: true, running: 3, stopped: 2, archived: 2 },
  },
];

for (const isMobile of [false, true]) {
  describe(`the page while it loads (${isMobile ? "phone" : "desktop"})`, () => {
    for (const { name, stored } of LAYOUTS) {
      it(`holds the layout of the last load (${name})`, async () => {
        if (stored !== null) setAppsLayout(stored);
        const expected = stored ?? getAppsLayout();
        const read = serve(appsFor(expected));
        const view = mount({ isMobile });
        await settle();
        const root = view.container;

        expect(listGets).toBe(1);
        expect(busy(root)).toBe(1);
        expect(realRows(root)).toBe(0);
        expect(root.textContent).toContain(loading);
        expect(filterBar(root) !== null).toBe(expected.filters);
        for (const control of filterControls(root))
          expect(control.disabled).toBe(true);
        // Running and Stopped hold their rows; Archived opens collapsed, so
        // it holds only its header.
        for (const section of ["running", "stopped", "archived"] as const)
          expect(sectionShown(root, section)).toBe(expected[section] > 0);
        expect(rowsIn(root, "running")).toBe(expected.running);
        expect(rowsIn(root, "stopped")).toBe(expected.stopped);
        expect(rowsIn(root, "archived")).toBe(0);
        const held = pageShape(root);

        await read.answer();
        expect(busy(root)).toBe(0);
        expect(heldRows(root)).toBe(0);
        expect(realRows(root)).toBe(expected.running + expected.stopped);
        expect(root.textContent).not.toContain(loading);
        expect(filterBar(root) !== null).toBe(expected.filters);
        if (expected.filters) {
          // The owner checkbox (a session exists) and the room select.
          expect(filterControls(root).length).toBe(2);
        }
        for (const control of filterControls(root))
          expect(control.disabled).toBe(false);
        expect(pageShape(root)).toBe(held);
      });
    }

    it("draws a held row at the size of a real row's thumbnail", async () => {
      setAppsLayout({ filters: true, running: 1, stopped: 0, archived: 0 });
      const read = serve(appsFor({ running: 1, stopped: 0, archived: 0 }));
      const view = mount({ isMobile });
      await settle();
      const heldRow = view.container.querySelector("[data-app-held-row]");
      expect(heldRow).not.toBeNull();
      const heldBox = heldRow!.firstElementChild as HTMLElement;
      const box = {
        width: heldBox.style.width,
        aspectRatio: heldBox.style.aspectRatio,
      };
      expect(box.width).not.toBe("");

      await read.answer();
      const thumb = view.container.querySelector<HTMLElement>("[data-app-row]")!
        .firstElementChild as HTMLElement;
      expect(box).toEqual({
        width: thumb.style.width,
        aspectRatio: thumb.style.aspectRatio,
      });
    });
  });
}

it("holds the filter bar and the no-match box when the filters hid every app", async () => {
  window.localStorage.setItem("isomux-apps-only-mine", "true");
  setAppsLayout({ filters: true, running: 0, stopped: 0, archived: 0 });
  const read = serve([app("theirs", "running", "u2")]);
  const view = mount();
  await settle();
  const root = view.container;
  expect(filterBar(root)).not.toBeNull();
  expect(root.textContent).toContain(loading);
  const held = pageShape(root);

  await read.answer();
  expect(realRows(root)).toBe(0);
  expect(root.textContent).toContain(en.t("apps.filter.noMatch"));
  expect(pageShape(root)).toBe(held);
});

it("the held Archived header does not open", async () => {
  setAppsLayout({ filters: true, running: 2, stopped: 0, archived: 2 });
  const read = serve(appsFor({ running: 2, stopped: 0, archived: 2 }));
  const view = mount();
  await settle();
  const root = view.container;
  expect(archivedToggle(root)).not.toBeNull();
  const toggle = archivedToggle(root)!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.disabled).toBe(true);
  await act(async () => toggle.click());

  await read.answer();
  expect(archivedToggle(root)!.disabled).toBe(false);
  expect(archivedToggle(root)!.getAttribute("aria-expanded")).toBe("false");
  expect(rowsIn(root, "archived")).toBe(0);
});

it("after a failed first load it keeps the held shape but stops saying it loads", async () => {
  setAppsLayout({ filters: true, running: 2, stopped: 1, archived: 0 });
  const read = serve(appsFor({ running: 2, stopped: 1, archived: 0 }));
  const view = mount();
  await settle();
  const root = view.container;
  const before = pageShape(listBox(root));
  await read.fail();

  expect(root.textContent).toContain(en.t("apps.loadFailed"));
  expect(root.textContent).not.toContain(loading);
  expect(busy(root)).toBe(0);
  expect(heldRows(root)).toBe(3);
  expect(filterBar(root)).not.toBeNull();
  expect(pageShape(listBox(root))).toBe(before);
});

it("stores the rows each section shows after the filters, once the list answers", async () => {
  window.localStorage.setItem("isomux-apps-only-mine", "true");
  // Unlike the answer below, and unlike what a write while held would store
  // (no bar, every count 0).
  const stored = { filters: false, running: 1, stopped: 2, archived: 0 };
  setAppsLayout(stored);
  const read = serve([
    app("mine-a", "running"),
    app("mine-b", "running"),
    app("theirs-a", "running", "u2"),
    app("theirs-b", "stopped", "u2"),
    app("mine-old", "archived"),
  ]);
  mount();
  await settle();
  // Held: nothing is stored for a load that has not answered.
  expect(getAppsLayout()).toEqual(stored);

  await read.answer();
  expect(getAppsLayout()).toEqual({
    filters: true,
    running: 2,
    stopped: 0,
    archived: 1,
  });
});

it("stores no filter bar when the office has no apps", async () => {
  const read = serve([]);
  const view = mount();
  await settle();
  await read.answer();
  expect(filterBar(view.container)).toBeNull();
  expect(getAppsLayout()).toEqual({
    filters: false,
    running: 0,
    stopped: 0,
    archived: 0,
  });
});
