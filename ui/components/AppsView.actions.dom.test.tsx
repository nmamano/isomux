// The Apps page rendered with the real store, so each case reaches a call site
// in AppsView: the thumbnail's link, its play button, the ⋯ menu, and the
// Archived section. Requests go through the api shim and are recorded.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { AppsView } = await import("./AppsView.tsx");
const { StoreProvider } = await import("../store.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { connect, setShim } = await import("../ws.ts");
type AppListWire = import("../../shared/types.ts").AppListWire;
type AppState = import("../../shared/types.ts").AppState;

setShim(() => {});
afterAll(() => {
  setApiShim(null);
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});

function app(
  name: string,
  state: AppState,
  over: Record<string, unknown> = {},
): AppListWire {
  return {
    name,
    command: "bun run start",
    cwd: "/fixture",
    dataDir: `/fixture/data/${name}`,
    port: 21000,
    hostLabel: name,
    hostGen: 1,
    userId: "owner",
    username: "Owner",
    createdBy: "Owner",
    createdAt: 1,
    state,
    restartCount: 0,
    url: `https://${name}.office.example`,
    canManage: true,
    ...over,
  };
}

// A verb's response is an AppWire: the list's canManage field is not on it.
const wire = (a: AppListWire) => {
  const { canManage: _list, ...rest } = a;
  return rest;
};

let list: AppListWire[] = [];
let calls: string[] = [];
let answer: (method: string, path: string) => unknown = () => {
  throw new Error("no answer set");
};
beforeEach(() => {
  calls = [];
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/apps") return list;
    calls.push(`${method} ${path}`);
    return answer(method, path);
  });
});

