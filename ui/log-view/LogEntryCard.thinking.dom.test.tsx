import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { render, fireEvent } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

it("thinking uses a colored SVG caret and keeps its disclosure transition", () => {
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
    const svg = header.querySelector("svg");
    expect(svg !== null).toBe(true);
    expect(svg?.querySelector("path")?.getAttribute("fill")).toBe(
      "currentColor",
    );
    const caret = svg?.parentElement;
    expect(caret?.style.transform).toBe("rotate(0deg)");
    expect(caret?.style.transition).toBe("transform 0.15s");
    expect(view.queryByText("Check the result.") === null).toBe(true);
    fireEvent.click(header);
    expect(caret?.style.transform).toBe("rotate(90deg)");
    expect(view.queryByText("Check the result.") !== null).toBe(true);
    view.unmount();
  }
});
