// Settings > Device label in an iPhone in-app view (task 260686c9): the
// member's own browser is not signed in yet, so "Install as app" opens
// Settings > New device, which makes a sign-in link to open there. Going
// there leaves the Device label pane the usual way: an unsaved label asks
// first. The entry's own cases: DevicePane.install.dom.test.tsx.

import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const { en } = await import("../../shared/i18n/en.ts");
const { asDevice } = await import("../test-support/ios-home-screen.ts");
const { IOS_UA, iphoneWith } = await import("../test-support/ios-browsers.ts");
const { apiCalls, click, discardPrompt, mount, resetDrillIn, type } =
  await import("../test-support/drill-in-fixture.tsx");

let undoDevice = () => {};
beforeEach(() => {
  resetDrillIn();
  undoDevice = asDevice(iphoneWith(IOS_UA.instagram));
});
afterEach(() => {
  undoDevice();
  undoDevice = () => {};
});
afterAll(() => setApiShim(null));

const props = { initialTarget: { kind: "section", section: "deviceLabel" } };
const mints = () =>
  apiCalls().filter(
    (c) => c.method === "POST" && c.path === "/api/invites/self",
  ).length;
const signIn = (view: Awaited<ReturnType<typeof mount>>) =>
  view.baseElement.querySelector<HTMLButtonElement>(
    '[data-office-install-entry] [data-browser-install="sign-in"]',
  );
// The condition: the entry sends the member to a browser (another app's view).
const entryMode = (view: Awaited<ReturnType<typeof mount>>) =>
  view.baseElement
    .querySelector<HTMLElement>("[data-office-install-entry]")
    ?.getAttribute("data-office-install-entry") ?? null;
const labelField = (view: Awaited<ReturnType<typeof mount>>) =>
  view.baseElement.querySelector<HTMLInputElement>(
    `input[placeholder="${en["settings.device.placeholder"]}"]`,
  );

it("opens New device from Install as app, which makes one sign-in link", async () => {
  const view = await mount(props);
  expect(labelField(view)).not.toBeNull();
  expect(entryMode(view)).toBe("browser");
  expect(mints()).toBe(0);
  await click(signIn(view));
  // The Device label pane is gone and New device made its link.
  expect(labelField(view)).toBeNull();
  expect(signIn(view)).toBeNull();
  expect(mints()).toBe(1);
  view.unmount();
});

it("asks before it leaves an unsaved device label", async () => {
  const view = await mount(props);
  await type(labelField(view), "Desk laptop");
  expect(entryMode(view)).toBe("browser");
  await click(signIn(view));
  expect(discardPrompt(view)).not.toBeNull();
  // Still on Device label, with the edit; no link yet.
  expect(labelField(view)?.value).toBe("Desk laptop");
  expect(mints()).toBe(0);
  view.unmount();
});
