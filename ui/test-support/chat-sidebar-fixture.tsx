// The desktop chat sidebar's office (task c61316be), through the real App,
// store and socket shim. Shared by the ui/App.chat-sidebar*.dom.test.tsx
// files, one subject per file because the 5 s cap is per file. Import it with
// `await import(...)` after setUpDomTestFile(), like every DOM module.
//
// The office: two rooms. r1 holds Scout (desk 0), Ranger (desk 1) and, in its
// back room, Builder; r2 holds Faraway (desk 0) and, in its back room,
// Backbencher. The lobby holds the receptionist. A test can seat other agents
// with setAgents.
//
// The sidebar's hooks, which the tests and the worker share (agreed with the
// worker at the design, 2026-11-11):
//   nav[data-chat-sidebar]                   the sidebar
//   button[data-sidebar-collapse]            its collapse button
//   button[data-show-sidebar]                the chat header's Show sidebar
//   button[data-log-back]                    the chat header's Back button
//   button[data-sidebar-nav="<row>"]         office, new-agent, members-chat
//                                            and the pages (asks, tasks,
//                                            cronjobs, apps, skills,
//                                            integrations)
//   [data-sidebar-badge]                     a row's count, absent at 0
//   button[data-sidebar-room="<roomId>"]     a room header, aria-expanded
//   button[data-sidebar-back-room="<roomId>"] a room's Back room row,
//                                            aria-expanded
//   button[data-sidebar-agent="<agentId>"]   an agent row, rendered only while
//                                            its section is open;
//                                            aria-current="page" on the open
//                                            agent's row

import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../App.tsx";
import { SceneDecorationContext } from "../office/scene-decoration.tsx";
import { StoreProvider } from "../store.tsx";
import { setApiShim } from "../api.ts";
import { connect, setShim, shimEmit } from "../ws.ts";
import { BACK_SEAT_BASE } from "../../shared/desks.ts";
import { selfUserRecord } from "./language-fixture.tsx";
import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type AskEntry,
  type UserRecord,
} from "../../shared/types.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";

export type View = ReturnType<typeof render>;

const base = {
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
};

export function agentAt(
  id: string,
  roomId: string,
  desk: number,
  extra: Partial<AgentInfo> = {},
): AgentInfo {
  return {
    ...base,
    id,
    name: `Agent ${id}`,
    roomId,
    desk,
    ...extra,
  } as unknown as AgentInfo;
}

export const scout = agentAt("a1", "r1", 0);
export const ranger = agentAt("a2", "r1", 1);
export const builder = agentAt("a3", "r1", BACK_SEAT_BASE);
export const faraway = agentAt("a4", "r2", 0);
export const backbencher = agentAt("a5", "r2", BACK_SEAT_BASE);
export const receptionist = agentAt("a6", LOBBY_ROOM_ID, 0);

const DEFAULT_AGENTS = [
  scout,
  ranger,
  builder,
  faraway,
  backbencher,
  receptionist,
];

const ROOMS = [
  { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
  { id: "r2", name: "Second room", prompt: null, canCloseWhenEmpty: true },
];

let agents: AgentInfo[] = DEFAULT_AGENTS;
export function setAgents(next: AgentInfo[]): void {
  agents = next;
}
let asks: AskEntry[] = [];
export function setAsks(next: AskEntry[]): void {
  asks = next;
}
export const ask = (id: string, agentId: string): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: 1_000,
  updatedAt: 1_000,
});
// The self record user_self_updated carries after boot, or null for none.
let selfUser: UserRecord | null = null;
export function setSelfPack(pack: MemberPack): void {
  selfUser = {
    ...selfUserRecord(null),
    id: "u1",
    name: "member",
    role: "member",
    allowedRooms: ["r1", "r2"],
    pack,
  };
}
// POST /api/agents bodies (a spawn), in order.
export const spawns: Record<string, unknown>[] = [];

/** The entry the page loaded on: the office. */
export const LOAD_ENTRY = { loadEntry: true };

