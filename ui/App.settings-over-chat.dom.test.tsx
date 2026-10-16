// Settings opened with "s" from an agent chat closes back to that chat, not to
// the office (tasks e927e6ff, 586b63a5), the way every page over a chat does.
// The steps are in ui/test-support/over-chat-fixture.ts. "s" only opens, so
// the same key does not close it again.

import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { describeOverChat } =
  await import("./test-support/over-chat-fixture.ts");

describeOverChat({
  key: "s",
  marker: '[data-testid="settings-content"]',
  path: "/settings",
  toggles: false,
});
