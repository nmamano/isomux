// Action asks, part 5 (task e3d1bc63): the cards of a member's removal,
// restore and delete for good, the office update, and the storage prune and
// compress. One rule picks the clicks for every kind: the card has no Undo,
// so a destructive Apply asks again before it runs (a prune after its
// preview); the others run on the first click. The other kinds'
// cards are in ask-action.dom.test.tsx; this file keeps that one under the
// DOM time cap.
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
const ASKER = {
  id: "a1",
  name: "Asker",
  roomId: "r1",
  desk: 0,
  access: "standard",
  userId: "u2",
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
// The body of each POST, in the order of `posts`.
let postBodies: unknown[] = [];
let answer: (path: string) => Promise<unknown> = async () => undefined;
let read: (path: string) => unknown = () => undefined;
beforeEach(() => {
  posts = [];
  postBodies = [];
  answer = async () => undefined;
  read = () => undefined;
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push(path);
      postBodies.push(body);
      return answer(path);
    }
    return read(path);
  });
});
afterAll(() => setApiShim(null));

// Morgan (u1, the member the asks are for) and Dana (u3) are office owners;
// Casey (u2) is the asking agent's manager, in Studio.
const member = (
  id: string,
  name: string,
  role: "owner" | "member",
  allowedRooms: string[] = [],
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
  member("u1", "Morgan", "owner"),
  member("u2", "Casey", "member", ["r1"]),
  member("u3", "Dana", "owner"),
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
    dispatch({ type: "users_admin_list", users: MEMBERS });
    for (const room of ROOMS) dispatch({ type: "room_created", room });
    dispatch({ type: "all_rooms_list", rooms: ROOMS });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

async function mount(entries: AskEntry[]) {
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

const memberAsk = (id: string, step: Record<string, unknown>): AskEntry =>
  ({
    id,
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Please do this.",
    createdAt: NOW,
    updatedAt: NOW,
    step,
  }) as AskEntry;
const results = (view: { container: HTMLElement }) =>
  [...view.container.querySelectorAll<HTMLElement>("[data-ask-result]")].map(
    (el) => el.dataset.askResult,
  );
const REMOVED = {
  members: [
    {
      user: {
        id: "u4",
        name: "Riley",
        role: "member",
        allowedRooms: [],
        createdAt: NOW,
      },
      removedAt: NOW - 86400000,
      expiresAt: NOW + 29 * 86400000,
      removedBy: "Morgan",
      heirId: "u1",
      heirName: "Morgan",
    },
  ],
};
const readRemoved = (path: string) =>
  path === "/api/removed-members" ? REMOVED : undefined;
const PRUNE_STEP = {
  kind: "storage-prune",
  target: "transcripts",
  olderThanDays: 30,
  keepPerAgent: 2,
};
const PREVIEW = {
  plan: {
    target: "transcripts",
    policy: { olderThanDays: 30, keepPerAgent: 2 },
    candidates: [
      { path: "agent-ghost/a.jsonl", agentId: "agent-ghost", bytes: 10 },
      { path: "agent-ghost/b.jsonl", agentId: "agent-ghost", bytes: 20 },
      { path: "agent-ghost/c.jsonl", agentId: "agent-ghost", bytes: 30 },
    ],
    bytes: 60,
    skipped: [],
  },
  applied: null,
};
const isConfirm = (button: HTMLButtonElement | null) =>
  !!button && button.hasAttribute("data-ask-action-confirm");

// Every destructive kind asks again (Nil's UI rule in AGENTS.md,
// 2026-11-05). Each pair is the ask id and its step; the prune is apart, as
// its first click is a preview.
const ASKS_AGAIN = [
  ["con00001", { kind: "member-remove", userId: "u2" }],
  ["con00002", { kind: "member-purge", userId: "u4" }],
  ["con00003", { kind: "member-sessions", userId: "u2" }],
  ["con00004", { kind: "sign-in-links-revoke", userId: "u2" }],
  [
    "con00005",
    { kind: "api-token-revoke", tokenId: "aaaa000000000001", userId: "u1" },
  ],
  // A restart: it cuts every turn in flight, and no way goes back.
  ["con00006", { kind: "office-update", tag: "v2026.11.2" }],
  // Casey out of Studio.
  [
    "con00007",
    { kind: "member-room", userId: "u2", roomId: "r1", grant: false },
  ],
  // Dana, an owner, made a member.
  ["con00008", { kind: "member-role", userId: "u3", role: "member" }],
] as const;
// The other side of the same kinds: a grant and a promote take nothing away.
const ONE_CLICK = [
  // Casey into Garden.
  [
    "one00001",
    { kind: "member-room", userId: "u2", roomId: "r2", grant: true },
  ],
  // Casey made an owner.
  ["one00002", { kind: "member-role", userId: "u2", role: "owner" }],
] as const;
// The card of each step, in one mount: the DOM time cap.
const mountSteps = (steps: readonly (readonly [string, object])[]) =>
  mount(steps.map(([id, step]) => memberAsk(id, { ...step })));

it("an Apply that destroys something asks again: the first click runs nothing, the second posts the run once", async () => {
  read = readRemoved;
  const { view, apply } = await mountSteps(ASKS_AGAIN);
  for (const [id] of ASKS_AGAIN) {
    await waitFor(() => expect(apply(id), id).not.toBe(null));
    expect([id, isConfirm(apply(id))]).toEqual([id, false]);
    posts = [];
    await act(async () => {
      fireEvent.click(apply(id)!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts, `${id} first click`).toEqual([]);
    expect([id, isConfirm(apply(id))]).toEqual([id, true]);
    await act(async () => {
      fireEvent.click(apply(id)!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts, `${id} second click`).toEqual([`/api/asks/${id}/action`]);
  }
  view.unmount();
});

it("a room grant and a promote run on the first click", async () => {
  const { view, apply } = await mountSteps(ONE_CLICK);
  for (const [id] of ONE_CLICK) {
    expect(apply(id), id).not.toBe(null);
    posts = [];
    await act(async () => {
      fireEvent.click(apply(id)!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts, id).toEqual([`/api/asks/${id}/action`]);
  }
  view.unmount();
});

// As on the page: the second click must follow the first, so a click that
// lands later, after the member moved on, runs nothing for good. The confirm
// takes the focus: a click does not focus a button in every browser (Safari),
// and a prune's button is disabled during its preview, which drops the focus
// with no blur (Chrome, seen with a real mouse). Without the focus, no blur
// ever ends the confirm.
it("each confirm takes the focus and ends when the Apply button loses it: the next click asks again and runs nothing", async () => {
  read = readRemoved;
  answer = async () => PREVIEW;
  const steps = [...ASKS_AGAIN, ["con00009", PRUNE_STEP]] as const;
  const { view, apply } = await mountSteps(steps);
  for (const [id] of steps) {
    await waitFor(() => expect(apply(id), id).not.toBe(null));
    await act(async () => {
      fireEvent.click(apply(id)!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([id, isConfirm(apply(id))]).toEqual([id, true]);
    expect(
      document.activeElement?.closest("[data-ask]")?.getAttribute("data-ask"),
      id,
    ).toBe(id);
    expect(
      document.activeElement?.hasAttribute("data-ask-action-apply"),
      id,
    ).toBe(true);
    await act(async () => {
      fireEvent.blur(apply(id)!);
    });
    expect([id, isConfirm(apply(id))]).toEqual([id, false]);
    await act(async () => {
      fireEvent.click(apply(id)!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts, id).not.toContain(`/api/asks/${id}/action`);
    // Leave the card idle for the next one.
    await act(async () => {
      fireEvent.blur(apply(id)!);
    });
  }
  view.unmount();
});

it("a member-remove card of the member the ask is for says Apply removes them; another member's does not", async () => {
  const { view, block } = await mount([
    memberAsk("del00002", { kind: "member-remove", userId: "u1" }),
    memberAsk("del00003", { kind: "member-remove", userId: "u2" }),
  ]);
  expect(
    ["del00002", "del00003"].map((id) =>
      block(id)!.hasAttribute("data-ask-action-self"),
    ),
  ).toEqual([true, false]);
  view.unmount();
});

it("a restore or purge card names the removed member; one no longer in Removed members is marked gone with no Apply", async () => {
  read = readRemoved;
  const { view, block, apply } = await mount([
    memberAsk("del00004", {
      kind: "member-restore",
      userId: "u4",
      agents: true,
    }),
    memberAsk("del00005", { kind: "member-purge", userId: "u4" }),
    memberAsk("del00006", { kind: "member-purge", userId: "u9" }),
  ]);
  await waitFor(() =>
    expect(block("del00004")!.textContent).toContain("Riley"),
  );
  expect(block("del00005")!.textContent).toContain("Riley");
  await waitFor(() =>
    expect(block("del00006")!.hasAttribute("data-ask-action-gone")).toBe(true),
  );
  expect(apply("del00006")).toBe(null);
  expect(apply("del00004")).not.toBe(null);
  // A restore loses nothing: one click runs it.
  await act(async () => {
    fireEvent.click(apply("del00004")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/asks/del00004/action"]);
  view.unmount();
});

it("a storage-prune Apply previews first with the step's policy and no apply, then asks again, and only the second click posts the run", async () => {
  answer = async (path) =>
    path === "/api/storage/prune"
      ? PREVIEW
      : {
          plan: PREVIEW.plan,
          applied: { deleted: 3, bytes: 60, refused: [] },
        };
  const { view, block, apply } = await mount([
    memberAsk("sto00001", PRUNE_STEP),
  ]);
  expect(isConfirm(apply("sto00001"))).toBe(false);
  await act(async () => {
    fireEvent.click(apply("sto00001")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/storage/prune"]);
  expect(postBodies).toEqual([
    { target: "transcripts", olderThanDays: 30, keepPerAgent: 2 },
  ]);
  expect(block("sto00001")!.dataset.askActionPreviewCount).toBe("3");
  expect(isConfirm(apply("sto00001"))).toBe(true);
  await act(async () => {
    fireEvent.click(apply("sto00001")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/storage/prune", "/api/asks/sto00001/action"]);
  view.unmount();
});

it("a refused prune preview shows its message and runs nothing", async () => {
  answer = async () => {
    throw new ApiError(409, "queue_state_unreadable", "The queue is unread.");
  };
  const { view, card, apply } = await mount([
    memberAsk("sto00002", { ...PRUNE_STEP, target: "attachments" }),
  ]);
  await act(async () => {
    fireEvent.click(apply("sto00002")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/storage/prune"]);
  expect(card("sto00002").querySelector("[role=alert]")?.textContent).toContain(
    "The queue is unread.",
  );
  expect(isConfirm(apply("sto00002"))).toBe(false);
  view.unmount();
});

it.each([
  [
    "storage-prune",
    PRUNE_STEP,
    { plan: PREVIEW.plan, applied: { deleted: 3, bytes: 60, refused: [] } },
    2,
  ],
  [
    "storage-compress",
    { kind: "storage-compress", olderThanDays: 30 },
    {
      plan: { olderThanDays: 30, candidates: [], bytes: 0, skipped: [] },
      applied: {
        compressed: 4,
        bytesBefore: 400,
        bytesAfter: 100,
        refused: [],
      },
    },
    1,
  ],
] as const)(
  "a %s run's answer stays on the stack as a result after the ask closes",
  async (_kind, step, applied, clicks) => {
    answer = async (path) =>
      path === "/api/storage/prune" ? PREVIEW : applied;
    const { view, apply } = await mount([memberAsk("sto00003", step)]);
    for (let i = 0; i < clicks; i++)
      await act(async () => {
        fireEvent.click(apply("sto00003")!);
        await new Promise((r) => setTimeout(r, 0));
      });
    expect(posts[posts.length - 1]).toBe("/api/asks/sto00003/action");
    // Compress loses nothing: its first click is the run.
    expect(posts).toHaveLength(clicks);
    await act(async () => {
      seeded({ type: "ask_removed", id: "sto00003" });
    });
    expect(results(view)).toEqual(["sto00003"]);
    view.unmount();
  },
);

it("an office-update card shows the release now and the one asked for; after the confirmed run starts the update it shows started and no Apply", async () => {
  read = (path) =>
    path === "/api/office/update"
      ? { managed: true, serviceKind: "user", busyAgents: 2 }
      : undefined;
  answer = async () => ({ ok: true, via: "user", tag: "v2026.11.2" });
  const { view, block, apply } = await mount([
    memberAsk("upd00001", { kind: "office-update", tag: "v2026.11.2" }),
  ]);
  await act(async () => {
    seeded({
      type: "update_status",
      mode: "release",
      updateAvailable: true,
      current: { release: "v2026.10.1", version: "v2026.10.1" },
      latest: { tag: "v2026.11.2", publishedAt: null, url: null },
      securityUpdate: null,
      apply: { kind: "host" },
    } as never);
  });
  expect(block("upd00001")!.dataset.askActionCurrent).toBe("v2026.10.1");
  expect(block("upd00001")!.dataset.askActionRequested).toBe("v2026.11.2");
  expect(isConfirm(apply("upd00001"))).toBe(false);
  await act(async () => {
    fireEvent.click(apply("upd00001")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  // A restart asks again.
  expect(posts).toEqual([]);
  expect(isConfirm(apply("upd00001"))).toBe(true);
  await act(async () => {
    fireEvent.click(apply("upd00001")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/asks/upd00001/action"]);
  expect(block("upd00001")!.hasAttribute("data-ask-action-started")).toBe(true);
  expect(apply("upd00001")).toBe(null);
  view.unmount();
});

// A sign-in link made for another member is sent to them, not to an invitee
// (Nil, 2026-11-05): the hint under the URL names the member, the title does
// not, and the box keeps the sign-in label. Here, not in
// ask-action.dom.test.tsx, for the DOM time cap. Copy is matched by catalog
// value, never by literal text.
it("a sign-in link result for another member: the hint names them, the title does not, and the box has no invite wording", async () => {
  const url = "https://office.example/i/RAWLINK9";
  answer = async () => ({ url, invite: {} });
  const { view, apply } = await mount([
    memberAsk("sil00001", { kind: "sign-in-link", userId: "u2" }),
  ]);
  await act(async () => {
    fireEvent.click(apply("sil00001")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/asks/sil00001/action"]);
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask-result="sil00001"]',
  )!;
  expect(card.textContent).toContain(url);
  expect(card.hasAttribute("data-ask-result-for-self")).toBe(false);
  const text = card.textContent ?? "";
  expect(text).toContain(en["settings.access.signInUrl"]);
  expect(text).not.toContain(en["settings.access.inviteUrl"]);
  expect(text).not.toContain(en["settings.access.sendUrl"]);
  // Casey, once in the card, and that once in the hint under the URL.
  const hints = [...card.querySelectorAll("p")].filter((p) =>
    p.textContent?.includes("Casey"),
  );
  expect(hints).toHaveLength(1);
  expect(text.split("Casey").length - 1).toBe(1);
  view.unmount();
});

// Task 4860c373: a card that reads the invites or the sessions list asks for
// it again when its GET lands in the same render as session_context (which
// clears the loaded flag), or the card's current value stays loading.
it.each([
  [
    "sign-in-links-revoke",
    "/api/invites",
    { type: "invites_list", invites: [] },
  ],
  [
    "member-sessions",
    "/api/sessions",
    { type: "sessions_active_list", sessions: [] },
  ],
] as const)(
  "a %s card requests %s again after a load lost to session_context",
  async (kind, path, landed) => {
    const gets: string[] = [];
    read = (p) => {
      gets.push(p);
      return new Promise(() => {});
    };
    const { view } = await mount([
      memberAsk("lst00001", { kind, userId: "u2" }),
    ]);
    await act(async () => {});
    expect(gets.filter((p) => p === path)).toHaveLength(1);
    act(() => {
      seeded(landed as never);
      seeded({
        type: "session_context",
        context: {
          userId: "u1",
          username: "Morgan",
          role: "owner",
          currentSessionPrefix: "00000000",
          connectionId: "c2",
        },
      });
    });
    await act(async () => {});
    expect(gets.filter((p) => p === path)).toHaveLength(2);
    view.unmount();
  },
);