async function mount() {
  const view = render(
    <StoreProvider>
      <AppsView onClose={() => {}} />
    </StoreProvider>,
  );
  await act(async () => {});
  const row = (name: string) =>
    view.container.querySelector<HTMLElement>(`[data-app-row="${name}"]`);
  const section = (name: string) =>
    view.container.querySelector<HTMLElement>(`[data-app-section="${name}"]`);
  const sectionOf = (name: string) =>
    row(name)?.closest("[data-app-section]")?.getAttribute("data-app-section");
  const openMenu = async (name: string) => {
    await act(async () =>
      row(name)!
        .querySelector<HTMLButtonElement>("[data-app-menu-button]")!
        .click(),
    );
  };
  const menuItem = (action: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-app-menu] [data-app-menu-action="${action}"] button`,
    );
  return { view, row, section, sectionOf, openMenu, menuItem };
}

it("a running app's thumbnail is a link to the app", async () => {
  list = [app("habits", "running")];
  const { view, row } = await mount();
  const thumb = row("habits")!.querySelector<HTMLAnchorElement>(
    'a[data-app-thumbnail="open"]',
  );
  expect(thumb).not.toBeNull();
  // The same address the name links to: the app's own URL.
  expect(thumb!.getAttribute("href")).toBe("https://habits.office.example");
  expect(thumb!.getAttribute("target")).toBe("_blank");
  view.unmount();
});

it("shows the uploaded thumbnail at its versioned URL, and none without one", async () => {
  list = [
    app("habits", "running", { thumbnailUpdatedAt: 77 }),
    app("plain", "running"),
  ];
  const { view, row } = await mount();
  expect(row("habits")!.querySelector("img")!.getAttribute("src")).toBe(
    "/api/apps/habits/thumbnail?v=77",
  );
  expect(row("plain")!.querySelector("img")).toBeNull();
  view.unmount();
});

it("a new thumbnail version gets its own chance after an old one failed to load", async () => {
  list = [app("habits", "running", { thumbnailUpdatedAt: 77 })];
  // The app's next state carries a newer upload, as an app_upserted would.
  answer = () => wire(app("habits", "running", { thumbnailUpdatedAt: 88 }));
  const { view, row, openMenu, menuItem } = await mount();
  const img = row("habits")!.querySelector("img")!;
  expect(img.getAttribute("src")).toBe("/api/apps/habits/thumbnail?v=77");
  await act(async () => {
    img.dispatchEvent(new Event("error"));
  });
  // The failed image gives way to the letter fallback.
  expect(row("habits")!.querySelector("img")).toBeNull();
  await openMenu("habits");
  await act(async () => menuItem("restart")!.click());
  expect(calls).toEqual(["POST /api/apps/habits/restart"]);
  expect(row("habits")!.querySelector("img")?.getAttribute("src")).toBe(
    "/api/apps/habits/thumbnail?v=88",
  );
  view.unmount();
});

it("a stopped app's thumbnail starts it", async () => {
  list = [app("habits", "stopped")];
  answer = () => wire(app("habits", "running"));
  const { view, row, sectionOf } = await mount();
  expect(sectionOf("habits")).toBe("stopped");
  await act(async () =>
    row("habits")!
      .querySelector<HTMLButtonElement>('button[data-app-thumbnail="start"]')!
      .click(),
  );
  expect(calls).toEqual(["POST /api/apps/habits/start"]);
  expect(sectionOf("habits")).toBe("running");
  view.unmount();
});

it("Archive in the menu archives the app into the closed Archived section", async () => {
  list = [app("habits", "stopped"), app("other", "running")];
  answer = () => wire(app("habits", "stopped", { archived: true }));
  const { view, row, section, openMenu, menuItem } = await mount();
  expect(section("archived")).toBeNull();
  await openMenu("habits");
  expect(menuItem("unarchive")).toBeNull();
  await act(async () => menuItem("archive")!.click());
  expect(calls).toEqual(["POST /api/apps/habits/archive"]);
  // Collapsed by default: the section is there, its rows are not.
  const archived = section("archived")!;
  expect(archived).not.toBeNull();
  expect(row("habits")).toBeNull();
  const toggle = archived.querySelector<HTMLButtonElement>(
    "button[aria-expanded]",
  )!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  // The open/closed mark is drawn: no text glyph for iOS to turn into emoji.
  expect(toggle.querySelector("svg")).not.toBeNull();
  expect(/[^\x20-\x7e]/.test(toggle.textContent ?? "")).toBe(false);
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(row("habits")).not.toBeNull();
  view.unmount();
});

it("an archived app offers Unarchive instead of Archive", async () => {
  list = [app("habits", "stopped", { archived: true })];
  answer = () => wire(app("habits", "stopped"));
  const { view, section, sectionOf, openMenu, menuItem } = await mount();
  await act(async () =>
    section("archived")!
      .querySelector<HTMLButtonElement>("button[aria-expanded]")!
      .click(),
  );
  await openMenu("habits");
  expect(menuItem("archive")).toBeNull();
  await act(async () => menuItem("unarchive")!.click());
  expect(calls).toEqual(["POST /api/apps/habits/unarchive"]);
  expect(sectionOf("habits")).toBe("stopped");
  view.unmount();
});

it("a viewer who cannot manage the app gets no menu and no play button", async () => {
  list = [
    app("theirs", "stopped", { canManage: false }),
    app("live", "running", { canManage: false }),
  ];
  const { view, row } = await mount();
  expect(row("theirs")!.querySelector("[data-app-menu-button]")).toBeNull();
  expect(row("theirs")!.querySelector("[data-app-thumbnail]")).toBeNull();
  expect(
    row("live")!.querySelector('a[data-app-thumbnail="open"]'),
  ).not.toBeNull();
  view.unmount();
});

it("disables the menu verbs while a request is out, and shows a failure", async () => {
  list = [app("habits", "running")];
  let reject!: (reason: unknown) => void;
  answer = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
    });
  const { view, openMenu, menuItem } = await mount();
  await openMenu("habits");
  await act(async () => menuItem("stop")!.click());
  expect(calls).toEqual(["POST /api/apps/habits/stop"]);
  await openMenu("habits");
  expect(menuItem("restart")!.getAttribute("aria-disabled")).toBe("true");
  expect(menuItem("log")!.getAttribute("aria-disabled")).toBeNull();
  const failure = "fixture supervisor failure";
  await act(async () =>
    reject(new ApiError(500, "supervisor_failed", failure)),
  );
  expect(view.container.textContent).toContain(failure);
  view.unmount();
});
