import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { PinnedMessageStrip } = await import("./PinnedMessageStrip.tsx");
const message = {
  id: "202608-00000001",
  kind: "user" as const,
  userId: "sam",
  userName: "Sam",
  content: "**Pinned text**",
  timestamp: 1,
  pinnedAt: 2,
  attachments: [],
};

it("jumps to a loaded pin and expands an unloaded pin in place with its unpin action", () => {
  let jumps = 0,
    unpins = 0;
  const props = {
    message,
    count: 1,
    author: "Sam",
    loaded: true,
    onJump: () => {
      jumps++;
    },
    onUnpin: () => {
      unpins++;
    },
  };
  const view = render(
    onLanguage("en", createElement(PinnedMessageStrip, props)),
  );
  expect(view.getByRole("button", { name: /Pinned \(1\)/ }).textContent).toBe(
    "Pinned (1) · SamPinned text",
  );
  expect(
    view
      .getByRole("button", { name: /Pinned \(1\)/ })
      .querySelector("strong") === null,
  ).toBe(true);
  fireEvent.click(view.getByRole("button", { name: /Pinned \(1\)/ }));
  expect(jumps).toBe(1);
  expect(
    view.container.querySelector("[data-members-chat-expanded-pin]") === null,
  ).toBe(true);
  view.rerender(
    onLanguage(
      "en",
      createElement(PinnedMessageStrip, { ...props, loaded: false }),
    ),
  );
  fireEvent.click(view.getByRole("button", { name: /Pinned \(1\)/ }));
  expect(jumps).toBe(1);
  expect(view.container.querySelector("strong")?.textContent).toBe(
    "Pinned text",
  );
  fireEvent.click(view.getByLabelText("Message actions"));
  fireEvent.click(view.getByRole("button", { name: "Unpin" }));
  expect(unpins).toBe(1);
});

for (const [language, word] of [
  ["en", "Pinned"],
  ["es", "Fijados"],
  ["ca", "Fixats"],
] as const) {
  it(`shows exactly twenty and the twenty-first sentinel with ${language} labels`, () => {
    const props = {
      message,
      count: 20,
      author: "Sam",
      loaded: true,
      onJump: () => {},
      onUnpin: () => {},
    };
    const view = render(
      onLanguage(language, createElement(PinnedMessageStrip, props)),
    );
    expect(view.getByRole("button").textContent).toContain(`${word} (20)`);
    view.rerender(
      onLanguage(
        language,
        createElement(PinnedMessageStrip, { ...props, count: 21 }),
      ),
    );
    expect(view.getByRole("button").textContent).toContain(`${word} (20+)`);
  });
}
