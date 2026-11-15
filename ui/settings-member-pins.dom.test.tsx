// An owner sets up another member's sidebar Pinned list on that member's
// Settings page (task 35596be5). The list is part of the page's draft: pin,
// reorder and remove change nothing until Save, which sends the whole list
// once through PUT /api/users/:username/pinned (route rules pinned in
// server/test-support/sidebar-agents.test.ts). A pin the member makes while
// the page is open shows when the owner has not edited the list.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { en } = await import("../shared/i18n/en.ts");
import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type RoomWire,
  type UserRecord,
} from "../shared/types.ts";

const calls: { method: string; path: string; body: unknown }[] = [];
beforeEach(() => {
  calls.length = 0;
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/removed-members") return { members: [] };
    if (path.endsWith("/instructions"))
      return { instructions: "", version: "1" };
    return {};
  });
});
afterAll(() => setApiShim(null));

const writes = () => calls.filter((c) => c.method !== "GET");
const pinWrites = () => writes().filter((c) => c.path.endsWith("/pinned"));

const self = selfUserRecord("en");
const member = (
  id: string,
  name: string,
  over: Partial<UserRecord> = {},
): UserRecord => ({
  ...selfUserRecord(null),
  id,
  name,
  role: "member",
  allowedRooms: ["r1"],
  ...over,
});
const olaf = member("u3", "Olaf");

const rooms: RoomWire[] = [
  {
    id: LOBBY_ROOM_ID,
    type: "lobby",
    name: "Lobby",
    prompt: null,
    canCloseWhenEmpty: false,
  },
  { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
  { id: "r2", name: "Second room", prompt: null, canCloseWhenEmpty: true },
] as RoomWire[];
const agent = (id: string, roomId: string, desk: number): AgentInfo =>
  ({
    id,
    name: `Agent ${id}`,
    roomId,
    desk,
    state: "idle",
    cwd: "/tmp",
  }) as unknown as AgentInfo;
// a1 and a2 in the room Pia reaches; a3 in a room she does not; a4 in the
// lobby, which every member reaches.
const agents = [
  agent("a1", "r1", 0),
  agent("a2", "r1", 1),
  agent("a3", "r2", 0),
  agent("a4", LOBBY_ROOM_ID, 0),
];

function settings(pia: UserRecord) {
  return onLanguage(
    "en",
    createElement(UserSettingsView, {
      onSwitchUser: () => {},
      onClose: () => {},
      initialUserId: pia.id,
    }),
    {
      users: new Map([self, pia, olaf].map((u) => [u.name.toLowerCase(), u])),
      agents,
      rooms,
    },
  );
}

const section = (root: HTMLElement) => {
  const el = root.querySelector<HTMLElement>("[data-member-pins]");
  if (!el) throw new Error("no Pinned section");
  return el;
};
const rowKeys = (root: HTMLElement) =>
  [...section(root).querySelectorAll<HTMLElement>("[data-member-pin-row]")].map(
    (r) => r.getAttribute("data-pin-key"),
  );
const row = (root: HTMLElement, key: string) => {
  const el = section(root).querySelector<HTMLElement>(
    `[data-member-pin-row][data-pin-key="${key}"]`,
  );
  if (!el) throw new Error(`no row for ${key}`);
  return el;
};
const button = (rowEl: HTMLElement, attr: string) => {
  const el = rowEl.querySelector<HTMLButtonElement>(`button[${attr}]`);
  if (!el) throw new Error(`no ${attr} button`);
  return el;
};
const picker = (root: HTMLElement) => {
  const el = section(root).querySelector<HTMLSelectElement>(
    "select[data-member-pins-picker]",
  );
  if (!el) throw new Error("no picker");
  return el;
};
const offered = (root: HTMLElement) =>
  [...picker(root).querySelectorAll("option")]
    .map((o) => o.value)
    .filter((v) => v !== "");
// The Save button: its label is Save when dirty and Saved when clean.
const saveButton = (root: HTMLElement) =>
  within(root).getByRole("button", {
    name: new RegExp(`^(${en["common.save"]}|${en["common.saved"]})$`),
  }) as HTMLButtonElement;

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}
async function pick(root: HTMLElement, key: string) {
  await act(async () => {
    fireEvent.change(picker(root), { target: { value: key } });
  });
}

