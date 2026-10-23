import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { render, fireEvent } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

// iOS draws a ▶ glyph through the emoji font and ignores its color, so the
// caret is an SVG on both layouts.
it("thinking opens on a click, with an SVG caret instead of a glyph", () => {
  for (const isMobile of [false, true]) {
    const view = render(
      onLanguage(
        "en",
        <LogEntryCard
          isMobile={isMobile}
          entry={{
            id: "thinking",
            agentId: "agent",
            timestamp: 0,
            kind: "thinking",
            content: "Check the result.",
          }}
        />,
      ),
    );
    const header = view.getByRole("button", { name: /Thinking/ });
    expect(header.textContent?.includes("\u25b6")).toBe(false);
    expect(header.querySelector("svg") !== null).toBe(true);
    expect(view.queryByText("Check the result.") === null).toBe(true);
    fireEvent.click(header);
    expect(view.queryByText("Check the result.") !== null).toBe(true);
    view.unmount();
  }
});
