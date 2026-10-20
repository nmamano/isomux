// The office an agent link opens into, through the real App, store and socket
// shim: two rooms, Scout in the first, Faraway at a desk and Backbencher in
// the back room of the second. Shared by the ask link tests (task 9aaec0eb)
// and the address bar tests (task 680747d8), one file each because the 5 s
// cap is per file. Import it with `await import(...)` after
// setUpDomTestFile(), like every DOM module.

import { afterAll, beforeEach } from "bun:test";
import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../App.tsx";
import { SceneDecorationContext } from "../office/scene-decoration.tsx";
import { StoreProvider } from "../store.tsx";
import { setApiShim } from "../api.ts";
import { connect, setShim, shimEmit } from "../ws.ts";
import { BACK_SEAT_BASE } from "../../shared/desks.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";

export type View = ReturnType<typeof render>;

export const scout = {
  id: "a1",
  name: "Scout",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  capabilities: {},
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;
// The link targets, in a second room: one at a desk, one in its back room.
export const faraway = { ...scout, id: "a2", name: "Faraway", roomId: "r2" };
export const backbencher = {
  ...scout,
  id: "a3",
  name: "Backbencher",
  roomId: "r2",
  desk: BACK_SEAT_BASE,
};

const ROOMS = [
  {
    id: "r1",
    name: "First room",
    prompt: null,
    canCloseWhenEmpty: true,
  },
  {
    id: "r2",
    name: "Second room",
    prompt: null,
    canCloseWhenEmpty: true,
    backRoom: true,
  },
];

/** Send the office state, as each socket open does. */
export function fullState(agents: AgentInfo[]): void {
  shimEmit({
    type: "full_state",
    agents,
    rooms: ROOMS,
    office: { name: "Test Office" },
    recentCwds: [],
    killedAgents: [],
    interactions: [],
  } as never);
}

// The asks GET /api/asks returns; a test sets them with setAsks.
let asks: AskEntry[] = [];
export function setAsks(next: AskEntry[]): void {
  asks = next;
}

export function setUpAgentLinkTests(): void {
  setApiShim(async (_method, path) => {
    if (path === "/api/asks") return asks;
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    if (path.startsWith("/api/pager")) return [];
    if (path === "/api/apps") return [];
    return {};
  });
  afterAll(() => {
    setApiShim(null);
    setShim(
      () => {},
      () => {},
    );
    connect(
      () => {},
      () => {},
    );
  });
  beforeEach(() => {
    asks = [];
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
}

/** Load the app as if the browser had just arrived on `path`, signed in as
 *  "member". */
export async function boot(path = "/"): Promise<View> {
  window.history.replaceState(null, "", path);
  let hydrated!: () => void;
  const hydration = new Promise<void>((resolve) => {
    hydrated = resolve;
  });
  setShim(
    () => {},
    () => {
      shimEmit({
        type: "session_context",
        context: { username: "member", userId: "u1", role: "member" },
      } as never);
      fullState([scout, faraway, backbencher]);
      hydrated();
    },
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
    await hydration;
  });
  // Let GET /api/asks land.
  await act(async () => {});
  await act(async () => {});
  return view;
}

export async function escape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

/** The room the office shows once the chat closes. */
export const activeRoom = (view: View) =>
  view.container
    .querySelector("[data-active-room-tab] [data-room-tab-button]")
    ?.getAttribute("data-room-tab-button") ?? null;
export const backScreen = (view: View) =>
  view.container.querySelector("[data-back-room]") !== null;
