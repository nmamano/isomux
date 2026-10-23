// "Install as app" in Settings > Device (task 5d536d33), on every viewport:
// Chrome and Edge install the office with the held beforeinstallprompt event,
// iPhone shows the Share > Add to Home Screen steps. No entry in an installed
// window or in a browser with no offer.

import { afterEach, beforeAll, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { DevicePane } = await import("./DevicePane.tsx");
const { captureInstallPrompt, heldInstallPrompt } =
  await import("../app-install.ts");
const { asDevice, IPHONE_HOME_SCREEN } =
  await import("../test-support/ios-home-screen.ts");

// ui/index.tsx does this at boot.
beforeAll(() => captureInstallPrompt(window));

const IPHONE_SAFARI = { ...IPHONE_HOME_SCREEN, standalone: false };
const DESKTOP = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  platform: "Win32",
  maxTouchPoints: 0,
};

let undoDevice = () => {};
let undoMedia = () => {};
let view: ReturnType<typeof render> | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  undoDevice();
  undoDevice = () => {};
  undoMedia();
  undoMedia = () => {};
  Reflect.deleteProperty(window, "onbeforeinstallprompt");
  window.dispatchEvent(new Event("appinstalled"));
  localStorage.clear();
});

function asChrome(device: Parameters<typeof asDevice>[0] = DESKTOP) {
  undoDevice = asDevice(device);
  (window as unknown as Record<string, unknown>).onbeforeinstallprompt = null;
}

// Chrome reports its installed window through the display mode, not
// navigator.standalone (Safari's).
function inInstalledWindow() {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    query === "(display-mode: standalone)"
      ? {
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }
      : original.call(window, query)) as typeof window.matchMedia;
  undoMedia = () => {
    window.matchMedia = original;
  };
}

function installEvent() {
  const prompt = mock(async () => {});
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    { prompt, userChoice: Promise.resolve({ outcome: "accepted" as const }) },
  );
  return { event, prompt };
}

function mount() {
  view = render(<DevicePane />);
  const v = view;
  return () =>
    v.container.querySelector<HTMLElement>("[data-office-install-entry]");
}

it("installs the office from Settings in desktop Chrome and Edge", async () => {
  asChrome();
  const entry = mount();
  // Chrome decides when the event comes, often after the page renders.
  expect(entry()).toBeNull();
  const { event, prompt } = installEvent();
  await act(async () => {
    window.dispatchEvent(event);
  });
  expect(entry()?.dataset.officeInstallEntry).toBe("prompt");
  const button = entry()!.querySelector("button");
  expect(button).not.toBeNull();
  await act(async () => {
    fireEvent.click(button!);
  });
  expect(prompt).toHaveBeenCalledTimes(1);
  // A used event cannot prompt again.
  expect(heldInstallPrompt()).toBeNull();
  expect(entry()).toBeNull();
});

it("shows the Add to Home Screen steps in iPhone Safari", () => {
  undoDevice = asDevice(IPHONE_SAFARI);
  const entry = mount();
  expect(entry()?.dataset.officeInstallEntry).toBe("steps");
  expect(entry()!.textContent.trim()).not.toBe("");
  // The Share icon is drawn, not a glyph: iOS draws glyphs as emoji.
  expect(entry()!.querySelector("svg")).not.toBeNull();
});

for (const [label, setUp] of [
  [
    "an installed Chrome window",
    () => {
      asChrome();
      inInstalledWindow();
    },
  ],
  // Firefox: neither the event nor the iPhone steps.
  ["a browser with no install offer", () => (undoDevice = asDevice(DESKTOP))],
] as const) {
  it(`has no install entry in ${label}`, async () => {
    setUp();
    const entry = mount();
    await act(async () => {
      window.dispatchEvent(installEvent().event);
    });
    expect(entry()).toBeNull();
  });
}