let savedWidth: PropertyDescriptor | undefined;
export function setWindowWidth(width: number): void {
  savedWidth ??= Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

export function setUpChatSidebarTests(): void {
  setApiShim(async (method, path, body) => {
    if (path === "/api/asks") return asks;
    if (path === "/api/asks/others") return [];
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    if (path === "/api/apps") return [];
    if (method === "POST" && path === "/api/agents") {
      spawns.push(body as Record<string, unknown>);
      return { agent: agentAt("new", "r1", 7) };
    }
    if (method === "GET" && /^\/api\/tasks(\?|$)/.test(path)) return [];
    // The Automations page's runs.
    if (path === "/api/cron-runs") return { jobs: [] };
    // The spawn dialog's reads.
    if (path === "/api/me/rooms") return { rooms: ROOMS };
    if (path === "/api/validate/cwd") return { ok: true };
    if (/^\/api\/agents\/[^/]+\/sessions/.test(path))
      return { sessions: [], currentSessionId: null };
    if (path.startsWith("/api/backends/")) return { models: [] };
    if (path.startsWith("/api/me/") || path === "/api/sessions")
      throw new Error("no fixture");
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
    agents = DEFAULT_AGENTS;
    asks = [];
    selfUser = null;
    spawns.length = 0;
    window.localStorage.clear();
    // A desktop window wide enough that the sidebar starts open.
    setWindowWidth(1440);
  });
  afterEach(() => {
    if (savedWidth) Object.defineProperty(window, "innerWidth", savedWidth);
    savedWidth = undefined;
  });
}

/** Load the office at "/", signed in as "member", on the load entry. */
export async function boot(): Promise<View> {
  window.history.replaceState(LOAD_ENTRY, "", "/");
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
      shimEmit({
        type: "full_state",
        agents,
        rooms: ROOMS,
        office: { name: "Test Office" },
        recentCwds: [],
        killedAgents: [],
        interactions: [],
      } as never);
      if (selfUser)
        shimEmit({ type: "user_self_updated", user: selfUser } as never);
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

export async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

export async function goBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The chat of the agent at desk 0 of the room in view, as "1" opens it from
 *  the office: Scout's, at boot. */
export async function openFirstDesk(view: View): Promise<void> {
  await press("1");
  expect(chatOpen(view)).toBe(true);
}

export const sidebar = (view: View) =>
  view.container.querySelector<HTMLElement>("nav[data-chat-sidebar]");
export const chatOpen = (view: View) =>
  view.container.querySelector(".log-view-shell") !== null;
export const backScreen = (view: View) =>
  view.container.querySelector("[data-back-room]") !== null;
export const activeRoom = (view: View) =>
  view.container
    .querySelector("[data-active-room-tab] [data-room-tab-button]")
    ?.getAttribute("data-room-tab-button") ?? null;

export const navRow = (view: View, row: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-nav="${row}"]`,
  );
export const agentRow = (view: View, agentId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-agent="${agentId}"]`,
  );
export const roomHeader = (view: View, roomId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-room="${roomId}"]`,
  );
export const backRoomRow = (view: View, roomId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-back-room="${roomId}"]`,
  );
/** The ids of the agent rows marked as the open agent's. */
export const currentRows = (view: View) =>
  [
    ...view.container.querySelectorAll(
      'nav[data-chat-sidebar] button[data-sidebar-agent][aria-current="page"]',
    ),
  ].map((row) => row.getAttribute("data-sidebar-agent"));

export async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => fireEvent.click(el!));
}

/** Open a back agent's chat through the sidebar: its room's Back room row,
 *  then its row. */
export async function openBackAgent(
  view: View,
  roomId: string,
  agentId: string,
): Promise<void> {
  if (roomHeader(view, roomId)?.getAttribute("aria-expanded") !== "true")
    await click(roomHeader(view, roomId));
  if (backRoomRow(view, roomId)?.getAttribute("aria-expanded") !== "true")
    await click(backRoomRow(view, roomId));
  await click(agentRow(view, agentId));
  expect(chatOpen(view)).toBe(true);
  expect(currentRows(view)).toEqual([agentId]);
}
