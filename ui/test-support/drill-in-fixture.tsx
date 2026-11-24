// Shared by the Settings drill-in tests of rooms and members (task
// 1f79f2e3): ui/components/UserSettingsView.drill-in.dom.test.tsx and
// ui/components/UserSettingsView.drill-in-self-room.dom.test.tsx. A test
// loads it with `await import(...)` after setUpDomTestFile(), never
// statically, and calls resetDrillIn() in its beforeEach.
//
// DOM contract: the page root of a drilled item carries
// data-settings-item="<kind>:<id>" (user, room, agent); a part row is
// button[data-settings-part="<part>"], the open one aria-current="true", and
// a row whose part holds an unsaved edit carries data-settings-part-dirty.
// Your own rows in the You group are the same buttons. The open part's body
// is [data-settings-part-body="<part>"]. The back row to the Settings list
// is button[data-settings-back]; on a phone with a part open, the back row
// to the parts list is [data-page-back-to-list], in the open part above its
// body, and the header keeps the page's Close, [data-page-close]. Save is
// [data-settings-save].
import { act, fireEvent, render } from "@testing-library/react";
import { expect } from "bun:test";
import { createElement } from "react";
import { UserSettingsView } from "../components/UserSettingsView.tsx";
import { onLanguage, selfUserRecord } from "./language-fixture.tsx";
import { setApiShim } from "../api.ts";
import { en } from "../../shared/i18n/en.ts";
import { LOBBY_ROOM_ID } from "../../shared/types.ts";
import type { RoomWire, UserRecord } from "../../shared/types.ts";

export type View = ReturnType<typeof render>;

interface Call {
  method: string;
  path: string;
  body: unknown;
}
const calls: Call[] = [];
// The write whose "<METHOD> <path>" is `route` answers with this error.
let refuse: { route: string; error: Error } | null = null;

/** Call in each test's beforeEach: a fresh shim, no refusal, no stored
 *  device choices. */
export function resetDrillIn(): void {
  calls.length = 0;
  refuse = null;
  window.localStorage.clear();
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (refuse && `${method} ${path}` === refuse.route) throw refuse.error;
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/removed-members") return { members: [] };
    // A create answers with an id already on the roster: the broadcast that
    // adds a new record is not part of this fixture.
    if (method === "POST" && path === "/api/users")
      return { user: { id: STEPHEN.id } };
    if (path === "/api/me/rooms") return { rooms: [ROOM] };
    // Settings > New device mints one sign-in link on mount.
    if (method === "POST" && path === "/api/invites/self")
      return { url: SIGN_IN_LINK, invite: {} };
    if (path.endsWith("/os-user"))
      return {
        support: { ok: false, reason: "fixture" },
        state: "off",
        officeOsUser: "office",
      };
    if (path.endsWith("/api-tokens")) return { apiTokens: [] };
    if (path.endsWith("/instructions"))
      return method === "GET"
        ? { instructions: "", version: "1" }
        : {
            instructions:
              (body as { instructions?: string }).instructions ?? null,
            version: "2",
          };
    if (path.endsWith("/settings")) return { prompt: "", version: "1" };
    return {};
  });
}
/** Every call the page sent since the last resetDrillIn. */
export const apiCalls = (): readonly Call[] => calls;
/** The next matching write answers with `error`. */
export function setRefuse(next: { route: string; error: Error }): void {
  refuse = next;
}

/** The link POST /api/invites/self answers with. */
export const SIGN_IN_LINK = "https://office.example/i/one-time";

export const ROOM = {
  id: "r1",
  name: "Sala Nord",
  prompt: null,
  canCloseWhenEmpty: true,
} as RoomWire;
const LOBBY = {
  id: LOBBY_ROOM_ID,
  type: "lobby",
  name: "Lobby",
  prompt: null,
  canCloseWhenEmpty: false,
} as RoomWire;
export const STEPHEN: UserRecord = {
  ...selfUserRecord(null),
  id: "u2",
  name: "Stephen",
  role: "member",
  allowedRooms: ["r1"],
};

/** The Settings page under the fixture's store: you (Tester, `role`, with
 *  `self` on your record), Stephen, the lobby and Sala Nord. */
export function page(
  props: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
  role: "owner" | "member" = "owner",
  self: Partial<UserRecord> = {},
) {
  const record = { ...selfUserRecord(null), role, ...self };
  return onLanguage(
    "en",
    createElement(UserSettingsView, {
      onSwitchUser: () => {},
      onClose: () => {},
      ...props,
    }),
    {
      rooms: [LOBBY, ROOM],
      hasReceivedInitialState: true,
      users: new Map([
        ["tester", record],
        ["stephen", STEPHEN],
      ]),
      ...(role === "member"
        ? {
            sessionContext: {
              userId: record.id,
              username: record.name,
              role: "member",
              currentSessionPrefix: "00000000",
              connectionId: "c1",
            },
          }
        : {}),
      ...state,
    },
  );
}

