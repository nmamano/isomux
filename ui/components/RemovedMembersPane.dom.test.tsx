// Removed members (task 321e7b8e): an owner restores a removed member, with or
// without what passed to the heir, or deletes them at once with a second
// click. The sidebar row and the seed are in UserSettingsView.sidebar.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { RemovedMembersPane } = await import("./RemovedMembersPane.tsx");
import type { RemovedMemberWire } from "../../shared/contract-shapes.ts";
afterAll(() => setApiShim(null));

const DAY = 24 * 3600_000;
function removed(
  id: string,
  over: Partial<RemovedMemberWire> = {},
): RemovedMemberWire {
  return {
    user: { ...selfUserRecord(null), id, name: `Member ${id}` },
    removedAt: 1_760_000_000_000,
    expiresAt: 1_760_000_000_000 + 30 * DAY,
    removedBy: "Morgan",
    heirName: "Morgan",
    passed: { agents: 1, schedules: 0, webhooks: 0 },
    ...over,
  };
}

let calls: { method: string; path: string; body: unknown }[] = [];
let refuse = false;
beforeEach(() => {
  calls = [];
  refuse = false;
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (refuse) throw new ApiError(409, "name_taken", "taken");
    return method === "POST" ? { user: {}, movedBack: {}, stayed: {} } : {};
  });
});

function mount(members: RemovedMemberWire[]) {
  const restored: string[] = [];
  const view = render(
    onLanguage(
      "en",
      createElement(RemovedMembersPane, {
        onRestored: (id: string) => restored.push(id),
      }),
      { removedMembers: members, removedMembersLoaded: true },
    ),
  );
  const card = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-removed-member="${id}"]`)!;
  const part = (id: string, name: string) =>
    card(id).querySelector<HTMLElement>(`[data-removed-member-${name}]`);
  return { view, restored, card, part };
}

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
}

it("restores with what passed to the heir, or without it when the box is cleared, and opens the member", async () => {
  const { restored, part } = mount([removed("a1"), removed("b2")]);
  const box = part("b2", "move-back") as HTMLInputElement;
  expect(box.checked).toBe(true);
  await click(box);
  expect(box.checked).toBe(false);
  await click(part("a1", "restore"));
  await click(part("b2", "restore"));
  expect(calls).toEqual([
    {
      method: "POST",
      path: "/api/removed-members/a1/restore",
      body: { agents: true },
    },
    {
      method: "POST",
      path: "/api/removed-members/b2/restore",
      body: { agents: false },
    },
  ]);
  expect(restored).toEqual(["a1", "b2"]);
});

it("offers the box only when an heir got something", () => {
  const { part } = mount([
    removed("a1"),
    removed("b2", { heirName: null }),
    removed("c3", { passed: { agents: 0, schedules: 0, webhooks: 0 } }),
    removed("d4", { passed: { agents: 0, schedules: 0, webhooks: 2 } }),
  ]);
  expect(
    ["a1", "b2", "c3", "d4"].map((id) => part(id, "move-back") !== null),
  ).toEqual([true, false, false, true]);
});

it("a refused restore stays on the card with the reason and opens nothing", async () => {
  refuse = true;
  const { restored, card, part } = mount([removed("a1")]);
  await click(part("a1", "restore"));
  expect(calls).toHaveLength(1);
  expect(restored).toEqual([]);
  expect(card("a1").textContent).toContain("taken");
});

it("Delete now deletes only on the second click", async () => {
  const { part } = mount([removed("a1")]);
  const button = part("a1", "delete")!;
  const before = button.textContent;
  await click(button);
  expect(calls).toEqual([]);
  // The button now asks to confirm.
  expect(button.textContent).not.toBe(before);
  await click(button);
  expect(calls).toEqual([
    { method: "DELETE", path: "/api/removed-members/a1", body: undefined },
  ]);
});

it("Delete now forgets the first click when the button loses focus", async () => {
  const { part } = mount([removed("a1")]);
  const button = part("a1", "delete")!;
  await click(button);
  await act(async () => {
    fireEvent.blur(button);
  });
  await click(button);
  expect(calls).toEqual([]);
});
