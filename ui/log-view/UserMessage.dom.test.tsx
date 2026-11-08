// A member's message in the agent chat shows as typed: no Markdown. In the
// members chat a message carries its reaction in its own row; quotes and
// rendered Markdown are covered at the panel (ui/members-chat replies and pins
// tests).
import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { EditableUserMessage, UserMessage } = await import("./LogEntryCard.tsx");
const { setRecording, setRecordingRules } =
  await import("../recording-mode.ts");

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
