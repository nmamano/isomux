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
const { en } = await import("../../shared/i18n/en.ts");
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

// Part 3: the settings an agent cannot change. A single-value card (a pack,
// one room of a room list) marks the value now and asked for on the block,
// as above; a card for a set of settings has one row per key, each marked
// with data-ask-action-key and its value now and asked for.
const SETTINGS_ENTRIES: AskEntry[] = [
  // Dana gets a pack with an office ceiling.
  memberAsk("set00001", {
    kind: "member-pack",
    userId: "u3",
    pack: { areas: { tasks: "read" }, agentCeiling: "office" },
  }),
  // Morgan's own language and read-aloud voice.
  memberAsk("set00002", {
    kind: "member-preferences",
    set: { language: "es", voiceOutput: "openai" },
  }),
  // Morgan's room lists: hide Studio, tuck Garden, push Garden, stop
  // notifications for Studio, push Studio.
  memberAsk("set00003", {
    kind: "member-view",
    list: "shown",
    roomId: "r1",
    on: false,
  }),
  memberAsk("set00004", {
    kind: "member-view",
    list: "tucked",
    roomId: "r2",
    on: true,
  }),
  memberAsk("set00005", {
    kind: "member-view",
    list: "push",
    roomId: "r2",
    on: true,
  }),
  memberAsk("set00006", {
    kind: "member-view",
    list: "notif",
    roomId: "r1",
    on: false,
  }),
  memberAsk("set00007", {
    kind: "member-view",
    list: "push",
    roomId: "r1",
    on: true,
  }),
  memberAsk("set00008", {
    kind: "office-settings",
    set: {
      memberUsageShare: 30,
      processIsolation: true,
      recordTerminals: true,
      providerFallback: true,
    },
  }),
  memberAsk("set00009", {
    kind: "backup-settings",
    set: { dir: "/srv/backups", retention: 3 },
  }),
  memberAsk("set00010", {
    kind: "backup-settings",
    set: { intervalHours: 6 },
  }),
  // A room the office state does not have.
  memberAsk("set00011", {
    kind: "member-view",
    list: "notif",
    roomId: "r9",
    on: true,
  }),
];

const OFFICE_SETTINGS = {
  version: "v1",
  name: "Office",
  memberUsageCap: false,
  memberUsageShare: 50,
  recordTerminals: false,
  providerFallback: false,
  processIsolation: false,
  claudeIsomuxLabel: false,
};
const BACKUP_STATUS = {
  lastRunAt: null,
  ok: true,
  error: null,
  retention: 7,
  intervalHours: 24,
  destDir: "/home/morgan/isomux-backups",
  destDirFromEnv: false,
};
function readSettings() {
  read = (path) =>
    path.startsWith("/api/office/settings")
      ? OFFICE_SETTINGS
      : path.startsWith("/api/backup/status")
        ? BACKUP_STATUS
        : undefined;
}

// Morgan notifies and pushes Studio.
const MORGAN_NOTIFIED = {
  ...(member("u1", "Morgan", "owner", []) as object),
  notifRooms: ["r1"],
  pushRooms: ["r1"],
} as never;

async function mountSettings() {
  readSettings();
  const m = await mount(SETTINGS_ENTRIES);
  await act(async () => {
    seeded({ type: "user_admin_updated", user: MORGAN_NOTIFIED } as never);
  });
  return m;
}

// The rows of a settings card, by key: the value now and asked for.
const rows = (b: HTMLElement) =>
  Object.fromEntries(
    [...b.querySelectorAll<HTMLElement>("[data-ask-action-key]")].map((r) => [
      r.dataset.askActionKey,
      {
        current: r.dataset.askActionCurrent,
        requested: r.dataset.askActionRequested,
      },
    ]),
  );

