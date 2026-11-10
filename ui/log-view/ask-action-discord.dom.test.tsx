// The card of a Discord route ask (task 386ec4d6): the agent names a place
// by a part of its name, and the card lists the member's places that match
// it - the channels, categories and servers their bots see - as one choice
// each. One match is picked already; several wait for the member's pick;
// none leaves no Apply. Only the member the ask is for reads their bots and
// gets the choice and Apply. A pick that has a route to another agent names
// that agent before Apply moves it. Apply sends the picked place.
//
// Hooks: each choice is a radio whose value is "<botId>:<scope>:<targetId>";
// the block carries the picked place, in the same form, as
// data-ask-action-place-picked; a move is data-ask-action-dc-moves.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, waitFor } = await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;

const NOW = Date.now();
const agent = (id: string, name: string, userId: string) =>
  ({
    id,
    name,
    roomId: "r1",
    desk: 0,
    access: "standard",
    userId,
  }) as never;
const ASKER = agent("a1", "Asker", "u1");
const PM = agent("a2", "Project Lead", "u2");
const HELPER = agent("a3", "Inbox Helper", "u1");

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

const BOT = "1100000000000000001";
const BOT2 = "1100000000000000002";
const GUILD = "1200000000000000001";
const GUILD2 = "1200000000000000002";
const CAT = "1300000000000000001";
const LEGAL = "1300000000000000002";
const RANDOM = "1300000000000000003";
const G2_CHAN = "1300000000000000004";

const AKIDO = {
  id: GUILD,
  name: "Akido HQ",
  channels: [
    { id: CAT, name: "Akido Talk", kind: "category", parentId: null },
    { id: LEGAL, name: "akido-legal", kind: "text", parentId: CAT },
    { id: RANDOM, name: "random", kind: "text", parentId: null },
  ],
};
const ELSEWHERE = {
  id: GUILD2,
  name: "Elsewhere",
  channels: [{ id: G2_CHAN, name: "akido-ops", kind: "text", parentId: null }],
};

const bot = (id: string, name: string) => ({
  id,
  name,
  addedAt: 1,
  status: { state: "connected" },
  inviteUrl: `https://discord.com/oauth2/authorize?client_id=${id}`,
});

const key = (botId: string, scope: string, targetId: string) =>
  `${botId}:${scope}:${targetId}`;

let posts: string[] = [];
let gets: string[] = [];
let postBodies: unknown[] = [];
let bots: unknown[] = [];
// Each bot's guilds; a bot with none here answers 404 (not connected yet).
let guilds: Record<string, unknown[]> = {};
let routes: unknown[] = [];
beforeEach(() => {
  posts = [];
  gets = [];
  postBodies = [];
  bots = [];
  guilds = {};
  routes = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push(path);
      postBodies.push(body);
      return undefined;
    }
    gets.push(path);
    if (path === "/api/discord") return bots;
    if (path === "/api/discord/routes") return routes;
    const guildsOf = /^\/api\/discord\/bots\/(\d+)\/guilds$/.exec(path);
    if (guildsOf) {
      const seen = guilds[guildsOf[1]];
      if (!seen) throw new ApiError(404, "not_found", "not connected");
      return seen;
    }
    return undefined;
  });
});
afterAll(() => setApiShim(null));

