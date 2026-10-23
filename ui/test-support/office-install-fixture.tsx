// The office view on a given device, for the Install as app tests
// (ui/office/office-install*.dom.test.tsx). Import it with await import after
// setUpDomTestFile(), and call setUpOfficeInstallFile() in the file body.

import { afterEach, beforeAll, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { onLanguage } from "./language-fixture.tsx";
import { OfficeView } from "../office/OfficeView.tsx";
import { captureInstallPrompt } from "../app-install.ts";
import {
  asDevice,
  IPHONE_HOME_SCREEN,
  type DeviceNavigator,
} from "./ios-home-screen.ts";
import { en } from "../../shared/i18n/en.ts";

export const IPHONE_SAFARI = { ...IPHONE_HOME_SCREEN, standalone: false };
export const ANDROID: DeviceNavigator = {
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
};
// Chrome's installed window, as readPushEnv reads it.
export const ANDROID_APP = { ...ANDROID, standalone: true };

let undoDevice = () => {};
let undoPointer = () => {};
let view: ReturnType<typeof render> | undefined;

// Each file has its own window: hold its install event as ui/index.tsx does
// at boot, and leave nothing for the next test.
export function setUpOfficeInstallFile(): void {
  beforeAll(() => captureInstallPrompt(window));
  afterEach(() => {
    view?.unmount();
    view = undefined;
    undoDevice();
    undoDevice = () => {};
    undoPointer();
    undoPointer = () => {};
    Reflect.deleteProperty(window, "onbeforeinstallprompt");
    window.dispatchEvent(new Event("appinstalled"));
    localStorage.clear();
  });
}

export function onDevice(device: DeviceNavigator): void {
  undoDevice = asDevice(device);
}

// A browser with the beforeinstallprompt event (Chromium).
export function asChrome(device: DeviceNavigator = ANDROID): void {
  onDevice(device);
  (window as unknown as Record<string, unknown>).onbeforeinstallprompt = null;
}

// The primary pointer is coarse on a phone or tablet and fine with a mouse or
// a trackpad; any pointer is coarse on every touch screen. happy-dom answers
// both from maxTouchPoints, so it cannot tell a touchscreen laptop from a
// tablet. Other media queries keep happy-dom's answer.
export function withPointer(primaryCoarse: boolean, anyCoarse = primaryCoarse) {
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

export function installEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = mock(async () => {});
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    { prompt, userChoice: Promise.resolve({ outcome }) },
  );
  return { event, prompt };
}

const noop = () => {};
// Neither the notice nor the menu item reads the lobby: it stays closed, which
// makes a mount cheaper.
export function mount(isMobile = true) {
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
      { lobbyOpen: false, isMobile },
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
    // The phone menu's item, in a portal, or the desktop bar's: both are a
    // button titled with the label. A title query skips the accessible-name
    // work a role query does over the whole office.
    menuItem: () => {
      const menu = v.queryByTitle(en["common.moreActions"]);
      if (menu) fireEvent.click(menu);
      const item =
        v
          .queryAllByTitle(en["appWidget.install"])
          .find((el) => el.tagName === "BUTTON") ?? null;
      // Close the menu again when there is nothing to click.
      if (menu && !item) fireEvent.click(menu);
      return item;
    },
  };
}