it("a member-pack card names the member and shows the pack now and asked for, live", async () => {
  const { view, card, block, apply } = await mountSettings();
  const b = block("set00001")!;
  expect(b).not.toBe(null);
  expect({
    ...flags(b),
    member: b.textContent!.includes("Dana"),
    apply: apply("set00001") !== null,
    link: card("set00001").querySelector("[data-ask-office-link]") !== null,
  }).toEqual({
    current: "none",
    requested: "office",
    manager: false,
    selfDemote: false,
    gone: false,
    member: true,
    apply: true,
    link: false,
  });
  await act(async () => {
    seeded({
      type: "user_admin_updated",
      user: {
        ...(member("u3", "Dana", "member", []) as object),
        pack: { areas: { tasks: "read" }, agentCeiling: "folder" },
      },
    } as never);
  });
  expect(flags(block("set00001")!).current).toBe("folder");
  view.unmount();
});

it("a member-preferences card has one row per key, with the value now (the default when the record has none) and the value asked for", async () => {
  const { view, block, apply } = await mountSettings();
  expect(rows(block("set00002")!)).toEqual({
    language: { current: "en", requested: "es" },
    voiceOutput: { current: "browser", requested: "openai" },
  });
  expect(apply("set00002")).not.toBe(null);
  view.unmount();
});

// A member-view card in level terms (task 473aeab7): the level id on the
// block, the level name in the from and to labels, and the meaning of the
// level asked for. No current when the member's lists are not known.
const viewCard = (b: HTMLElement) => ({
  current: b.dataset.askActionCurrent,
  requested: b.dataset.askActionRequested,
  from: b.querySelector("[data-ask-action-from]")?.textContent,
  to: b.querySelector("[data-ask-action-to]")?.textContent,
});
type Level = "hidden" | "tucked" | "shown" | "notify" | "push";
const levelCard = (current: Level | undefined, requested: Level) => ({
  current,
  requested,
  from: current && en[`settings.room.viewLevel.${current}`],
  to: en[`settings.room.viewLevel.${requested}`],
});

