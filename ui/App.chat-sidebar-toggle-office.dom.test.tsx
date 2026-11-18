// The desktop sidebar is optional (task c61316be): a back agent's chat hides
// its back room strip only while the sidebar is open, and in the office the
// one choice holds between the office and a chat, without a new mount. Split
// from ui/App.chat-sidebar-toggle.dom.test.tsx, which holds the chat's Back
// and Show sidebar buttons and the default by window width, because the 5 s
// cap is per file. The setup is in ui/test-support/chat-sidebar-fixture.tsx.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  boot,
  builder,
  chatOpen,
  click,
  openBackAgent,
  openFirstDesk,
  scout,
  setUpChatSidebarTests,
  sidebar,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const KEY = "isomux-chat-sidebar";
const backButton = (view: View) =>
  view.container.querySelector("button[data-log-back]");
const showButton = (view: View) =>
  view.container.querySelector<HTMLButtonElement>("button[data-show-sidebar]");
const collapseButton = (view: View) =>
  view.container.querySelector<HTMLButtonElement>(
    "nav[data-chat-sidebar] button[data-sidebar-collapse]",
  );
const strip = (view: View) =>
  view.container.querySelector("[data-back-room-strip]");

it("hides the back room strip of a back agent's chat only while the sidebar is open", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await openBackAgent(view, "r1", builder.id);
  expect(strip(view)).toBeNull();

  await click(collapseButton(view));
  // Today's chat of a back agent: the strip names the front agents.
  expect(strip(view)).not.toBeNull();
});

it("in the office: the one choice holds between the office and a chat, and the office bar has its own Show sidebar", async () => {
  const view = await boot();
  expect(sidebar(view)).not.toBeNull();
  // Hidden in the office: the office bar's Show sidebar.
  await click(collapseButton(view));
  expect(sidebar(view)).toBeNull();
  expect(window.localStorage.getItem(KEY)).toBe("closed");
  expect(showButton(view)).not.toBeNull();

  // The same choice holds in a chat.
  await openFirstDesk(view);
  expect(sidebar(view)).toBeNull();
  expect(backButton(view)).not.toBeNull();

  // Back in the office, its Show sidebar shows it, for both views.
  await click(backButton(view));
  expect(chatOpen(view)).toBe(false);
  await click(showButton(view));
  expect(sidebar(view)).not.toBeNull();
  expect(window.localStorage.getItem(KEY)).toBe("open");
  await openFirstDesk(view);
  expect(sidebar(view)).not.toBeNull();
});

it("does not mount again between the office and a chat: a section the member closed stays closed", async () => {
  const view = await boot();
  const lobby = () =>
    view.container
      .querySelector('nav[data-chat-sidebar] button[data-sidebar-room="lobby"]')
      ?.getAttribute("aria-expanded") ?? null;
  // The Lobby section starts open; the member closes it in the office.
  expect(lobby()).toBe("true");
  await click(
    view.container.querySelector(
      'nav[data-chat-sidebar] button[data-sidebar-room="lobby"]',
    ),
  );
  expect(lobby()).toBe("false");

  // A row opens a chat, and the Office row returns: still closed.
  await click(
    view.container.querySelector(
      `nav[data-chat-sidebar] button[data-sidebar-agent="${scout.id}"]`,
    ),
  );
  expect(chatOpen(view)).toBe(true);
  expect(lobby()).toBe("false");
  await click(
    view.container.querySelector(
      'nav[data-chat-sidebar] button[data-sidebar-nav="office"]',
    ),
  );
  expect(chatOpen(view)).toBe(false);
  expect(lobby()).toBe("false");
});
