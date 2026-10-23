// The Skills page over an agent chat closes back to that chat (task
// 586b63a5). Skills has no shortcut, so the saved spot puts it there: a saved
// panel over a saved agent. The steps are in
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
  setUpOverChat,
} = await import("./test-support/over-chat-fixture.ts");

setUpOverChat();

const skillsOpen = () =>
  document.body.querySelector("[data-skills-page]") !== null;

describe("Skills restored over a chat", () => {
  it("Close returns to the chat, and Back from it to the office", async () => {
    window.localStorage.clear();
    saveView("ricky", {
      roomId: "r1",
      agentId: "a1",
      panel: "skills",
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
    expect(skillsOpen()).toBe(true);
    expect(chatShowing(view)).toBe(false);
    expect(window.location.pathname).toBe("/skills");

    await closesInPlace(() => clickClose(view));
    expect(skillsOpen()).toBe(false);
    expectChatEntry(view);
    await expectBackToOffice(view);
    expect(skillsOpen()).toBe(false);
  });
});
