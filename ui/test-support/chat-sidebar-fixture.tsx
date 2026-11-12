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
//                                            integrations, settings)
//   [data-sidebar-badge]                     a row's count, absent at 0
//   button[data-sidebar-room="<roomId>"]     a room header, aria-expanded
//   button[data-sidebar-back-room="<roomId>"] a room's Back room row,
//                                            aria-expanded
//   button[data-sidebar-agent="<agentId>"]   an agent row, rendered only while
//                                            its section is open;
//                                            aria-current="page" on the open
//                                            agent's row
//
// The human chats (task 019e4d7c, agreed with the worker at the Part B stub):
//   [data-sidebar-members]                   the Members section header
//   button[data-sidebar-member="<userId>"]   a member row; data-removed on a
//                                            removed peer, data-online on an
//                                            online member, aria-current="page"
//                                            on the open chat's row
//   [data-sidebar-member-settings]           a member row's gear (owners)
//   [data-sidebar-unread-dot]                the collapsed sidebar's open
//                                            button, while a human chat has
//                                            unread
//   [data-human-chat="members"|"<userId>"]   the full-screen human chat
//   [data-member-settings]                   its header's settings button
//   [data-chat-switcher]                     its title where no sidebar shows,
//   [data-chat-switcher-option="members"|"<userId>"]  and the options
//   [data-peer-removed]                      the notice that replaces the
//                                            composer for a removed peer
//   [data-lobby-chat-fab]                    the lobby's chat button
// Added by task 5dac6b9b (agreed with the worker, 2026-11-12):
//   [data-sidebar-room-summary="<roomId>"]   a folded room header's summary
//   [data-sidebar-back-room-summary="<roomId>"] a folded back room's summary
//   [data-sidebar-room-working="<n>"]        in a summary: the green dot and
//                                            the working count, absent at 0
//                                            (its badge: [data-sidebar-badge])
//   [data-sidebar-back-room-agents]          the indented list of a back room
//   button[data-sidebar-room-menu="<roomId>"] a room header's "..." button
//   [data-room-menu="settings|tuck|untuck|up|down"] the room menu's items
//                                            (role=menuitem); one menu open
//                                            at a time
//   [data-sidebar-tucked-rooms]              the list under Tucked rooms
//   button[data-sidebar-pin="<agentId>"]     an agent row's pin button,
//                                            aria-pressed when pinned
//   [data-agent-menu-pin="pin|unpin"]        the desk menu's pin item
//   button[data-sidebar-section="pinned|recent"] a section header,
//                                            aria-expanded, absent when empty
//   [data-sidebar-section-agents="pinned|recent"] that section's rows
//   [data-sidebar-slot]                      the sidebar's slot, its width in
//                                            style
//   [data-sidebar-resizer]                   the slot's right edge
//   nav[data-sidebar-closing]                the sidebar while it slides out
// Added by task b2889127 (agreed with the worker, 2026-11-12):
//   button[data-sidebar-pin="member:<userId>"] a live member row's pin
//                                            button, aria-pressed when pinned
//   button[data-sidebar-member="<userId>"]   also in Pinned's
//                                            [data-sidebar-section-agents],
//                                            mixed with the agent rows

import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../App.tsx";
import { SceneDecorationContext } from "../office/scene-decoration.tsx";
import { FeaturesProvider, StoreProvider } from "../store.tsx";
import type { Features } from "../../shared/features.ts";
import { setApiShim } from "../api.ts";
import { connect, setShim, shimEmit } from "../ws.ts";
import { BACK_SEAT_BASE } from "../../shared/desks.ts";
import { selfUserRecord } from "./language-fixture.tsx";
import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type AskEntry,
  type MemberDmSummary,
  type MembersChatMessage,
  type UserPublicWire,
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
// A third room, only in the tests that seat it (setRooms).
export const THIRD_ROOM = {
  id: "r3",
  name: "Third room",
  prompt: null,
  canCloseWhenEmpty: true,
};
let rooms: typeof ROOMS = ROOMS;
export function setRooms(next: typeof ROOMS): void {
  rooms = next;
}
export const ALL_ROOMS = [...ROOMS, THIRD_ROOM];

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
// The member's own full record, with `over` on top (tucked rooms, a role).
export function setSelfUser(over: Partial<UserRecord>): void {
  selfUser = {
    ...selfUserRecord(null),
    id: "u1",
    name: "member",
    role: "member",
    allowedRooms: ["r1", "r2", "r3"],
    ...over,
  };
}
// The role session_context carries; "member" unless a test sets "owner".
let role: "member" | "owner" = "member";
export function setRole(next: "member" | "owner"): void {
  role = next;
}
// POST /api/agents bodies (a spawn), in order.
export const spawns: Record<string, unknown>[] = [];
// PUT /api/me/view/* writes, in order.
export const viewWrites: { path: string; body: unknown }[] = [];

