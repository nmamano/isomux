// "Install as app" in Settings > Device (task 5d536d33), on every viewport:
// Chrome and Edge install the office with the held beforeinstallprompt event,
// iPhone shows the Share > Add to Home Screen steps. No entry in an installed
// window or in a browser with no offer.

import { afterEach, beforeAll, beforeEach, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { DevicePane } = await import("./DevicePane.tsx");
const { captureInstallPrompt, heldInstallPrompt } =
  await import("../app-install.ts");
const { asDevice, IPHONE_HOME_SCREEN } =
  await import("../test-support/ios-home-screen.ts");
const { expectInlineInstallSteps } =
  await import("../test-support/install-steps.ts");
const { IOS_UA, iphoneWith } = await import("../test-support/ios-browsers.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

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
// happy-dom's window has onbeforeinstallprompt; a test is a browser without
// it unless it calls asChrome(). Put happy-dom's back after each test.
const installHandler = Object.getOwnPropertyDescriptor(
  window,
  "onbeforeinstallprompt",
)!;
let view: ReturnType<typeof render> | undefined;
beforeEach(() => {
  Reflect.deleteProperty(window, "onbeforeinstallprompt");
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  undoDevice();
  undoDevice = () => {};
  undoMedia();
  undoMedia = () => {};
  Object.defineProperty(window, "onbeforeinstallprompt", installHandler);
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

// session: the office has sign-in on and the member is signed in.
function mount({
  session = false,
  onOpenNewDevice,
}: { session?: boolean; onOpenNewDevice?: () => void } = {}) {
  view = render(
    onLanguage("en", <DevicePane onOpenNewDevice={onOpenNewDevice} />, {
      ...(session ? {} : { sessionContext: null }),
    }),
  );
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
  // The icons are drawn, not glyphs: iOS draws glyphs as emoji.
  expectInlineInstallSteps(entry()!);
});

// Each iPhone browser gets its own steps (task 5765f58e), read from its user
// agent; a browser whose menus we do not know gets the generic ones.
for (const [label, ua, browser] of [
  ["Chrome", IOS_UA.chrome, "chrome"],
  ["Firefox", IOS_UA.firefox, "firefox"],
  ["Edge", IOS_UA.edge, "edge"],
  ["Opera", IOS_UA.opera, "other"],
] as const) {
  it(`shows the ${browser} steps in iPhone ${label}`, () => {
    undoDevice = asDevice(iphoneWith(ua));
    const entry = mount();
    expect(entry()?.dataset.officeInstallEntry).toBe("steps");
    expectInlineInstallSteps(entry()!, browser);
  });
}

// A mail or social app's view has no Add to Home Screen, and the member's own
// browser is not signed in yet (task 260686c9): the entry sends a signed-in
// member to New device for a sign-in link, never to Safari.
it("sends a signed-in member to New device from an iPhone in-app view", async () => {
  undoDevice = asDevice(iphoneWith(IOS_UA.instagram));
  const written: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  const onOpenNewDevice = mock(() => {});
  try {
    const entry = mount({ session: true, onOpenNewDevice });
    expect(entry()?.dataset.officeInstallEntry).toBe("browser");
    expect(entry()!.querySelector("[data-install-icon]")).toBeNull();
    expect(entry()!.querySelector("a")).toBeNull();
    const buttons = [
      ...entry()!.querySelectorAll<HTMLButtonElement>("[data-browser-install]"),
    ];
    expect(buttons.map((b) => b.dataset.browserInstall)).toEqual(["sign-in"]);
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    expect(onOpenNewDevice).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

// Without sign-in the office's link opens in any browser: the entry copies it.
it("copies the office's link from an iPhone in-app view of an office without sign-in", async () => {
  undoDevice = asDevice(iphoneWith(IOS_UA.instagram));
  const written: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  const onOpenNewDevice = mock(() => {});
  try {
    const entry = mount({ onOpenNewDevice });
    expect(entry()?.dataset.officeInstallEntry).toBe("browser");
    const buttons = [
      ...entry()!.querySelectorAll<HTMLButtonElement>("[data-browser-install]"),
    ];
    expect(buttons.map((b) => b.dataset.browserInstall)).toEqual(["copy"]);
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    expect(written).toEqual([`${window.location.origin}/`]);
    expect(onOpenNewDevice).not.toHaveBeenCalled();
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
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
