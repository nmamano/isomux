import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { AppsView } = await import("./AppsView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { asDevice, IPHONE_HOME_SCREEN } =
  await import("../test-support/ios-home-screen.ts");
type AppListWire = import("../../shared/types.ts").AppListWire;

const apps: AppListWire[] = [
  {
    name: "short",
    url: "https://short.office.example",
    shortUrl: "https://office.example/short",
  },
  { name: "skills", url: "https://skills.office.example" },
  { name: "local" },
].map((app) => ({
  ...app,
  port: 21000,
  userId: "u1",
  username: "Owner",
  createdByAgentId: "creator",
  createdAt: 1,
  state: "running",
  restartCount: 0,
  canManage: false,
}));
setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/apps") return apps;
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));

it("prints each preferred address and opens it from the name and address links", async () => {
  const view = render(
    onLanguage("en", <AppsView onClose={() => {}} />, {
      apps,
      appsLoaded: true,
    }),
  );
  await act(async () => {});
  const expected = [
    apps[0].shortUrl!,
    apps[1].url!,
    `http://${window.location.hostname}:21000/`,
  ];
  apps.forEach((app, index) => {
    const row = view.container.querySelector(`[data-app-row="${app.name}"]`)!;
    const address = Array.from(row.querySelectorAll("a")).find(
      (link) => link.textContent === expected[index],
    );
    expect(address?.getAttribute("href")).toBe(expected[index]);
    expect(
      view.getByRole("link", { name: app.name }).getAttribute("href"),
    ).toBe(expected[index]);
  });
  view.unmount();
});

// iOS keeps a same-origin link inside the Home Screen window, which has no
// Back button, so there every app link opens Safari while the printed
// address stays the plain one.
it("opens every app in Safari from the iPhone Home Screen office", async () => {
  const undo = asDevice(IPHONE_HOME_SCREEN);
  try {
    const view = render(
      onLanguage("en", <AppsView onClose={() => {}} />, {
        apps,
        appsLoaded: true,
      }),
    );
    await act(async () => {});
    const expected = [
      apps[0].shortUrl!,
      apps[1].url!,
      `http://${window.location.hostname}:21000/`,
    ];
    apps.forEach((app, index) => {
      const row = view.container.querySelector(`[data-app-row="${app.name}"]`)!;
      const address = Array.from(row.querySelectorAll("a")).find(
        (link) => link.textContent === expected[index],
      );
      expect(address?.getAttribute("href")).toBe("x-safari-" + expected[index]);
      expect(
        view.getByRole("link", { name: app.name }).getAttribute("href"),
      ).toBe("x-safari-" + expected[index]);
    });
    view.unmount();
  } finally {
    undo();
  }
});
