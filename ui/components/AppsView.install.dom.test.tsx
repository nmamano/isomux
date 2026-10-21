// "Install as app" in the Apps page's ⋯ menu (task 8a07aa4e). Every member
// who sees an app with a short link may install it, so a member who cannot
// manage the app gets a menu too, holding only this item. The item is a link
// to the short link with the install hash, because on the iPhone Home Screen
// office it must leave for Safari (the x-safari scheme works as a navigation),
// where Add to Home Screen runs.

import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { AppsView } = await import("./AppsView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { INSTALL_HASH } = await import("../app-install.ts");
const { asDevice, IPHONE_HOME_SCREEN } =
  await import("../test-support/ios-home-screen.ts");
type AppListWire = import("../../shared/types.ts").AppListWire;

const SHORT = "https://office.example/short";
function app(name: string, over: Partial<AppListWire>): AppListWire {
  return {
    name,
    command: "bun run start",
    cwd: "/fixture",
    port: 21000,
    hostLabel: name,
    hostGen: 1,
    userId: "u1",
    username: "Owner",
    createdBy: "Owner",
    createdAt: 1,
    state: "running",
    restartCount: 0,
    url: `https://${name}.office.example`,
    canManage: false,
    ...over,
  } as AppListWire;
}
let apps: AppListWire[] = [];
setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/apps") return apps;
  throw new Error(`Unexpected request: ${method} ${path}`);
});
let undoDevice = () => {};
let view: ReturnType<typeof render> | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  undoDevice();
  undoDevice = () => {};
  Reflect.deleteProperty(window, "onbeforeinstallprompt");
});
afterAll(() => setApiShim(null));

function asChrome() {
  (window as unknown as Record<string, unknown>).onbeforeinstallprompt = null;
}

async function mount(list: AppListWire[]) {
  apps = list;
  view = render(
    onLanguage("en", <AppsView onClose={() => {}} />, {
      apps,
      appsLoaded: true,
    }),
  );
  await act(async () => {});
  const row = (name: string) =>
    view!.container.querySelector<HTMLElement>(`[data-app-row="${name}"]`)!;
  const menuButton = (name: string) =>
    row(name).querySelector<HTMLButtonElement>("[data-app-menu-button]");
  const openMenu = async (name: string) => {
    const button = menuButton(name);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
  };
  const actions = () =>
    [
      ...document.querySelectorAll("[data-app-menu] [data-app-menu-action]"),
    ].map((item) => item.getAttribute("data-app-menu-action"));
  const installLink = () =>
    document.querySelector<HTMLAnchorElement>(
      '[data-app-menu] [data-app-menu-action="install"] a',
    );
  return { row, menuButton, openMenu, actions, installLink };
}

for (const [label, setUp, href] of [
  ["Chrome", asChrome, SHORT + INSTALL_HASH],
  [
    "the iPhone Home Screen office",
    () => {
      undoDevice = asDevice(IPHONE_HOME_SCREEN);
    },
    "x-safari-" + SHORT + INSTALL_HASH,
  ],
] as const) {
  it(`offers a member who cannot manage the app only Install, as a link (${label})`, async () => {
    setUp();
    const page = await mount([
      app("short", { shortUrl: SHORT }),
      app("nolink", {}),
    ]);
    // An app with no short link has no install page, so nothing to offer.
    expect(page.menuButton("nolink")).toBeNull();
    await page.openMenu("short");
    expect(page.actions()).toEqual(["install"]);
    const link = page.installLink();
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(href);
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")?.split(" ")).toContain("noopener");
    expect(link!.textContent).toContain(
      (await import("../../shared/i18n/en.ts")).en["apps.menu.install"],
    );
  });
}

it("puts Install first in a manager's menu, before the manage verbs", async () => {
  asChrome();
  const page = await mount([
    app("short", { shortUrl: SHORT, canManage: true }),
  ]);
  await page.openMenu("short");
  const actions = page.actions();
  expect(actions[0]).toBe("install");
  expect(actions).toContain("log");
  expect(actions.at(-1)).toBe("delete");
});

it("offers no menu to a member who cannot manage the app where the browser cannot install", async () => {
  // happy-dom is neither Chromium nor iOS.
  const page = await mount([app("short", { shortUrl: SHORT })]);
  expect(page.menuButton("short")).toBeNull();
});
