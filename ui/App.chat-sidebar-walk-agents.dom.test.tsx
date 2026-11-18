// No entry of the desktop sidebar hides it (task c61316be; Nil, 2026-11-11:
// "the general principle is that clicking something on the side bar does not
// close the sidebar"). This file walks every button inside an agent row,
// whatever it is, so a row button added later is walked too;
// ui/App.chat-sidebar-walk-nav.dom.test.tsx walks the page rows and
// ui/App.chat-sidebar-walk.dom.test.tsx every other button. The walk is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  WALK_AGENTS,
  bootWalk,
  inAgentRow,
  setUpChatSidebarTests,
  walkSidebar,
} = await import("./test-support/chat-sidebar-fixture.tsx");

setUpChatSidebarTests();

it("no button of an agent row hides the sidebar: the walk opens every closed section and clicks every row, settings and pin button", async () => {
  const view = await bootWalk();
  const visited = await walkSidebar(view, inAgentRow);

  // The walk reached every agent's buttons (its enabling condition). Task
  // 5dac6b9b: an agent row's pin button; task c921308f: its settings button.
  const expected = WALK_AGENTS.flatMap((a) => [
    `data-sidebar-agent=${a.id}`,
    `data-sidebar-pin=${a.id}`,
    `data-sidebar-agent-settings=${a.id}`,
  ]);
  expect(expected.filter((key) => !visited.has(key))).toEqual([]);
});
