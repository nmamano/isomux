// Settings > Device label in an iPhone in-app view (task 260686c9): the
// member's own browser is not signed in yet, so "Install as app" opens
// Settings > New device, which makes a sign-in link to open there. Going
// there leaves the Device label pane the usual way: an unsaved label asks
// first. The entry's own cases: DevicePane.install.dom.test.tsx.

import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { en } = await import("../../shared/i18n/en.ts");
const { asDevice } = await import("../test-support/ios-home-screen.ts");
const { IOS_UA, iphoneWith } = await import("../test-support/ios-browsers.ts");
const {
  apiCalls,
  click,
  discardPrompt,
  mount,
  resetDrillIn,
  SIGN_IN_LINK,
  type,
} = await import("../test-support/drill-in-fixture.tsx");

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

// Opened from here, the member opens the link in their browser on this phone
// (Nil, 2026-11-23, task 149f9eac): New device shows it to copy, with no QR
// code. The sidebar row keeps the QR: ui/new-device-pane.dom.test.tsx.
it("opens New device from Install as app, which makes one sign-in link to copy with no QR code", async () => {
  const view = await mount(props);
  expect(labelField(view)).not.toBeNull();
  expect(entryMode(view)).toBe("browser");
  expect(mints()).toBe(0);
  await click(signIn(view));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The Device label pane is gone and New device made its link.
  expect(labelField(view)).toBeNull();
  expect(signIn(view)).toBeNull();
  expect(mints()).toBe(1);
  const text = view.baseElement.textContent ?? "";
  expect(text).toContain(SIGN_IN_LINK);
  expect(
    view.baseElement.querySelectorAll("[data-device-qr]").length,
    "no QR code",
  ).toBe(0);
  expect(text).toContain(en["settings.devices.browserHint"]);
  expect(text).not.toContain(en["settings.devices.newDeviceHint"]);
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
