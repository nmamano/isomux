// No entry of the desktop sidebar hides it (task c61316be; Nil, 2026-11-11:
// "the general principle is that clicking something on the side bar does not
// close the sidebar"). This file walks every page row, so a page added later
// is walked too; ui/App.chat-sidebar-walk.dom.test.tsx walks every other
// button outside an agent row and ui/App.chat-sidebar-walk-agents.dom.test.tsx
// the buttons inside one. The walk is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { bootWalk, isNavRow, setUpChatSidebarTests, walkSidebar } =
  await import("./test-support/chat-sidebar-fixture.tsx");

setUpChatSidebarTests();

it("no page row hides the sidebar: the walk clicks every page row it draws, opening closed sections first", async () => {
  const view = await bootWalk();
  const visited = await walkSidebar(view, isNavRow);

  // The walk reached every page row (its enabling condition).
  const expected = [
    "office",
    "members-chat",
    "asks",
    "tasks",
    "cronjobs",
    "apps",
    "skills",
    "integrations",
    "settings",
  ].map((row) => `data-sidebar-nav=${row}`);
  expect(expected.filter((key) => !visited.has(key))).toEqual([]);
});
