// A member's message in the agent chat shows as typed: no Markdown. In the
// members chat a message carries its reaction in its own row; quotes and
// rendered Markdown are covered at the panel (ui/members-chat replies and pins
// tests).
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { UserMessage } = await import("./LogEntryCard.tsx");

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
