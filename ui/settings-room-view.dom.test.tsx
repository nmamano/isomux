// The "Your view" column of the Rooms table on the member's own profile
// (task 611c968e): one level control per room, in place of the Displayed,
// Tucked, Notifications and Push boxes. It is also the touch path to tuck a
// room (the tab bar's drag-to-chip needs a mouse). The table lists the rooms
// in the viewer's tab order.

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

type Over = {
  hidden?: string[];
  tucked?: string[];
  notifRooms?: string[];
  pushRooms?: string[];
};
type Room = (typeof rooms)[number] & { type?: "lobby" };
type StoreRooms = { rooms?: Room[]; allRooms?: Room[] };

const page = (over: Over, store: StoreRooms = {}) =>
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
      ...store,
    },
  );

// Mount, then let the mount-time reads (memory) settle inside act.
async function mount(over: Over, store: StoreRooms = {}) {
  const view = render(page(over, store));
  await act(async () => {});
  return view;
}

type View = ReturnType<typeof render>;
// Each row's control is a radio group named after its room.
const groups = (view: View) => view.queryAllByRole("radiogroup");
const groupFor = (view: View, id: string) =>
  groups(view).find((g) =>
    (g.getAttribute("aria-label") ?? "").includes(`Room ${id}`),
  )!;
const levelOf = (view: View, id: string) =>
  groupFor(view, id).dataset.viewLevel;
async function pick(view: View, id: string, level: string) {
  const step = groupFor(view, id).querySelector<HTMLButtonElement>(
    `[role="radio"][data-view-level="${level}"]`,
  )!;
  await act(async () => {
    fireEvent.click(step);
  });
}
async function save(view: View) {
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: en["common.save"] }));
  });
}
const writes = () => requests.filter((r) => r.method !== "GET");

describe("Your view column", () => {
  it("reads each room's level, and saves a pick with the full-list routes: tucked before notifications, push last", async () => {
    const view = await mount({ notifRooms: ["r1"], pushRooms: [] });
    expect(levelOf(view, "r1")).toBe("notify");
    expect(levelOf(view, "r2")).toBe("shown");
    await pick(view, "r1", "tucked");
    await pick(view, "r2", "push");
    await save(view);
    // The server drops a tucked room's notifications, so the tuck goes
    // before the notifications write.
    expect(writes()).toEqual([
      { method: "PUT", path: "/api/me/view/tucked", body: { tucked: ["r1"] } },
      {
        method: "PUT",
        path: "/api/me/view/notif-rooms",
        body: { notifRooms: ["r2"] },
      },
      {
        method: "PUT",
        path: "/api/me/view/push-rooms",
        body: { pushRooms: ["r2"] },
      },
    ]);
    view.unmount();
  });

  it("a hidden tucked room reads as hidden; raised to notifications it is shown first, then untucked, then notified", async () => {
    const view = await mount({ hidden: ["r2"], tucked: ["r2"] });
    expect(levelOf(view, "r2")).toBe("hidden");
    await pick(view, "r2", "notify");
    await save(view);
    expect(writes()).toEqual([
      {
        method: "PUT",
        path: "/api/me/view/shown",
        body: { shown: ["r1", "r2"] },
      },
      { method: "PUT", path: "/api/me/view/tucked", body: { tucked: [] } },
      {
        method: "PUT",
        path: "/api/me/view/notif-rooms",
        body: { notifRooms: ["r2"] },
      },
    ]);
    view.unmount();
  });

  it("a hide goes first and takes the room's notifications and push with it; a room picked back to where it was writes nothing", async () => {
    const view = await mount({ notifRooms: ["r1"], pushRooms: ["r1"] });
    await pick(view, "r1", "hidden");
    await pick(view, "r2", "push");
    await pick(view, "r2", "shown");
    await save(view);
    expect(writes()[0]).toEqual({
      method: "PUT",
      path: "/api/me/view/shown",
      body: { shown: ["r2"] },
    });
    // The server drops a hidden room's notifications and push on its own,
    // so writing the lists again is allowed, but only without either room.
    for (const w of writes().slice(1)) {
      expect(["/api/me/view/notif-rooms", "/api/me/view/push-rooms"]).toContain(
        w.path,
      );
      expect(Object.values(w.body as Record<string, string[]>)[0]).toEqual([]);
    }
    view.unmount();
  });

  it("takes a tuck made in the tab bar while the form is open and clean, with the notifications and push the server dropped for it", async () => {
    const view = await mount({ notifRooms: ["r1"], pushRooms: ["r1"] });
    expect(levelOf(view, "r1")).toBe("push");
    // The record the server sends after the tab bar tucks a push room.
    await act(async () => {
      view.rerender(page({ tucked: ["r1"], notifRooms: [], pushRooms: [] }));
    });
    expect(levelOf(view, "r1")).toBe("tucked");
    // The form stays clean: no edit to save.
    expect(view.queryByRole("button", { name: en["common.save"] })).toBeNull();
    const saved = view.getByRole("button", {
      name: en["common.saved"],
    }) as HTMLButtonElement;
    expect(saved.disabled).toBe(true);
    view.unmount();
  });

  it("lists the rooms in the viewer's tab order, then the rest in office order", async () => {
    const lobby: Room = {
      id: "lobby",
      name: "Room lobby",
      type: "lobby",
      prompt: null,
      canCloseWhenEmpty: false,
    };
    const r3 = { ...rooms[0], id: "r3", name: "Room r3" };
    // The office holds every room; the viewer's tab bar has r3 before r1 and
    // no r2, which they hid. The lobby is never a row.
    const view = await mount(
      { hidden: ["r2"] },
      { allRooms: [lobby, ...rooms, r3], rooms: [lobby, r3, rooms[0]] },
    );
    const byLabel = ["lobby", "r1", "r2", "r3"];
    const rowOrder = groups(view)
      .map((g) =>
        byLabel.find((id) =>
          (g.getAttribute("aria-label") ?? "").includes(`Room ${id}`),
        ),
      )
      .filter((id) => id !== undefined);
    expect(rowOrder).toStrictEqual(["r3", "r1", "r2"]);
    view.unmount();
  });
});
