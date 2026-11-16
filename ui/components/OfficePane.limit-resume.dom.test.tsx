// Task 2b42971b: the owner's "resume after usage limit" checkbox in the Office
// pane. It is the office's switch (OfficeSettingSwitch, whose save, conflict
// and older-server cases OfficePane.isomux-label.dom.test.tsx covers): this
// file checks the pane reads it and writes its own field.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { OfficePane } = await import("./OfficePane.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const { t } = translatorFor("en");

afterAll(() => {
  setApiShim(null);
});

function fakeOffice() {
  const state = { limitResume: true, label: false };
  const version = () => `s:${JSON.stringify(state)}`;
  const writes: Record<string, unknown>[] = [];
  setApiShim(async (method, path, body) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/office/instructions" && method === "GET")
      return { instructions: null, version: "i" };
    if (path === "/api/office/settings" && method === "GET")
      return {
        name: null,
        version: version(),
        processIsolation: true,
        processIsolationStatus: "on",
        claudeIsomuxLabel: state.label,
        limitResume: state.limitResume,
      };
    if (path === "/api/office/settings" && method === "PUT") {
      writes.push(b);
      if ("limitResume" in b) state.limitResume = b.limitResume as boolean;
      if ("claudeIsomuxLabel" in b)
        state.label = b.claudeIsomuxLabel as boolean;
      return undefined;
    }
    throw new Error(`no shim for ${method} ${path}`);
  });
  return { state, writes, version };
}

const resumeBox = (view: ReturnType<typeof render>) =>
  view.queryByRole("checkbox", {
    name: t("settings.office.limitResume"),
  }) as HTMLInputElement | null;

it("shows the office's switch on, and the owner's click writes only it, off", async () => {
  const office = fakeOffice();
  const first = office.version();
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  expect(resumeBox(view)?.checked).toBe(true);

  await act(async () => {
    fireEvent.click(resumeBox(view)!);
  });
  await waitFor(() => expect(resumeBox(view)?.checked).toBe(false));
  expect(office.writes).toEqual([{ version: first, limitResume: false }]);
  expect(office.state.label).toBe(false);
  view.unmount();
});