it("shows the member's list in order and offers, grouped by room, the agents in rooms she reaches and the other members", async () => {
  const pia = member("u2", "Pia", { pinnedAgents: ["a1", "member:u3"] });
  const view = render(settings(pia));
  await act(async () => {});
  const detail = view.getByTestId("settings-content");
  expect(detail.querySelector("h4")?.textContent).toBe("Pia");

  expect(rowKeys(detail)).toEqual(["a1", "member:u3"]);
  expect(row(detail, "a1").textContent).toContain("Agent a1");
  expect(row(detail, "member:u3").textContent).toContain("Olaf");
  // The ends of the list cannot move further.
  expect(button(row(detail, "a1"), "data-pin-up").disabled).toBe(true);
  expect(button(row(detail, "member:u3"), "data-pin-down").disabled).toBe(true);

  // Not offered: what is pinned, Pia herself, an agent in a room she does
  // not reach. The lobby agent is offered: every member reaches the lobby.
  expect(offered(detail).sort()).toEqual(["a2", "a4", "member:u1"]);
  // An agent selector groups agents by room (AGENTS.md UI rules).
  const a2 =
    picker(detail).querySelector<HTMLOptionElement>('option[value="a2"]')!;
  expect(a2.parentElement?.tagName).toBe("OPTGROUP");
  expect(a2.parentElement?.getAttribute("label")).toBe("First room");
  const owner = picker(detail).querySelector<HTMLOptionElement>(
    'option[value="member:u1"]',
  )!;
  expect(owner.parentElement?.tagName).toBe("OPTGROUP");
  expect(owner.parentElement?.getAttribute("label")).not.toBe("First room");

  // Nothing drafted yet: Save is off.
  expect(saveButton(detail).disabled).toBe(true);
  view.unmount();
});

it("pin, move and remove stay a draft; Save sends the whole list once, to the name before a rename", async () => {
  const pia = member("u2", "Pia", { pinnedAgents: ["a1", "member:u3"] });
  const view = render(settings(pia));
  await act(async () => {});
  const detail = view.getByTestId("settings-content");

  await pick(detail, "a2");
  expect(rowKeys(detail)).toEqual(["a1", "member:u3", "a2"]);
  expect(offered(detail)).not.toContain("a2");
  expect(saveButton(detail).disabled).toBe(false);

  await click(button(row(detail, "a2"), "data-pin-up"));
  expect(rowKeys(detail)).toEqual(["a1", "a2", "member:u3"]);
  await click(button(row(detail, "a1"), "data-pin-remove"));
  expect(rowKeys(detail)).toEqual(["a2", "member:u3"]);
  // A removed pin is offered again.
  expect(offered(detail)).toContain("a1");
  await click(button(row(detail, "a2"), "data-pin-down"));
  expect(rowKeys(detail)).toEqual(["member:u3", "a2"]);

  // No write before Save.
  expect(pinWrites().length).toBe(0);
  // With a rename in the same save, the list goes to the name before the
  // rename, and before the rename PATCH moves the route.
  fireEvent.change(detail.querySelector("input")!, {
    target: { value: "Pia Two" },
  });
  await click(saveButton(detail));
  expect(pinWrites()).toEqual([
    {
      method: "PUT",
      path: "/api/users/Pia/pinned",
      body: { pinned: ["member:u3", "a2"] },
    },
  ]);
  const order = writes().map((c) => `${c.method} ${c.path}`);
  expect(order).toContain("PATCH /api/users/Pia");
  expect(order.indexOf("PUT /api/users/Pia/pinned")).toBeLessThan(
    order.indexOf("PATCH /api/users/Pia"),
  );
  view.unmount();
});

it("a list edited back to the record is not dirty; a save that leaves the list alone does not send it", async () => {
  const pia = member("u2", "Pia", { pinnedAgents: ["a1"] });
  const view = render(settings(pia));
  await act(async () => {});
  const detail = view.getByTestId("settings-content");

  await pick(detail, "a2");
  expect(saveButton(detail).disabled).toBe(false);
  await click(button(row(detail, "a2"), "data-pin-remove"));
  expect(rowKeys(detail)).toEqual(["a1"]);
  expect(saveButton(detail).disabled).toBe(true);

  // A name change only: no list write.
  const name = detail.querySelector("input")!;
  fireEvent.change(name, { target: { value: "Pia Two" } });
  await click(saveButton(detail));
  expect(writes().length).toBeGreaterThan(0);
  expect(pinWrites().length).toBe(0);
  view.unmount();
});

