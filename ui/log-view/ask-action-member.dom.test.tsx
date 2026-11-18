// An action ask on a member's room access or role (task e3d1bc63, part 2),
// and a member-view card on a hidden room or for a member whose lists the
// office state does not hold (task 473aeab7). Split from
// ui/log-view/ask-action.dom.test.tsx, which holds the agent-access cards and
// the credential actions; ui/log-view/ask-action-settings.dom.test.tsx holds
// the settings cards. The office is in ui/test-support/ask-action-fixture.tsx.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const {
  MEMBERS,
  flags,
  levelCard,
  member,
  memberAsk,
  mount,
  seeded,
  viewCard,
} = await import("../test-support/ask-action-fixture.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;

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
// The answer to a GET (part 3: the office and backup settings a card reads).
let read: (path: string) => unknown = () => undefined;
beforeEach(() => {
  posts = [];
  answer = async () => undefined;
  read = () => undefined;
  setApiShim(async (method, path) => {
    if (method === "POST") {
      posts.push(path);
      return answer(path);
    }
    return read(path);
  });
});
afterAll(() => setApiShim(null));

// Part 2: a member's room access and role.
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

// Morgan hides Garden and keeps its tucked flag.
const VIEW_ENTRIES: AskEntry[] = [
  memberAsk("vw000001", {
    kind: "member-view",
    list: "shown",
    roomId: "r2",
    on: true,
  }),
  memberAsk("vw000002", {
    kind: "member-view",
    list: "notif",
    roomId: "r2",
    on: true,
  }),
  memberAsk("vw000003", {
    kind: "member-view",
    list: "tucked",
    roomId: "r2",
    on: false,
  }),
];

// Asks for a member whose record the office state does not hold yet: the
// card has no lists to read.
const UNKNOWN_ENTRIES: AskEntry[] = (
  [
    ["shown", true],
    ["shown", false],
    ["tucked", true],
    ["tucked", false],
    ["notif", true],
    ["notif", false],
    ["push", true],
    ["push", false],
  ] as const
).map(
  ([list, on], i) =>
    ({
      ...memberAsk(`unk0000${i}`, {
        kind: "member-view",
        list,
        roomId: "r1",
        on,
      }),
      memberUserId: "u9",
    }) as AskEntry,
);

it("a member-view card on a hidden room keeps it tucked when shown again and shows the level a refused step asks for; without the member's lists it shows the level the step names", async () => {
  const m = await mount([...VIEW_ENTRIES, ...UNKNOWN_ENTRIES]);
  await act(async () => {
    seeded({
      type: "user_admin_updated",
      user: {
        ...(member("u1", "Morgan", "owner", []) as object),
        hidden: ["r2"],
        tucked: ["r2"],
      },
    } as never);
  });
  expect(
    ["vw000001", "vw000002", "vw000003"].map((id) => viewCard(m.block(id)!)),
  ).toEqual([
    levelCard("hidden", "tucked"),
    // The server refuses sound for a hidden room: the card shows Sound, the
    // level the step asks for, and Apply gives the refusal.
    levelCard("hidden", "notify"),
    // Untucking a hidden room leaves it hidden.
    levelCard("hidden", "hidden"),
  ]);
  expect(UNKNOWN_ENTRIES.map((e) => viewCard(m.block(e.id)!))).toEqual(
    (
      [
        "shown",
        "hidden",
        "tucked",
        "shown",
        "notify",
        "shown",
        "push",
        "notify",
      ] as const
    ).map((level) => levelCard(undefined, level)),
  );
  m.view.unmount();
});
