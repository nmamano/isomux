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
