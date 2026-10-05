// The pager view's app source link: the best-effort match, and the apps read
// on mount and on every hydration. Shared setup is in
// ui/test-support/pager-view-fixture.tsx.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { sourceApp } = await import("./PagerView.tsx");
const { h, mount, page, row, setupPagerViewTests, shim } =
  await import("../test-support/pager-view-fixture.tsx");
setupPagerViewTests();
type AppListWire = import("../../shared/types.ts").AppListWire;
type View = Awaited<ReturnType<typeof mount>>["view"];

describe("app sources", () => {
  const appPage = page("p1", {
    createdAt: 5_000,
    source: {
      kind: "app",
      appName: "health",
      registrationGen: 1,
      name: "health",
      roomId: "r1",
    },
  });
  const app = (createdAt: number) =>
    ({
      name: "health",
      port: 21000,
      createdAt,
      state: "running",
      restartCount: 0,
      url: "https://health.office.example",
      userId: "u1",
      username: "Nil",
      createdByAgentId: "a1",
      canManage: false,
    }) as AppListWire;

  it("matches the registration that raised the page, not a later one", async () => {
    expect(sourceApp(appPage, [app(4_000)])).not.toBeNull();
    expect(sourceApp(appPage, [app(6_000)])).toBeNull();
    expect(sourceApp(page("p2"), [app(4_000)])).toBeNull();
    const undated = { ...app(4_000), createdAt: undefined } as unknown;
    expect(sourceApp(appPage, [undated as AppListWire])).toBeNull();
  });

  it("links to the app it reads on mount, and stays text for a replacement", async () => {
    shim.apps = [app(4_000)];
    const { view } = await mount([appPage]);
    expect(shim.calls).toContain("GET /api/apps");
    const link = row(view, "p1").querySelector<HTMLAnchorElement>(
      "a.pager-source-link",
    );
    expect(link?.getAttribute("href")).toBe("https://health.office.example");
    view.unmount();

    shim.apps = [app(6_000)];
    const { view: replaced } = await mount([appPage]);
    expect(replaced.container.querySelector(".pager-source-link")).toBeNull();
  });

  const reconnect = () =>
    act(async () =>
      h.dispatch({
        type: "full_state",
        agents: h.latest.agents,
        rooms: h.latest.rooms,
        office: { name: "Test" },
        recentCwds: [],
        killedAgents: [],
        interactions: [],
      } as never),
    );
  const href = (view: View) =>
    view.container.querySelector("a.pager-source-link")?.getAttribute("href") ??
    null;
  const appReads = () => shim.calls.filter((c) => c === "GET /api/apps").length;

  it("reads the apps again after a reconnect, so a replacement loses the link", async () => {
    shim.apps = [app(4_000)];
    const { view } = await mount([appPage]);
    expect(href(view)).toBe("https://health.office.example");
    expect(appReads()).toBe(1);
    shim.apps = [app(6_000)];
    await reconnect();
    expect(h.latest.hydrationEpoch).toBe(1);
    expect(appReads()).toBe(2);
    expect(href(view)).toBeNull();
  });

  it("drops an apps answer from before the reconnect", async () => {
    shim.heldApps = [];
    const held = shim.heldApps;
    const { view } = await mount([appPage]);
    await reconnect();
    expect(held.length).toBe(2);
    await act(async () => held[1]([app(4_000)]));
    expect(href(view)).toBe("https://health.office.example");
    // The first run's answer names only the replacement; it must not land.
    await act(async () => held[0]([app(6_000)]));
    expect(href(view)).toBe("https://health.office.example");
  });

  it("reads again when an app delta overtakes the snapshot", async () => {
    shim.heldApps = [];
    const held = shim.heldApps;
    const { view } = await mount([appPage]);
    await act(async () =>
      h.dispatch({
        type: "app_upserted",
        app: { ...app(1_000), name: "other" },
      }),
    );
    await act(async () => held[0]([app(4_000)]));
    // Refused by the revision guard, so no link yet, and a second read.
    expect(href(view)).toBeNull();
    expect(held.length).toBe(2);
    await act(async () => held[1]([app(4_000)]));
    expect(href(view)).toBe("https://health.office.example");
  });
});
