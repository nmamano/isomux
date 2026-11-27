// The card of a member-os-user action ask (task 4088f164): the owner turns a
// member's own OS user on or off from the card, as the Run on Settings ›
// Members › OS user does. The properties:
// - the card reads the member's OS user when it shows, and names the user
//   the step asks for: the named one, or the new user's default name;
// - where sudo asks for a password: the sudo card's masked field (one that
//   password managers skip), Apply disabled while it
//   is empty, and Apply sends exactly that password, then clears the field;
//   where sudo needs none: Apply with no password; where the office cannot
//   run the command: a blocker and no Apply;
// - a run or a move that goes on, a named user for a member who has one, and
//   an off for a member who came with an office move: a blocker, no field and
//   no Apply;
// - after Apply the card reads again every OS_USER_POLL_MS, and a failed run
//   shows its failure and brings the field and Apply back for a retry; the
//   reads stop on unmount and at OS_USER_POLL_CAP_MS;
// - a wrong password says how many tries are left;
// - the other members on the user the step names, or on the member's user,
//   show before the owner types the password.
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { OS_USER_POLL_MS, OS_USER_POLL_CAP_MS } =
  await import("../components/MemberOsUserSection.tsx");
const { lineParts } = await import("../test-support/ask-action-fixture.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;
type MemberOsUserWire =
  import("../../shared/contract-shapes.ts").MemberOsUserWire;

const NOW = Date.now();
const ASKER = {
  id: "a1",
  name: "Asker",
  roomId: "r1",
  desk: 0,
  access: "standard",
  userId: "u1",
} as never;

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

const VIEW_PATH = "/api/users/Mia/os-user";
const PASSWORD = "Card-pa55-4088f164";
const COMMANDS = {
  enable: "sudo /usr/local/sbin/isomux-member-user enable 0a1b2c3d",
  disable: "sudo /usr/local/sbin/isomux-member-user disable 0a1b2c3d",
};

// Each POST's path and body; what the next one answers.
let posts: { path: string; body: unknown }[] = [];
let answer: () => Promise<unknown> = async () => ({ action: "enable" });
// What the next reads of the OS user answer: the head of the queue, the
// last one repeats.
let views: MemberOsUserWire[] = [];
let reads = 0;
beforeEach(() => {
  posts = [];
  answer = async () => ({ action: "enable" });
  views = [];
  reads = 0;
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push({ path, body });
      return answer();
    }
    if (method === "GET" && path === VIEW_PATH) {
      reads++;
      const next = views.length > 1 ? views.shift()! : views[0];
      if (!next) throw new ApiError(500, "boom", "internal");
      return next;
    }
    return undefined;
  });
});
afterEach(() => {
  jest.useRealTimers();
});
afterAll(() => setApiShim(null));

function osView(over: Partial<MemberOsUserWire> = {}): MemberOsUserWire {
  return {
    state: "off",
    commands: COMMANDS,
    run: "password",
    support: { ok: true },
    newUserName: "isomux-mia7",
    ...over,
  };
}
const onAs = (name: string, over: Partial<MemberOsUserWire> = {}) =>
  osView({ state: "on", osUser: { name, uid: 2001 }, ...over });

