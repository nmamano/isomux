// The phone's top bar on each page a phone opens from an address (task
// d60726c7), through the real App and store: one opaque fixed bar at the
// top, above every layer, with nothing starting under it. The checks and
// the reasons are in test-support/phone-top-bar.ts; the drawer, the chat,
// the notices and the desktop are in App.phone-top-bar-overlays.dom.test.tsx.

import { it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { recordRawStyles } = await import("./test-support/raw-style.ts");
recordRawStyles();
const { checkBar } = await import("./test-support/phone-top-bar.ts");
const { bootPhone, setUpChatSidebarTests } =
  await import("./test-support/chat-sidebar-fixture.tsx");

setUpChatSidebarTests();

// The pages a phone opens from an address.
const PAGES = [
  "/",
  "/inbox/asks",
  "/tasks",
  "/automations",
  "/apps",
  "/skills",
  "/integrations",
  "/settings",
  "/users",
];

for (const page of PAGES)
  it(`on a phone, ${page} has one opaque fixed bar at the top, above every layer, and starts below it`, async () => {
    const view = await bootPhone(undefined, page);
    try {
      checkBar(view, page);
    } finally {
      view.unmount();
    }
  });
