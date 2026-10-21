// Install as app on the short-link page (task 8a07aa4e). Chrome offers a real
// install: the page holds beforeinstallprompt and its dock button calls
// prompt(). iPhone Safari has no such event, so the button shows the Share >
// Add to Home Screen steps. The Apps page links here with #install, which
// opens the steps (or, on Chrome, the install offer once the event arrives).
// prompt() needs a click, so on Chrome the offer holds its own button.
//
// The iPhone Home Screen window has no Back control: there the phone's Chat
// launcher leaves for Safari instead of taking the app's window to the office.

import { afterAll, afterEach, beforeAll, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { AppWidgetPage } = await import("./AppWidgetPage.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { captureInstallPrompt, heldInstallPrompt, INSTALL_HASH } =
  await import("./app-install.ts");
const { asDevice, IPHONE_HOME_SCREEN } =
  await import("./test-support/ios-home-screen.ts");
const { en } = await import("../shared/i18n/en.ts");

// ui/index.tsx does this at boot on the short-link page.
beforeAll(() => captureInstallPrompt(window));

const boot = { name: "hello", registration: 1 };
const agent = {
  id: "one",
  name: "One",
  state: "idle",
  outfit: { color: "#218cff", hair: "#3e3025", skin: "#FFD5B8" },
  queue: [],
} as unknown as import("../shared/types.ts").AgentInfo;
const IPHONE_SAFARI = { ...IPHONE_HOME_SCREEN, standalone: false };

const settings = (
  window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean } };
  }
).happyDOM.settings;
const iframeLoading = settings.disableIframePageLoading;
settings.disableIframePageLoading = true;
let undoDevice = () => {};
let view: ReturnType<typeof render> | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  undoDevice();
  undoDevice = () => {};
  Reflect.deleteProperty(window, "onbeforeinstallprompt");
  // No test may leave an event for the next one.
  window.dispatchEvent(new Event("appinstalled"));
  window.history.replaceState(null, "", "/hello/");
});
afterAll(() => {
  setApiShim(null);
  settings.disableIframePageLoading = iframeLoading;
});

// A browser with the beforeinstallprompt event (Chromium).
function asChrome() {
  (window as unknown as Record<string, unknown>).onbeforeinstallprompt = null;
}

function installEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = mock(async () => {});
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    { prompt, userChoice: Promise.resolve({ outcome }) },
  );
  return { event, prompt };
}

async function mount({
  chat = false,
  isMobile = false,
  onOpenOffice,
}: {
  chat?: boolean;
  isMobile?: boolean;
  onOpenOffice?: (agent: unknown) => void;
} = {}) {
  sessionStorage.clear();
  setApiShim(async () => ({
    ...boot,
    appUrl: "https://hello.office.example",
    sessionExpiresAt: Date.now() + 1000000,
    chat: chat ? { agentId: agent.id, agentName: agent.name } : null,
  }));
  await act(async () => {
    view = render(
      <StateCtx.Provider
        value={{ ...initialState, agents: [agent], connected: true, isMobile }}
      >
        <AppWidgetPage boot={boot} onOpenOffice={onOpenOffice} />
      </StateCtx.Provider>,
    );
  });
  const container = view!.container;
  return {
    container,
    dock: () => container.querySelector<HTMLElement>(".app-widget-dock"),
    install: () =>
      view!.queryByRole("button", { name: en["appWidget.install"] }),
    popover: () =>
      container.querySelector<HTMLElement>("[data-app-install-popover]"),
  };
}

it("shows no install button where the browser cannot install", async () => {
  // happy-dom is neither Chromium nor iOS.
  const page = await mount({ chat: true });
  expect(page.dock()).not.toBeNull();
  expect(page.install()).toBeNull();
  expect(page.popover()).toBeNull();
});

for (const ending of ["accepted", "dismissed", "appinstalled"] as const) {
  it(`installs with the held event from the dock and then hides the button (${ending})`, async () => {
    asChrome();
    const page = await mount({ chat: true });
    // Chrome decides when the event comes, often after the page renders.
    expect(page.install()).toBeNull();
    const { event, prompt } = installEvent(
      ending === "dismissed" ? "dismissed" : "accepted",
    );
    await act(async () => {
      window.dispatchEvent(event);
    });
    const button = page.install();
    expect(button).not.toBeNull();
    expect(page.dock()!.contains(button)).toBe(true);
    await act(async () => {
      if (ending === "appinstalled")
        window.dispatchEvent(new Event("appinstalled"));
      else fireEvent.click(button!);
    });
    expect(prompt).toHaveBeenCalledTimes(ending === "appinstalled" ? 0 : 1);
    // A used event cannot prompt again, and an installed app needs no button.
    expect(heldInstallPrompt()).toBeNull();
    expect(page.install()).toBeNull();
  });
}

