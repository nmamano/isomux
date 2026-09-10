import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { MembersChatPanel } = await import("./MembersChatPanel.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
afterAll(() => setApiShim(null));
const messages = [1, 2].map((n) => ({
  id: `202609-0000000${n}`,
  kind: "user" as const,
  userId: "u1",
  userName: "Tester",
  content: `message ${n}`,
  attachments: [],
  timestamp: n,
}));

it("closes an outside menu, closes Edit, and closes confirmed Delete even when its request fails", async () => {
  setApiShim(async () => {
    throw new ApiError(500, "failed", "");
  });
  const view = render(
    onLanguage("en", createElement(MembersChatPanel), {
      membersChat: {
        messages,
        loaded: true,
        hasMore: false,
        readPointer: messages[1].id,
        unread: 0,
      },
    }),
  );
  const menus = Array.from(view.container.querySelectorAll("details"));
  const summaries = view.getAllByLabelText("Message actions");
  fireEvent.click(summaries[0]);
  expect(menus[0].open).toBe(true);
  fireEvent.click(summaries[1]);
  expect(menus[0].open).toBe(false);
  expect(menus[1].open).toBe(true);
  fireEvent.click(view.getByRole("textbox"));
  expect(menus[1].open).toBe(false);
  fireEvent.click(summaries[0]);
  fireEvent.click(view.getAllByTitle("Edit")[0]);
  expect(view.container.querySelector("details[open]") === null).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  const summary = view.getAllByLabelText("Message actions")[0];
  fireEvent.click(summary);
  fireEvent.click(view.getAllByTitle("Delete")[0]);
  expect(summary.closest("details")!.open).toBe(true);
  await act(async () =>
    fireEvent.click(view.getByTitle("Click again to delete")),
  );
  expect(summary.closest("details")!.open).toBe(false);
  expect(view.getByRole("alert").textContent).toContain("Could not delete");
});