export async function mount(
  props: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
  role: "owner" | "member" = "owner",
): Promise<View> {
  const view = render(page(props, state, role));
  await settle();
  return view;
}

export async function settle() {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
export async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
  await settle();
}
export async function type(el: Element | null, value: string) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.change(el!, { target: { value } });
  });
}

export const item = (view: View) =>
  view.baseElement
    .querySelector("[data-settings-item]")
    ?.getAttribute("data-settings-item") ?? null;
export const partRow = (view: View, part: string) =>
  view.baseElement.querySelector<HTMLButtonElement>(
    `button[data-settings-part="${part}"]`,
  );
/** The part rows, in order. */
export const parts = (view: View) =>
  [...view.baseElement.querySelectorAll("button[data-settings-part]")].map(
    (el) => el.getAttribute("data-settings-part"),
  );
export const current = (view: View) =>
  [
    ...view.baseElement.querySelectorAll(
      'button[data-settings-part][aria-current="true"]',
    ),
  ].map((el) => el.getAttribute("data-settings-part"));
/** The parts whose row shows the unsaved-edits dot. */
export const dirty = (view: View) =>
  [
    ...view.baseElement.querySelectorAll(
      "button[data-settings-part][data-settings-part-dirty]",
    ),
  ].map((el) => el.getAttribute("data-settings-part"));
/** The parts whose body is in the page. */
export const bodies = (view: View) =>
  [...view.baseElement.querySelectorAll("[data-settings-part-body]")].map(
    (el) => el.getAttribute("data-settings-part-body"),
  );
export const body = (view: View, part: string) =>
  view.baseElement.querySelector<HTMLElement>(
    `[data-settings-part-body="${part}"]`,
  );
export const backRow = (view: View) =>
  view.baseElement.querySelector<HTMLButtonElement>(
    "button[data-settings-back]",
  );
export const phoneBack = (view: View) =>
  view.baseElement.querySelector<HTMLButtonElement>("[data-page-back-to-list]");
/** On a phone with a part open, the page's two leave controls (task
 *  9ec5ce17): the header's Close and the back row to the parts list. `kept`
 *  is the back row's text that page translation keeps (translate="no"), and
 *  `inPart` tells whether the back row is in the open part, not the header. */
export function phoneLeaveControls(view: View) {
  const close = view.baseElement.querySelector("[data-page-close]");
  const back = phoneBack(view);
  return {
    close: close?.textContent?.trim() ?? null,
    back: back?.textContent?.trim() ?? null,
    kept: [...(back?.querySelectorAll('[translate="no"]') ?? [])].map(
      (el) => el.textContent,
    ),
    inPart: back?.closest('[data-testid="settings-content"]') != null,
  };
}
/** What a phone shows for an item named `name` with a part open: Close and a
 *  back row, the back row in the part; the back row keeps the name out of
 *  page translation and adds words to it, so it names the item's parts list,
 *  not the item, and does not read as the Close. */
export function expectItemBackRow(view: View, name: string): void {
  const c = phoneLeaveControls(view);
  expect({
    close: c.close !== null,
    back: c.back !== null,
    inPart: c.inPart,
    kept: c.kept,
    namesItem: c.back?.includes(name),
    moreThanName: c.back !== null && c.back !== name,
    sameAsClose: c.back === c.close,
  }).toEqual({
    close: true,
    back: true,
    inPart: true,
    kept: [name],
    namesItem: true,
    moreThanName: true,
    sameAsClose: false,
  });
}
export const saveButton = (view: View) =>
  view.baseElement.querySelector<HTMLButtonElement>("[data-settings-save]");
/** A Settings list row by its catalog label (not a part row, and not the
 *  header's Close, which names the office under the page). */
export const listRow = (view: View, label: string) =>
  [...view.baseElement.querySelectorAll("button")].find(
    (b) =>
      !b.hasAttribute("data-settings-part") &&
      !b.hasAttribute("data-page-close") &&
      b.textContent?.trim() === label,
  ) ?? null;
export const discardPrompt = (view: View) =>
  [...view.baseElement.querySelectorAll("span")].find(
    (span) => span.textContent === en["common.discardPrompt"],
  )?.parentElement ?? null;
/** The text input whose value is `value`, inside `root`. */
export const inputWith = (root: HTMLElement | null, value: string) =>
  [...(root?.querySelectorAll<HTMLInputElement>("input") ?? [])].find(
    (input) => input.value === value,
  ) ?? null;
export const textarea = (root: HTMLElement | null) =>
  root?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
export const writes = () => calls.filter((c) => c.method !== "GET");

export async function openPart(view: View, part: string) {
  await click(partRow(view, part));
  expect(current(view)).toEqual([part]);
}
export async function save(view: View) {
  await click(saveButton(view));
  await settle();
}
