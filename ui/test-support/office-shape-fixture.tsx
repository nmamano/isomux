// The office while it loads (task ea29a8e2; AGENTS.md "UI rules": a view
// keeps its layout while it loads), through the real App, store and socket
// shim. Shared by ui/App.office-shape*.dom.test.tsx, one subject per file
// because the 5 s cap is per file. Import it with `await import(...)` after
// setUpDomTestFile(), then call setUpChatSidebarTests() from
// ./chat-sidebar-fixture.tsx (the API shim and the per-test reset).
//
// Until the first full_state, the tab bar and the room scene draw dim
// placeholders in the shape this device last drew (localStorage
// "isomux-office-shape", written on pagehide or visibilitychange hidden).
//
// Hooks agreed with the worker at the stub (2026-11-17):
//   [data-room-tab-placeholder]   a tab placeholder, its width in style
//   [data-online-placeholder]     the online chip's placeholder, width in style
//   [data-tucked-placeholder]     the tucked chip's placeholder, only when the
//                                 stored width is over 0
//   [data-desk-placeholder="<n>"] a desk placeholder, and in it
//   [data-desk-placeholder-tag]   its name tag box, width and height in style
//   [data-online-chip]            the real online chip (measured)
//   [data-desk-tag="<n>"]         a DeskUnit's floating name tag (measured)
//   [data-tucked-chip]            the real tucked chip (measured)
//   a real tab is [data-room-tab-button]'s parent (measured)

import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../App.tsx";
import { SceneDecorationContext } from "../office/scene-decoration.tsx";
import { StoreProvider } from "../store.tsx";
import { setShim, shimEmit } from "../ws.ts";
import { selfUserRecord } from "./language-fixture.tsx";
import type { OfficeShape } from "../office-shape.ts";
import {
  ALL_ROOMS,
  LOAD_ENTRY,
  backbencher,
  builder,
  faraway,
  ranger,
  receptionist,
  scout,
  type View,
} from "./chat-sidebar-fixture.tsx";

export const SHAPE_KEY = "isomux-office-shape";

/** Load the office at "/" with the socket open and no frame sent yet. The
 *  member last had r1 open on this device, so the first frame draws a room
 *  (with nothing saved, a load opens on the lobby, whose loading view is
 *  task c4c84c95's). */
export async function mount(): Promise<View> {
  window.history.replaceState(LOAD_ENTRY, "", "/");
  window.localStorage.setItem(
    "isomux-view",
    JSON.stringify({
      user: "member",
      roomId: "r1",
      agentId: null,
      panel: null,
      lobby: false,
    }),
  );
  let opened!: () => void;
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  setShim(
    () => {},
    () => opened(),
  );
  const view = render(
    createElement(
      StoreProvider,
      null,
      createElement(
        SceneDecorationContext.Provider,
        { value: false },
        createElement(App),
      ),
    ),
  );
  await act(async () => {
    await open;
  });
  return view;
}

export async function frame(msg: unknown): Promise<void> {
  await act(async () => {
    shimEmit(msg as never);
  });
}

export const sessionContext = {
  type: "session_context",
  context: { username: "member", userId: "u1", role: "member" },
};
/** The member's own record, with `tucked` tucked. */
export const selfFrame = (tucked: string[]) => ({
  type: "user_self_updated",
  user: {
    ...selfUserRecord(null),
    id: "u1",
    name: "member",
    role: "member",
    allowedRooms: ["r1", "r2", "r3"],
    tucked,
  },
});
/** r1 (in view after load) holds Scout at desk 0, Ranger at desk 1 and, in
 *  its back room, Builder. Three rooms. */
export const fullState = {
  type: "full_state",
  agents: [scout, ranger, builder, faraway, backbencher, receptionist],
  rooms: ALL_ROOMS,
  office: { name: "Test Office" },
  recentCwds: [],
  killedAgents: [],
  interactions: [],
};
/** Two members online: the online chip shows. */
export const presence = {
  type: "presence_list",
  entries: [],
  totalOnlineUsers: 2,
  onlineUserIds: ["u1", "u2"],
};
/** Everything a boot sends, in the server's order. */
export async function loadAll(tucked: string[] = []): Promise<void> {
  await frame(sessionContext);
  await frame(selfFrame(tucked));
  await frame(fullState);
  await frame(presence);
}

export const all = (view: View, selector: string) => [
  ...view.container.querySelectorAll<HTMLElement>(selector),
];
export const one = (view: View, selector: string) =>
  view.container.querySelector<HTMLElement>(selector);

/** What the placeholders draw: the tab widths, the chips and the desks. */
export function drawn(view: View) {
  return {
    tabs: all(view, "[data-room-tab-placeholder]").map((el) => el.style.width),
    online: one(view, "[data-online-placeholder]")?.style.width ?? null,
    tucked: one(view, "[data-tucked-placeholder]")?.style.width ?? null,
    desks: all(view, "[data-desk-placeholder]").map((el) => {
      const tag = el.querySelector<HTMLElement>("[data-desk-placeholder-tag]");
      return [
        el.getAttribute("data-desk-placeholder"),
        tag?.style.width ?? null,
        tag?.style.height ?? null,
      ];
    }),
  };
}
/** What drawn() gives for a shape. */
export const expected = (s: OfficeShape) => ({
  tabs: s.tabs.map((w) => `${w}px`),
  online: `${s.online}px`,
  tucked: s.tucked > 0 ? `${s.tucked}px` : null,
  desks: [...s.desks]
    .sort((a, b) => a.desk - b.desk)
    .map((d) => [String(d.desk), `${d.w}px`, `${d.h}px`]),
});

export const stored = (): unknown => {
  const raw = window.localStorage.getItem(SHAPE_KEY);
  return raw === null ? null : JSON.parse(raw);
};
export const store = (s: unknown) =>
  window.localStorage.setItem(SHAPE_KEY, JSON.stringify(s));

export const SHAPE: OfficeShape = {
  tabs: [120, 90],
  online: 130,
  tucked: 70,
  desks: [
    { desk: 0, w: 80, h: 22 },
    { desk: 3, w: 60, h: 30 },
  ],
};

/** happy-dom lays nothing out: every rect is 0. Give an element a size. */
export function size(el: Element, width: number, height = 20): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      width,
      height,
      bottom: height,
      right: width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}
/** The real tabs of the bar, in order. */
export const realTabs = (view: View) =>
  all(view, "[data-room-tab-button]").map((b) => b.parentElement!);
export const tabIds = (view: View) =>
  all(view, "[data-room-tab-button]").map((b) =>
    b.getAttribute("data-room-tab-button"),
  );

export const hidePage = () =>
  act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });
export async function hideTab(): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  try {
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } finally {
    if (saved) Object.defineProperty(document, "visibilityState", saved);
    else delete (document as { visibilityState?: unknown }).visibilityState;
  }
}

/** The spawn dialog (EditAgentDialog for a new agent) or a dialog. */
export const dialogOpen = (view: View) =>
  one(view, '[role="dialog"]') !== null ||
  one(view, ".agent-engine-section") !== null;
export const backRoomOpen = (view: View) =>
  one(view, "[data-back-room]") !== null;
/** The hit area of each empty desk (EmptySlot's diamond). */
export const emptyDeskHits = (view: View) =>
  all(view, "[data-turn-anchor] > svg > path[data-no-pan]");
/** Let the floor move to the back room finish. */
export const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
