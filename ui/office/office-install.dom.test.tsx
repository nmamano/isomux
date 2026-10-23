// Install the office as an app (tasks 5d536d33, 55310a37). In a phone or
// tablet browser that can install the office, the office view shows a notice
// until the member closes it or installs from it: on Chrome its Install
// button calls the held beforeinstallprompt event, on iPhone it shows the
// Share > Add to Home Screen steps. The phone menu keeps an "Install as app"
// item after the notice is gone. Nothing shows in an installed window or on a
// desktop, whatever the window width.

import { afterEach, beforeAll, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { OfficeView } = await import("./OfficeView.tsx");
const { captureInstallPrompt, heldInstallPrompt } =
  await import("../app-install.ts");
const { asDevice, IPHONE_HOME_SCREEN } =
  await import("../test-support/ios-home-screen.ts");
const { en } = await import("../../shared/i18n/en.ts");

// ui/index.tsx does this at boot.
beforeAll(() => captureInstallPrompt(window));

const IPHONE_SAFARI = { ...IPHONE_HOME_SCREEN, standalone: false };
const ANDROID = {
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
};
// Chrome's installed window, as readPushEnv reads it.
const ANDROID_APP = { ...ANDROID, standalone: true };

let undoDevice = () => {};
let undoPointer = () => {};
let view: ReturnType<typeof render> | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  undoDevice();
  undoDevice = () => {};
  undoPointer();
  undoPointer = () => {};
  Reflect.deleteProperty(window, "onbeforeinstallprompt");
  // No test may leave an event for the next one.
  window.dispatchEvent(new Event("appinstalled"));
  localStorage.clear();
});

// A browser with the beforeinstallprompt event (Chromium).
function asChrome(device: Parameters<typeof asDevice>[0] = ANDROID) {
  undoDevice = asDevice(device);
  (window as unknown as Record<string, unknown>).onbeforeinstallprompt = null;
}

// The primary pointer is coarse on a phone or tablet and fine with a mouse or
// a trackpad; any pointer is coarse on every touch screen. happy-dom answers
// both from maxTouchPoints, so it cannot tell a touchscreen laptop from a
// tablet. Other media queries keep happy-dom's answer.
function withPointer(primaryCoarse: boolean, anyCoarse = primaryCoarse) {
  const original = window.matchMedia;
  const answers: Record<string, boolean> = {
    "(pointer: coarse)": primaryCoarse,
    "(any-pointer: coarse)": anyCoarse,
  };
  window.matchMedia = ((query: string) =>
    query in answers
      ? {
          matches: answers[query],
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }
      : original.call(window, query)) as typeof window.matchMedia;
  undoPointer = () => {
    window.matchMedia = original;
  };
}

function installEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = mock(async () => {});
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    { prompt, userChoice: Promise.resolve({ outcome }) },
  );
  return { event, prompt };
}

const noop = () => {};
function mount(isMobile = true) {
  view?.unmount();
  view = render(
    onLanguage(
      "en",
      createElement(OfficeView, {
        onSpawn: noop,
        onContextMenu: noop,
        onOpenSettings: noop,
        onEditOfficePrompt: noop,
        onOpenThemePicker: noop,
        onOpenTasks: noop,
        onOpenCronjobs: noop,
        onOpenApps: noop,
        onOpenUpdate: noop,
      }),
      {
        lobbyOpen: true,
        isMobile,
        membersChat: {
          loaded: true,
          messages: [],
          hasMore: false,
          readPointer: null,
          unread: 0,
        },
      },
    ),
  );
  const v = view;
  const notice = () =>
    v.baseElement.querySelector<HTMLElement>("[data-office-install-notice]");
  return {
    notice,
    dismiss: () =>
      notice()?.querySelector<HTMLElement>("[data-office-install-dismiss]") ??
      null,
    // The phone menu's item: the menu renders in a portal. The desktop
    // layout has no menu and shows its actions in the bar.
    menuItem: () => {
      const menu = v.queryByTitle(en["common.moreActions"]);
      if (menu) fireEvent.click(menu);
      const item =
        v
          .queryAllByRole("button", { name: en["appWidget.install"] })
          .find((b) => !notice()?.contains(b)) ?? null;
      // Close the menu again when there is nothing to click.
      if (menu && !item) fireEvent.click(menu);
      return item;
    },
  };
}

