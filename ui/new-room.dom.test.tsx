// Room creation doors (task 195533cb). Settings > Rooms ends with a New room
// row: it shows while the group is closed, one click creates one room, the
// room comes into the store from the POST answer (no broadcast needed) and
// its General part opens, an unsaved edit asks first, and a refusal shows
// under the row. Who sees a door is one rule for every door (Settings row,
// office wall door, tab bar +): anyone but a member with a permission pack,
// whatever areas the pack gives, as rooms.create refuses every pack.
// The wall door's creation flow itself is ui/office/room-door-create.dom.test.tsx.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { createElement, useEffect, useReducer } = await import("react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { OfficeView } = await import("./office/OfficeView.tsx");
const { StateCtx, DispatchCtx, reducer } = await import("./store.tsx");
const { LanguageProvider } = await import("./i18n.tsx");
const { stateWithSelfUser, selfUserRecord, asMember } =
  await import("./test-support/language-fixture.tsx");
const { ApiError, setApiShim } = await import("./api.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");

type View = ReturnType<typeof render>;
type AppState = import("./store.tsx").AppState;
type RoomWire = import("../shared/types.ts").RoomWire;
type ReactNode = import("react").ReactNode;

const { t } = translatorFor("en");
const NEW_ROOM = t("office.newRoom.door");
const noop = () => {};

const ROOM: RoomWire = {
  id: "r1",
  name: "Sala Nord",
  prompt: null,
  canCloseWhenEmpty: true,
};
const CREATED: RoomWire = {
  id: "created",
  name: "Room 2",
  prompt: null,
  canCloseWhenEmpty: true,
};

// Every POST /api/rooms body, in order; the answer comes from `reply`.
const posts: unknown[] = [];
let reply: () => Promise<unknown>;
setApiShim(async (method, path, body) => {
  if (method === "POST" && path === "/api/rooms") {
    posts.push(body);
    return reply();
  }
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path === "/api/removed-members") return { members: [] };
  if (path === "/api/me/rooms") return { rooms: [ROOM] };
  // The store keeps this answer (the real reducer is mounted here).
  if (path === "/api/sessions") return { sessions: [], currentSessionId: null };
  if (path.endsWith("/instructions")) return { instructions: "", version: "1" };
  if (path.endsWith("/settings")) return { prompt: "", version: "1" };
  if (path.startsWith("/api/members-chat"))
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  return {};
});
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  posts.length = 0;
  reply = async () => ({ room: CREATED });
});

// The viewers of the rule: an owner, a member with no pack, and a member
// whose pack gives every area at write, rooms included.
type Viewer = "owner" | "member" | "pack";
const VIEWERS: Viewer[] = ["owner", "member", "pack"];
function viewerState(viewer: Viewer): Partial<AppState> {
  const base = { ...selfUserRecord("en"), allowedRooms: [ROOM.id] };
  if (viewer === "owner") return { users: new Map([["tester", base]]) };
  const member = asMember(viewer === "pack" ? "write" : undefined);
  return {
    users: new Map([["tester", { ...base, ...member.record }]]),
    ...member.state,
  };
}

// The real reducer behind the page, so a dispatched room_created lands in
// state.rooms as it does in the app. Nothing here emits a broadcast.
let snapshot: AppState;
function Live({
  initial,
  children,
}: {
  initial: AppState;
  children?: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    snapshot = state;
  }, [state]);
  return createElement(
    StateCtx.Provider,
    { value: state },
    createElement(
      DispatchCtx.Provider,
      { value: dispatch },
      createElement(LanguageProvider, null, children),
    ),
  );
}

