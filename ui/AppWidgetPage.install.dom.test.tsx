// Install as app on the short-link page (tasks 8a07aa4e, 1260608a). Chrome
// offers a real install: the page holds beforeinstallprompt and the install
// entry calls prompt(). iOS Safari has no such event, so the entry shows the
// Share > Add to Home Screen steps. The entry sits beside "Open app
// directly": in the chat panel's header when there is a chat, in the dock
// when there is none, and nowhere on a phone with a chat, which has neither.
// The Apps page links here with #install, which opens the steps (or, on
// Chrome, the install offer once the event arrives) in a popover with its own
// close control. prompt() needs a click, so on Chrome the offer holds its own
// button. Only one install surface shows at a time: opening or closing the
// panel closes them all.
//
// The iPhone Home Screen window has no Back control: there the phone's Chat
// launcher leaves for Safari instead of taking the app's window to the office.

import { afterAll, afterEach, beforeAll, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act, within } =
  await import("@testing-library/react");
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
// iPad Safari at desktop width: it reports a Mac with touch points.
const IPAD_SAFARI = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  platform: "MacIntel",
  maxTouchPoints: 5,
  standalone: false,
};

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
  const panel = () => view!.queryByRole("dialog", { hidden: true });
  const launcher = () =>
    container.querySelector<HTMLElement>(".app-widget-launcher");
  return {
    container,
    dock: () => container.querySelector<HTMLElement>(".app-widget-dock"),
    panel,
    header: () => panel()?.querySelector<HTMLElement>("header") ?? null,
    launcher,
    toggleChat: async () => {
      await act(async () => {
        fireEvent.click(launcher()!);
      });
    },
    // The visible install entry.
    install: () =>
      view!.queryByRole("button", { name: en["appWidget.install"] }),
    // Every install entry in the DOM, shown or not.
    entries: () =>
      view!.queryAllByRole("button", {
        name: en["appWidget.install"],
        hidden: true,
      }),
    popover: () =>
      container.querySelector<HTMLElement>("[data-app-install-popover]"),
    // Every place that shows the Add to Home Screen steps.
    steps: () => view!.queryAllByText(en["appWidget.installSteps"]),
  };
}

function directLinkIn(region: HTMLElement) {
  return region.querySelector('a[href^="https://hello.office.example"]');
}

function closeControl(popover: HTMLElement) {
  return within(popover).getByRole("button", { name: en["common.close"] });
}

it("shows no install entry where the browser cannot install", async () => {
  // happy-dom is neither Chromium nor iOS.
  const page = await mount({ chat: true });
  await page.toggleChat();
  expect(page.panel()).not.toBeNull();
  expect(page.entries()).toHaveLength(0);
  expect(page.popover()).toBeNull();
});

for (const ending of ["accepted", "dismissed", "appinstalled"] as const) {
  it(`installs with the held event from the chat header and then hides the entry (${ending})`, async () => {
    asChrome();
    const page = await mount({ chat: true });
    // Chrome decides when the event comes, often after the page renders.
    expect(page.entries()).toHaveLength(0);
    const { event, prompt } = installEvent(
      ending === "dismissed" ? "dismissed" : "accepted",
    );
    await act(async () => {
      window.dispatchEvent(event);
    });
    // Not beside the chat launcher.
    expect(page.entries()).toHaveLength(1);
    expect(page.dock()!.contains(page.entries()[0])).toBe(false);
    await page.toggleChat();
    const button = page.install();
    expect(button).not.toBeNull();
    // Beside "Open app directly", in the panel's header.
    const header = page.header()!;
    expect(directLinkIn(header)).not.toBeNull();
    expect(header.contains(button)).toBe(true);
    await act(async () => {
      if (ending === "appinstalled")
        window.dispatchEvent(new Event("appinstalled"));
      else fireEvent.click(button!);
    });
    expect(prompt).toHaveBeenCalledTimes(ending === "appinstalled" ? 0 : 1);
    // A used event cannot prompt again, and an installed app needs no entry.
    expect(heldInstallPrompt()).toBeNull();
    expect(page.entries()).toHaveLength(0);
  });
}

it("shows the Add to Home Screen steps inside the chat panel from its header on a wide iPad", async () => {
  undoDevice = asDevice(IPAD_SAFARI);
  const page = await mount({ chat: true });
  expect(page.entries()).toHaveLength(1);
  expect(page.dock()!.contains(page.entries()[0])).toBe(false);
  await page.toggleChat();
  const button = page.install();
  expect(button).not.toBeNull();
  expect(page.header()!.contains(button)).toBe(true);
  expect(button!.getAttribute("aria-expanded")).toBe("false");
  expect(page.steps()).toHaveLength(0);
  fireEvent.click(button!);
  expect(button!.getAttribute("aria-expanded")).toBe("true");
  const id = button!.getAttribute("aria-controls");
  expect(id).not.toBeNull();
  const steps = document.getElementById(id!);
  expect(steps).not.toBeNull();
  expect(page.panel()!.contains(steps)).toBe(true);
  expect(page.popover()).toBeNull();
  expect(page.steps()).toHaveLength(1);
  // The Share icon is drawn, not a glyph: iOS draws glyphs as emoji.
  expect(steps!.querySelector("svg")).not.toBeNull();
  fireEvent.click(button!);
  expect(button!.getAttribute("aria-expanded")).toBe("false");
  expect(page.steps()).toHaveLength(0);
});