it("a member-view card shows the room's view level now and the level after the step, and marks a change that stops the room's notifications or turns them on", async () => {
  const { view, block, apply } = await mountSettings();
  const views = ["set00003", "set00004", "set00005", "set00006", "set00007"];
  expect(
    views.map((id) => {
      const b = block(id)!;
      return {
        id,
        ...viewCard(b),
        alertsStop: b.hasAttribute("data-ask-action-alerts-stop"),
        notifOn: b.hasAttribute("data-ask-action-notif-on"),
      };
    }),
  ).toEqual([
    // Hiding Studio stops its notifications and pushes.
    {
      id: "set00003",
      ...levelCard("push", "hidden"),
      alertsStop: true,
      notifOn: false,
    },
    // Garden has none to stop.
    {
      id: "set00004",
      ...levelCard("shown", "tucked"),
      alertsStop: false,
      notifOn: false,
    },
    // A push for Garden turns its notifications on too.
    {
      id: "set00005",
      ...levelCard("shown", "push"),
      alertsStop: false,
      notifOn: true,
    },
    // Studio's notifications off stop its pushes: the server drops the push
    // with the sound, so Studio is Shown after, not Push.
    {
      id: "set00006",
      ...levelCard("push", "shown"),
      alertsStop: true,
      notifOn: false,
    },
    // Studio pushes already: the step is done, nothing else moves.
    {
      id: "set00007",
      ...levelCard("push", "push"),
      alertsStop: false,
      notifOn: false,
    },
  ]);
  // The meaning line explains the level asked for, not the one now, and the
  // name of the list the step changes is not a third value on the card.
  const hide = block("set00003")!.textContent!;
  expect([
    hide.includes(en["settings.room.viewLevelInfo.hidden"]),
    hide.includes(en["settings.room.viewLevelInfo.push"]),
  ]).toEqual([true, false]);
  const soundOff = block("set00006")!.textContent!;
  expect([
    soundOff.includes(en["settings.room.viewLevelInfo.shown"]),
    soundOff.includes(en["settings.room.viewLevel.notify"]),
  ]).toEqual([true, false]);
  expect(block("set00003")!.textContent).toContain("Studio");
  expect(block("set00005")!.textContent).toContain("Garden");
  // A room the office state does not have: gone, no Apply.
  expect(block("set00011")!.hasAttribute("data-ask-action-gone")).toBe(true);
  expect(apply("set00011")).toBe(null);
  // The levels and marks read the member's lists live.
  await act(async () => {
    seeded({
      type: "user_admin_updated",
      user: member("u1", "Morgan", "owner", []),
    } as never);
  });
  expect(block("set00003")!.hasAttribute("data-ask-action-alerts-stop")).toBe(
    false,
  );
  expect(viewCard(block("set00006")!)).toEqual(levelCard("shown", "shown"));
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

it("an office-settings card has one row per key with the office's value now, and a hint under each switch that changes what agents can do", async () => {
  const { view, block, apply } = await mountSettings();
  await waitFor(() =>
    expect(rows(block("set00008")!).memberUsageShare?.current).toBe("50"),
  );
  expect(rows(block("set00008")!)).toEqual({
    memberUsageShare: { current: "50", requested: "30" },
    processIsolation: { current: "false", requested: "true" },
    recordTerminals: { current: "false", requested: "true" },
    providerFallback: { current: "false", requested: "true" },
  });
  const hinted = [
    ...block("set00008")!.querySelectorAll<HTMLElement>(
      "[data-ask-action-key]",
    ),
  ]
    .filter((r) => r.querySelector("[data-ask-action-hint]") !== null)
    .map((r) => r.dataset.askActionKey)
    .sort();
  expect(hinted).toEqual([
    "processIsolation",
    "providerFallback",
    "recordTerminals",
  ]);
  expect(apply("set00008")).not.toBe(null);
  view.unmount();
});

it("a backup-settings card has one row per key with the value now, and says what a backup holds when the folder moves", async () => {
  const { view, block, apply } = await mountSettings();
  await waitFor(() =>
    expect(rows(block("set00009")!).retention?.current).toBe("7"),
  );
  expect(rows(block("set00009")!)).toEqual({
    dir: { current: "/home/morgan/isomux-backups", requested: "/srv/backups" },
    retention: { current: "7", requested: "3" },
  });
  // The full folder shows, not a short form.
  expect(block("set00009")!.textContent).toContain("/srv/backups");
  expect(
    ["set00009", "set00010"].map((id) =>
      block(id)!.hasAttribute("data-ask-action-backup-holds"),
    ),
  ).toEqual([true, false]);
  expect(rows(block("set00010")!)).toEqual({
    intervalHours: { current: "24", requested: "6" },
  });
  expect(apply("set00009")).not.toBe(null);
  view.unmount();
});

it("Apply on each settings card posts that ask's run once", async () => {
  const { view, apply } = await mountSettings();
  for (const id of [
    "set00001",
    "set00002",
    "set00003",
    "set00008",
    "set00009",
  ]) {
    await act(async () => {
      fireEvent.click(apply(id)!);
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toEqual([
    "/api/asks/set00001/action",
    "/api/asks/set00002/action",
    "/api/asks/set00003/action",
    "/api/asks/set00008/action",
    "/api/asks/set00009/action",
  ]);
  view.unmount();
});

it("an office-settings card reads the settings again when any office setting changes, not only the name", async () => {
  const { view, block } = await mountSettings();
  await waitFor(() =>
    expect(rows(block("set00008")!).memberUsageShare?.current).toBe("50"),
  );
  // Another owner sets the share by hand: the event carries the name and
  // instructions only, both as the state has them.
  const { office } = (await import("../store.tsx")).initialState;
  expect([office.name, office.prompt]).toEqual([null, null]);
  const changed = { ...OFFICE_SETTINGS, version: "v2", memberUsageShare: 70 };
  read = (path) =>
    path.startsWith("/api/office/settings") ? changed : undefined;
  await act(async () => {
    seeded({ type: "office_settings_updated", prompt: null, name: null });
  });
  await waitFor(() =>
    expect(rows(block("set00008")!).memberUsageShare?.current).toBe("70"),
  );
  view.unmount();
});
