// An action ask (task e3d1bc63): the card shows the target agent, its stop
// now (read live from the office state) and the stop asked for, and Apply
// runs it through POST /api/asks/:askId/action. A refusal shows on the card
// and the card stays; the ask closes only when the server closes it. The
// same AskCard is the Inbox's.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;

const NOW = Date.now();
const action = (
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
const ENTRIES: AskEntry[] = [
  action("act00001", "t1", "privileged"),
  // The asking agent itself, to a pack stop.
  action("act00002", "a1", "office", { areas: { tasks: "read" } }),
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

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: string[] = [];
let answer: (path: string) => Promise<unknown> = async () => undefined;
beforeEach(() => {
  posts = [];
  answer = async () => undefined;
  setApiShim(async (method, path) => {
    if (method === "POST") {
      posts.push(path);
      return answer(path);
    }
    return undefined;
  });
});
afterAll(() => setApiShim(null));

// Part 2: the members and rooms a member-room or member-role card reads.
// Morgan (u1, the member the asks are for) is an office owner and holds the
// full records; Casey (u2) is the asking agent's manager.
const member = (
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
const MEMBERS = [
  member("u1", "Morgan", "owner", []),
  member("u2", "Casey", "member", ["r1"]),
  member("u3", "Dana", "member", []),
];
const ROOMS = [
  { id: "r1", name: "Studio" },
  { id: "r2", name: "Garden" },
] as never[];

let seeded: ReturnType<typeof useDispatch> = () => {};
function Seed({
  entries,
  children,
}: {
  entries: AskEntry[];
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    seeded = dispatch;
    dispatch({ type: "agent_added", agent: ASKER });
    dispatch({ type: "agent_added", agent: CURATOR });
    dispatch({ type: "users_admin_list", users: MEMBERS });
    for (const room of ROOMS) dispatch({ type: "room_created", room });
    dispatch({ type: "all_rooms_list", rooms: ROOMS });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

async function mount(entries: AskEntry[] = ENTRIES) {
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

it("shows the target, its stop now and the stop asked for, with Apply and no link", async () => {
  const { view, card, block, apply } = await mount();
  const b = block("act00001");
  expect(b).not.toBe(null);
  expect({
    current: b!.dataset.askActionCurrent,
    requested: b!.dataset.askActionRequested,
    self: b!.hasAttribute("data-ask-action-self"),
    gone: b!.hasAttribute("data-ask-action-gone"),
    names: b!.textContent!.includes("Curator"),
    apply: apply("act00001") !== null,
    link: card("act00001").querySelector("[data-ask-office-link]") !== null,
  }).toEqual({
    current: "standard",
    requested: "privileged",
    self: false,
    gone: false,
    names: true,
    apply: true,
    link: false,
  });
  // The asking agent's own grant is marked as such.
  expect(block("act00002")!.hasAttribute("data-ask-action-self")).toBe(true);
  expect(block("act00002")!.dataset.askActionRequested).toBe("office");
  view.unmount();
});

it("reads the target's stop live: a change in the office state shows on the card", async () => {
  const { view, block } = await mount();
  expect(block("act00001")!.dataset.askActionCurrent).toBe("standard");
  await act(async () => {
    seeded({
      type: "agent_updated",
      agentId: "t1",
      changes: { access: "office", pack: { areas: { tasks: "read" } } },
    } as never);
  });
  expect(block("act00001")!.dataset.askActionCurrent).toBe("office");
  view.unmount();
});

it("a target the office state does not have: marked gone, no Apply", async () => {
  const { view, block, apply } = await mount();
  expect(block("act00003")!.hasAttribute("data-ask-action-gone")).toBe(true);
  expect(apply("act00003")).toBe(null);
  // Gone while the card is up.
  expect(apply("act00001")).not.toBe(null);
  await act(async () => {
    seeded({ type: "agent_removed", agentId: "t1" } as never);
  });
  expect(block("act00001")!.hasAttribute("data-ask-action-gone")).toBe(true);
  expect(apply("act00001")).toBe(null);
  view.unmount();
});

it("Apply posts the run once, is disabled while it runs, and the card stays until the server closes the ask", async () => {
  let release: () => void = () => {};
  answer = () =>
    new Promise((resolve) => (release = () => resolve({ agent: {} })));
  const { view, card, apply } = await mount();
  const button = apply("act00001")!;
  expect(button.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(button);
  });
  expect(posts).toEqual(["/api/asks/act00001/action"]);
  expect(apply("act00001")!.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(apply("act00001")!);
  });
  expect(posts).toHaveLength(1);
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
  // The run does not close the ask: the server's ask_removed does.
  expect(card("act00001")).not.toBe(null);
  view.unmount();
});

it("a refused run shows the route's message on the card, the card stays, and Apply can go again", async () => {
  answer = async () => {
    throw new ApiError(
      422,
      "engine_below_standard",
      "This engine does not run that stop yet.",
    );
  };
  const { view, card, apply } = await mount();
  await act(async () => {
    fireEvent.click(apply("act00001")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/asks/act00001/action"]);
  expect(card("act00001")).not.toBe(null);
  expect(card("act00001").querySelector("[role=alert]")?.textContent).toContain(
    "This engine does not run that stop yet.",
  );
  expect(apply("act00001")!.disabled).toBe(false);
  view.unmount();
});

// Apply makes the change, so the reply field does not start with "done": a
// Reply sent as it stands would close the ask with nothing changed.
it("starts the reply field empty on an action ask", async () => {
  const { view, card } = await mount();
  const field = card("act00001").querySelector<HTMLTextAreaElement>(
    "[data-ask-reply-input]",
  );
  expect(field).not.toBe(null);
  expect(field!.value).toBe("");
  view.unmount();
});

// Part 2: a member's room access and role.
const memberAsk = (id: string, step: Record<string, unknown>): AskEntry =>
  ({
    id,
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Change this member?",
    createdAt: NOW,
    updatedAt: NOW,
    step,
  }) as AskEntry;
const MEMBER_ENTRIES: AskEntry[] = [
  // Dana into Garden.
  memberAsk("mem00001", {
    kind: "member-room",
    userId: "u3",
    roomId: "r2",
    grant: true,
  }),
  // The asking agent's manager into Garden: its own reach grows.
  memberAsk("mem00002", {
    kind: "member-room",
    userId: "u2",
    roomId: "r2",
    grant: true,
  }),
  // The manager out of Studio: its reach does not grow.
  memberAsk("mem00003", {
    kind: "member-room",
    userId: "u2",
    roomId: "r1",
    grant: false,
  }),
  // Dana made an owner.
  memberAsk("mem00004", { kind: "member-role", userId: "u3", role: "owner" }),
  // The manager made an owner.
  memberAsk("mem00005", { kind: "member-role", userId: "u2", role: "owner" }),
  // Morgan, the member the ask is for, made a member.
  memberAsk("mem00006", { kind: "member-role", userId: "u1", role: "member" }),
  // A member the office state does not have.
  memberAsk("mem00007", { kind: "member-role", userId: "u9", role: "owner" }),
  // Morgan, the member the ask is for, made an owner: no demote.
  memberAsk("mem00008", { kind: "member-role", userId: "u1", role: "owner" }),
];

const flags = (b: HTMLElement) => ({
  current: b.dataset.askActionCurrent,
  requested: b.dataset.askActionRequested,
  manager: b.hasAttribute("data-ask-action-manager"),
  selfDemote: b.hasAttribute("data-ask-action-self-demote"),
  gone: b.hasAttribute("data-ask-action-gone"),
});

it("a member-room card names the member and the room, shows granted or removed now and asked for, with Apply and no link", async () => {
  const { view, card, block, apply } = await mount(MEMBER_ENTRIES);
  const b = block("mem00001")!;
  expect(b).not.toBe(null);
  expect({
    ...flags(b),
    member: b.textContent!.includes("Dana"),
    room: b.textContent!.includes("Garden"),
    apply: apply("mem00001") !== null,
    link: card("mem00001").querySelector("[data-ask-office-link]") !== null,
  }).toEqual({
    current: "removed",
    requested: "granted",
    manager: false,
    selfDemote: false,
    gone: false,
    member: true,
    room: true,
    apply: true,
    link: false,
  });
  expect(flags(block("mem00003")!)).toMatchObject({
    current: "granted",
    requested: "removed",
  });
  view.unmount();
});

it("a member-role card shows the role now and the role asked for", async () => {
  const { view, block, apply } = await mount(MEMBER_ENTRIES);
  expect(flags(block("mem00004")!)).toEqual({
    current: "member",
    requested: "owner",
    manager: false,
    selfDemote: false,
    gone: false,
  });
  expect(block("mem00004")!.textContent).toContain("Dana");
  expect(apply("mem00004")).not.toBe(null);
  view.unmount();
});

it("marks a change that widens the asking agent's manager's reach, and only that", async () => {
  const { view, block } = await mount(MEMBER_ENTRIES);
  expect({
    roomGrant: flags(block("mem00002")!).manager,
    roomRemoval: flags(block("mem00003")!).manager,
    otherMember: flags(block("mem00001")!).manager,
    promote: flags(block("mem00005")!).manager,
    otherPromote: flags(block("mem00004")!).manager,
  }).toEqual({
    roomGrant: true,
    roomRemoval: false,
    otherMember: false,
    promote: true,
    otherPromote: false,
  });
  view.unmount();
});

it("marks a demote of the member the ask is for, and no other role change", async () => {
  const { view, block } = await mount(MEMBER_ENTRIES);
  expect(
    MEMBER_ENTRIES.filter(
      (e) => block(e.id)?.hasAttribute("data-ask-action-self-demote") ?? false,
    ).map((e) => e.id),
  ).toEqual(["mem00006"]);
  expect(flags(block("mem00006")!)).toMatchObject({
    current: "owner",
    requested: "member",
  });
  view.unmount();
});

it("reads the member's rooms and role live: a change in the office state shows on the card", async () => {
  const { view, block } = await mount(MEMBER_ENTRIES);
  await act(async () => {
    seeded({
      type: "user_admin_updated",
      user: member("u3", "Dana", "owner", ["r2"]),
    } as never);
  });
  expect(flags(block("mem00001")!).current).toBe("granted");
  expect(flags(block("mem00004")!).current).toBe("owner");
  view.unmount();
});

it("a member the office state does not have: marked gone, no Apply; and a member removed while the card is up", async () => {
  const { view, block, apply } = await mount(MEMBER_ENTRIES);
  expect(flags(block("mem00007")!).gone).toBe(true);
  expect(apply("mem00007")).toBe(null);
  expect(apply("mem00004")).not.toBe(null);
  await act(async () => {
    seeded({
      type: "users_admin_list",
      users: MEMBERS.slice(0, 2),
    } as never);
  });
  expect(flags(block("mem00001")!).gone).toBe(true);
  expect(flags(block("mem00004")!).gone).toBe(true);
  expect(apply("mem00001")).toBe(null);
  expect(apply("mem00004")).toBe(null);
  view.unmount();
});

it("Apply on a member card posts the run once", async () => {
  const { view, apply } = await mount(MEMBER_ENTRIES);
  await act(async () => {
    fireEvent.click(apply("mem00004")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/asks/mem00004/action"]);
  view.unmount();
});
