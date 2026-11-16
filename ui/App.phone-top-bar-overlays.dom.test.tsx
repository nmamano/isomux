// The phone's top bar over the phone's overlays (task d60726c7), through
// the real App and store: the bar stays on top of the sidebar drawer, an
// agent's chat, the new-build notice and the connection banner, and none of
// them starts under it; a desktop has no bar. The checks and the reasons are
// in test-support/phone-top-bar.ts; the pages are in
// App.phone-top-bar.dom.test.tsx.

import { expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { recordRawStyles } = await import("./test-support/raw-style.ts");
recordRawStyles();
const { bars, checkBar } = await import("./test-support/phone-top-bar.ts");
const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StateCtx, DispatchCtx, initialState } = await import("./store.tsx");
const { shimEmit } = await import("./ws.ts");
const build = await import("./ui-build.ts");
const { ConnectionBanner } = await import("./components/ConnectionBanner.tsx");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const {
  boot,
  bootPhone,
  chatOpen,
  click,
  openFirstDesk,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");

setUpChatSidebarTests();

it("on a phone, the bar stays on top of the sidebar drawer and an agent's chat, and neither starts under it", async () => {
  const view = await bootPhone();
  try {
    await openFirstDesk(view);
    expect(chatOpen(view)).not.toBeNull();
    checkBar(view, "agent chat");
    const show = view.baseElement.querySelector<HTMLButtonElement>(
      "button[data-show-sidebar]",
    );
    expect(show).not.toBeNull();
    await click(show);
    expect(
      view.baseElement.querySelector("[data-phone-sidebar]"),
    ).not.toBeNull();
    checkBar(view, "sidebar drawer");
  } finally {
    view.unmount();
  }
});

it("on a phone, the bar is above the new-build notice and the connection banner", async () => {
  const own = spyOn(build, "ownUiBuild").mockImplementation(
    () => "0123456789abcdef",
  );
  const view = await bootPhone();
  try {
    await act(async () =>
      shimEmit({ type: "ui_build", uiBuild: "fedcba9876543210" }),
    );
    // The notice is up: its layer is among those the bar must top.
    expect(
      view.queryByRole("button", {
        name: translatorFor("en").t("update.screen.reload"),
      }),
    ).not.toBeNull();
    checkBar(view, "build notice");

    // The banner shows only after a lost link, which the fixture's socket
    // cannot lose: render it alone, offline, and compare its layer.
    const banner = render(
      createElement(
        StateCtx.Provider,
        {
          value: {
            ...initialState,
            connected: false,
            hasReceivedInitialState: true,
          },
        },
        createElement(
          DispatchCtx.Provider,
          { value: () => {} },
          createElement(ConnectionBanner),
        ),
      ),
    );
    try {
      const layer = banner.container.firstElementChild as HTMLElement | null;
      expect(layer).not.toBeNull();
      const bannerZ = parseInt(getComputedStyle(layer!).zIndex, 10);
      expect(Number.isNaN(bannerZ)).toBe(false);
      const barZ = parseInt(getComputedStyle(bars(view)[0]).zIndex, 10);
      expect(barZ).toBeGreaterThan(bannerZ);
    } finally {
      banner.unmount();
    }
  } finally {
    view.unmount();
    own.mockRestore();
  }
});

// The bar is mounted once for the whole App, so one desktop page shows it
// is phone-only.
it("on a desktop, the App has no bar", async () => {
  const view = await boot(undefined, "/inbox/asks");
  try {
    // The page rendered (the Inbox is there), and has no bar.
    expect(view.baseElement.querySelector("[data-inbox]")).not.toBeNull();
    expect(bars(view)).toHaveLength(0);
  } finally {
    view.unmount();
  }
});
