// The sidebar's Pinned and Recent sections (task 5dac6b9b; Nil, 2026-11-12:
// "Pinned and Recent", and "what happens if a pinned agent is recent? i
// assume it's not duplicated"). Pinned lists the member's pinned agents in
// their order; Recent the newest five agents the member messaged, without the
// pinned ones. Both come from the member's own record, so they follow the
// member across devices; a pinned or recent agent also stays in its room. A
// pin button on a row and the desk menu pin and unpin; each section folds,
// and the fold is kept on this device. Drag reorder is checked in a browser
// (HTML5 drag); its order rule is in ui/chat-sidebar.test.ts. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const { selfUserRecord } = await import("./test-support/language-fixture.tsx");
const {
  agentRow,
  backbencher,
  boot,
  click,
  faraway,
  ranger,
  roomHeader,
  scout,
  setSelfUser,
  setUpChatSidebarTests,
  viewWrites,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const sectionHeader = (view: View, name: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-section="${name}"]`,
  );
const sectionIds = (view: View, name: string) =>
  [
    ...view.container.querySelectorAll(
      `nav[data-chat-sidebar] [data-sidebar-section-agents="${name}"] button[data-sidebar-agent]`,
    ),
  ].map((row) => row.getAttribute("data-sidebar-agent"));
const pinButton = (view: View, agentId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-pin="${agentId}"]`,
  );
const pinWrites = () =>
  viewWrites.filter((w) => w.path === "/api/me/view/pinned").map((w) => w.body);
const rowCount = (view: View, agentId: string) =>
  view.container.querySelectorAll(
    `nav[data-chat-sidebar] button[data-sidebar-agent="${agentId}"]`,
  ).length;

const RECORD = {
  pinnedAgents: [faraway.id, scout.id],
  // "gone" is an agent this client does not have.
  recentAgents: [ranger.id, faraway.id, "gone", backbencher.id],
};

it("lists the pinned agents in the member's order and the recent ones without them; both stay in their rooms", async () => {
  setSelfUser(RECORD);
  const view = await boot();
  expect(sectionIds(view, "pinned")).toEqual([faraway.id, scout.id]);
  expect(sectionIds(view, "recent")).toEqual([ranger.id, backbencher.id]);

  // Faraway is pinned and r2's agent: open r2 and it shows there too.
  if (roomHeader(view, "r2")?.getAttribute("aria-expanded") !== "true")
    await click(roomHeader(view, "r2"));
  expect(rowCount(view, faraway.id)).toBe(2);

  // A later record (a message sent from another device) moves Recent.
  await act(async () => {
    shimEmit({
      type: "user_self_updated",
      user: {
        ...selfUserRecord(null),
        id: "u1",
        name: "member",
        role: "member",
        allowedRooms: ["r1", "r2", "r3"],
        ...RECORD,
        recentAgents: [backbencher.id, scout.id, ranger.id],
      },
    } as never);
  });
  expect(sectionIds(view, "recent")).toEqual([backbencher.id, ranger.id]);
});

it("with nothing pinned or recent, neither section shows", async () => {
  setSelfUser({});
  const view = await boot();
  expect(roomHeader(view, "r1")).not.toBeNull();
  expect(sectionHeader(view, "pinned")).toBeNull();
  expect(sectionHeader(view, "recent")).toBeNull();
});

it("a row's pin button pins at the end and unpins, writing the member's full list; the sections follow at once", async () => {
  setSelfUser(RECORD);
  const view = await boot();
  expect(pinButton(view, ranger.id)?.getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(pinButton(view, scout.id)?.getAttribute("aria-pressed")).toBe("true");

  await click(pinButton(view, ranger.id));
  expect(pinWrites()).toEqual([{ pinned: [faraway.id, scout.id, ranger.id] }]);
  expect(sectionIds(view, "pinned")).toEqual([faraway.id, scout.id, ranger.id]);
  // Ranger left Recent for Pinned: not twice.
  expect(sectionIds(view, "recent")).toEqual([backbencher.id]);

  await click(pinButton(view, scout.id));
  expect(pinWrites()[1]).toEqual({ pinned: [faraway.id, ranger.id] });
  expect(sectionIds(view, "pinned")).toEqual([faraway.id, ranger.id]);
});

it("the desk menu of a row pins an agent and unpins a pinned one", async () => {
  setSelfUser(RECORD);
  const view = await boot();
  const menuPin = async (agentId: string) => {
    const row = agentRow(view, agentId);
    expect(row).not.toBeNull();
    await act(async () =>
      fireEvent.contextMenu(row!, { clientX: 40, clientY: 200 }),
    );
    const items = view.baseElement.querySelectorAll<HTMLElement>(
      `[data-agent-menu="${agentId}"] [data-agent-menu-pin]`,
    );
    expect(items.length).toBe(1);
    return items[0];
  };

  const pin = await menuPin(backbencher.id);
  expect(pin.getAttribute("data-agent-menu-pin")).toBe("pin");
  await click(pin);
  expect(pinWrites()).toEqual([
    { pinned: [faraway.id, scout.id, backbencher.id] },
  ]);

  const unpin = await menuPin(faraway.id);
  expect(unpin.getAttribute("data-agent-menu-pin")).toBe("unpin");
  await click(unpin);
  expect(pinWrites()[1]).toEqual({ pinned: [scout.id, backbencher.id] });
});

it("each section folds, and the fold outlives a reload on this device", async () => {
  setSelfUser(RECORD);
  const first = await boot();
  expect(sectionHeader(first, "pinned")?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  await click(sectionHeader(first, "pinned"));
  expect(sectionHeader(first, "pinned")?.getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(sectionIds(first, "pinned")).toEqual([]);
  // Recent is its own fold.
  expect(sectionIds(first, "recent")).toEqual([ranger.id, backbencher.id]);
  await click(sectionHeader(first, "recent"));
  expect(sectionIds(first, "recent")).toEqual([]);
  first.unmount();

  const second = await boot();
  expect({
    pinned: sectionHeader(second, "pinned")?.getAttribute("aria-expanded"),
    recent: sectionHeader(second, "recent")?.getAttribute("aria-expanded"),
    pinnedRows: sectionIds(second, "pinned"),
  }).toEqual({ pinned: "false", recent: "false", pinnedRows: [] });
});
