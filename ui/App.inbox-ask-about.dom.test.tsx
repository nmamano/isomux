// "About your ask" from the Inbox, through the real App and store (task
// 715ab3dd): the button opens the agent's chat with the prefix in front of the
// draft the member had left there, the composer focused and the caret after
// the prefix, and the ask still open. The chat-side behaviour is in
// ui/log-view/ask-about.dom.test.tsx; the setup in
// ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { ask, boot, inboxButton, setAsks, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
const { askExcerpt } = await import("./log-view/ask-about.ts");
const { saveDraft } = await import("./view-persistence.ts");

setUpInboxTests();

const PROMPT = "Should we move the nightly backups to the desktop box tonight?";

it("opens the agent's chat with the prefix in front of the draft, the caret after it", async () => {
  setAsks([{ ...ask("q1", "a1"), prompt: PROMPT }]);
  // The draft the member left in Scout's chat; the store restores it.
  saveDraft("member", "a1", "and the tag?");
  const view = await boot();
  const composer = () => {
    const all = view.container.querySelectorAll("textarea");
    return all[all.length - 1];
  };

  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(view.container.querySelector("[data-asks-group]")).not.toBeNull();

  const button = view.container.querySelector<HTMLButtonElement>(
    '[data-ask="q1"] button[data-ask-about]',
  );
  expect(button).not.toBeNull();
  // No wait after the click: the composer takes focus inside it, since a
  // phone browser opens its keyboard only for a focus inside the tap.
  act(() => {
    fireEvent.click(button!);
  });

  // The Inbox closed and Scout's chat is open.
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector("[data-asks-group]")).toBeNull();
  const ta = composer();
  // A boolean, not toBe on two nodes: a red run would serialise both.
  expect(document.activeElement === ta).toBe(true);
  expect(ta.value.endsWith("and the tag?")).toBe(true);
  const prefix = ta.value.slice(0, ta.value.length - "and the tag?".length);
  expect(prefix).toContain(`"${askExcerpt(PROMPT)}"`);
  // After the prefix, not at the end where a restored draft puts it.
  expect(ta.selectionStart).toBe(prefix.length);
  expect(ta.selectionEnd).toBe(prefix.length);
  // The ask is still open: the chat's stack shows it.
  expect(view.container.querySelector('[data-ask="q1"]')).not.toBeNull();
});
