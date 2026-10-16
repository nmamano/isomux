// The turn-end push option under the Rooms table of the member's own
// profile (task 1eda8af8): a self-only preference on the user record.
//
// Pins: the box shows the record's value, off when absent; a change makes
// the form dirty and Save sends only it to PATCH /api/me/preferences.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
const { settingsReportsApi } =
  await import("./test-support/settings-reports-fixture.ts");

const writes: unknown[] = [];
setApiShim(async (method, path, body) => {
  if (method !== "GET") writes.push([method, path, body]);
  if (path === "/api/me/preferences") return undefined;
  return settingsReportsApi(method, path, body);
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  writes.length = 0;
});

async function mount(turnEndPush?: true) {
  const record = {
    ...selfUserRecord(null),
    ...(turnEndPush ? { turnEndPush } : {}),
  };
  const view = render(
    onLanguage(
      null,
      createElement(UserSettingsView, {
        onSwitchUser: () => {},
        onClose: () => {},
      }),
      { users: new Map([[record.name.toLowerCase(), record]]) },
    ),
  );
  await act(async () => {});
  return view;
}

const box = (view: Awaited<ReturnType<typeof mount>>) =>
  view.getByTestId("turn-end-push") as HTMLInputElement;

describe("turn-end push option", () => {
  it("is off when the record has none, and Save sends only the change", async () => {
    const view = await mount();
    expect(box(view).checked).toBe(false);
    await act(async () => fireEvent.click(box(view)));
    expect(box(view).checked).toBe(true);
    const save = view
      .getAllByRole("button")
      .find((el) => el.textContent?.trim() === "Save");
    expect(save).toBeDefined();
    await act(async () => fireEvent.click(save!));
    expect(writes).toEqual([
      ["PATCH", "/api/me/preferences", { turnEndPush: true }],
    ]);
    view.unmount();
  });

  it("shows a record's on as checked, and Save sends off", async () => {
    const view = await mount(true);
    expect(box(view).checked).toBe(true);
    await act(async () => fireEvent.click(box(view)));
    const save = view
      .getAllByRole("button")
      .find((el) => el.textContent?.trim() === "Save");
    await act(async () => fireEvent.click(save!));
    expect(writes).toEqual([
      ["PATCH", "/api/me/preferences", { turnEndPush: false }],
    ]);
    view.unmount();
  });
});