it("shows the iPhone steps until the member closes them, and the menu reopens them", () => {
  undoDevice = asDevice(IPHONE_SAFARI);
  let page = mount();
  const notice = page.notice();
  expect(notice).not.toBeNull();
  expect(notice!.dataset.officeInstallNotice).toBe("steps");
  expect(notice!.textContent.trim()).not.toBe("");
  // The Share icon is drawn, not a glyph: iOS draws glyphs as emoji.
  expect(notice!.querySelector("svg")).not.toBeNull();
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

it("installs from the phone menu on Android after the notice is closed", async () => {
  asChrome();
  let page = mount();
  const { event, prompt } = installEvent();
  await act(async () => {
    window.dispatchEvent(event);
  });
  expect(page.notice()).not.toBeNull();
  // A reload with no dismiss shows it again.
  page = mount();
  expect(page.notice()?.dataset.officeInstallNotice).toBe("prompt");
  fireEvent.click(page.dismiss()!);
  expect(page.notice()).toBeNull();
  page = mount();
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

// The member acted on the notice, whatever they chose in Chrome's dialog.
// Chrome can offer a new event on a later visit.
it("does not show the notice again after its Install button, even with a new event", async () => {
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
});

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

for (const [label, device] of [
  ["the iPhone Home Screen", IPHONE_HOME_SCREEN],
  ["an installed Chrome window", ANDROID_APP],
] as const) {
  it(`shows no notice and no menu item in ${label}`, async () => {
    if (device === ANDROID_APP) asChrome(device);
    else undoDevice = asDevice(device);
    const page = mount();
    // Chrome does not offer an installed app, but nothing may rely on that.
    await act(async () => {
      window.dispatchEvent(installEvent().event);
    });
    expect(page.notice()).toBeNull();
    expect(page.menuItem()).toBeNull();
  });
}

// Nil, 2026-10-23: an app is no better than a tab on a computer, so the
// notice is for phones and tablets. A desktop window narrow enough for the
// phone layout is still a desktop. Settings > Device label keeps the entry.
for (const isMobile of [true, false]) {
  it(`shows no notice and no menu item on a desktop (phone layout: ${isMobile})`, async () => {
    asChrome({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      platform: "Linux x86_64",
      maxTouchPoints: 0,
    });
    withPointer(false);
    const page = mount(isMobile);
    await act(async () => {
      window.dispatchEvent(installEvent().event);
    });
    // The condition: the same event shows the notice on a phone.
    expect(heldInstallPrompt()).not.toBeNull();
    expect(page.notice()).toBeNull();
    expect(page.menuItem()).toBeNull();
  });
}

// A touch screen with a mouse or trackpad as the primary pointer is a
// computer.
for (const isMobile of [true, false]) {
  it(`shows no notice and no menu item on a touchscreen laptop (phone layout: ${isMobile})`, async () => {
    asChrome({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      platform: "Win32",
      maxTouchPoints: 10,
    });
    withPointer(false, true);
    const page = mount(isMobile);
    await act(async () => {
      window.dispatchEvent(installEvent().event);
    });
    expect(heldInstallPrompt()).not.toBeNull();
    expect(page.notice()).toBeNull();
    expect(page.menuItem()).toBeNull();
  });
}

// A tablet wide enough for the desktop layout still gets the notice.
it("shows the iPad steps in the desktop layout", () => {
  // iPadOS Safari asks for desktop sites and reads as a Mac with touch.
  undoDevice = asDevice({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 5,
    standalone: false,
  });
  const page = mount(false);
  expect(page.notice()?.dataset.officeInstallNotice).toBe("steps");
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
