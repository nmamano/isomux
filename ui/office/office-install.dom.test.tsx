// Install the office as an app (tasks 5d536d33, 55310a37). In a phone or
// tablet browser that can install the office, the office view shows a notice
// until the member closes it or installs from it: on Chrome its Install
// button calls the held beforeinstallprompt event, on iPhone it shows the
// Share > Add to Home Screen steps. The phone menu keeps an "Install as app"
// item after the notice is gone. Where it shows:
// office-install-devices.dom.test.tsx.

import { expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { fireEvent, act } = await import("@testing-library/react");
const { heldInstallPrompt, readInstallEnv } = await import("../app-install.ts");
const { IOS_UA, iphoneWith } = await import("../test-support/ios-browsers.ts");
const { expectInlineInstallSteps } =
  await import("../test-support/install-steps.ts");
const { en } = await import("../../shared/i18n/en.ts");
const {
  ANDROID,
  asChrome,
  installEvent,
  IPHONE_SAFARI,
  mount,
  onDevice,
  setUpOfficeInstallFile,
} = await import("../test-support/office-install-fixture.tsx");
setUpOfficeInstallFile();

it("shows the iPhone steps until the member closes them, and the menu reopens them", () => {
  onDevice(IPHONE_SAFARI);
  let page = mount();
  const notice = page.notice();
  expect(notice).not.toBeNull();
  expect(notice!.dataset.officeInstallNotice).toBe("steps");
  // "Works better as an app", then the steps with their drawn icons (iOS
  // draws glyphs as emoji).
  expect(notice!.textContent).toContain(en["officeInstall.notice"]);
  expectInlineInstallSteps(notice!);
  // Steps only: Safari has no install dialog to call.
  expect(notice!.querySelectorAll("button")).toHaveLength(1);
  // Nil, 2026-10-23: going into a chat and back is no dismiss.
  page = mount();
  expect(page.notice()?.dataset.officeInstallNotice).toBe("steps");
  fireEvent.click(page.dismiss()!);
  expect(page.notice()).toBeNull();
  page = mount();
  expect(page.notice()).toBeNull();
  // The menu still offers it, and opens the steps although closed.
  const item = page.menuItem();
  expect(item).not.toBeNull();
  fireEvent.click(item!);
  expect(page.notice()?.dataset.officeInstallNotice).toBe("steps");
  fireEvent.click(page.dismiss()!);
  expect(page.notice()).toBeNull();
  // The menu opens them again after a dismiss.
  fireEvent.click(page.menuItem()!);
  expect(page.notice()?.dataset.officeInstallNotice).toBe("steps");
  fireEvent.click(page.dismiss()!);
  expect(page.notice()).toBeNull();
});

it("waits for Chrome's event on Android, installs with it, and then offers nothing", async () => {
  asChrome();
  const page = mount();
  // No event yet: Chrome may not offer one at all.
  expect(page.notice()).toBeNull();
  expect(page.menuItem()).toBeNull();
  const { event, prompt } = installEvent();
  await act(async () => {
    window.dispatchEvent(event);
  });
  const notice = page.notice();
  expect(notice?.dataset.officeInstallNotice).toBe("prompt");
  const install = [...notice!.querySelectorAll("button")].find(
    (b) => !b.hasAttribute("data-office-install-dismiss"),
  );
  expect(install).toBeDefined();
  expect(page.dismiss()).not.toBeNull();
  await act(async () => {
    fireEvent.click(install!);
  });
  expect(prompt).toHaveBeenCalledTimes(1);
  // A used event cannot prompt again.
  expect(heldInstallPrompt()).toBeNull();
  expect(page.notice()).toBeNull();
  expect(page.menuItem()).toBeNull();
});

// The member acted on the notice, whatever they chose in Chrome's dialog.
// Chrome can offer a new event on a later visit: the phone menu installs with
// it. Closing the notice puts it away the same way (the iPhone test).
it("does not show the notice again after its Install button, and the menu installs with a new event", async () => {
  asChrome();
  let page = mount();
  await act(async () => {
    window.dispatchEvent(installEvent("dismissed").event);
  });
  const install = [...page.notice()!.querySelectorAll("button")].find(
    (b) => !b.hasAttribute("data-office-install-dismiss"),
  );
  await act(async () => {
    fireEvent.click(install!);
  });
  page = mount();
  const { event, prompt } = installEvent();
  await act(async () => {
    window.dispatchEvent(event);
  });
  // The condition: the new event is held, and the menu offers it.
  expect(heldInstallPrompt() === event).toBe(true);
  expect(page.notice()).toBeNull();
  const item = page.menuItem();
  expect(item).not.toBeNull();
  await act(async () => {
    fireEvent.click(item!);
  });
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(page.notice()).toBeNull();
  expect(page.menuItem()).toBeNull();
});

// A mail or social app's view (task 5765f58e) has no Add to Home Screen, and
// the invite link that opened it is used up (Nil, 2026-11-23, task
// 260686c9): the member's own browser is not signed in yet. A signed-in
// member goes to Settings > New device for a sign-in link to open there. The
// member acted on the notice, so it does not come back on its own; the phone
// menu opens it again.
it("sends a signed-in member from an iPhone in-app view to New device, and the menu reopens it", async () => {
  onDevice(iphoneWith(IOS_UA.facebook));
  const written: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  const onOpenNewDevice = mock(() => {});
  const props = { onOpenNewDevice };
  try {
    let page = mount(true, { props });
    const notice = page.notice();
    expect(notice?.dataset.officeInstallNotice).toBe("browser");
    expect(notice!.querySelector("[data-install-icon]")).toBeNull();
    expect(notice!.querySelector("a")).toBeNull();
    const buttons = [
      ...notice!.querySelectorAll<HTMLButtonElement>("[data-browser-install]"),
    ];
    expect(buttons.map((b) => b.dataset.browserInstall)).toEqual(["sign-in"]);
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    expect(onOpenNewDevice).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
    page = mount(true, { props });
    expect(page.notice()).toBeNull();
    const item = page.menuItem();
    expect(item).not.toBeNull();
    fireEvent.click(item!);
    expect(page.notice()?.dataset.officeInstallNotice).toBe("browser");
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

// Without sign-in the office's link opens in any browser: the notice copies it.
it("copies the office's link from an iPhone in-app view of an office without sign-in, and the menu reopens it", async () => {
  onDevice(iphoneWith(IOS_UA.facebook));
  const written: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  const onOpenNewDevice = mock(() => {});
  try {
    const page = mount(true, {
      props: { onOpenNewDevice },
      state: { sessionContext: null },
    });
    const notice = page.notice();
    expect(notice?.dataset.officeInstallNotice).toBe("browser");
    expect(notice!.querySelector("a")).toBeNull();
    const buttons = [
      ...notice!.querySelectorAll<HTMLButtonElement>("[data-browser-install]"),
    ];
    expect(buttons.map((b) => b.dataset.browserInstall)).toEqual(["copy"]);
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    expect(written).toEqual([`${window.location.origin}/`]);
    expect(onOpenNewDevice).not.toHaveBeenCalled();
    fireEvent.click(page.dismiss()!);
    expect(page.notice()).toBeNull();
    const item = page.menuItem();
    expect(item).not.toBeNull();
    fireEvent.click(item!);
    expect(page.notice()?.dataset.officeInstallNotice).toBe("browser");
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

// The browser is read from the user agent in an iPhone tab only: a Home
// Screen window's user agent names no browser, and it is no in-app view.
for (const [label, device, browser] of [
  ["an iPhone Chrome tab", iphoneWith(IOS_UA.chrome), "chrome"],
  [
    "an iPhone Home Screen window",
    { ...iphoneWith(IOS_UA.webview), standalone: true },
    null,
  ],
  ["Android", ANDROID, null],
] as const) {
  it(`reads the iPhone browser in ${label}: ${String(browser)}`, () => {
    onDevice(device);
    expect(readInstallEnv().iosBrowser).toBe(browser);
  });
}
