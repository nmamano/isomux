import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { AppsView } = await import("./AppsView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
type AppListWire = import("../../shared/types.ts").AppListWire;
type AppState = import("../../shared/types.ts").AppState;

// onLanguage's self user.
const SELF = "u1";

function app(name: string, userId: string, state: AppState): AppListWire {
  return {
    name,
    port: 21000,
    userId,
    username: userId,
    createdByAgentId: "agent",
    createdAt: 1,
    state,
    restartCount: 0,
    canManage: false,
  };
}

const apps = [
  app("mine-running", SELF, "running"),
  app("mine-stopped", SELF, "stopped"),
  app("other-running", "u2", "running"),
  app("other-failed", "u2", "failed"),
];

setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/apps") return apps;
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => localStorage.clear());

async function mount(signedIn = true) {
  const view = render(
    onLanguage("en", <AppsView onClose={() => {}} />, {
      apps,
      appsLoaded: true,
      ...(signedIn ? {} : { sessionContext: null }),
    }),
  );
  await act(async () => {});
  const box = (filter: string) =>
    view.container.querySelector<HTMLInputElement>(
      `input[data-app-filter="${filter}"]`,
    );
  const listed = () =>
    apps
      .map((a) => a.name)
      .filter((name) => view.queryByRole("link", { name }) !== null);
  return { view, box, listed };
}

it("hides other members' apps, and remembers that on this device", async () => {
  const first = await mount();
  expect(first.listed()).toEqual(apps.map((a) => a.name));
  expect(first.box("onlyMine")!.checked).toBe(false);
  await act(async () => first.box("onlyMine")!.click());
  expect(first.listed()).toEqual(["mine-running", "mine-stopped"]);
  first.view.unmount();

  const reloaded = await mount();
  expect(reloaded.box("onlyMine")!.checked).toBe(true);
  expect(reloaded.listed()).toEqual(["mine-running", "mine-stopped"]);
  await act(async () => reloaded.box("onlyMine")!.click());
  reloaded.view.unmount();

  const again = await mount();
  expect(again.box("onlyMine")!.checked).toBe(false);
  again.view.unmount();
});

it("has no Hide-stopped filter: stopped and failed apps stay listed", async () => {
  const { view, listed } = await mount();
  const filters = view.container.querySelectorAll("input[data-app-filter]");
  expect(Array.from(filters, (f) => f.getAttribute("data-app-filter"))).toEqual(
    ["onlyMine"],
  );
  expect(listed()).toContain("mine-stopped");
  expect(listed()).toContain("other-failed");
  view.unmount();
});

it("keeps the filters reachable when they hide every app", async () => {
  const { view, box, listed } = await mount();
  await act(async () => box("onlyMine")!.click());
  expect(listed()).toEqual(["mine-running", "mine-stopped"]);
  // Hand both of the member's apps to someone else and nothing passes; the
  // filter stays on screen so it can be turned off again.
  view.rerender(
    onLanguage("en", <AppsView onClose={() => {}} />, {
      apps: apps.map((a) => ({ ...a, userId: "u2" })),
      appsLoaded: true,
    }),
  );
  expect(listed()).toEqual([]);
  expect(box("onlyMine")).not.toBeNull();
  view.unmount();
});

it("offers no owner filter without a session, and a stored one hides nothing", async () => {
  localStorage.setItem("isomux-apps-only-mine", "true");
  const { view, box, listed } = await mount(false);
  expect(box("onlyMine")).toBeNull();
  expect(
    view.container.querySelector("select[data-room-filter]"),
  ).not.toBeNull();
  expect(listed()).toEqual(apps.map((a) => a.name));
  view.unmount();
});

it("filters by the creator agent's live room and remembers the room on this device", async () => {
  const roomed = [
    { ...app("in-alpha", SELF, "running"), createdByAgentId: "agent-a" },
    { ...app("in-beta", "u2", "running"), createdByAgentId: "agent-b" },
    { ...app("creator-gone", "u2", "running"), createdByAgentId: "gone" },
  ];
  const state = {
    apps: roomed,
    appsLoaded: true,
    rooms: [
      { id: "a1a1a1a1", name: "Alpha" },
      { id: "b2b2b2b2", name: "Beta" },
    ],
    agents: [
      { id: "agent-a", name: "A", roomId: "a1a1a1a1" },
      { id: "agent-b", name: "B", roomId: "b2b2b2b2" },
    ],
  } as unknown as Parameters<typeof onLanguage>[2];
  const mountRooms = async () => {
    const view = render(
      onLanguage("en", <AppsView onClose={() => {}} />, state),
    );
    await act(async () => {});
    const listed = () =>
      roomed
        .map((a) => a.name)
        .filter((name) => view.queryByRole("link", { name }) !== null);
    const select = () =>
      view.container.querySelector<HTMLSelectElement>(
        "select[data-room-filter]",
      )!;
    return { view, listed, select };
  };
  const { fireEvent } = await import("@testing-library/react");
  const first = await mountRooms();
  expect(first.listed()).toEqual(["in-alpha", "in-beta", "creator-gone"]);
  await act(async () => {
    fireEvent.change(first.select(), { target: { value: "b2b2b2b2" } });
  });
  expect(first.listed()).toEqual(["in-beta"]);
  await act(async () => {
    fireEvent.change(first.select(), { target: { value: "none" } });
  });
  expect(first.listed()).toEqual(["creator-gone"]);
  first.view.unmount();
  const again = await mountRooms();
  expect(again.select().value).toBe("none");
  again.view.unmount();
});