async function settle() {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function mountSettings(
  viewer: Viewer = "owner",
  props: Record<string, unknown> = {},
): Promise<View> {
  const initial = stateWithSelfUser("en", {
    rooms: [ROOM],
    hasReceivedInitialState: true,
    ...viewerState(viewer),
  });
  const view = render(
    createElement(
      Live,
      { initial },
      createElement(UserSettingsView, {
        onSwitchUser: noop,
        onClose: noop,
        ...props,
      }),
    ),
  );
  await settle();
  return view;
}

/** The sidebar button that reads `label`, or null. The + glyph is
 *  aria-hidden, so the label is the row's only visible text. */
function row(view: View, label: string): HTMLButtonElement | null {
  return (
    view
      .queryAllByText(label)
      .filter((el) => !el.closest('[aria-hidden="true"]'))
      .map((el) => el.closest("button"))
      .find((el): el is HTMLButtonElement => el !== null) ?? null
  );
}
const newRoomRow = (view: View) => row(view, NEW_ROOM);
const roomsToggle = (view: View) =>
  view.container.querySelector<HTMLElement>(
    '[data-sidebar-group-toggle="rooms"]',
  );
const membersToggle = (view: View) =>
  view.container.querySelector<HTMLElement>(
    '[data-sidebar-group-toggle="members"]',
  );
const roomsOpen = (view: View) =>
  roomsToggle(view)?.getAttribute("aria-expanded") ?? null;
// The drilled item and its open part (ui/test-support/drill-in-fixture.tsx
// has the DOM contract).
const item = (view: View) =>
  view.baseElement
    .querySelector("[data-settings-item]")
    ?.getAttribute("data-settings-item") ?? null;
const openPart = (view: View) =>
  [
    ...view.baseElement.querySelectorAll(
      'button[data-settings-part][aria-current="true"]',
    ),
  ].map((el) => el.getAttribute("data-settings-part"));
const backRow = (view: View) =>
  view.baseElement.querySelector<HTMLButtonElement>(
    "button[data-settings-back]",
  );
const discardPrompt = (view: View) => {
  const text = view.queryByText(t("common.discardPrompt"));
  return text?.parentElement ?? null;
};

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
  await settle();
}

