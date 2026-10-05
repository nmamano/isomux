// The Tucked column of the Rooms table on the member's own profile: the touch
// path to tuck a room (the tab bar's drag-to-chip needs a mouse).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
const { en } = await import("../shared/i18n/en.ts");

const rooms = ["r1", "r2"].map((id) => ({
  id,
  name: `Room ${id}`,
  prompt: null,
  canCloseWhenEmpty: true,
}));

let requests: { method: string; path: string; body: unknown }[] = [];
beforeEach(() => {
  requests = [];
  setApiShim(async (method, path, body) => {
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/me/rooms") return { rooms };
    requests.push({ method, path, body });
    return {};
  });
});
afterAll(() => setApiShim(null));

const page = (over: { hidden?: string[]; tucked?: string[] }) =>
  onLanguage(
    null,
    createElement(UserSettingsView, {
      onSwitchUser: () => {},
      onClose: () => {},
    }),
    {
      rooms,
      hasReceivedInitialState: true,
      users: new Map([["tester", { ...selfUserRecord(null), ...over }]]),
    },
  );

// Mount, then let the mount-time reads (memory) settle inside act.
async function mount(over: { hidden?: string[]; tucked?: string[] }) {
  const view = render(page(over));
  await act(async () => {});
  return view;
}

const tuckBox = (view: ReturnType<typeof render>, id: string) =>
  view.getByRole("checkbox", {
    name: en["settings.profile.tuck"].replace("{room}", `Room ${id}`),
  }) as HTMLInputElement;

describe("Tucked column", () => {
  it("saves the tucked list with the full-list route", async () => {
    const view = await mount({});
    expect(tuckBox(view, "r2").checked).toBe(false);
    await act(async () => {
      fireEvent.click(tuckBox(view, "r2"));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: en["common.save"] }));
    });
    expect(requests.filter((r) => r.path === "/api/me/view/tucked")).toEqual([
      { method: "PUT", path: "/api/me/view/tucked", body: { tucked: ["r2"] } },
    ]);
    view.unmount();
  });

  it("shows a hidden tucked room as tucked but locked", async () => {
    const view = await mount({ hidden: ["r2"], tucked: ["r2"] });
    expect(tuckBox(view, "r2").checked).toBe(true);
    expect(tuckBox(view, "r2").disabled).toBe(true);
    expect(tuckBox(view, "r1").disabled).toBe(false);
    view.unmount();
  });

  it("takes a tuck made in the tab bar while the form is open and clean", async () => {
    const view = await mount({});
    await act(async () => {
      view.rerender(page({ tucked: ["r1"] }));
    });
    expect(tuckBox(view, "r1").checked).toBe(true);
    // The form stays clean: no edit to save.
    expect(view.queryByRole("button", { name: en["common.save"] })).toBeNull();
    const saved = view.getByRole("button", {
      name: en["common.saved"],
    }) as HTMLButtonElement;
    expect(saved.disabled).toBe(true);
    view.unmount();
  });
});