// The other members (users_list after full_state, with "member" itself), who
// is online, and full_state's 1:1 chat summaries (absent: not sent).
let members: UserPublicWire[] = [];
export function setMembers(next: UserPublicWire[]): void {
  members = next;
}
export const memberWire = (id: string, name: string): UserPublicWire => ({
  id,
  name,
  role: "member",
  avatarColor: "#4a90d9",
  avatarVariant: "classic",
  createdAt: 0,
});
let onlineIds: string[] = [];
export function setOnline(next: string[]): void {
  onlineIds = next;
}
let memberDms: MemberDmSummary[] | undefined;
export function setMemberDms(next: MemberDmSummary[] | undefined): void {
  memberDms = next;
}
// GET /api/users/<id>/chat answers, by peer id; an empty page otherwise.
export const dmPages: Record<string, MembersChatMessage[]> = {};
// While true, every 1:1 chat page request fails.
let dmFail = false;
export function setDmFail(next: boolean): void {
  dmFail = next;
}
// Every API call, in order.
export const requests: { method: string; path: string; body: unknown }[] = [];

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
    requests.push({ method, path, body });
    const dm = /^\/api\/users\/([^/?]+)\/chat(\/[^?]*)?(\?.*)?$/.exec(path);
    if (dm) {
      const peerId = decodeURIComponent(dm[1]);
      const rest = dm[2] ?? "";
      if (method === "GET" && rest === "") {
        if (dmFail) throw new Error("offline");
        return {
          messages: dmPages[peerId] ?? [],
          hasMore: false,
          readPointer: null,
          unread: 0,
        };
      }
      if (method === "POST" && rest === "/read")
        return {
          readPointer: (body as { lastReadId?: string })?.lastReadId ?? null,
          unread: 0,
        };
      if (method === "POST" && rest === "") {
        const text = (body as { text?: string })?.text ?? "";
        return {
          id: `202611-${(requests.length + 0x100).toString(16).padStart(8, "0")}`,
          kind: "user",
          userId: "u1",
          userName: "member",
          timestamp: 9_000,
          content: text,
          attachments: [],
        } satisfies MembersChatMessage;
      }
      return {};
    }
    if (path === "/api/member-chats") return { chats: memberDms ?? [] };
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
    if (path === "/api/me/rooms") return { rooms };
    // The Settings page's reads.
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (method === "GET" && path === "/api/office/settings")
      return { prompt: null, name: null, version: "1" };
    if (method === "GET" && /^\/api\/rooms\/[^/]+\/settings$/.test(path))
      return { prompt: null, version: "1" };
    if (path === "/api/removed-members") return { members: [] };
    if (method === "GET" && path === "/api/office/instructions")
      return { instructions: null, version: "1" };
    if (method === "GET" && /^\/api\/rooms\/[^/]+\/instructions$/.test(path))
      return { instructions: null, version: "1" };
    if (path === "/api/validate/cwd") return { ok: true };
    if (/^\/api\/agents\/[^/]+\/sessions/.test(path))
      return { sessions: [], currentSessionId: null };
    if (path.startsWith("/api/backends/")) return { models: [] };
    // The member's view writes (order, tucked, pinned), in order.
    if (method === "PUT" && path.startsWith("/api/me/view/")) {
      viewWrites.push({ path, body });
      return undefined;
    }
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
    rooms = ROOMS;
    role = "member";
    asks = [];
    selfUser = null;
    spawns.length = 0;
    members = [];
    onlineIds = [];
    memberDms = undefined;
    for (const id of Object.keys(dmPages)) delete dmPages[id];
    dmFail = false;
    requests.length = 0;
    viewWrites.length = 0;
    window.localStorage.clear();
    // A desktop window wide enough that the sidebar starts open.
    setWindowWidth(1440);
  });
  afterEach(() => {
    if (savedWidth) Object.defineProperty(window, "innerWidth", savedWidth);
    savedWidth = undefined;
  });
}

/** Load the office at `path` ("/" by default), signed in as "member", on the
 *  load entry. `features` is the office the App runs in: production unless a
 *  test passes another, as the landing-page embed does. */
export async function boot(features?: Features, path = "/"): Promise<View> {
  window.history.replaceState(LOAD_ENTRY, "", path);
  let hydrated!: () => void;
  const hydration = new Promise<void>((resolve) => {
    hydrated = resolve;
  });
  setShim(
    () => {},
    () => {
      shimEmit({
        type: "session_context",
        context: { username: "member", userId: "u1", role },
      } as never);
      shimEmit({
        type: "full_state",
        agents,
        rooms,
        office: { name: "Test Office" },
        recentCwds: [],
        killedAgents: [],
        interactions: [],
        ...(memberDms ? { memberDms } : {}),
      } as never);
      if (members.length > 0)
        shimEmit({
          type: "users_list",
          users: [{ ...memberWire("u1", "member"), role }, ...members],
        } as never);
      if (onlineIds.length > 0)
        shimEmit({
          type: "presence_list",
          entries: [],
          totalOnlineUsers: onlineIds.length,
          onlineUserIds: onlineIds,
        } as never);
      if (selfUser)
        shimEmit({ type: "user_self_updated", user: selfUser } as never);
      hydrated();
    },
  );
  const app = createElement(
    StoreProvider,
    null,
    createElement(
      SceneDecorationContext.Provider,
      { value: false },
      createElement(App),
    ),
  );
  const view = render(
    features
      ? createElement(FeaturesProvider, { features, children: app })
      : app,
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

/** The sidebar, or null when it is hidden or sliding out (task 5dac6b9b: a
 *  closing sidebar stays mounted, inert, for its slide). */
export const sidebar = (view: View) =>
  view.container.querySelector<HTMLElement>(
    "nav[data-chat-sidebar]:not([data-sidebar-closing])",
  );
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