// Morgan (u1, the member the asks are for) is an office owner; Mia (u5) is
// the member whose OS user changes.
const member = (id: string, name: string, role: "owner" | "member") =>
  ({
    id,
    name,
    role,
    allowedRooms: [],
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
  member("u1", "Morgan", "owner"),
  member("u5", "Mia", "member"),
];
const ROOMS = [{ id: "r1", name: "Studio" }] as never[];

function Seed({
  entries,
  children,
}: {
  entries: AskEntry[];
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({ type: "agent_added", agent: ASKER });
    dispatch({ type: "users_admin_list", users: MEMBERS });
    for (const room of ROOMS) dispatch({ type: "room_created", room });
    dispatch({ type: "all_rooms_list", rooms: ROOMS });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

const ask = (id: string, step: Record<string, unknown>): AskEntry =>
  ({
    id,
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Please do this.",
    createdAt: NOW,
    updatedAt: NOW,
    step: { kind: "member-os-user", userId: "u5", ...step },
  }) as AskEntry;

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

async function mount(step: Record<string, unknown>) {
  const view = render(
    <StoreProvider>
      <Seed entries={[ask("os000001", step)]}>
        <AsksStack agentId="a1" isMobile={false} />
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-ask]").length).toBe(1),
  );
  await waitFor(() => expect(reads).toBeGreaterThan(0));
  await settle();
  const block = () =>
    view.container.querySelector<HTMLElement>(
      '[data-ask="os000001"] [data-ask-action]',
    )!;
  const apply = () =>
    block().querySelector<HTMLButtonElement>("[data-ask-action-apply]");
  const field = () =>
    // The sudo card's masked field (MaskedInput): no browser offers to
    // save the box account's password.
    block().querySelector<HTMLInputElement>("input[data-masked-credential]");
  const blocker = () => block().querySelector("[data-ask-action-blocker]");
  const type = async (text: string) => {
    await act(async () => {
      fireEvent.change(field()!, { target: { value: text } });
    });
  };
  const click = async () => {
    await act(async () => {
      fireEvent.click(apply()!);
    });
    await settle();
  };
  return { view, block, apply, field, blocker, type, click };
}

it("names the user the step asks for: the new user's default name for a plain on, the named user otherwise", async () => {
  views = [osView()];
  const plain = await mount({ on: true });
  expect(plain.block().textContent).toContain("isomux-mia7");
  plain.view.unmount();
  views = [osView()];
  const named = await mount({ on: true, osUser: "alice", existing: true });
  expect(named.block().textContent).toContain("alice");
  named.view.unmount();
});

it("asks for the password where sudo needs one: Apply waits for it, sends exactly it once, and clears the field", async () => {
  views = [osView()];
  const c = await mount({ on: true });
  const field = c.field();
  expect(field).not.toBeNull();
  expect(field!.getAttribute("autocomplete")).toBe("off");
  expect(c.apply()?.disabled).toBe(true);
  await c.type(PASSWORD);
  expect(c.apply()?.disabled).toBe(false);
  await c.click();
  expect(posts).toEqual([
    { path: "/api/asks/os000001/action", body: { password: PASSWORD } },
  ]);
  // Cleared after the start, or gone while the run goes on.
  expect(c.field()?.value ?? "").toBe("");
  c.view.unmount();
});

it("sends no password where sudo needs none, and shows a blocker with no Apply where the office cannot run the command", async () => {
  views = [osView({ run: "no_password" })];
  const free = await mount({ on: true });
  expect(free.field()).toBeNull();
  expect(free.apply()?.disabled).toBe(false);
  await free.click();
  expect(posts.length).toBe(1);
  expect(JSON.stringify(posts[0].body ?? {})).toBe("{}");
  free.view.unmount();

  views = [osView({ run: null })];
  const none = await mount({ on: true });
  expect(none.blocker()).not.toBeNull();
  expect(none.apply()).toBeNull();
  expect(none.field()).toBeNull();
  none.view.unmount();
});

it("shows a blocker, no field and no Apply while a run or a move goes on, for a named user while the member has one, and for an off of a member who came with a move", async () => {
  const cases: [string, Record<string, unknown>, MemberOsUserWire][] = [
    [
      "a run",
      { on: true },
      osView({ attempt: { action: "enable", status: "running", at: 1 } }),
    ],
    [
      "a move",
      { on: false },
      osView({ state: "moving", osUser: { name: "mia", uid: 2001 } }),
    ],
    [
      "has one",
      { on: true, osUser: "alice", existing: true },
      osView({ state: "not_ready", osUser: { name: "mia", uid: 2001 } }),
    ],
    [
      "moved in",
      { on: false },
      osView({
        state: "not_ready",
        osUser: { name: "mia", uid: 2001 },
        movedIn: true,
      }),
    ],
  ];
  for (const [label, step, now] of cases) {
    views = [now];
    const c = await mount(step);
    expect({
      label,
      blocker: c.blocker() !== null,
      apply: c.apply() !== null && !c.apply()!.disabled,
      field: c.field() !== null,
    }).toEqual({ label, blocker: true, apply: false, field: false });
    c.view.unmount();
  }
  // The enabling condition: the same off runs for a member on as mia.
  views = [onAs("mia")];
  const c = await mount({ on: false });
  expect([c.blocker() === null, c.field() !== null]).toEqual([true, true]);
  c.view.unmount();
});

it("after Apply reads again every OS_USER_POLL_MS; a failed run shows its failure and brings the field and Apply back, and a retry sends the new password", async () => {
  views = [osView()];
  const c = await mount({ on: true });
  jest.useFakeTimers();
  const running = osView({
    attempt: { action: "enable", status: "running", at: 1 },
  });
  const failed = osView({
    attempt: {
      action: "enable",
      status: "failed",
      at: 2,
      message: "useradd: the stand-in refused",
    },
  });
  views = [running, failed];
  await c.type(PASSWORD);
  await c.click();
  const afterApply = reads;
  await advance(OS_USER_POLL_MS);
  expect(reads).toBeGreaterThan(afterApply);
  // Polls until the failed attempt shows.
  for (let i = 0; i < 3 && !c.block().textContent?.includes("stand-in"); i++)
    await advance(OS_USER_POLL_MS);
  expect(c.block().textContent).toContain("useradd: the stand-in refused");
  expect(c.field()).not.toBeNull();
  expect(c.field()!.value).toBe("");
  await c.type(`${PASSWORD}-2`);
  expect(c.apply()?.disabled).toBe(false);
  await c.click();
  expect(posts.map((p) => p.body)).toEqual([
    { password: PASSWORD },
    { password: `${PASSWORD}-2` },
  ]);
  c.view.unmount();
});

it("stops reading on unmount and at OS_USER_POLL_CAP_MS", async () => {
  views = [osView()];
  const c = await mount({ on: true });
  jest.useFakeTimers();
  views = [osView({ attempt: { action: "enable", status: "running", at: 1 } })];
  await c.type(PASSWORD);
  await c.click();
  await advance(OS_USER_POLL_MS * 2);
  // The enabling condition: it reads while the run goes on.
  const polling = reads;
  await advance(OS_USER_POLL_MS);
  expect(reads).toBeGreaterThan(polling);
  await advance(OS_USER_POLL_CAP_MS + OS_USER_POLL_MS);
  const capped = reads;
  await advance(OS_USER_POLL_MS * 5);
  expect(reads).toBe(capped);
  c.view.unmount();

  jest.useRealTimers();
  views = [osView()];
  reads = 0;
  const again = await mount({ on: true });
  jest.useFakeTimers();
  views = [osView({ attempt: { action: "enable", status: "running", at: 1 } })];
  await again.type(PASSWORD);
  await again.click();
  await advance(OS_USER_POLL_MS);
  const before = reads;
  expect(before).toBeGreaterThan(1);
  again.view.unmount();
  await advance(OS_USER_POLL_MS * 5);
  expect(reads).toBe(before);
});

it("says how many tries are left after a wrong password", async () => {
  views = [osView()];
  answer = async () => {
    throw new ApiError(422, "not_started", "sudo did not start the command", {
      reason: "sudo: 1 incorrect password attempt",
      attemptsLeft: 2,
    });
  };
  const c = await mount({ on: true });
  await c.type("wrong");
  await c.click();
  expect(posts.length).toBe(1);
  // The tries left, as a number in the card's error line.
  const alert = c.block().querySelector('[role="alert"]');
  expect(alert?.textContent ?? "").toContain("2");
  expect(c.field()).not.toBeNull();
  c.view.unmount();
});

it("shows the other members on the user the step names, and on the member's own user, before the password", async () => {
  views = [
    osView({
      candidates: [
        {
          name: "alice",
          uid: 1001,
          members: [{ name: "Riley", owner: false }],
        },
      ],
    }),
  ];
  const join = await mount({ on: true, osUser: "alice", existing: true });
  expect(join.block().textContent).toContain("Riley");
  expect(join.field()).not.toBeNull();
  join.view.unmount();

  views = [onAs("mia", { sharedWith: [{ name: "Quinn", owner: true }] })];
  const leave = await mount({ on: false });
  expect(leave.block().textContent).toContain("Quinn");
  leave.view.unmount();
});

// Task ee88b02c: while the OS user is read, the row draws one dimmed block
// after its label in place of "value now -> value asked": the value asked
// depends on the read too (a plain on names the new user's default name
// only once the read comes), so nothing of the tail shows until it comes.
it("while the OS user is read, the row draws one block after its label, then the user now and the user asked for", async () => {
  let release: (v: MemberOsUserWire) => void = () => {};
  setApiShim(async (method, path) => {
    if (method === "GET" && path === VIEW_PATH) {
      reads++;
      return new Promise<MemberOsUserWire>((r) => (release = r));
    }
    return undefined;
  });
  const { view, block } = await mount({ on: true });
  const row = () =>
    block().querySelector<HTMLElement>('[data-ask-action-key="osUser"]')!;
  const line = () => ({
    label: row().firstElementChild!.firstElementChild!.textContent,
    parts: lineParts(row().firstElementChild!),
  });
  // The enabling condition: the read is out (mount waited for it) and has
  // not come back.
  expect(row().dataset.askActionCurrent).toBeUndefined();
  const loading = line();
  expect(loading.parts).toEqual(["loading"]);
  expect(block().textContent).not.toContain("isomux-mia7");
  await act(async () => {
    release(osView());
  });
  await settle();
  expect({
    current: row().dataset.askActionCurrent,
    requested: row().dataset.askActionRequested,
    line: line(),
    loading: block().querySelectorAll("[data-ask-action-loading]").length,
  }).toEqual({
    current: "off",
    requested: "isomux-mia7",
    line: { label: loading.label, parts: ["text", "arrow", "text"] },
    loading: 0,
  });
  view.unmount();
});
