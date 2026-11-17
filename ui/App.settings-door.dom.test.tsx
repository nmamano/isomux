// A settings door while Settings is already open (task f3322da8; Nil,
// 2026-11-14: "if the settings page is already open, clicking the settings
// icon on a member doesn't move to that member's settings page"). The desktop
// sidebar's member and room settings buttons stay clickable beside the open
// page. Each click drills Settings into that member or room (task
// 1f79f2e3), wherever the page stood (on You, on another member, on Theme);
// its back row shows the list with the group that holds it open. An
// unsaved edit is asked about first: Cancel keeps the page and the edit,
// Discard goes on to the member. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const { en } = await import("../shared/i18n/en.ts");
const { selfUserRecord } = await import("./test-support/language-fixture.tsx");
const {
  boot,
  click,
  memberWire,
  navRow,
  setMembers,
  setRole,
  setSelfUser,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

/** An owner's office with two other members, Ann (u2) and Bea (u3), whose
 *  full records reach the owner, so Settings shows an editor for each. */
async function bootOwner(): Promise<View> {
  setRole("owner");
  setSelfUser({ role: "owner" });
  setMembers([memberWire("u2", "Ann"), memberWire("u3", "Bea")]);
  const view = await boot();
  const full = (id: string, name: string, role: "owner" | "member") => ({
    ...selfUserRecord(null),
    id,
    name,
    role,
  });
  await act(async () => {
    shimEmit({
      type: "users_admin_list",
      users: [
        full("u1", "member", "owner"),
        full("u2", "Ann", "member"),
        full("u3", "Bea", "member"),
      ],
    } as never);
  });
  return view;
}

const settingsPage = (view: View) =>
  view.baseElement.querySelector('[data-testid="settings-content"]');

/** Where the Settings page stands: the item it is drilled into (task
 *  1f79f2e3) and its open part, the rows its own list marks as current (a
 *  member row by its name), and which of the Members and Rooms groups are
 *  open (none shows while an item is drilled in). */
function where(view: View) {
  const current = [
    ...view.baseElement.querySelectorAll('[aria-current="true"]'),
  ]
    .filter(
      (el) =>
        el.closest("nav[data-chat-sidebar]") === null &&
        !el.hasAttribute("data-settings-part"),
    )
    .map((el) =>
      (
        el.querySelector('[translate="no"]')?.textContent ??
        el.textContent ??
        ""
      ).trim(),
    );
  const group = (id: string) =>
    view.baseElement
      .querySelector(`[data-sidebar-group-toggle="${id}"]`)
      ?.getAttribute("aria-expanded") ?? null;
  return {
    item:
      view.baseElement
        .querySelector("[data-settings-item]")
        ?.getAttribute("data-settings-item") ?? null,
    part:
      view.baseElement
        .querySelector('button[data-settings-part][aria-current="true"]')
        ?.getAttribute("data-settings-part") ?? null,
    current,
    members: group("members"),
    rooms: group("rooms"),
  };
}

const memberGear = (view: View, userId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-member-settings="${userId}"]`,
  );
const roomGear = (view: View, roomId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-room-settings="${roomId}"]`,
  );

/** Settings from the sidebar's Settings row: it opens on You. */
async function openSettingsOnYou(view: View): Promise<void> {
  await click(navRow(view, "settings"));
  expect(settingsPage(view)).not.toBeNull();
  // Your own General row: one of your parts, not a drill-in.
  expect(where(view)).toEqual({
    item: null,
    part: "general",
    current: [],
    members: "false",
    rooms: "false",
  });
}

const BEA = {
  item: "user:u3",
  part: "general",
  current: [],
  members: null,
  rooms: null,
};

it("a member's settings button over Settings open on You, then on another member, shows each member in the opened Members group", async () => {
  const view = await bootOwner();
  await openSettingsOnYou(view);

  await click(memberGear(view, "u3"));
  expect(settingsPage(view)).not.toBeNull();
  expect(where(view)).toEqual(BEA);

  await click(memberGear(view, "u2"));
  expect(where(view)).toEqual({ ...BEA, item: "user:u2" });

  // Back to the Settings list, with the Members group the door opened.
  await click(view.baseElement.querySelector("button[data-settings-back]"));
  expect(where(view)).toEqual({
    item: null,
    part: null,
    current: [],
    members: "true",
    rooms: "false",
  });
});

it("a room's settings button over Settings open on Theme shows that room, in the opened Rooms group", async () => {
  const view = await bootOwner();
  await openSettingsOnYou(view);
  const theme = [
    ...view.baseElement.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (el) =>
      el.closest("nav[data-chat-sidebar]") === null &&
      el.textContent?.trim() === en["common.theme"],
  );
  await click(theme ?? null);
  expect(where(view)).toEqual({
    item: null,
    part: null,
    current: [en["common.theme"]],
    members: "false",
    rooms: "false",
  });

  await click(roomGear(view, "r2"));
  expect(where(view)).toEqual({
    item: "room:r2",
    part: "general",
    current: [],
    members: null,
    rooms: null,
  });

  // A member's button next: the member, not the room. Each door is a new
  // visit, so the Rooms group the room opened closes again.
  await click(memberGear(view, "u3"));
  expect(where(view)).toEqual(BEA);
});

it("a member's settings button over an unsaved edit asks first: Cancel keeps the edit on You, Discard shows the member", async () => {
  const view = await bootOwner();
  await openSettingsOnYou(view);
  const nameField = () =>
    settingsPage(view)?.querySelector<HTMLInputElement>(
      'input[maxlength="32"]',
    ) ?? null;
  expect(nameField()?.value).toBe("member");
  await act(async () => {
    fireEvent.change(nameField()!, { target: { value: "Edited" } });
  });

  const prompt = () =>
    [...view.baseElement.querySelectorAll("span")].find(
      (el) => el.textContent === en["common.discardPrompt"],
    )?.parentElement ?? null;
  const promptButton = (label: string) =>
    [...(prompt()?.querySelectorAll("button") ?? [])].find(
      (el) => el.textContent?.trim() === label,
    ) ?? null;

  await click(memberGear(view, "u3"));
  expect(prompt()).not.toBeNull();
  expect(where(view).part).toBe("general");
  expect(where(view).item).toBeNull();

  await click(promptButton(en["common.cancel"]));
  expect(prompt()).toBeNull();
  expect(where(view)).toEqual({
    item: null,
    part: "general",
    current: [],
    members: "false",
    rooms: "false",
  });
  expect(nameField()?.value).toBe("Edited");

  await click(memberGear(view, "u3"));
  await click(promptButton(en["common.discard"]));
  expect(prompt()).toBeNull();
  expect(where(view)).toEqual(BEA);
});
