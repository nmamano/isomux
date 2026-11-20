// The card of a messaging-route ask and of a storage-retention ask (task
// 2ff2729f). A messaging-route card names the member's route (read from
// their own route list of the step's app) and has one row per key of `set`:
// the value the route has now and the value asked for. A route the list no
// longer has shows as gone, with no Apply. Only the member the ask is for
// reads their routes and gets Apply, which posts the run with no body. A
// storage-retention card has one row per key: the age now and the one
// asked for.
//
// Hooks: each row is [data-ask-action-key=<key of set>] with
// data-ask-action-current and data-ask-action-requested, each the value as a
// string (String(value): "true", "false", "null"; the stored default when
// the route has no key: "" for no prefix, "false" for a switch that is off).
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, waitFor } = await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { resetRouteAskData } = await import("../route-ask-data.ts");
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
const MEMBERS = [
  { id: "u1", name: "Morgan" },
  { id: "u2", name: "Casey" },
].map((m) => ({
  ...m,
  role: "member",
  avatarColor: "#336699",
  avatarVariant: "classic",
  createdAt: NOW,
})) as never[];

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

const BOT = "1100000000000000001";
const GUILD = "1200000000000000001";
const LEGAL = "1300000000000000002";
const GROUP = "120363000000000001@g.us";

const DC_ROUTE = {
  id: "d_1",
  botId: BOT,
  guildId: GUILD,
  scope: "channel",
  targetId: LEGAL,
  name: "Isomux Discord",
  agentId: "a3",
  trigger: "mention",
  replyMode: "read",
  createdAt: 1,
};
const WA_ROW = {
  id: "r_1",
  chat: GROUP,
  group: true,
  name: "Family group",
  agentId: "a3",
  trigger: "mention",
  sendDirect: true,
  createdAt: 1,
};
const RETENTION = {
  compressAfterDays: 7,
  deleteAfterDays: null,
  keepPerAgent: 2,
  lastRunAt: null,
  lastRun: null,
  lastError: null,
  running: false,
};

