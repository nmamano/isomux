// Integrations opened with "i" from an agent chat closes back to that chat (task
// 586b63a5). The steps are in ui/test-support/over-chat-fixture.ts.

import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { describeOverChat } =
  await import("./test-support/over-chat-fixture.ts");

describeOverChat({
  key: "i",
  marker: "[data-integrations-page]",
  path: "/integrations",
  // "i" again closes through the same closePage call as "a" again
  // (App.tsx, pageUpdate "home"); ui/App.apps-over-chat.dom.test.tsx has it.
  sameKeyCase: false,
});
