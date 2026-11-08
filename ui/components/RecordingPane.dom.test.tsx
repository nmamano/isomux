// The Recording mode pane's two options (task 1a5c9478): "hide member names"
// and "hide file paths" are per browser, on by default, and apply at once
// like the switch. The rules they switch are pinned in
// shared/recording-redact.test.ts and ui/App.recording-mode.dom.test.tsx.
import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { RecordingPane } = await import("./RecordingPane.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { RECORDING_OPTIONS_KEY, getRecordingOptions, setRecordingOptions } =
  await import("../recording-mode.ts");
const { en } = await import("../../shared/i18n/en.ts");

afterEach(() => {
  try {
    setRecordingOptions({ members: true, paths: true });
  } catch {
    // The stub throws; nothing to reset.
  }
  localStorage.removeItem(RECORDING_OPTIONS_KEY);
});

function label(key: string): string {
  const text = (en as Record<string, string>)[key];
  expect({ key, text: typeof text }).toEqual({ key, text: "string" });
  return text;
}

it("shows both options on by default; each box sets its own option at once and follows a change made elsewhere", async () => {
  const view = render(onLanguage("en", <RecordingPane />));
  const box = (key: string) =>
    within(view.container).getByRole("checkbox", {
      name: label(key),
    }) as HTMLInputElement;
  const members = () => box("recording.hideMembers");
  const paths = () => box("recording.hidePaths");
  expect([members().checked, paths().checked]).toEqual([true, true]);

  await act(async () => fireEvent.click(members()));
  expect(getRecordingOptions()).toEqual({ members: false, paths: true });
  expect([members().checked, paths().checked]).toEqual([false, true]);

  await act(async () => fireEvent.click(paths()));
  expect(getRecordingOptions()).toEqual({ members: false, paths: false });

  // Another tab, or the same page elsewhere.
  await act(async () => setRecordingOptions({ members: true }));
  expect([members().checked, paths().checked]).toEqual([true, false]);
  view.unmount();
});