let posts: string[] = [];
let postBodies: unknown[] = [];
let gets: string[] = [];
let dcRoutes: unknown[] = [];
let waRows: unknown[] = [];
beforeEach(() => {
  // The cards' lists are held per process (ui/route-ask-data.ts).
  resetRouteAskData();
  posts = [];
  postBodies = [];
  gets = [];
  dcRoutes = [DC_ROUTE];
  waRows = [WA_ROW];
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push(path);
      postBodies.push(body);
      return undefined;
    }
    gets.push(path);
    if (path === "/api/discord")
      return [
        {
          id: BOT,
          name: "Morgan's bot",
          addedAt: 1,
          status: { state: "connected" },
          inviteUrl: `https://discord.com/oauth2/authorize?client_id=${BOT}`,
        },
      ];
    if (path === "/api/discord/routes") return dcRoutes;
    if (path.startsWith("/api/discord/bots/"))
      throw new ApiError(404, "not_found", "not connected");
    if (path === "/api/whatsapp/routes") return waRows;
    if (path === "/api/whatsapp/chats") return [];
    if (path === "/api/storage/retention") return RETENTION;
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
    dispatch({ type: "users_list", users: MEMBERS });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

async function mount(step: Record<string, unknown>, memberUserId = "u1") {
  const entry = {
    id: "mr000001",
    agentId: "a1",
    memberUserId,
    prompt: "Please let me answer in this Discord channel.",
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
      `[data-ask="mr000001"] [data-ask-action]`,
    );
  const apply = () =>
    block()?.querySelector<HTMLButtonElement>("[data-ask-action-apply]") ??
    null;
  const text = () => block()?.textContent ?? "";
  // The rows by key: the value now and asked for.
  const rows = () =>
    Object.fromEntries(
      [
        ...(block()?.querySelectorAll<HTMLElement>("[data-ask-action-key]") ??
          []),
      ].map((r) => [
        r.dataset.askActionKey,
        {
          current: r.dataset.askActionCurrent,
          requested: r.dataset.askActionRequested,
        },
      ]),
    );
  return { view, block, apply, text, rows };
}

const dcStep = (set: Record<string, unknown>, routeId = "d_1") => ({
  kind: "messaging-route",
  app: "discord",
  routeId,
  set,
});
const waStep = (set: Record<string, unknown>, routeId = "r_1") => ({
  kind: "messaging-route",
  app: "whatsapp",
  routeId,
  set,
});
const tick = () => new Promise((r) => setTimeout(r, 20));

it("a Discord route card names the route and has one row per key of set, the route's value now (its default when it has no key) and the value asked for; Apply posts the run once with no body", async () => {
  const m = await mount(
    dcStep({
      replyMode: "ask",
      prefix: "[bot]",
      includeBots: true,
      react: false,
      agentId: "a2",
    }),
  );
  await waitFor(() => expect(m.rows().replyMode?.current).toBe("read"));
  expect(m.rows()).toEqual({
    replyMode: { current: "read", requested: "ask" },
    prefix: { current: "", requested: "[bot]" },
    includeBots: { current: "false", requested: "true" },
    react: { current: "false", requested: "false" },
    agentId: { current: "a3", requested: "a2" },
  });
  expect(m.text().includes("Isomux Discord")).toBe(true);
  expect(m.block()!.hasAttribute("data-ask-action-gone")).toBe(false);
  // The member's own lists, of the step's app only.
  expect(gets.includes("/api/discord/routes")).toBe(true);
  expect(gets.filter((p) => p.startsWith("/api/whatsapp/")).length).toBe(0);
  fireEvent.click(m.apply()!);
  await waitFor(() => expect(posts.length).toBe(1));
  expect([posts[0], postBodies[0]]).toEqual([
    "/api/asks/mr000001/action",
    undefined,
  ]);
});

it("a WhatsApp row card reads the member's rows, not their Discord routes", async () => {
  const m = await mount(
    waStep({ trigger: "all", sendDirect: false, ownMessages: true }),
  );
  await waitFor(() => expect(m.rows().trigger?.current).toBe("mention"));
  expect(m.rows()).toEqual({
    trigger: { current: "mention", requested: "all" },
    sendDirect: { current: "true", requested: "false" },
    ownMessages: { current: "false", requested: "true" },
  });
  expect(m.text().includes("Family group")).toBe(true);
  expect(gets.includes("/api/whatsapp/routes")).toBe(true);
  expect(gets.filter((p) => p.startsWith("/api/discord")).length).toBe(0);
  expect(m.apply()).not.toBe(null);
});

it("a route the member's list no longer has shows as gone, with no Apply", async () => {
  dcRoutes = [];
  const m = await mount(dcStep({ replyMode: "ask" }));
  await waitFor(() =>
    expect(m.block()!.hasAttribute("data-ask-action-gone")).toBe(true),
  );
  expect(m.apply()).toBe(null);
  // The route that is gone has no value now.
  expect(m.rows().replyMode?.current).toBeUndefined();
});

it("another member's ask reads no routes and has no Apply", async () => {
  const m = await mount(dcStep({ replyMode: "ask" }), "u2");
  await waitFor(() => expect(m.block()).not.toBe(null));
  await tick();
  expect(
    gets.filter(
      (p) => p.startsWith("/api/discord") || p.startsWith("/api/whatsapp"),
    ).length,
  ).toBe(0);
  expect(m.apply()).toBe(null);
});

it("a storage-retention card has one row per key, the age now and the one asked for (null: off)", async () => {
  const m = await mount({
    kind: "storage-retention",
    set: { compressAfterDays: 14, deleteAfterDays: 90 },
  });
  await waitFor(() => expect(m.rows().compressAfterDays?.current).toBe("7"));
  expect(m.rows()).toEqual({
    compressAfterDays: { current: "7", requested: "14" },
    deleteAfterDays: { current: "null", requested: "90" },
  });
  expect(gets.includes("/api/storage/retention")).toBe(true);
  fireEvent.click(m.apply()!);
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0]).toBe("/api/asks/mr000001/action");
});
