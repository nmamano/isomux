// The wall doors and the tab bar walk one room list (task 8070f62b): tucked
// rooms are skipped, an active tucked room is pinned last, and a drop on the
// tabs moves the doors before the server answers.
import { beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { mount, room, act, fireEvent, shimEmit } = fixture;
fixture.setupRoomDoorTests({ decorations: false });

type UserRecord = import("../../shared/types.ts").UserRecord;
type PresenceInfo = import("../../shared/types.ts").PresenceInfo;

const { t } = translatorFor("en");
const SELF = "u-self";
const noop = () => {};

// Each PUT /api/me/view/{order,tucked} waits here until the test answers it.
let writes: {
  path: string;
  body: unknown;
  resolve: () => void;
  reject: (e: Error) => void;
}[] = [];

beforeEach(() => {
  writes = [];
  setApiShim(async (method, path, body) => {
    if (method === "PUT" && path.startsWith("/api/me/view/"))
      return new Promise<void>((resolve, reject) =>
        writes.push({ path, body, resolve, reject }),
      );
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    return {};
  });
});

function self(tucked: string[]): UserRecord {
  return {
    id: SELF,
    name: "Tester",
    notifRooms: [],
    createdAt: 0,
    role: "member",
    avatarColor: "#4a90d9",
    avatarVariant: "classic",
    allowedRooms: [],
    hidden: [],
    order: [],
    tucked,
    pushRooms: [],
    memberPrompt: null,
    language: null,
  };
}

function open(ids: string[], tucked: string[], current: string | null) {
  const view = mount(ids.map((id) => room(id, `Room ${id}`)));
  act(() => {
    shimEmit({
      type: "session_context",
      context: {
        userId: SELF,
        username: "Tester",
        role: "member",
        currentSessionPrefix: "s",
        connectionId: "c-self",
      },
    });
    shimEmit({ type: "user_self_updated", user: self(tucked) });
  });
  act(() =>
    current === null
      ? fixture.dispatch({ type: "set_lobby_open", open: true })
      : fixture.dispatch({ type: "set_current_room", roomId: current }),
  );
  return view;
}

const name = (id: string) => `Room ${id}`;

// The room tabs in bar order, the pinned tab of an active tucked room
// included, by room id.
function tabs(c: HTMLElement): string[] {
  return [...c.querySelectorAll("[draggable]")].map(
    (el) => el.textContent?.match(/Room ([a-z])/)?.[1] ?? "?",
  );
}

function tab(c: HTMLElement, id: string): HTMLElement {
  const el = [...c.querySelectorAll("[draggable]")].find((t) =>
    t.textContent?.includes(name(id)),
  );
  if (!el) throw new Error(`no tab ${id}`);
  return el as HTMLElement;
}

function activeTab(c: HTMLElement): string {
  const el = c.querySelector('[data-active-room-tab="true"]');
  return el?.textContent?.match(/Room ([a-z])/)?.[1] ?? "?";
}

// The live wall doors, left then right, by label. A door click turns the room
// (task 8f71e886), and the turn's snapshots are inert copies of the doors.
function doors(c: HTMLElement): (string | null)[] {
  return [...c.querySelectorAll('svg[data-turn="doors"] g.isomux-wall-door')]
    .filter((g) => !g.closest("[inert]"))
    .map((g) => g.getAttribute("aria-label"));
}

// What the doors must say for the active tab: its neighbours in the bar, the
// Lobby before the first tab and the new-room door after the last.
function tabNeighbours(c: HTMLElement): string[] {
  const ids = tabs(c);
  const i = ids.indexOf(activeTab(c));
  expect(i).toBeGreaterThanOrEqual(0);
  return [
    i > 0 ? name(ids[i - 1]) : t("common.lobby"),
    i < ids.length - 1 ? name(ids[i + 1]) : t("office.newRoom.door"),
  ];
}

const dataTransfer = () => ({
  setData: noop,
  effectAllowed: "",
  dropEffect: "",
});

function dragTab(c: HTMLElement, from: string, onto: () => Element) {
  const dt = dataTransfer();
  act(() => {
    fireEvent.dragStart(tab(c, from), { dataTransfer: dt });
  });
  act(() => {
    fireEvent.dragOver(onto(), { dataTransfer: dt });
  });
  act(() => {
    fireEvent.drop(onto(), { dataTransfer: dt });
  });
}

it("skips a tucked room: the doors are the active tab's neighbours, and lead there", async () => {
  const { container } = open(["a", "b", "c", "d"], ["b"], "c");
  expect(tabs(container)).toEqual(["a", "c", "d"]);
  expect(doors(container)).toEqual([name("a"), name("d")]);
  expect(doors(container)).toEqual(tabNeighbours(container));
  const left = container.querySelector(
    `svg[data-turn="doors"] g[aria-label="${name("a")}"]`,
  )!;
  await act(async () => fireEvent.click(left));
  expect(fixture.snapshot.currentRoomId).toBe("a");
  expect(doors(container)).toEqual(tabNeighbours(container));
});

it("gives an open tucked room the doors of its pinned tab", () => {
  const { container } = open(["a", "b", "c"], ["b"], "b");
  expect(tabs(container)).toEqual(["a", "c", "b"]);
  expect(activeTab(container)).toBe("b");
  expect(doors(container)).toEqual([name("c"), t("office.newRoom.door")]);
  expect(doors(container)).toEqual(tabNeighbours(container));
});

it("moves the doors with a tuck before the server answers, and back on failure", async () => {
  const { container } = open(["a", "b", "c"], [], "c");
  expect(doors(container)).toEqual([name("b"), t("office.newRoom.door")]);
  dragTab(container, "b", () => container.querySelector("[data-tucked-chip]")!);
  expect(writes.map((w) => w.path)).toEqual(["/api/me/view/tucked"]);
  expect(tabs(container)).toEqual(["a", "c"]);
  expect(doors(container)).toEqual([name("a"), t("office.newRoom.door")]);
  await act(async () => writes[0].reject(new Error("offline")));
  expect(tabs(container)).toEqual(["a", "b", "c"]);
  expect(doors(container)).toEqual([name("b"), t("office.newRoom.door")]);
});

it("moves the doors with a tab drop before the server answers", () => {
  const { container } = open(["a", "b", "c"], [], "a");
  expect(doors(container)).toEqual([t("common.lobby"), name("b")]);
  dragTab(container, "c", () => tab(container, "a"));
  expect(writes.map((w) => w.path)).toEqual(["/api/me/view/order"]);
  expect(tabs(container)).toEqual(["c", "a", "b"]);
  expect(doors(container)).toEqual([name("c"), name("b")]);
  expect(doors(container)).toEqual(tabNeighbours(container));
});

it("opens the lobby's door onto the first tab", async () => {
  const { container } = open(["a", "b"], ["a"], null);
  expect(fixture.snapshot.lobbyOpen).toBe(true);
  expect(tabs(container)).toEqual(["b"]);
  expect(doors(container)).toEqual([name("b")]);
  await act(async () =>
    fireEvent.click(
      container.querySelector(`svg g[aria-label="${name("b")}"]`)!,
    ),
  );
  expect(fixture.snapshot.currentRoomId).toBe("b");
});

function presence(roomId: string): PresenceInfo {
  return {
    connectionId: "peer",
    userId: "peer",
    username: "peer",
    currentRoomId: roomId,
    focusedAgentId: null,
    viewMode: "office",
    device: null,
    avatarColor: "#7c9cf5",
    avatarVariant: "classic",
  };
}
function peerIn(roomId: string) {
  act(() =>
    shimEmit({
      type: "presence_list",
      entries: [presence(roomId)],
      totalOnlineUsers: 1,
      onlineUserIds: ["peer"],
    }),
  );
}
const ghost = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('div[title="peer"]');

// A ghost walks out through a door only when that door leads to its room. The
// left door here leads to a; a ghost bound for the tucked room b, which no door
// leads to, leaves without walking to a door.
it("walks a ghost out only through the door to its room", () => {
  const { container } = open(["a", "b", "c"], ["b"], "c");
  peerIn("c");
  expect(ghost(container)).not.toBeNull();
  peerIn("b");
  expect(ghost(container)).toBeNull();
  // The control: the same ghost bound for a walks to the left door.
  peerIn("c");
  const natural = ghost(container)!.style.left;
  expect(natural).not.toBe("25px");
  peerIn("a");
  expect(ghost(container)!.style.left).toBe("25px");
});
