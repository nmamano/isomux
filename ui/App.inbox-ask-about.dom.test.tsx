// "Discuss in chat" from the Inbox, through the real App and store (tasks
// 715ab3dd, e3c25581): the button opens the Inbox's chat panel on the agent,
// with the prefix in front of the draft the member had left in that agent's
// chat, the composer focused and the caret after the prefix, and the ask still
// open. The draft is the chat's: the full chat opens on it, and the focus
// request is spent, so the full chat does not move the caret again. A draft
// Discuss changes after a failed send goes as a new message. The
// chat-side behaviour is in ui/log-view/ask-about.dom.test.tsx; the setup in
// ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  ask,
  boot,
  chatComposer,
  chatPanel,
  chatSelect,
  inboxButton,
  openFullChat,
  sentMessages,
  setAsks,
  setMessagePost,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
const { askExcerpt } = await import("./log-view/ask-about.ts");
const { saveDraft } = await import("./view-persistence.ts");

setUpInboxTests();

const PROMPT = "Should we move the nightly backups to the desktop box tonight?";
const DRAFT = "and the tag?";

it("opens the chat panel on the agent with the prefix in front of the draft, the caret after it, and the full chat keeps that draft", async () => {
  setAsks([{ ...ask("q1", "a1"), prompt: PROMPT }]);
  // The draft the member left in Scout's chat; the store restores it.
  saveDraft("member", "a1", DRAFT);
  const view = await boot();

  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(view.container.querySelector("[data-asks-group]")).not.toBeNull();
  expect(chatPanel(view)).toBeNull();

  const button = view.container.querySelector<HTMLButtonElement>(
    '[data-ask="q1"] button[data-ask-about]',
  );
  expect(button).not.toBeNull();
  // No wait after the click: the composer takes focus inside it, since a
  // phone browser opens its keyboard only for a focus inside the tap.
  act(() => {
    fireEvent.click(button!);
  });

  // The Inbox stays, with the ask still open, and the panel is on Scout.
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(view.container.querySelector('[data-ask="q1"]')).not.toBeNull();
  expect(view.container.querySelector("[data-asks-stack]")).toBeNull();
  expect(chatSelect(view)?.value).toBe("a1");
  const ta = chatComposer(view)!;
  expect(ta).not.toBeNull();
  // A boolean, not toBe on two nodes: a red run would serialise both.
  expect(document.activeElement === ta).toBe(true);
  expect(ta.value.endsWith(DRAFT)).toBe(true);
  const prefix = ta.value.slice(0, ta.value.length - DRAFT.length);
  expect(prefix).toContain(`"${askExcerpt(PROMPT)}"`);
  // After the prefix, not at the end where a restored draft puts it.
  expect(ta.selectionStart).toBe(prefix.length);
  expect(ta.selectionEnd).toBe(prefix.length);
  const text = ta.value;

  // The full chat opens on the same draft. The panel spent the focus
  // request, so the chat's composer has its caret at the end, where a mount
  // puts it, and not after the prefix a second time.
  await openFullChat(view);
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
  const all = view.container.querySelectorAll("textarea");
  const composer = all[all.length - 1];
  expect(composer.value).toBe(text);
  expect(composer.selectionStart).toBe(text.length);
});

it("sends a draft changed from outside the panel after a failed send as a new message", async () => {
  setAsks([ask("q1", "a1"), ask("q2", "a1")]);
  // The first send fails, as when the reply is lost on the way back; the
  // server may still have the message under its id.
  let fail = true;
  setMessagePost(async () => {
    if (fail) throw new Error("offline");
    return { messageId: "m", queued: false };
  });
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  await act(async () =>
    fireEvent.click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-asks-agent="a1"]',
      )!,
    ),
  );
  await act(async () =>
    fireEvent.change(chatComposer(view)!, { target: { value: "first" } }),
  );
  await act(async () => {
    fireEvent.submit(chatPanel(view)!.querySelector("form")!);
  });
  expect(sentMessages.length).toBe(1);
  expect(chatComposer(view)!.value).toBe("first");

  // "Discuss in chat" on the agent's other ask changes the draft from the
  // Inbox, not from the panel's composer.
  fail = false;
  await act(async () =>
    fireEvent.click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-ask="q2"] button[data-ask-about]',
      )!,
    ),
  );
  const text = chatComposer(view)!.value;
  expect(text.endsWith("first")).toBe(true);
  expect(text).not.toBe("first");
  await act(async () => {
    fireEvent.submit(chatPanel(view)!.querySelector("form")!);
  });
  expect(sentMessages.length).toBe(2);
  expect(sentMessages[1].body.text).toBe(text);
  // A new text is a new message: the old id would let the server drop it as
  // a repeat of the first.
  expect(sentMessages[1].body.clientMessageId).not.toBe(
    sentMessages[0].body.clientMessageId,
  );
});
