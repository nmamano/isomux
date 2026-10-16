import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

// The shape of a settings notice: a header, one line per change.
const CONTENT = "first line\nsecond: a → b\nthird line";

function renderSystem(content: string, metadata?: Record<string, unknown>) {
  return render(
    onLanguage(
      "en",
      <LogEntryCard
        entry={{
          id: "notice",
          agentId: "agent",
          timestamp: 0,
          kind: "system",
          content,
          metadata,
        }}
      />,
    ),
  );
}

// A one-line system entry is the reference for how a system message looks.
function styleOf(view: ReturnType<typeof renderSystem>) {
  const box = view.container.firstElementChild as HTMLElement;
  return {
    textAlign: box.style.textAlign,
    fontStyle: box.style.fontStyle,
    color: box.style.color,
    fontFamily: box.style.fontFamily,
  };
}

it("shows a multi-line isomux notice as a system message, line breaks kept", () => {
  const oneLine = renderSystem("one line");
  const reference = styleOf(oneLine);
  oneLine.unmount();

  const view = renderSystem(CONTENT, { notice: "settings" });
  expect(styleOf(view)).toEqual(reference);
  const box = view.container.firstElementChild as HTMLElement;
  expect(box.style.whiteSpace).toBe("pre-wrap");
  expect(box.textContent).toBe(CONTENT);
  expect(view.container.querySelectorAll("p").length).toBe(0);
  view.unmount();
});

it("keeps unmarked multi-line system output on the Markdown path", () => {
  const view = renderSystem(CONTENT);
  const box = view.container.firstElementChild as HTMLElement;
  expect(box.style.textAlign).toBe("left");
  expect(view.container.querySelectorAll("p").length).toBeGreaterThan(0);
  view.unmount();
});
