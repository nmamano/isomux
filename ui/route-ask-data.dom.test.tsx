// The data of the WhatsApp and Discord route ask cards (task 33210f25): read
// at boot for the viewer's own open route asks, so a card draws its real
// shape (a chat picker, a "moves" line) at its first render instead of
// growing when its lists land. A card mount refreshes the held data without
// clearing it; a failed part keeps what is held; one viewer's data never
// shows to another.
import { beforeEach, afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { render, act, waitFor } = await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("./store.tsx");
const { ApiError, setApiShim } = await import("./api.ts");
const { setShim, connect } = await import("./ws.ts");
const { AsksStack } = await import("./log-view/AsksStack.tsx");
const {
  loadWhatsAppRouteData,
  resetRouteAskData,
  useDiscordRouteData,
  useRouteAskPrefetch,
  useWhatsAppRouteData,
} = await import("./route-ask-data.ts");
type AskEntry = import("../shared/types.ts").AskEntry;

const NOW = Date.now();
const agent = (id: string, name: string, userId: string) =>
  ({ id, name, roomId: "r1", desk: 0, access: "standard", userId }) as never;
const AGENTS = [
  agent("a1", "Asker", "u1"),
  agent("a2", "Project Lead", "u2"),
  agent("a3", "Inbox Helper", "u1"),
];

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

const GROUP = "120363000000000001@g.us";
const BOARD = "120363000000000002@g.us";
const BOT = "1100000000000000001";
const GUILD = "1200000000000000001";
const LEGAL = "1300000000000000002";

const WA_CHATS = "/api/whatsapp/chats";
const WA_ROWS = "/api/whatsapp/routes";
const DC_BOTS = "/api/discord";
const DC_ROUTES = "/api/discord/routes";
const DC_GUILDS = `/api/discord/bots/${BOT}/guilds`;

const chatLegal = { chat: GROUP, name: "Akido Legal Team", group: true };
const chatBoard = { chat: BOARD, name: "Akido board", group: true };
const waRowToHelper = {
  id: "r1",
  chat: GROUP,
  group: true,
  name: "Akido",
  agentId: "a3",
  trigger: "mention",
  createdAt: 1,
};
const dcBot = {
  id: BOT,
  name: "Morgan's bot",
  addedAt: 1,
  status: { state: "connected" },
  inviteUrl: `https://discord.com/oauth2/authorize?client_id=${BOT}`,
};
const akidoGuild = {
  id: GUILD,
  name: "Akido HQ",
  channels: [{ id: LEGAL, name: "akido-legal", kind: "text", parentId: null }],
};
const dcRouteToHelper = {
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
};

// What each GET answers: a value, FAIL (a 500), or HOLD (an open request the
// test answers with answer()).
const FAIL = Symbol("fail");
const HOLD = Symbol("hold");
let replies: Record<string, unknown> = {};
let gets: string[] = [];
let held: { path: string; resolve: (v: unknown) => void }[] = [];
const count = (path: string) => gets.filter((p) => p === path).length;

beforeEach(() => {
  resetRouteAskData();
  replies = {};
  gets = [];
  held = [];
  setApiShim(async (method, path) => {
    if (method !== "GET") return undefined;
    gets.push(path);
    const reply = replies[path];
    if (reply === FAIL) throw new ApiError(500, "internal", "down");
    if (reply === HOLD)
      return new Promise((resolve) => held.push({ path, resolve }));
    return reply ?? [];
  });
});
afterAll(() => setApiShim(null));

/** Answer the oldest open request for path. */
function answer(path: string, value: unknown) {
  const i = held.findIndex((h) => h.path === path);
  expect(i).toBeGreaterThanOrEqual(0);
  const [h] = held.splice(i, 1);
  h.resolve(value);
}

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 10)));

const waAsk = (memberUserId = "u1", id = "wa000001") =>
  ({
    id,
    agentId: "a1",
    memberUserId,
    prompt: "Please route the Akido group to the Project Lead.",
    createdAt: NOW,
    updatedAt: NOW,
    step: { kind: "whatsapp-route", chatName: "akido", agentId: "a2" },
  }) as AskEntry;
