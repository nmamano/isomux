// ExpandableTextarea's recordingPrivate (task 1a5c9478): the memory and
// instructions fields mark both their textareas, the inline one and the
// expanded editor's, with the scope they show, so recording mode blurs them
// until a click (ui/recording-mode.dom.test.ts pins the blur and the reveal).
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { ExpandableTextarea } = await import("./ExpandableTextarea.tsx");
const { RECORDING_PRIVATE_ATTR } = await import("../recording-mode.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { layOutTextareas, scrolledToEnd } =
  await import("../test-support/textarea-layout.ts");
const { t } = translatorFor("en");

const TITLE = "Room memory";
const field = (scope?: string) => (
  <ExpandableTextarea
    value="- a note"
    onChange={() => {}}
    title={TITLE}
    recordingPrivate={scope}
  />
);
// Every textarea on the page: the inline one, then the expanded editor's.
const scopes = () =>
  [...document.body.querySelectorAll("textarea")].map((ta) =>
    ta.getAttribute(RECORDING_PRIVATE_ATTR),
  );

it("marks the inline and the expanded textarea with the scope, follows a new scope, and marks nothing without one", async () => {
  const view = render(field("room:r1:memory"));
  expect(scopes()).toEqual(["room:r1:memory"]);
  await act(async () =>
    fireEvent.click(
      within(view.container).getByRole("button", {
        name: t("dialogs.textarea.expand", { title: TITLE }),
      }),
    ),
  );
  expect(scopes()).toEqual(["room:r1:memory", "room:r1:memory"]);

  await act(async () => view.rerender(field("room:r2:memory")));
  expect(scopes()).toEqual(["room:r2:memory", "room:r2:memory"]);

  await act(async () => view.rerender(field(undefined)));
  expect(scopes()).toEqual([null, null]);
  view.unmount();
});

// The expanded editor opens with the caret at the end of a long text and the
// end in view (task 75c7ce43). Its height comes from the overlay (a flex
// child), so the test gives it a box. The model has no wrap, so a long text
// is written as many lines.
it("opens a long text with its end in view and the caret there", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const undoLayout = layOutTextareas({
    box: (el) => (el.closest('[role="dialog"]') ? 300 : null),
  });
  try {
    const view = render(
      <ExpandableTextarea value={long} onChange={() => {}} title={TITLE} />,
    );
    await act(async () =>
      fireEvent.click(
        within(view.container).getByRole("button", {
          name: t("dialogs.textarea.expand", { title: TITLE }),
        }),
      ),
    );
    const editor = document.body.querySelector<HTMLTextAreaElement>(
      '[role="dialog"] textarea',
    )!;
    // A boolean, not toBe on two nodes: a red run would serialise both.
    expect(document.activeElement === editor).toBe(true);
    expect(editor.selectionStart).toBe(long.length);
    expect(scrolledToEnd(editor)).toEqual({ overflows: true, atEnd: true });
    view.unmount();
  } finally {
    undoLayout();
  }
});
