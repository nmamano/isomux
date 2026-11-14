// A member's message in the agent chat shows as typed: no Markdown. In the
// members chat a message carries its reaction in its own row; quotes and
// rendered Markdown are covered at the panel (ui/members-chat replies and pins
// tests).
import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { EditableUserMessage, UserMessage } = await import("./LogEntryCard.tsx");
const { setRecording, setRecordingRules } =
  await import("../recording-mode.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

afterEach(() => setRecording(false));

it("keeps a default user message literal", () => {
  const view = render(createElement(UserMessage, { content: "**literal**" }));
  expect(view.container.querySelector("strong") === null).toBe(true);
  expect(view.getByText("**literal**").textContent).toBe("**literal**");
  view.unmount();
});

it("puts a members chat message's inline accessory in the row with its content", () => {
  const view = render(
    createElement(UserMessage, {
      variant: "members-chat",
      content: "**rendered**",
      renderedContent: createElement("strong", null, "rendered"),
      inlineAccessory: createElement("button", null, "reaction"),
    }),
  );
  const row = view.getByRole("button", { name: "reaction" }).parentElement!;
  expect(row.contains(view.getByText("rendered"))).toBe(true);
  view.unmount();
});

// Task 1a5c9478: recording mode's member rule is case-sensitive, so the
// author label must hold the name as written; the style uppercases it. A
// label uppercased in code ("RICKY") showed the name while recording.
it("hides the author's name in the chat label while recording, in the message and in its edit form", async () => {
  setRecordingRules({
    officeHosts: [],
    otherOffices: [],
    words: [],
    members: ["Ana Lee", "Ricky"],
  });
  setRecording(true);
  for (const element of [
    createElement(UserMessage, { content: "hello", username: "Ricky" }),
    createElement(UserMessage, {
      content: "hello",
      username: "Ricky",
      variant: "members-chat",
    }),
    createElement(EditableUserMessage, {
      content: "hello",
      entryId: "e1",
      username: "Ricky",
    }),
  ]) {
    const view = render(element);
    // The layer rewrites added nodes at the next microtask checkpoint.
    await new Promise((r) => setTimeout(r, 0));
    const text = view.container.textContent ?? "";
    expect({ text, leaks: /ricky/i.test(text) }).toEqual({
      text,
      leaks: false,
    });
    expect(text).toContain("Member 2");
    view.unmount();
  }
});

// Task 5ea0e610: Send in the edit form of a sent message did nothing on a
// blank draft, yet looked enabled. It is disabled while the draft is blank.
it("disables Send in the edit form while the draft is blank", () => {
  const sends: string[] = [];
  const view = render(
    createElement(EditableUserMessage, {
      content: "hello",
      entryId: "e1",
      onSubmit: (_id: string, text: string) => sends.push(text),
    }),
  );
  const send = view.getByRole("button", {
    name: translatorFor("en").t("common.send"),
  }) as HTMLButtonElement;
  const draft = view.container.querySelector("textarea")!;
  expect(send.disabled).toBe(false);
  for (const blank of ["", "  \n "]) {
    fireEvent.change(draft, { target: { value: blank } });
    expect({ blank, disabled: send.disabled }).toEqual({
      blank,
      disabled: true,
    });
  }
  fireEvent.change(draft, { target: { value: " edited " } });
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  expect(sends).toEqual(["edited"]);
  view.unmount();
});