it("a pin the member makes while the page is open shows when the owner has not edited the list; the owner's draft wins when they have", async () => {
  const pia = member("u2", "Pia", { pinnedAgents: ["a1"] });
  const view = render(settings(pia));
  await act(async () => {});
  const detail = () => view.getByTestId("settings-content");

  // The member pins a2 from her sidebar: the record arrives over the socket.
  view.rerender(settings({ ...pia, pinnedAgents: ["a1", "a2"] }));
  await act(async () => {});
  expect(rowKeys(detail())).toEqual(["a1", "a2"]);
  expect(saveButton(detail()).disabled).toBe(true);

  // The owner removes a1; then the member pins Olaf.
  await click(button(row(detail(), "a1"), "data-pin-remove"));
  view.rerender(settings({ ...pia, pinnedAgents: ["a1", "a2", "member:u3"] }));
  await act(async () => {});
  expect(rowKeys(detail())).toEqual(["a2"]);
  await click(saveButton(detail()));
  expect(pinWrites()).toEqual([
    {
      method: "PUT",
      path: "/api/users/Pia/pinned",
      body: { pinned: ["a2"] },
    },
  ]);
  view.unmount();
});

it("a key of an agent that no longer exists: once the server stores the saved list without it, the form reads clean", async () => {
  // The member pinned an agent that was later removed: the record keeps its
  // id until the next write, and the store drops it then.
  const pia = member("u2", "Pia", { pinnedAgents: ["gone", "a1"] });
  const view = render(settings(pia));
  await act(async () => {});
  const detail = () => view.getByTestId("settings-content");
  expect(rowKeys(detail())).toEqual(["a1"]);
  expect(saveButton(detail()).disabled).toBe(true);

  await pick(detail(), "a2");
  await click(saveButton(detail()));
  expect(pinWrites().length).toBe(1);
  // The stored list arrives over the socket, without the dead id.
  view.rerender(settings({ ...pia, pinnedAgents: ["a1", "a2"] }));
  await act(async () => {});
  expect(rowKeys(detail())).toEqual(["a1", "a2"]);
  expect(saveButton(detail()).disabled).toBe(true);

  // The owner has not edited since the save: a pin the member makes now
  // shows, and the form stays clean, so a later save cannot undo it.
  view.rerender(settings({ ...pia, pinnedAgents: ["a1", "a2", "a3"] }));
  await act(async () => {});
  expect(rowKeys(detail())).toEqual(["a1", "a2", "a3"]);
  expect(saveButton(detail()).disabled).toBe(true);
  view.unmount();
});

it("no Pinned section on the owner's own page or in the New member form", async () => {
  const pia = member("u2", "Pia");
  const own = render(
    onLanguage(
      "en",
      createElement(UserSettingsView, {
        onSwitchUser: () => {},
        onClose: () => {},
        initialUserId: "u1",
      }),
      {
        users: new Map([self, pia].map((u) => [u.name.toLowerCase(), u])),
        agents,
        rooms,
      },
    ),
  );
  await act(async () => {});
  const ownPage = own.getByTestId("settings-content");
  expect(ownPage.querySelector("h4")?.textContent).toBe("Tester");
  expect(ownPage.querySelectorAll("[data-member-pins]").length).toBe(0);
  own.unmount();

  const fresh = render(
    onLanguage(
      "en",
      createElement(UserSettingsView, {
        onSwitchUser: () => {},
        onClose: () => {},
      }),
      { users: new Map([[self.name.toLowerCase(), self]]), agents, rooms },
    ),
  );
  await act(async () => {});
  const members = fresh.container.querySelector(
    '[data-sidebar-group-toggle="members"][aria-expanded="false"]',
  );
  if (members) fireEvent.click(members);
  await click(
    fresh.getByRole("button", { name: en["settings.members.newMember"] }),
  );
  const form = fresh.getByTestId("settings-content");
  // The condition: this is the New member form.
  within(form).getByRole("button", { name: en["settings.members.create"] });
  expect(form.querySelectorAll("[data-member-pins]").length).toBe(0);
  fresh.unmount();
});