it("shows the Add to Home Screen steps from the dock in iPhone Safari", async () => {
  undoDevice = asDevice(IPHONE_SAFARI);
  const page = await mount({ chat: true });
  const button = page.install();
  expect(button).not.toBeNull();
  expect(page.dock()!.contains(button)).toBe(true);
  expect(button!.getAttribute("aria-expanded")).toBe("false");
  expect(page.popover()).toBeNull();
  fireEvent.click(button!);
  expect(button!.getAttribute("aria-expanded")).toBe("true");
  const popover = page.popover();
  expect(popover).not.toBeNull();
  expect(popover!.id).not.toBe("");
  expect(button!.getAttribute("aria-controls")).toBe(popover!.id);
  expect(popover!.textContent.trim()).not.toBe("");
  // The Share icon is drawn, not a glyph: iOS draws glyphs as emoji.
  expect(popover!.querySelector("svg")).not.toBeNull();
  fireEvent.click(button!);
  expect(button!.getAttribute("aria-expanded")).toBe("false");
  expect(page.popover()).toBeNull();
});

for (const [label, device, chat] of [
  ["with a chat", IPHONE_SAFARI, true],
  // Without a chat the dock still shows, for the install button.
  ["without a chat", IPHONE_SAFARI, false],
] as const) {
  it(`opens the steps for ${INSTALL_HASH} at load in iPhone Safari (${label}) and drops the hash`, async () => {
    undoDevice = asDevice(device);
    window.history.replaceState(
      null,
      "",
      `/hello/?view=details${INSTALL_HASH}`,
    );
    const page = await mount({ chat });
    expect(page.popover()).not.toBeNull();
    expect(page.install()!.getAttribute("aria-expanded")).toBe("true");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/hello/");
    expect(window.location.search).toBe("?view=details");
    const frame = page.container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("src")).not.toContain("install");
  });
}

it(`waits for the event on Chrome before it opens the offer for ${INSTALL_HASH}, and installs from it`, async () => {
  asChrome();
  window.history.replaceState(null, "", `/hello/${INSTALL_HASH}`);
  const page = await mount();
  // No event: an empty offer would be a dead end.
  expect(page.popover()).toBeNull();
  expect(window.location.hash).toBe("");
  const { event, prompt } = installEvent();
  await act(async () => {
    window.dispatchEvent(event);
  });
  const popover = page.popover();
  expect(popover).not.toBeNull();
  const offer = popover!.querySelector("button");
  expect(offer).not.toBeNull();
  await act(async () => {
    fireEvent.click(offer!);
  });
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(page.popover()).toBeNull();
  expect(page.install()).toBeNull();
});

it("does not open the Chrome offer when the event comes without the hash", async () => {
  asChrome();
  const page = await mount();
  await act(async () => {
    window.dispatchEvent(installEvent().event);
  });
  expect(page.install()).not.toBeNull();
  expect(page.popover()).toBeNull();
});

// The flip is standalone: Safari has a Back button, the Home Screen window
// has none.
for (const [label, device, leaves] of [
  ["iPhone Safari", IPHONE_SAFARI, false],
  ["the iPhone Home Screen", IPHONE_HOME_SCREEN, true],
] as const) {
  it(`the phone's Chat launcher ${leaves ? "leaves for Safari" : "opens the office"} in ${label}`, async () => {
    undoDevice = asDevice(device);
    const onOpenOffice = mock(() => {});
    const page = await mount({ chat: true, isMobile: true, onOpenOffice });
    const launcher = page.container.querySelector<HTMLElement>(
      ".app-widget-launcher",
    );
    expect(launcher).not.toBeNull();
    if (leaves) {
      expect(launcher!.tagName).toBe("A");
      expect(launcher!.getAttribute("href")).toBe(
        "x-safari-" + window.location.origin + "/agents/" + agent.id,
      );
      return;
    }
    expect(launcher!.tagName).toBe("BUTTON");
    fireEvent.click(launcher!);
    expect(onOpenOffice).toHaveBeenCalledTimes(1);
  });
}
