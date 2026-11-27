// The action-ask cards' office (task e3d1bc63), shared by the
// ui/log-view/ask-action*.dom.test.tsx files below, split because the 5 s cap
// is per file: ask-action (agent access and the credential actions),
// ask-action-member (a member's rooms and role, and a room view on a hidden
// room or with no lists) and ask-action-settings (packs, preferences, room views and
// the office and backup settings). Import it with `await import(...)` after
// setUpDomTestFile(), like every DOM module.
//
// Each test file keeps its own API shim state (posts, answer, read): a test
// assigns them, and an imported binding cannot be assigned.
import { expect } from "bun:test";

const { render, waitFor } = await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { AsksStack } = await import("../log-view/AsksStack.tsx");
const { en } = await import("../../shared/i18n/en.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;

export const NOW = Date.now();
export const action = (
  id: string,
  agentId: string,
  access: string,
  pack?: Record<string, unknown>,
): AskEntry =>
  ({
    id,
    agentId: "a1",
    memberUserId: "u1",
    prompt: `Move ${agentId}?`,
    createdAt: NOW,
    updatedAt: NOW,
    step: { kind: "agent-access", agentId, access, ...(pack ? { pack } : {}) },
  }) as AskEntry;
export const ENTRIES: AskEntry[] = [
  action("act00001", "t1", "privileged"),
  // The asking agent itself, to a stop below Standard.
  action("act00002", "a1", "office"),
  // An agent the office state does not have.
  action("act00003", "ghost", "privileged"),
];
const ASKER = {
  id: "a1",
  name: "Asker",
  roomId: "r1",
  desk: 0,
  access: "standard",
  userId: "u2",
} as never;
// No access field: the wire leaves it out at Standard.
const CURATOR = {
  id: "t1",
  name: "Curator",
  roomId: "r1",
  desk: 1,
} as never;

// Part 2: the members and rooms a member-room or member-role card reads.
// Morgan (u1, the member the asks are for) is an office owner and holds the
// full records; Casey (u2) is the asking agent's manager.
export const member = (
  id: string,
  name: string,
  role: "owner" | "member",
  allowedRooms: string[],
) =>
  ({
    id,
    name,
    role,
    allowedRooms,
    notifRooms: [],
    pushRooms: [],
    hidden: [],
    order: [],
    tucked: [],
    memberPrompt: null,
    language: "en",
    createdAt: NOW,
    avatarColor: "#336699",
    avatarVariant: "classic",
  }) as never;
export const MEMBERS = [
  member("u1", "Morgan", "owner", []),
  member("u2", "Casey", "member", ["r1"]),
  member("u3", "Dana", "member", []),
];
const ROOMS = [
  { id: "r1", name: "Studio" },
  { id: "r2", name: "Garden" },
] as never[];

let dispatchNow: ReturnType<typeof useDispatch> = () => {};
/** The store's dispatch of the card on screen. A test file destructures this
 *  from the import, so it is a stable function that calls the dispatch of the
 *  latest mount. */
export const seeded: ReturnType<typeof useDispatch> = (action) =>
  dispatchNow(action);
export function Seed({
  entries,
  children,
}: {
  entries: AskEntry[];
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatchNow = dispatch;
    dispatch({ type: "agent_added", agent: ASKER });
    dispatch({ type: "agent_added", agent: CURATOR });
    dispatch({ type: "users_admin_list", users: MEMBERS });
    for (const room of ROOMS) dispatch({ type: "room_created", room });
    dispatch({ type: "all_rooms_list", rooms: ROOMS });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

export async function mount(entries: AskEntry[] = ENTRIES) {
  const view = render(
    <StoreProvider>
      <Seed entries={entries}>
        <AsksStack agentId="a1" isMobile={false} />
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-ask]").length).toBe(
      entries.length,
    ),
  );
  const card = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
  const block = (id: string) =>
    card(id).querySelector<HTMLElement>("[data-ask-action]");
  const apply = (id: string) =>
    card(id).querySelector<HTMLButtonElement>("[data-ask-action-apply]");
  return { view, card, block, apply };
}

// An ask with any step, for the member u1 (Morgan).
export const memberAsk = (
  id: string,
  step: Record<string, unknown>,
): AskEntry =>
  ({
    id,
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Change this member?",
    createdAt: NOW,
    updatedAt: NOW,
    step,
  }) as AskEntry;

// The marks of an action block: the value now and asked for, and the flags.
export const flags = (b: HTMLElement) => ({
  current: b.dataset.askActionCurrent,
  requested: b.dataset.askActionRequested,
  manager: b.hasAttribute("data-ask-action-manager"),
  selfDemote: b.hasAttribute("data-ask-action-self-demote"),
  gone: b.hasAttribute("data-ask-action-gone"),
});

// A member-view card in level terms (task 473aeab7): the level id on the
// block, the level name in the from and to labels, and the meaning of the
// level asked for. No current when the member's lists are not known.
export const viewCard = (b: HTMLElement) => ({
  current: b.dataset.askActionCurrent,
  requested: b.dataset.askActionRequested,
  from: b.querySelector("[data-ask-action-from]")?.textContent,
  to: b.querySelector("[data-ask-action-to]")?.textContent,
});
export type Level = "hidden" | "tucked" | "shown" | "notify" | "push";
export const levelCard = (current: Level | undefined, requested: Level) => ({
  current,
  requested,
  from: current && en[`settings.room.viewLevel.${current}`],
  to: en[`settings.room.viewLevel.${requested}`],
});

// Where a value row puts its parts (task 8e61bf71): a card that reads its
// value now draws its value rows as cells of one grid, so the value asked
// keeps its cell while the value now loads. For the value asked `to`: whether
// its row is a run of cells of a grid (every element between them draws no
// box of its own), and the cell that holds the value asked, the placeholder
// and the value now (-1: none).
export function valueSlots(to: HTMLElement) {
  const row = to.parentElement!;
  let up = row;
  let cellsOfGrid = row.style.display === "contents";
  while (up.parentElement && up.parentElement.style.display !== "grid") {
    up = up.parentElement;
    cellsOfGrid &&= up.style.display === "contents";
    if (up.hasAttribute("data-ask-action")) break;
  }
  const cells = [...row.children];
  const holds = (selector: string) =>
    cells.findIndex((c) => c.querySelector(selector) !== null);
  return {
    cellsOfGrid: cellsOfGrid && up.parentElement?.style.display === "grid",
    to: cells.indexOf(to),
    placeholder: holds("[data-ask-action-loading]"),
    from: cells.findIndex(
      (c) =>
        c.matches("[data-ask-action-from]") ||
        c.querySelector("[data-ask-action-from]") !== null,
    ),
  };
}

// Whether a block draws its value rows as a grid at all.
export const hasGrid = (b: HTMLElement) =>
  [...b.querySelectorAll<HTMLElement>("*")].some(
    (e) => e.style.display === "grid",
  );