// One install surface at a time: the panel covers the popover, and steps
// left open in a closed panel must not come back as a popover.
for (const browser of ["iPad Safari", "Chrome"] as const) {
  it(`opening or closing the chat panel closes the ${INSTALL_HASH} offer for good (${browser})`, async () => {
    if (browser === "Chrome") asChrome();
    else undoDevice = asDevice(IPAD_SAFARI);
    window.history.replaceState(null, "", `/hello/${INSTALL_HASH}`);
    const page = await mount({ chat: true });
    if (browser === "Chrome")
      await act(async () => {
        window.dispatchEvent(installEvent().event);
      });
    expect(page.popover()).not.toBeNull();
    // Not also in the closed panel.
    expect(page.steps()).toHaveLength(browser === "Chrome" ? 0 : 1);
    await page.toggleChat();
    expect(page.panel()!.style.display).not.toBe("none");
    expect(page.popover()).toBeNull();
    expect(page.steps()).toHaveLength(0);
    const button = page.install()!;
    expect(button).not.toBeNull();
    if (browser === "Chrome") {
      fireEvent.keyDown(page.panel()!, { key: "Escape" });
      expect(page.panel()!.style.display).toBe("none");
      expect(page.popover()).toBeNull();
      return;
    }
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // Steps opened in the panel, then the panel closed: by Escape, then by
    // the launcher.
    for (const closeBy of ["Escape", "launcher"] as const) {
      fireEvent.click(page.install()!);
      expect(page.steps()).toHaveLength(1);
      if (closeBy === "Escape")
        fireEvent.keyDown(page.panel()!, { key: "Escape" });
      else await page.toggleChat();
      expect(page.panel()!.style.display).toBe("none");
      expect(page.popover()).toBeNull();
      expect(page.steps()).toHaveLength(0);
      await page.toggleChat();
      expect(page.install()!.getAttribute("aria-expanded")).toBe("false");
      expect(page.steps()).toHaveLength(0);
    }
  });
}

for (const browser of ["iPhone Safari", "Chrome"] as const) {
  it(`has no install entry on a phone with a chat, and ${INSTALL_HASH} opens an offer that its close control closes (${browser})`, async () => {
    if (browser === "Chrome") asChrome();
    else undoDevice = asDevice(IPHONE_SAFARI);
    window.history.replaceState(null, "", `/hello/${INSTALL_HASH}`);
    const page = await mount({ chat: true, isMobile: true });
    const { event, prompt } = installEvent();
    if (browser === "Chrome")
      await act(async () => {
        window.dispatchEvent(event);
      });
    expect(page.launcher()).not.toBeNull();
    expect(page.entries()).toHaveLength(0);
    const popover = page.popover();
    expect(popover).not.toBeNull();
    await act(async () => {
      fireEvent.click(closeControl(popover!));
    });
    expect(page.popover()).toBeNull();
    expect(prompt).toHaveBeenCalledTimes(0);
    expect(page.entries()).toHaveLength(0);
  });
}

it("shows the Add to Home Screen steps from the dock, beside the direct link, without a chat in iPhone Safari", async () => {
  undoDevice = asDevice(IPHONE_SAFARI);
  const page = await mount();
  const button = page.install();
  expect(button).not.toBeNull();
  expect(page.dock()!.contains(button)).toBe(true);
  expect(directLinkIn(page.dock()!)).not.toBeNull();
  expect(button!.getAttribute("aria-expanded")).toBe("false");
  expect(page.popover()).toBeNull();
  fireEvent.click(button!);
  expect(button!.getAttribute("aria-expanded")).toBe("true");
  const popover = page.popover();
  expect(popover).not.toBeNull();
  expect(popover!.id).not.toBe("");
  expect(button!.getAttribute("aria-controls")).toBe(popover!.id);
  expect(page.steps()).toHaveLength(1);
  // The Share icon is drawn, not a glyph: iOS draws glyphs as emoji.
  expect(popover!.querySelector("svg")).not.toBeNull();
  fireEvent.click(button!);
  expect(button!.getAttribute("aria-expanded")).toBe("false");
  expect(page.popover()).toBeNull();
  // The close control closes it as the entry does.
  fireEvent.click(button!);
  fireEvent.click(closeControl(page.popover()!));
  expect(page.popover()).toBeNull();
  expect(button!.getAttribute("aria-expanded")).toBe("false");
});

for (const [label, chat] of [
  ["on a phone with a chat", true],
  // Without a chat the dock still shows, for the install entry.
  ["without a chat", false],
] as const) {
  it(`opens the steps for ${INSTALL_HASH} at load in iPhone Safari (${label}) and drops the hash`, async () => {
    undoDevice = asDevice(IPHONE_SAFARI);
    window.history.replaceState(
      null,
      "",
      `/hello/?view=details${INSTALL_HASH}`,
    );
    const page = await mount({ chat, isMobile: chat });
    expect(page.popover()).not.toBeNull();
    if (chat) expect(page.entries()).toHaveLength(0);
    else expect(page.install()!.getAttribute("aria-expanded")).toBe("true");
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
  const offer = within(popover!).getByRole("button", {
    name: (name) => name !== en["common.close"],
  });
  await act(async () => {
    fireEvent.click(offer);
  });
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(page.popover()).toBeNull();
  expect(page.entries()).toHaveLength(0);
});

it("does not open the Chrome offer when the event comes without the hash, and keeps the entry in the dock without a chat", async () => {
  asChrome();
  const page = await mount();
  await act(async () => {
    window.dispatchEvent(installEvent().event);
  });
  const button = page.install();
  expect(button).not.toBeNull();
  expect(page.dock()!.contains(button)).toBe(true);
  expect(directLinkIn(page.dock()!)).not.toBeNull();
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
