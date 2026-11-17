// No entry of the desktop sidebar hides it (task c61316be; Nil, 2026-11-11:
// "the general principle is that clicking something on the side bar does not
// close the sidebar"). Only its own hide button does. This file walks every
// button outside an agent row, whatever it is, so an entry added later is
// walked too; ui/App.chat-sidebar-walk-agents.dom.test.tsx walks the buttons
// inside one. The walk is in ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { bootWalk, inAgentRow, setUpChatSidebarTests, walkSidebar } =
  await import("./test-support/chat-sidebar-fixture.tsx");

setUpChatSidebarTests();

it("no entry outside an agent row hides the sidebar: the walk clicks every such button it draws, opening closed sections first", async () => {
  const view = await bootWalk();
  const visited = await walkSidebar(view, (b) => !inAgentRow(b));

  // The walk reached every kind of entry (its enabling condition).
  const expected = [
    ...[
      "office",
      "members-chat",
      "asks",
      "tasks",
      "cronjobs",
      "apps",
      "skills",
      "integrations",
      "settings",
    ].map((row) => `data-sidebar-nav=${row}`),
    "data-sidebar-more-rooms=",
    ...["lobby", "r1", "r2", "r3"].map((id) => `data-sidebar-room=${id}`),
    // Task c921308f: a room's settings button.
    ...["r1", "r2", "r3"].map((id) => `data-sidebar-room-settings=${id}`),
    ...["r1", "r2", "r3"].map((id) => `data-sidebar-back-room=${id}`),
    ...["r1", "r2", "r3"].map((id) => `data-sidebar-new-agent=${id}`),
  ];
  expect(expected.filter((key) => !visited.has(key))).toEqual([]);
});