const dcAsk = (memberUserId = "u1") =>
  ({
    id: "dc000001",
    agentId: "a1",
    memberUserId,
    prompt: "Please route the legal channel to the Project Lead.",
    createdAt: NOW,
    updatedAt: NOW,
    step: { kind: "discord-route", placeName: "legal", agentId: "a2" },
  }) as AskEntry;
const otherKindAsk = () =>
  ({
    id: "ac000001",
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Please lift my access.",
    createdAt: NOW,
    updatedAt: NOW,
    step: { kind: "agent-access", agentId: "a1", access: "office" },
  }) as AskEntry;

function Seed({
  viewer,
  entries,
  children,
}: {
  viewer: string;
  entries: AskEntry[];
  children?: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({
      type: "session_context",
      context: {
        userId: viewer,
        username: "Morgan",
        role: "owner",
        currentSessionPrefix: "abcd1234",
      } as never,
    });
    for (const a of AGENTS) dispatch({ type: "agent_added", agent: a });
  }, [dispatch, viewer]);
  useEffect(() => {
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

function Prefetch() {
  useRouteAskPrefetch();
  return null;
}

// The app: the prefetch at boot, and the asks once the member opens them.
function Office({
  entries,
  showAsks,
  viewer = "u1",
}: {
  entries: AskEntry[];
  showAsks: boolean;
  viewer?: string;
}) {
  return (
    <StoreProvider>
      <Seed viewer={viewer} entries={entries}>
        <Prefetch />
        {showAsks && <AsksStack agentId="a1" isMobile={false} />}
      </Seed>
    </StoreProvider>
  );
}

const card = (root: HTMLElement, askId: string) =>
  root.querySelector<HTMLElement>(`[data-ask="${askId}"] [data-ask-action]`);
const radios = (root: HTMLElement) =>
  card(root, "wa000001")?.querySelectorAll('input[type="radio"]').length ?? 0;
const waMoves = (root: HTMLElement) =>
  card(root, "wa000001")?.querySelectorAll("[data-ask-action-wa-moves]")
    .length ?? 0;
const dcMoves = (root: HTMLElement) =>
  card(root, "dc000001")?.querySelectorAll("[data-ask-action-dc-moves]")
    .length ?? 0;
const loading = (root: HTMLElement, askId: string) =>
  card(root, askId)?.querySelectorAll("[data-ask-action-loading]").length ?? 0;

const goodData = () => {
  replies[WA_CHATS] = [chatLegal, chatBoard];
  replies[WA_ROWS] = [waRowToHelper];
  replies[DC_BOTS] = [dcBot];
  replies[DC_GUILDS] = [akidoGuild];
  replies[DC_ROUTES] = [dcRouteToHelper];
};

/** Boot with the prefetch only, let its reads land, then open the asks. */
async function bootThenOpen(entries: AskEntry[]) {
  const view = render(<Office entries={entries} showAsks={false} />);
  await settle();
  view.rerender(<Office entries={entries} showAsks />);
  return { view, root: view.container };
}

it("with the boot read landed, the cards draw the chat picker and the moves line at their first render, with no loading placeholder", async () => {
  goodData();
  const view = render(<Office entries={[waAsk(), dcAsk()]} showAsks={false} />);
  await settle();
  // The boot read ran for both kinds and landed.
  for (const p of [WA_CHATS, WA_ROWS, DC_BOTS, DC_GUILDS, DC_ROUTES])
    expect(count(p)).toBe(1);
  // The cards' own refreshes stay open: what they draw is the held data.
  for (const p of [WA_CHATS, WA_ROWS, DC_BOTS, DC_ROUTES]) replies[p] = HOLD;
  view.rerender(<Office entries={[waAsk(), dcAsk()]} showAsks />);
  const root = view.container;
  expect(card(root, "wa000001")).not.toBe(null);
  expect(card(root, "dc000001")).not.toBe(null);
  expect(
    card(root, "wa000001")!.querySelectorAll("[data-ask-action-wa-pick]")
      .length,
  ).toBe(1);
  expect(radios(root)).toBe(2);
  expect(dcMoves(root)).toBe(1);
  expect(loading(root, "wa000001")).toBe(0);
  expect(loading(root, "dc000001")).toBe(0);
  expect(held.length).toBeGreaterThan(0);
});

it("the boot read runs only for the viewer's own route asks, per kind, and an unrelated asks change starts no read", async () => {
  goodData();
  // Another member's route ask and an own ask of another kind: no read.
  const others = render(
    <Office entries={[waAsk("u2"), otherKindAsk()]} showAsks={false} />,
  );
  await settle();
  expect(
    gets.filter((p) => p.startsWith("/api/whatsapp/") || p.startsWith(DC_BOTS))
      .length,
  ).toBe(0);
  others.unmount();

  // An own WhatsApp ask: the WhatsApp lists only.
  const own = render(<Office entries={[waAsk()]} showAsks={false} />);
  await settle();
  expect([count(WA_CHATS), count(WA_ROWS)]).toEqual([1, 1]);
  expect(gets.filter((p) => p.startsWith(DC_BOTS)).length).toBe(0);

  // More asks arrive, one of them a second own WhatsApp ask: no new read.
  own.rerender(
    <Office
      entries={[waAsk(), otherKindAsk(), waAsk("u1", "wa000002")]}
      showAsks={false}
    />,
  );
  await settle();
  expect([count(WA_CHATS), count(WA_ROWS)]).toEqual([1, 1]);
});

it("a card mount refreshes the held data, and the card shows what changed", async () => {
  replies[WA_CHATS] = [chatLegal];
  replies[DC_BOTS] = [dcBot];
  replies[DC_GUILDS] = [akidoGuild];
  replies[DC_ROUTES] = [];
  const view = render(<Office entries={[waAsk(), dcAsk()]} showAsks={false} />);
  await settle();
  // Changed since the boot read: a second matching chat, a route to another
  // agent.
  replies[WA_CHATS] = [chatLegal, chatBoard];
  replies[DC_ROUTES] = [dcRouteToHelper];
  view.rerender(<Office entries={[waAsk(), dcAsk()]} showAsks />);
  const root = view.container;
  // First render: the held data, one chat and no move.
  expect(radios(root)).toBe(0);
  expect(dcMoves(root)).toBe(0);
  await waitFor(() => expect(radios(root)).toBe(2));
  await waitFor(() => expect(dcMoves(root)).toBe(1));
  expect(count(WA_CHATS)).toBe(2);
  expect(count(DC_ROUTES)).toBe(2);
});

// A probe of the held WhatsApp data for one viewer: the chat names, or null.
// Every value it rendered goes to `rendered`, so a frame that showed another
// viewer's data and was then replaced still counts.
let rendered: unknown[] = [];
function Probe({ viewer }: { viewer: string }) {
  const data = useWhatsAppRouteData(viewer);
  const names = data ? data.chats.map((c) => c.name) : null;
  rendered.push(names);
  return <div data-probe={JSON.stringify(names)} />;
}
const probe = (root: HTMLElement) =>
  JSON.parse(root.querySelector("[data-probe]")!.getAttribute("data-probe")!);

it("one viewer's data is never shown to another, in either order of their reads", async () => {
  replies[WA_CHATS] = HOLD;
  replies[WA_ROWS] = HOLD;
  const A = [{ chat: GROUP, name: "A's chat", group: true }];
  const B = [{ chat: BOARD, name: "B's chat", group: true }];

  // A's read lands after B's started, then B's lands.
  loadWhatsAppRouteData("A");
  loadWhatsAppRouteData("B");
  // B does not wait on A's read.
  expect(count(WA_CHATS)).toBe(2);
  const first = render(<Probe viewer="B" />);
  answer(WA_CHATS, A);
  answer(WA_ROWS, []);
  await settle();
  expect(probe(first.container)).toBe(null);
  answer(WA_CHATS, B);
  answer(WA_ROWS, []);
  await settle();
  expect(probe(first.container)).toEqual(["B's chat"]);
  first.unmount();

  // B's read lands first, then A's late one.
  resetRouteAskData();
  held = [];
  gets = [];
  loadWhatsAppRouteData("A");
  loadWhatsAppRouteData("B");
  const second = render(<Probe viewer="B" />);
  const [aChats, aRows] = held.splice(0, 2);
  answer(WA_CHATS, B);
  answer(WA_ROWS, []);
  await settle();
  expect(probe(second.container)).toEqual(["B's chat"]);
  aChats.resolve(A);
  aRows.resolve([]);
  await settle();
  expect(probe(second.container)).toEqual(["B's chat"]);
  second.unmount();

  // A's data is held: B's first render shows nothing of it.
  resetRouteAskData();
  replies[WA_CHATS] = A;
  replies[WA_ROWS] = [];
  loadWhatsAppRouteData("A");
  await settle();
  replies[WA_CHATS] = HOLD;
  replies[WA_ROWS] = HOLD;
  rendered = [];
  const third = render(<Probe viewer="B" />);
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.every((names) => names === null)).toBe(true);
  expect(probe(third.container)).toBe(null);
});

// Each part a refresh can fail, and what the card shows from the held data.
const PARTS: {
  part: string;
  path: string;
  shows: (root: HTMLElement) => number;
  expected: number;
}[] = [
  { part: "WhatsApp chats", path: WA_CHATS, shows: radios, expected: 2 },
  { part: "WhatsApp rows", path: WA_ROWS, shows: waMoves, expected: 1 },
  { part: "Discord bot list", path: DC_BOTS, shows: dcMoves, expected: 1 },
  { part: "one bot's guilds", path: DC_GUILDS, shows: dcMoves, expected: 1 },
  { part: "Discord routes", path: DC_ROUTES, shows: dcMoves, expected: 1 },
];

for (const { part, path, shows, expected } of PARTS)
  it(`a refresh whose ${part} fails keeps the held ${part}`, async () => {
    goodData();
    // Two chats with a row on one: picker, and the move once picked. One
    // chat for the rows case, so it is picked and the move shows.
    if (path === WA_ROWS) replies[WA_CHATS] = [chatLegal];
    const { view, root } = await bootThenOpen([waAsk(), dcAsk()]);
    await settle();
    expect(count(path)).toBe(2);
    expect(shows(root)).toBe(expected);
    replies[path] = FAIL;
    // Close and open the asks: a new card mount refreshes.
    view.rerender(<Office entries={[waAsk(), dcAsk()]} showAsks={false} />);
    view.rerender(<Office entries={[waAsk(), dcAsk()]} showAsks />);
    await settle();
    expect(count(path)).toBe(3);
    expect(shows(root)).toBe(expected);
  });

it("a first read whose list fails reads it as empty: the card shows no match, not a placeholder", async () => {
  replies[WA_CHATS] = FAIL;
  const { root } = await bootThenOpen([waAsk()]);
  await settle();
  expect(loading(root, "wa000001")).toBe(0);
  expect(
    card(root, "wa000001")!.querySelectorAll("[data-ask-action-wa-none]")
      .length,
  ).toBe(1);
});

// useDiscordRouteData is reached through the Discord card above; this keeps
// its import in use for a direct probe of the null viewer.
it("a null viewer reads nothing", async () => {
  goodData();
  function Nobody() {
    const wa = useWhatsAppRouteData(null);
    const dc = useDiscordRouteData(null);
    return <div data-probe={JSON.stringify([wa, dc])} />;
  }
  const view = render(<Nobody />);
  await settle();
  expect(gets.length).toBe(0);
  expect(probe(view.container)).toEqual([null, null]);
});
