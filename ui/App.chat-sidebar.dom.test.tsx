// Where the desktop chat sidebar shows (task c61316be; Nil, 2026-11-11:
// "Sidebar on chat and pages"): beside an agent's chat and beside the Inbox,
// Tasks, Automations, Apps, Skills and Integrations pages; never on Settings,
// the office or a phone. Its rows open those pages. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const {
  boot,
  chatOpen,
  click,
  navRow,
  openFirstDesk,
  press,
  setUpChatSidebarTests,
  setWindowWidth,
  sidebar,
} = await import("./test-support/chat-sidebar-fixture.tsx");

setUpChatSidebarTests();

// Each page's own marker, which only that page renders.
const PAGES = [
  ["asks", "[data-inbox]"],
  ["tasks", "[data-tasks-page]"],
  ["cronjobs", "[data-automations-header]"],
  ["apps", "[data-apps-page]"],
  ["skills", "[data-skills-page]"],
  ["integrations", "[data-integrations-page]"],
] as const;

it("is not on the office; shows beside a chat; its rows open each page with the sidebar still beside it", async () => {
  const view = await boot();
  expect(chatOpen(view)).toBe(false);
  expect(sidebar(view)).toBeNull();

  await openFirstDesk(view);
  expect(sidebar(view)).not.toBeNull();

  for (const [page, marker] of PAGES) {
    await click(navRow(view, page));
    expect({
      page,
      open: view.container.querySelector(marker) !== null,
      sidebar: sidebar(view) !== null,
      chat: chatOpen(view),
    }).toEqual({ page, open: true, sidebar: true, chat: false });
  }
});

it("is not on Settings, even when Settings opens over a page that has it", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await press("t");
  expect(view.container.querySelector("[data-tasks-page]")).not.toBeNull();
  expect(sidebar(view)).not.toBeNull();

  await press("s");
  expect(
    view.baseElement.querySelector('[data-testid="settings-content"]'),
  ).not.toBeNull();
  expect(sidebar(view)).toBeNull();
});

it("is not on a phone: the chat keeps its own header", async () => {
  setWindowWidth(390);
  // This browser chose the sidebar open before (a desktop window made narrow),
  // so only the phone check keeps it off, not the narrow-width default.
  window.localStorage.setItem("isomux-chat-sidebar", "open");
  const view = await boot();
  // The store reads the width again on a resize, after its 150 ms debounce.
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  await openFirstDesk(view);
  // The chat is in its phone layout (LogView lays out its shell as a row on
  // a phone, a column on a desktop), so the window really reads as a phone.
  const shell = view.container.querySelector<HTMLElement>(".log-view-shell");
  expect(shell?.style.flexDirection).toBe("row");
  expect(sidebar(view)).toBeNull();
  // A phone is not a collapsed desktop: no Show sidebar either.
  expect(view.container.querySelector("[data-show-sidebar]")).toBeNull();
});
