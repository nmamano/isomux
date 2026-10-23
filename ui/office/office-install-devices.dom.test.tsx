// Where the office's Install as app shows (tasks 5d536d33, 55310a37): the
// notice and the phone menu's item, in a phone or tablet browser that can
// install the office. Nothing shows in an installed window, after an install
// from outside the office, or on a computer, whatever the window width.
// ui/app-install.test.ts tells each device kind apart; this file checks that
// the office view asks it. The flows: office-install.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act } = await import("@testing-library/react");
const { heldInstallPrompt } = await import("../app-install.ts");
const { IPHONE_HOME_SCREEN } =
  await import("../test-support/ios-home-screen.ts");
const {
  ANDROID_APP,
  asChrome,
  installEvent,
  mount,
  onDevice,
  setUpOfficeInstallFile,
  withPointer,
} = await import("../test-support/office-install-fixture.tsx");
setUpOfficeInstallFile();

for (const [label, device] of [
  ["the iPhone Home Screen", IPHONE_HOME_SCREEN],
  ["an installed Chrome window", ANDROID_APP],
] as const) {
  it(`shows no notice and no menu item in ${label}`, async () => {
    if (device === ANDROID_APP) asChrome(device);
    else onDevice(device);
    const page = mount();
    // Chrome does not offer an installed app, but nothing may rely on that.
    await act(async () => {
      window.dispatchEvent(installEvent().event);
    });
    expect(page.notice()).toBeNull();
    expect(page.menuItem()).toBeNull();
  });
}

it("drops the notice and the menu item when the office is installed another way", async () => {
  asChrome();
  const page = mount();
  await act(async () => {
    window.dispatchEvent(installEvent().event);
  });
  expect(page.notice()).not.toBeNull();
  await act(async () => {
    window.dispatchEvent(new Event("appinstalled"));
  });
  expect(page.notice()).toBeNull();
  expect(page.menuItem()).toBeNull();
});

// Nil, 2026-10-23: an app is no better than a tab on a computer, so the
// notice is for phones and tablets. Settings > Device label keeps the entry.
// A touch screen with a mouse or trackpad as the primary pointer is a
// computer, and so is a window narrow enough for the phone layout: the one
// layout with a menu item, and the notice does not read the layout.
it("shows no notice and no menu item on a touchscreen laptop in the phone layout", async () => {
  asChrome({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    platform: "Win32",
    maxTouchPoints: 10,
  });
  withPointer(false, true);
  const page = mount();
  await act(async () => {
    window.dispatchEvent(installEvent().event);
  });
  // The condition: the same event shows the notice on a phone.
  expect(heldInstallPrompt()).not.toBeNull();
  expect(page.notice()).toBeNull();
  expect(page.menuItem()).toBeNull();
});

// A tablet wide enough for the desktop layout still gets the notice. The
// desktop bar has no install item: on a computer it would sit there in every
// window, and Settings > Device label has it.
it("shows the iPad steps in the desktop layout, with no install item in the bar", () => {
  // iPadOS Safari asks for desktop sites and reads as a Mac with touch.
  onDevice({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 5,
    standalone: false,
  });
  const page = mount(false);
  expect(page.notice()?.dataset.officeInstallNotice).toBe("steps");
  expect(page.menuItem()).toBeNull();
});

// Chrome on a large Android tablet sends a desktop user agent: only the
// touch pointer tells it from a computer.
it("shows the notice on an Android tablet with a desktop user agent", async () => {
  asChrome({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    platform: "Linux x86_64",
    maxTouchPoints: 5,
  });
  withPointer(true);
  const page = mount(false);
  await act(async () => {
    window.dispatchEvent(installEvent().event);
  });
  expect(page.notice()?.dataset.officeInstallNotice).toBe("prompt");
});
