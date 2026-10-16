// The Push column of the Rooms table on the member's own profile (task
// 0c3fa26f): per room, a push to the member's devices at turn end. It
// replaced the one "notify my devices" box, and is independent of the
// Notifications column.

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

type Over = { hidden?: string[]; pushRooms?: string[]; notifRooms?: string[] };
const page = (over: Over) =>
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

async function mount(over: Over) {
  const view = render(page(over));
  await act(async () => {});
  return view;
}

const boxFor = (
  view: ReturnType<typeof render>,
  key: "settings.profile.devicesFor" | "settings.profile.display",
  id: string,
) =>
  view.getByRole("checkbox", {
    name: en[key].replace("{room}", `Room ${id}`),
  }) as HTMLInputElement;
const devicesBox = (view: ReturnType<typeof render>, id: string) =>
  boxFor(view, "settings.profile.devicesFor", id);

describe("Push column", () => {
  it("saves the push rooms with the full-list route and no preference write", async () => {
    const view = await mount({ pushRooms: ["r1"], notifRooms: [] });
    expect(devicesBox(view, "r1").checked).toBe(true);
    expect(devicesBox(view, "r2").checked).toBe(false);
    await act(async () => {
      fireEvent.click(devicesBox(view, "r2"));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: en["common.save"] }));
    });
    expect(requests.filter((r) => r.method !== "GET")).toEqual([
      {
        method: "PUT",
        path: "/api/me/view/push-rooms",
        body: { pushRooms: ["r1", "r2"] },
      },
    ]);
    view.unmount();
  });

  it("hiding a room clears and locks its box, and a re-show keeps it clear", async () => {
    const view = await mount({ pushRooms: ["r2"] });
    await act(async () => {
      fireEvent.click(boxFor(view, "settings.profile.display", "r2"));
    });
    expect(devicesBox(view, "r2").checked).toBe(false);
    expect(devicesBox(view, "r2").disabled).toBe(true);
    expect(devicesBox(view, "r1").disabled).toBe(false);
    // Shown again, the box stays cleared: the hide removed the room from the
    // form, not only from the render.
    await act(async () => {
      fireEvent.click(boxFor(view, "settings.profile.display", "r2"));
    });
    expect(devicesBox(view, "r2").disabled).toBe(false);
    expect(devicesBox(view, "r2").checked).toBe(false);
    view.unmount();
  });

  it("takes a change saved in the room pane while the form is open and clean", async () => {
    const view = await mount({});
    await act(async () => {
      view.rerender(page({ pushRooms: ["r1"] }));
    });
    expect(devicesBox(view, "r1").checked).toBe(true);
    expect(view.queryByRole("button", { name: en["common.save"] })).toBeNull();
    view.unmount();
  });
});
