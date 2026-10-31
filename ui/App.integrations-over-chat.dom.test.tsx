// The Integrations page over an agent chat closes back to that chat (task
// 586b63a5). Integrations has no shortcut (task d866bef9), so the saved spot
// puts it there, as in ui/App.skills-over-chat.dom.test.tsx. The steps are in
// ui/test-support/over-chat-fixture.ts.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { saveView } = await import("./view-persistence.ts");
const {
  Harness,
  WITH_CHAT,
  chatShowing,
  clickClose,
  closesInPlace,
  expectBackToOffice,
  expectChatEntry,
  press,
  setUpOverChat,
} = await import("./test-support/over-chat-fixture.ts");
type View = import("./test-support/over-chat-fixture.ts").View;

setUpOverChat();

const integrationsOpen = () =>
  document.body.querySelector("[data-integrations-page]") !== null;

async function restoreOverChat(): Promise<View> {
  window.localStorage.clear();
  saveView("ricky", {
    roomId: "r1",
    agentId: "a1",
    panel: "integrations",
    lobby: false,
  });
  const view = render(
    createElement(Harness, {
      initial: {
        ...WITH_CHAT,
        hasReceivedInitialState: true,
        sessionContext: { username: "ricky", userId: "u1", role: "owner" },
      } as typeof WITH_CHAT,
    }),
  );
  await act(async () => {});
  expect(integrationsOpen()).toBe(true);
  expect(chatShowing(view)).toBe(false);
  expect(window.location.pathname).toBe("/integrations");
  return view;
}

async function expectChatThenOffice(view: View): Promise<void> {
  expect(integrationsOpen()).toBe(false);
  expectChatEntry(view);
  await expectBackToOffice(view);
  expect(integrationsOpen()).toBe(false);
}

describe("Integrations restored over a chat", () => {
  it("Escape returns to the chat, and Back from it to the office", async () => {
    const view = await restoreOverChat();
    await closesInPlace(() => press("Escape"));
    await expectChatThenOffice(view);
  });

  it("Close returns to the chat, and Back from it to the office", async () => {
    const view = await restoreOverChat();
    await closesInPlace(() => clickClose(view));
    await expectChatThenOffice(view);
  });
});