describe("Settings > Rooms > New room", () => {
  it("shows to an owner and to a member without a pack, not to a member with a pack that gives rooms write", async () => {
    const seen: Record<string, boolean> = {};
    for (const viewer of VIEWERS) {
      const view = await mountSettings(viewer);
      // The condition: the Rooms group is on the page for every viewer.
      expect(roomsToggle(view) === null).toBe(false);
      if (viewer === "pack") {
        const self = [...snapshot.users.values()][0] as {
          pack?: { areas: Record<string, string> };
        };
        expect(self.pack?.areas.rooms).toBe("write");
      }
      seen[viewer] = newRoomRow(view) !== null;
      view.unmount();
    }
    expect(seen).toEqual({ owner: true, member: true, pack: false });
  });

  it("shows while the Rooms group is closed, and is the group's last row when it is open", async () => {
    const view = await mountSettings();
    // Rooms starts closed: its room rows are not drawn.
    expect(roomsOpen(view)).toBe("false");
    expect(row(view, ROOM.name) === null).toBe(true);
    expect(newRoomRow(view) === null).toBe(false);

    await click(roomsToggle(view));
    expect(roomsOpen(view)).toBe("true");
    const roomRow = row(view, ROOM.name);
    const add = newRoomRow(view);
    expect(roomRow === null || add === null).toBe(false);
    // After the last room row, before the Members group.
    expect(
      !!(
        roomRow!.compareDocumentPosition(add!) &
        Node.DOCUMENT_POSITION_FOLLOWING
      ),
    ).toBe(true);
    expect(
      !!(
        add!.compareDocumentPosition(membersToggle(view)!) &
        Node.DOCUMENT_POSITION_FOLLOWING
      ),
    ).toBe(true);
    view.unmount();
  });

  it("creates one room for two clicks in one tick, installs it from the answer alone and opens its General part", async () => {
    let answer: (value: unknown) => void = noop;
    reply = () => new Promise((resolve) => (answer = resolve));
    const view = await mountSettings();
    const add = newRoomRow(view)!;
    expect(add === null).toBe(false);
    const before = item(view);

    await act(async () => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    await settle();
    expect(posts).toEqual([{}]);
    // While the POST is out the row takes no click, and nothing opened yet.
    expect(newRoomRow(view)?.disabled).toBe(true);
    await click(newRoomRow(view));
    expect(posts).toHaveLength(1);
    expect(item(view)).toBe(before);

    // The answer, with no room_created broadcast and no full_state.
    await act(async () => answer({ room: CREATED }));
    await settle();
    expect(snapshot.rooms.map((r) => r.id)).toEqual([ROOM.id, CREATED.id]);
    expect(item(view)).toBe(`room:${CREATED.id}`);
    expect(openPart(view)).toEqual(["general"]);
    expect(posts).toHaveLength(1);

    // Back on the Settings list, the Rooms group is open on the new room.
    await click(backRow(view));
    expect(roomsOpen(view)).toBe("true");
    expect(row(view, CREATED.name) === null).toBe(false);
    expect(newRoomRow(view)?.disabled).toBe(false);
    view.unmount();
  });

  it("asks first over an unsaved edit: Cancel creates nothing, Discard creates the room", async () => {
    const view = await mountSettings("owner", {
      initialTarget: { kind: "user", id: "u1", part: "instructions" },
    });
    await act(async () => {
      fireEvent.change(
        view.getByPlaceholderText(
          t("settings.profile.profilePromptPlaceholder"),
        ),
        { target: { value: "Answer in one line." } },
      );
    });

    await click(newRoomRow(view));
    const prompt = discardPrompt(view);
    expect(prompt === null).toBe(false);
    expect(posts).toHaveLength(0);
    await click(within(prompt!).getByText(t("common.cancel")));
    expect(discardPrompt(view) === null).toBe(true);
    expect(posts).toHaveLength(0);
    expect(openPart(view)).toEqual(["instructions"]);

    await click(newRoomRow(view));
    await click(within(discardPrompt(view)!).getByText(t("common.discard")));
    expect(posts).toEqual([{}]);
    expect(item(view)).toBe(`room:${CREATED.id}`);
    view.unmount();
  });

  it("shows a refusal under the row and stays; a network failure shows the fallback in its place", async () => {
    const REFUSAL = "Refused by the fixture.";
    reply = async () => {
      throw new ApiError(403, "fixture_refusal", REFUSAL);
    };
    const view = await mountSettings();
    const before = item(view);

    await click(newRoomRow(view));
    expect(posts).toHaveLength(1);
    expect(view.queryAllByText(REFUSAL).length).toBe(1);
    expect(item(view)).toBe(before);
    expect(newRoomRow(view)?.disabled).toBe(false);

    reply = async () => {
      throw new TypeError("Failed to fetch");
    };
    await click(newRoomRow(view));
    expect(posts).toHaveLength(2);
    expect(view.queryAllByText(REFUSAL).length).toBe(0);
    expect(view.queryAllByText("Failed to fetch").length).toBe(0);
    expect(view.queryAllByText(t("office.newRoom.failed")).length).toBe(1);
    expect(item(view)).toBe(before);

    // The next click clears the line at once, while its POST is still out
    // (after the answer the list column gives way to the room's parts).
    let answer: (value: unknown) => void = noop;
    reply = () => new Promise((resolve) => (answer = resolve));
    await click(newRoomRow(view));
    expect(posts).toHaveLength(3);
    expect(newRoomRow(view)?.disabled).toBe(true);
    expect(view.queryAllByText(t("office.newRoom.failed")).length).toBe(0);
    await act(async () => answer({ room: CREATED }));
    await settle();
    expect(item(view)).toBe(`room:${CREATED.id}`);
    view.unmount();
  });
});

describe("the office doors", () => {
  it("show the wall door and the tab bar + to an owner and a member without a pack, neither to a member with a pack that gives rooms write", async () => {
    const seen: Record<string, { door: boolean; plus: boolean }> = {};
    for (const viewer of VIEWERS) {
      const initial = stateWithSelfUser("en", {
        rooms: [ROOM],
        currentRoomId: ROOM.id,
        hasReceivedInitialState: true,
        connected: true,
        ...viewerState(viewer),
      });
      const view = render(
        createElement(
          Live,
          { initial },
          createElement(OfficeView, {
            onSpawn: noop,
            onContextMenu: noop,
            onOpenSettings: noop,
            onEditOfficePrompt: noop,
            onOpenThemePicker: noop,
            onOpenTasks: noop,
            onOpenCronjobs: noop,
            onOpenApps: noop,
            onOpenUpdate: noop,
          }),
        ),
      );
      await settle();
      seen[viewer] = {
        door:
          view.queryAllByRole("button", { hidden: true, name: NEW_ROOM })
            .length > 0,
        plus:
          view.container.querySelectorAll(
            `[title="${t("office.tabs.newRoom")}"]`,
          ).length > 0,
      };
      view.unmount();
    }
    expect(seen).toEqual({
      owner: { door: true, plus: true },
      member: { door: true, plus: true },
      pack: { door: false, plus: false },
    });
  });
});