function Seed({
  entries,
  children,
}: {
  entries: AskEntry[];
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({
      type: "session_context",
      context: {
        userId: "u1",
        username: "Morgan",
        role: "owner",
        currentSessionPrefix: "abcd1234",
      } as never,
    });
    for (const a of [ASKER, PM, HELPER])
      dispatch({ type: "agent_added", agent: a });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

async function mount(step: Record<string, unknown>, memberUserId = "u1") {
  const entry = {
    id: "dc000001",
    agentId: "a1",
    memberUserId,
    prompt: "Please route the Akido channel to the Project Lead.",
    createdAt: NOW,
    updatedAt: NOW,
    step,
  } as AskEntry;
  const view = render(
    <StoreProvider>
      <Seed entries={[entry]}>
        <AsksStack agentId="a1" isMobile={false} />
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-ask]").length).toBe(1),
  );
  const block = () =>
    view.container.querySelector<HTMLElement>(
      `[data-ask="dc000001"] [data-ask-action]`,
    );
  const radios = () => [
    ...(block()?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ??
      []),
  ];
  const apply = () =>
    block()?.querySelector<HTMLButtonElement>("[data-ask-action-apply]") ??
    null;
  const picked = () =>
    block()?.getAttribute("data-ask-action-place-picked") ?? null;
  const text = () => block()?.textContent ?? "";
  return { view, block, radios, apply, picked, text };
}

const step = (extra: Record<string, unknown> = {}) => ({
  kind: "discord-route",
  placeName: "akido",
  agentId: "a2",
  ...extra,
});

// The lists the card reads arrived.
const readAll = (botIds: string[]) =>
  waitFor(() =>
    expect(
      [
        "/api/discord",
        "/api/discord/routes",
        ...botIds.map((id) => `/api/discord/bots/${id}/guilds`),
      ].every((p) => gets.includes(p)),
    ).toBe(true),
  );
const tick = () => new Promise((r) => setTimeout(r, 20));

it("names the agent; one matching place is picked already, and Apply sends it", async () => {
  bots = [bot(BOT, "Morgan's bot")];
  guilds = { [BOT]: [AKIDO] };
  const m = await mount(step({ placeName: "legal" }));
  await waitFor(() => expect(m.picked()).toBe(key(BOT, "channel", LEGAL)));
  expect(m.text().includes("akido-legal")).toBe(true);
  expect(m.text().includes("random")).toBe(false);
  expect(m.text().includes("Project Lead")).toBe(true);
  fireEvent.click(m.apply()!);
  await waitFor(() => expect(posts.length).toBe(1));
  expect([posts[0], postBodies[0]]).toEqual([
    "/api/asks/dc000001/action",
    { botId: BOT, guildId: GUILD, scope: "channel", targetId: LEGAL },
  ]);
});

it('a leading "#" matches the channel', async () => {
  bots = [bot(BOT, "Morgan's bot")];
  guilds = { [BOT]: [AKIDO] };
  const m = await mount(step({ placeName: "#random" }));
  await waitFor(() => expect(m.picked()).toBe(key(BOT, "channel", RANDOM)));
});

it("several matches across kinds, servers and bots wait for the member's pick, each with its bot's name; Apply then sends the picked one", async () => {
  bots = [bot(BOT, "First bot"), bot(BOT2, "Second bot")];
  guilds = { [BOT]: [AKIDO], [BOT2]: [ELSEWHERE] };
  const m = await mount(step());
  await waitFor(() => expect(m.radios().length).toBe(4));
  expect(m.radios().filter((r) => r.checked).length).toBe(0);
  expect(m.picked()).toBe(null);
  expect(
    m
      .radios()
      .map((r) => r.value)
      .sort(),
  ).toEqual(
    [
      key(BOT, "server", GUILD),
      key(BOT, "category", CAT),
      key(BOT, "channel", LEGAL),
      key(BOT2, "channel", G2_CHAN),
    ].sort(),
  );
  // Each choice names its bot, since the member has two.
  const labelOf = (value: string) =>
    m
      .radios()
      .find((r) => r.value === value)
      ?.closest("label")?.textContent ?? "";
  expect(labelOf(key(BOT2, "channel", G2_CHAN)).includes("Second bot")).toBe(
    true,
  );
  expect(labelOf(key(BOT, "channel", LEGAL)).includes("First bot")).toBe(true);
  expect(labelOf(key(BOT, "channel", LEGAL)).includes("Akido HQ")).toBe(true);
  // No pick, no run.
  const before = m.apply();
  if (before) {
    fireEvent.click(before);
    await tick();
  }
  expect(posts.length).toBe(0);
  const second = m
    .radios()
    .find((r) => r.value === key(BOT2, "channel", G2_CHAN))!;
  fireEvent.click(second);
  await waitFor(() => expect(m.picked()).toBe(key(BOT2, "channel", G2_CHAN)));
  fireEvent.click(m.apply()!);
  await waitFor(() => expect(posts.length).toBe(1));
  expect(postBodies[0]).toEqual({
    botId: BOT2,
    guildId: GUILD2,
    scope: "channel",
    targetId: G2_CHAN,
  });
});

it("one bot: the choices do not name it", async () => {
  bots = [bot(BOT, "Only bot")];
  guilds = { [BOT]: [AKIDO] };
  const m = await mount(step());
  await waitFor(() => expect(m.radios().length).toBe(3));
  expect(m.text().includes("Only bot")).toBe(false);
});

it("the step's scope narrows the choices", async () => {
  bots = [bot(BOT, "Morgan's bot")];
  guilds = { [BOT]: [AKIDO] };
  const m = await mount(step({ scope: "category" }));
  await waitFor(() => expect(m.picked()).toBe(key(BOT, "category", CAT)));
  expect(m.radios().length).toBe(0);
});

it("a bot that is not connected yet adds no places; the other bot's still show", async () => {
  bots = [bot(BOT, "First bot"), bot(BOT2, "Second bot")];
  guilds = { [BOT2]: [ELSEWHERE] };
  const m = await mount(step());
  await readAll([BOT, BOT2]);
  await waitFor(() => expect(m.picked()).toBe(key(BOT2, "channel", G2_CHAN)));
  expect(m.radios().length).toBe(0);
});

it("a pick with a route to another agent names that agent before Apply; a route to the same agent says nothing of a move", async () => {
  bots = [bot(BOT, "Morgan's bot")];
  guilds = { [BOT]: [AKIDO] };
  routes = [
    {
      id: "d_1",
      botId: BOT,
      guildId: GUILD,
      scope: "channel",
      targetId: LEGAL,
      name: "Legal",
      agentId: "a3",
      trigger: "mention",
      replyMode: "ask",
      createdAt: 1,
    },
  ];
  const m = await mount(step({ placeName: "legal" }));
  await waitFor(() => expect(m.picked()).toBe(key(BOT, "channel", LEGAL)));
  expect(m.block()!.querySelectorAll("[data-ask-action-dc-moves]").length).toBe(
    1,
  );
  expect(m.text().includes("Inbox Helper")).toBe(true);
  expect(posts.length).toBe(0);
  m.view.unmount();

  routes = [{ ...(routes[0] as object), agentId: "a2" }];
  const same = await mount(step({ placeName: "legal" }));
  await waitFor(() => expect(same.picked()).toBe(key(BOT, "channel", LEGAL)));
  expect(
    same.block()!.querySelectorAll("[data-ask-action-dc-moves]").length,
  ).toBe(0);
});

it("a route of another bot at the same server and channel id is no route of the pick", async () => {
  bots = [bot(BOT, "First bot"), bot(BOT2, "Second bot")];
  guilds = { [BOT]: [AKIDO] };
  routes = [
    {
      id: "d_1",
      botId: BOT2,
      guildId: GUILD,
      scope: "channel",
      targetId: LEGAL,
      name: "Legal",
      agentId: "a3",
      trigger: "mention",
      replyMode: "ask",
      createdAt: 1,
    },
  ];
  const m = await mount(step({ placeName: "legal" }));
  await waitFor(() => expect(m.picked()).toBe(key(BOT, "channel", LEGAL)));
  await tick();
  expect(m.block()!.querySelectorAll("[data-ask-action-dc-moves]").length).toBe(
    0,
  );
});

it("a viewer who is not the ask's member reads no Discord lists and gets no choice and no Apply", async () => {
  bots = [bot(BOT, "Morgan's bot")];
  guilds = { [BOT]: [AKIDO] };
  const m = await mount(step(), "u3");
  await waitFor(() => expect(m.text().includes("Project Lead")).toBe(true));
  await tick();
  expect(gets.filter((p) => p.startsWith("/api/discord")).length).toBe(0);
  expect(m.radios().length).toBe(0);
  expect(m.picked()).toBe(null);
  expect(m.apply()).toBe(null);
});

it("no matching place: no choice and no Apply that runs", async () => {
  bots = [bot(BOT, "Morgan's bot")];
  guilds = { [BOT]: [AKIDO] };
  const m = await mount(step({ placeName: "book club" }));
  await waitFor(() => expect(m.text().includes("Project Lead")).toBe(true));
  await readAll([BOT]);
  await tick();
  expect(m.radios().length).toBe(0);
  expect(m.picked()).toBe(null);
  const button = m.apply();
  if (button) {
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await tick();
  }
  expect(posts.length).toBe(0);
});
