// The Discord card of the Integrations Messaging tab (task 7fd44c30, slice
// 3): the member connects their own bots by token, adds them to a server,
// sees their live status, and routes a channel, a category or a whole server
// to one of their agents. Rendered over a live reducer, so a discord_status
// message reaches the card as it does from the socket. The API is a shim
// whose answers the test picks; copy is never matched, only the hooks.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { expectPortalLink } from "../test-support/discord-portal.ts";

setUpDomTestFile();

const { fireEvent, render, act } = await import("@testing-library/react");
const { DiscordSection } = await import("./DiscordSection.tsx");
const { asMember, selfUserRecord, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { getDiscordLayout, setDiscordLayout } =
  await import("../device-settings.ts");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { DISCORD_BOTS_MAX, DISCORD_INVITE_PERMISSIONS } =
  await import("../../shared/discord.ts");

type DiscordBot = import("../../shared/discord.ts").DiscordBot;
type DiscordRoute = import("../../shared/discord.ts").DiscordRoute;
type DiscordGuildSeen = import("../../shared/discord.ts").DiscordGuildSeen;
type AppState = import("../store.tsx").AppState;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type Action = Parameters<typeof reducer>[1];

const BOT = "1100000000000000001";
const BOT2 = "1100000000000000002";
const GUILD = "1200000000000000001";
const GUILD2 = "1200000000000000002";
const CAT = "1300000000000000001";
const GENERAL = "1300000000000000002";
const SIDE = "1300000000000000003";
const FORUM = "1300000000000000004";
const LOOSE = "1300000000000000005";
const G2_CHAN = "1300000000000000006";
const TOKEN = "fake.Token-SecretValue-0001";

const bot = (
  id: string,
  state: DiscordBot["status"] = { state: "connected" },
  name = `Bot ${id.slice(-1)}`,
): DiscordBot => ({ id, name, addedAt: 1, status: state });

const GUILDS: DiscordGuildSeen[] = [
  {
    id: GUILD,
    name: "Isomux",
    channels: [
      { id: CAT, name: "Talk", kind: "category", parentId: null },
      { id: GENERAL, name: "general", kind: "text", parentId: CAT },
      { id: SIDE, name: "side", kind: "text", parentId: CAT },
      { id: FORUM, name: "help", kind: "forum", parentId: CAT },
      { id: LOOSE, name: "random", kind: "text", parentId: null },
    ],
  },
  {
    id: GUILD2,
    name: "Elsewhere",
    channels: [{ id: G2_CHAN, name: "chat", kind: "text", parentId: null }],
  },
];

const route = (id: string, over: Partial<DiscordRoute> = {}): DiscordRoute => ({
  id,
  botId: BOT,
  guildId: GUILD,
  scope: "channel",
  targetId: GENERAL,
  name: `Route ${id}`,
  agentId: "a-office",
  trigger: "mention",
  replyMode: "bot",
  createdAt: 1,
  ...over,
});

const agent = (id: string, name: string, userId: string, access: string) =>
  ({ id, name, userId, access }) as unknown as AgentInfo;
const AGENTS = [
  agent("a-office", "Helper", "u1", "office"),
  agent("a-std", "Shell", "u1", "standard"),
  agent("a-chat", "Talker", "u1", "chat"),
  agent("a-other", "Not mine", "u2", "office"),
];

let bots: DiscordBot[] = [];
let routes: DiscordRoute[] = [];
// Each bot's guilds; a bot with none here answers 404 (not connected yet).
let guilds: Record<string, DiscordGuildSeen[]> = {};
let calls: { method: string; path: string; body: unknown }[] = [];
let connectAnswer: (body: unknown) => Promise<unknown> = async () => bot(BOT);
let routeAnswer: (body: unknown) => Promise<unknown> = async (body) => {
  const made = route(`d_${routes.length + 1}`, body as Partial<DiscordRoute>);
  routes = [...routes, made];
  return made;
};
const defaultRouteAnswer = routeAnswer;
let patchAnswer: (path: string, body: unknown) => Promise<unknown> = async (
  path,
  body,
) => {
  const id = path.split("/").at(-1);
  routes = routes.map((r) =>
    r.id === id ? ({ ...r, ...(body as object) } as DiscordRoute) : r,
  );
  return routes.find((r) => r.id === id);
};
const defaultPatchAnswer = patchAnswer;
let botsGate: Promise<void> | null = null;
let botsFail = false;
let routesFail = false;

beforeEach(() => {
  window.localStorage.removeItem("isomux-discord-layout");
  bots = [];
  routes = [];
  guilds = {};
  calls = [];
  botsGate = null;
  botsFail = false;
  routesFail = false;
  connectAnswer = async () => bot(BOT);
  routeAnswer = defaultRouteAnswer;
  patchAnswer = defaultPatchAnswer;
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/discord") {
      if (botsGate) await botsGate;
      if (botsFail) throw new ApiError(500, "internal", "Internal");
      return bots;
    }
    if (method === "POST" && path === "/api/discord/bots")
      return connectAnswer(body);
    const guildsOf = /^\/api\/discord\/bots\/(\d+)\/guilds$/.exec(path);
    if (method === "GET" && guildsOf) {
      const seen = guilds[guildsOf[1]];
      if (!seen) throw new ApiError(404, "not_found", "not connected");
      return seen;
    }
    if (method === "DELETE" && path.startsWith("/api/discord/bots/")) {
      const id = path.split("/").at(-1);
      bots = bots.filter((b) => b.id !== id);
      routes = routes.filter((r) => r.botId !== id);
      return undefined;
    }
    if (method === "GET" && path === "/api/discord/routes") {
      if (routesFail) throw new ApiError(500, "internal", "Internal");
      return routes;
    }
    if (method === "POST" && path === "/api/discord/routes")
      return routeAnswer(body);
    if (method === "PATCH" && path.startsWith("/api/discord/routes/"))
      return patchAnswer(path, body);
    if (method === "DELETE" && path.startsWith("/api/discord/routes/")) {
      routes = routes.filter((r) => !path.endsWith(`/${r.id}`));
      return undefined;
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

afterAll(() => setApiShim(null));

async function settle() {
  await act(async () => {});
}

async function show(over: Partial<AppState> = {}) {
  let state = stateWithSelfUser(null, { agents: AGENTS, ...over });
  const tree = () => (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider
        value={(action) => {
          state = reducer(state, action);
          view.rerender(tree());
        }}
      >
        <LanguageProvider>
          <DiscordSection />
        </LanguageProvider>
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
  const view = render(tree());
  await settle();
  // A server push, as the socket dispatches it.
  const push = async (next: DiscordBot[]) => {
    const action: Action = { type: "discord_status", bots: next };
    await act(async () => {
      state = reducer(state, action);
      view.rerender(tree());
    });
    await settle();
  };
  const q = (selector: string) => view.container.querySelector(selector);
  const all = (selector: string) => [
    ...view.container.querySelectorAll(selector),
  ];
  const click = async (selector: string | Element) => {
    const el = typeof selector === "string" ? q(selector) : selector;
    if (!(el instanceof HTMLElement)) throw new Error(`no ${String(selector)}`);
    await act(async () => {
      fireEvent.click(el);
    });
    await settle();
  };
  return { view, push, q, all, click, state: () => state };
}

type Shown = Awaited<ReturnType<typeof show>>;

const writes = () => calls.filter((c) => c.method !== "GET");
const guildReads = (botId: string) =>
  calls.filter(
    (c) => c.method === "GET" && c.path === `/api/discord/bots/${botId}/guilds`,
  ).length;
const section = (s: Shown) => s.q("[data-integrations-card=discord]")!;

function field(root: Element, name: string) {
  const el = root.querySelector(`[name="${name}"]`);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement))
    throw new Error(`no ${name}`);
  return el;
}
async function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    fireEvent.change(el, { target: { value } });
  });
  await settle();
}
// The token never stays: in no input, and nowhere in the markup.
function noToken(s: Shown, label: string) {
  for (const input of s.all("input"))
    expect({ label, value: (input as HTMLInputElement).value }).not.toEqual({
      label,
      value: TOKEN,
    });
  expect({
    label,
    inMarkup: s.view.container.innerHTML.includes(TOKEN),
  }).toEqual({ label, inMarkup: false });
}
// The Add buttons: the bot's outside the routes block, the route's inside.
const addButtons = (s: Shown) => {
  const adds = s.all("[data-integrations-add]");
  return {
    bot: adds.filter((a) => a.closest("[data-discord-routes]") === null),
    route: adds.filter((a) => a.closest("[data-discord-routes]") !== null),
  };
};
const live = (root: Element, selector: string) =>
  [...root.querySelectorAll(selector)].filter(
    (el) => el.closest("[data-reserved]") === null,
  );
const inHeld = (root: Element, selector: string) =>
  root.querySelectorAll(`[data-reserved] ${selector}`).length;

async function typeToken(s: Shown, value = TOKEN) {
  const form = s.q("form[data-discord-connect-form]");
  if (!form) throw new Error("no connect form");
  const input = field(form, "discordToken") as HTMLInputElement;
  await change(input, value);
  return { form, input };
}

// --- Connecting a bot ---

it("with no bot, the connect form shows: a password field the browser does not fill; Connect sends one POST with the token, the bot's row shows, and the token is gone", async () => {
  const s = await show();
  expect(s.q("[data-discord-bot]")).toBeNull();
  expect(s.q("[data-discord-routes]")).toBeNull();
  const { input } = await typeToken(s);
  expect(input.type).toBe("password");
  expect(input.getAttribute("autocomplete")).toBe("off");
  connectAnswer = async () => {
    bots = [bot(BOT, { state: "connecting" }, "Office Bot")];
    return bots[0];
  };
  await s.click("[data-discord-connect]");
  expect(writes()).toEqual([
    { method: "POST", path: "/api/discord/bots", body: { token: TOKEN } },
  ]);
  expect(s.q(`[data-discord-bot="${BOT}"]`)).not.toBeNull();
  expect(s.q('[role="alert"]')).toBeNull();
  noToken(s, "after a connect");
  // The token went nowhere but the POST body.
  expect(JSON.stringify(s.state())).not.toContain(TOKEN);
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
});

it("the connect form's steps hint links the Discord Developer Portal, in a new tab", async () => {
  const s = await show();
  const form = s.q("form[data-discord-connect-form]");
  if (!form) throw new Error("no connect form");
  expectPortalLink(form);
});

it("each refusal code has its own line, any other failure the generic one; the field is empty after each", async () => {
  const s = await show();
  const lineFor = async (status: number, code: string) => {
    connectAnswer = async () => {
      throw new ApiError(status, code, "refused");
    };
    await typeToken(s);
    await s.click("[data-discord-connect]");
    const alert = s.q('[role="alert"]');
    expect({ code, alert: alert !== null }).toEqual({ code, alert: true });
    noToken(s, code);
    return alert!.textContent ?? "";
  };
  const named = [
    await lineFor(400, "token_refused"),
    await lineFor(400, "not_a_bot"),
    await lineFor(400, "check_failed"),
    await lineFor(409, "bot_taken"),
    await lineFor(409, "bots_max"),
  ];
  const generic = await lineFor(500, "internal");
  expect(new Set([...named, generic]).size).toBe(6);
  expect(await lineFor(409, "disconnected")).toBe(generic);
  // The cap line names the cap.
  expect(named[4]).toContain(String(DISCORD_BOTS_MAX));
  expect(s.q("[data-discord-bot]")).toBeNull();
});

it("with a bot, connecting another sits behind its Add; Cancel leaves no token; at the cap there is no Add", async () => {
  bots = [bot(BOT)];
  const s = await show();
  expect(s.q("form[data-discord-connect-form]")).toBeNull();
  const add = addButtons(s).bot;
  expect(add).toHaveLength(1);
  await s.click(add[0]);
  await typeToken(s);
  await s.click("[data-discord-connect-cancel]");
  expect(s.q("form[data-discord-connect-form]")).toBeNull();
  noToken(s, "after a cancel");
  s.view.unmount();

  bots = Array.from({ length: DISCORD_BOTS_MAX }, (_, i) =>
    bot(`11000000000000000${String(i + 1).padStart(2, "0")}`),
  );
  const full = await show();
  expect(full.all("[data-discord-bot]")).toHaveLength(DISCORD_BOTS_MAX);
  expect(addButtons(full).bot).toHaveLength(0);
  expect(full.q("form[data-discord-connect-form]")).toBeNull();
});

// --- The bot rows ---

it("each bot shows its state; a stopped one its reason and Connect again; every bot Disconnect and an invite link to add it to a server", async () => {
  bots = [
    bot(BOT, { state: "connected" }),
    bot(BOT2, { state: "connecting" }),
    bot("1100000000000000003", { state: "dead", reason: "intent_off" }),
  ];
  const s = await show();
  const stateOf = (id: string) =>
    s
      .q(`[data-discord-bot="${id}"] [data-discord-bot-state]`)
      ?.getAttribute("data-discord-bot-state") ?? null;
  expect([stateOf(BOT), stateOf(BOT2), stateOf("1100000000000000003")]).toEqual(
    ["connected", "connecting", "dead"],
  );
  expect(
    s
      .all("[data-discord-bot-reason]")
      .map((e) => e.getAttribute("data-discord-bot-reason")),
  ).toEqual(["intent_off"]);
  expect(
    s
      .all("[data-discord-reconnect]")
      .map((e) => e.getAttribute("data-discord-reconnect")),
  ).toEqual(["1100000000000000003"]);
  expect(s.all("[data-discord-disconnect]")).toHaveLength(3);

  for (const id of [BOT, BOT2]) {
    const link = s.q(`a[data-discord-invite="${id}"]`);
    expect({ id, link: link !== null }).toEqual({ id, link: true });
    const url = new URL(link!.getAttribute("href") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(id);
    expect(url.searchParams.get("scope")).toBe("bot");
    expect(url.searchParams.get("permissions")).toBe(
      String(DISCORD_INVITE_PERMISSIONS),
    );
  }
  expect(String(DISCORD_INVITE_PERMISSIONS)).toBe("274877975616");
});

it("the reason lines differ per reason", async () => {
  const reasons = ["token_invalid", "intent_off", "crash_loop"] as const;
  bots = reasons.map((reason, i) =>
    bot(`110000000000000000${i + 1}`, { state: "dead", reason }),
  );
  const s = await show();
  const lines = reasons.map(
    (r) => s.q(`[data-discord-bot-reason="${r}"]`)?.textContent ?? "",
  );
  expect(lines.every((l) => l.length > 0)).toBe(true);
  expect(new Set(lines).size).toBe(3);
});

it("a pushed status changes the rows live", async () => {
  bots = [bot(BOT, { state: "connecting" })];
  const s = await show();
  await s.push([
    bot(BOT, { state: "dead", reason: "token_invalid" }),
    bot(BOT2),
  ]);
  expect(
    s
      .q(`[data-discord-bot="${BOT}"] [data-discord-bot-state]`)
      ?.getAttribute("data-discord-bot-state"),
  ).toBe("dead");
  expect(s.q(`[data-discord-bot="${BOT2}"]`)).not.toBeNull();
  await s.push([]);
  expect(s.q("[data-discord-bot]")).toBeNull();
  expect(s.q("form[data-discord-connect-form]")).not.toBeNull();
});

it("Connect again opens the token form and sends the new token; the field is empty after", async () => {
  bots = [bot(BOT, { state: "dead", reason: "token_invalid" })];
  const s = await show();
  await s.click(`[data-discord-reconnect="${BOT}"]`);
  connectAnswer = async () => bot(BOT, { state: "connecting" });
  await typeToken(s);
  await s.click("[data-discord-connect]");
  expect(writes()).toEqual([
    { method: "POST", path: "/api/discord/bots", body: { token: TOKEN } },
  ]);
  expect(
    s
      .q(`[data-discord-bot="${BOT}"] [data-discord-bot-state]`)
      ?.getAttribute("data-discord-bot-state"),
  ).toBe("connecting");
  noToken(s, "after connect again");
});

it("Disconnect sends one DELETE; the bot and its routes leave the card, another bot's routes stay", async () => {
  bots = [bot(BOT), bot(BOT2)];
  guilds = { [BOT]: GUILDS, [BOT2]: GUILDS };
  routes = [route("d_1"), route("d_2", { botId: BOT2, targetId: SIDE })];
  const s = await show();
  expect(s.all("[data-discord-route]")).toHaveLength(2);
  // Disconnect asks first (task c6589760): the first click arms it.
  await s.click(`[data-discord-disconnect="${BOT}"]`);
  expect(writes()).toEqual([]);
  expect(
    s
      .q(`[data-discord-disconnect="${BOT}"]`)
      ?.hasAttribute("data-confirm-armed"),
  ).toBe(true);
  await s.click(`[data-discord-disconnect="${BOT}"]`);
  expect(writes()).toEqual([
    { method: "DELETE", path: `/api/discord/bots/${BOT}`, body: undefined },
  ]);
  expect(s.q(`[data-discord-bot="${BOT}"]`)).toBeNull();
  expect(s.q('[data-discord-route="d_1"]')).toBeNull();
  expect(s.q('[data-discord-route="d_2"]')).not.toBeNull();
});

// --- The routes ---

it("lists each route with its place, server and agent from its bot's guilds; a dead marker and the mode pills; a place the bot does not know still shows the route", async () => {
  bots = [bot(BOT)];
  guilds = { [BOT]: GUILDS };
  routes = [
    route("d_1", { name: "General talk" }),
    route("d_2", {
      scope: "category",
      targetId: CAT,
      name: "All of Talk",
      replyMode: "read",
    }),
    route("d_3", {
      scope: "server",
      targetId: GUILD,
      name: "Whole",
      replyMode: "ask",
      agentId: "a-std",
      dead: "agent_not_yours",
    }),
    route("d_4", { targetId: "1300000000000000099", name: "Gone place" }),
  ];
  const s = await show();
  const row = (id: string) => s.q(`[data-discord-route="${id}"]`);
  expect(row("d_1")?.textContent).toContain("General talk");
  expect(row("d_1")?.textContent).toContain("general");
  expect(row("d_1")?.textContent).toContain("Isomux");
  expect(row("d_1")?.textContent).toContain("Helper");
  expect(row("d_2")?.textContent).toContain("Talk");
  expect(row("d_3")?.textContent).toContain("Shell");
  expect(row("d_4")?.textContent).toContain("Gone place");
  expect(row("d_4")?.textContent).not.toContain("1300000000000000099");
  const modeOf = (id: string) =>
    s
      .q(`[data-discord-route="${id}"] [data-discord-route-mode]`)
      ?.getAttribute("data-discord-route-mode") ?? null;
  // Only the modes that are not the default ("ask") carry a pill.
  expect([modeOf("d_1"), modeOf("d_2"), modeOf("d_3")]).toEqual([
    "bot",
    "read",
    null,
  ]);
  expect(
    s
      .all("[data-discord-route-dead]")
      .map((e) => [
        e.closest("[data-discord-route]")?.getAttribute("data-discord-route"),
        e.getAttribute("data-discord-route-dead"),
      ]),
  ).toEqual([["d_3", "agent_not_yours"]]);
});

it("Delete removes one route with one DELETE", async () => {
  bots = [bot(BOT)];
  guilds = { [BOT]: GUILDS };
  routes = [route("d_1"), route("d_2", { targetId: SIDE })];
  const s = await show();
  // Delete asks first (task c6589760): the first click arms it.
  await s.click('[data-discord-route-delete="d_1"]');
  expect(writes()).toEqual([]);
  expect(
    s
      .q('[data-discord-route-delete="d_1"]')
      ?.hasAttribute("data-confirm-armed"),
  ).toBe(true);
  await s.click('[data-discord-route-delete="d_1"]');
  expect(writes()).toEqual([
    { method: "DELETE", path: "/api/discord/routes/d_1", body: undefined },
  ]);
  expect(s.q('[data-discord-route="d_1"]')).toBeNull();
  expect(s.q('[data-discord-route="d_2"]')).not.toBeNull();
});

it("reads each bot's guilds on mount, again when the bot becomes connected, and each time the route form opens", async () => {
  bots = [bot(BOT, { state: "connecting" })];
  const s = await show();
  expect(guildReads(BOT)).toBe(1);
  // Still connecting: no new read.
  await s.push([bot(BOT, { state: "connecting" })]);
  expect(guildReads(BOT)).toBe(1);
  guilds = { [BOT]: GUILDS };
  await s.push([bot(BOT, { state: "connected" })]);
  expect(guildReads(BOT)).toBe(2);
  // Connected again: not a change.
  await s.push([bot(BOT, { state: "connected" })]);
  expect(guildReads(BOT)).toBe(2);
  await s.click(addButtons(s).route[0]);
  expect(s.q("form[data-discord-route-form]")).not.toBeNull();
  expect(guildReads(BOT)).toBe(3);
});

async function openAdd(s: Shown) {
  const [add] = addButtons(s).route;
  if (!add) throw new Error("no route Add");
  await s.click(add);
  const form = s.q("form[data-discord-route-form]");
  if (!form) throw new Error("no route form");
  return form;
}
const options = (select: HTMLSelectElement) =>
  [...select.options].filter((o) => !o.disabled).map((o) => o.value);
const saveEnabled = (form: Element) => {
  const save = form.querySelector("[data-panel-save]");
  return save instanceof HTMLButtonElement && !save.disabled;
};
const choose = async (s: Shown, group: string, value: string) =>
  s.click(`[data-discord-route-form] [${group}] [data-choice="${value}"]`);
const checkedReplies = (form: Element) =>
  form
    .querySelector(
      '[data-discord-route-replies] [data-choice][aria-checked="true"]',
    )
    ?.getAttribute("data-choice") ?? null;
const routePosts = () =>
  calls.filter((c) => c.method === "POST" && c.path === "/api/discord/routes");

it("Add: one bot needs no bot field; the server's text and forum channels, not its categories or routed places; the name from the place; defaults send no setting", async () => {
  bots = [bot(BOT)];
  guilds = { [BOT]: GUILDS };
  // GENERAL already has a route of this bot.
  routes = [route("d_1")];
  const s = await show();
  const form = await openAdd(s);
  expect(checkedReplies(form)).toBe("ask");
  expect(form.querySelector('[name="discordRouteBot"]')).toBeNull();
  const guild = field(form, "discordRouteGuild") as HTMLSelectElement;
  expect(options(guild).sort()).toEqual([GUILD, GUILD2].sort());
  await change(guild, GUILD);
  const target = () => field(form, "discordRouteTarget") as HTMLSelectElement;
  expect(options(target()).sort()).toEqual([FORUM, LOOSE, SIDE].sort());
  await change(target(), SIDE);
  expect((field(form, "discordRouteName") as HTMLInputElement).value).toContain(
    "side",
  );
  const agents = options(field(form, "discordRouteAgent") as HTMLSelectElement);
  expect(agents.sort()).toEqual(["a-office", "a-std"]);
  await change(field(form, "discordRouteAgent"), "a-office");
  await s.click("[data-discord-route-form] [data-panel-save]");
  expect(routePosts().map((c) => c.body)).toEqual([
    {
      botId: BOT,
      guildId: GUILD,
      scope: "channel",
      targetId: SIDE,
      name: (routePosts()[0].body as { name: string }).name,
      agentId: "a-office",
    },
  ]);
  expect((routePosts()[0].body as { name: string }).name).toContain("side");
  expect(s.q("form[data-discord-route-form]")).toBeNull();
  expect(s.all("[data-discord-route]")).toHaveLength(2);
});

it("Add: a category lists the categories, a whole server has no place field; the settings that are not the default are sent", async () => {
  bots = [bot(BOT)];
  guilds = { [BOT]: GUILDS };
  const s = await show();
  let form = await openAdd(s);
  await change(field(form, "discordRouteGuild"), GUILD);
  await choose(s, "data-discord-route-scope", "category");
  expect(
    options(field(form, "discordRouteTarget") as HTMLSelectElement),
  ).toEqual([CAT]);
  await change(field(form, "discordRouteTarget"), CAT);
  await change(field(form, "discordRouteName"), "Talk");
  await change(field(form, "discordRouteAgent"), "a-std");
  await choose(s, "data-discord-route-trigger", "all");
  await choose(s, "data-discord-route-replies", "bot");
  await change(field(form, "discordRoutePrefix"), "[Helper]");
  await s.click(form.querySelector('input[name="discordRouteIncludeBots"]')!);
  await s.click(form.querySelector('input[name="discordRouteReact"]')!);
  await s.click("[data-discord-route-form] [data-panel-save]");
  expect(routePosts().map((c) => c.body)).toEqual([
    {
      botId: BOT,
      guildId: GUILD,
      scope: "category",
      targetId: CAT,
      name: "Talk",
      agentId: "a-std",
      trigger: "all",
      replyMode: "bot",
      prefix: "[Helper]",
      includeBots: true,
      react: true,
    },
  ]);

  form = await openAdd(s);
  await change(field(form, "discordRouteGuild"), GUILD2);
  await choose(s, "data-discord-route-scope", "server");
  expect(form.querySelector('[name="discordRouteTarget"]')).toBeNull();
  await change(field(form, "discordRouteName"), "All");
  await change(field(form, "discordRouteAgent"), "a-office");
  await choose(s, "data-discord-route-replies", "read");
  await s.click("[data-discord-route-form] [data-panel-save]");
  expect(routePosts()[1].body).toEqual({
    botId: BOT,
    guildId: GUILD2,
    scope: "server",
    targetId: GUILD2,
    name: "All",
    agentId: "a-office",
    replyMode: "read",
  });
});

it("Add: a server with a whole-server route of this bot offers no whole server, and moving a whole server to it leaves one shown scope picked and no Save", async () => {
  bots = [bot(BOT), bot(BOT2)];
  guilds = { [BOT]: GUILDS, [BOT2]: GUILDS };
  // BOT has a whole-server route on GUILD; BOT2 has none.
  routes = [route("d_1", { scope: "server", targetId: GUILD })];
  const s = await show();
  const form = await openAdd(s);
  const scopes = () =>
    [...form.querySelectorAll("[data-discord-route-scope] [data-choice]")].map(
      (b) => b.getAttribute("data-choice"),
    );
  const picked = () =>
    [
      ...form.querySelectorAll(
        '[data-discord-route-scope] [data-choice][aria-checked="true"]',
      ),
    ].map((b) => b.getAttribute("data-choice"));
  const pickBot = (id: string) => change(field(form, "discordRouteBot"), id);
  const pickGuild = (id: string) =>
    change(field(form, "discordRouteGuild"), id);

  await pickBot(BOT);
  await pickGuild(GUILD);
  expect(scopes()).toEqual(["channel", "category"]);
  // Another bot's route does not take the server.
  await pickBot(BOT2);
  await pickGuild(GUILD);
  expect(scopes()).toEqual(["channel", "category", "server"]);

  await pickBot(BOT);
  await pickGuild(GUILD2);
  await choose(s, "data-discord-route-scope", "server");
  expect(picked()).toEqual(["server"]);
  await change(field(form, "discordRouteName"), "All");
  await pickGuild(GUILD);
  expect(picked()).toHaveLength(1);
  expect(scopes()).toContain(picked()[0]);
  // No place on GUILD is picked yet.
  expect(saveEnabled(form)).toBe(false);
});

it("Add with two bots: a bot field, and the places come from the picked bot's guilds", async () => {
  bots = [bot(BOT), bot(BOT2)];
  guilds = { [BOT]: GUILDS, [BOT2]: [GUILDS[1]] };
  const s = await show();
  const form = await openAdd(s);
  const pick = field(form, "discordRouteBot") as HTMLSelectElement;
  expect(options(pick).sort()).toEqual([BOT, BOT2].sort());
  await change(pick, BOT2);
  expect(
    options(field(form, "discordRouteGuild") as HTMLSelectElement),
  ).toEqual([GUILD2]);
  await change(field(form, "discordRouteGuild"), GUILD2);
  await change(field(form, "discordRouteTarget"), G2_CHAN);
  await s.click("[data-discord-route-form] [data-panel-save]");
  expect((routePosts()[0].body as { botId: string }).botId).toBe(BOT2);
});

it("Add for a bot that is not connected yet, or in no server: no Save; the one in no server offers its invite link", async () => {
  bots = [bot(BOT, { state: "connecting" })];
  const s = await show();
  let form = await openAdd(s);
  expect(saveEnabled(form)).toBe(false);
  expect(form.querySelector("[data-discord-invite]")).toBeNull();
  s.view.unmount();

  bots = [bot(BOT)];
  guilds = { [BOT]: [] };
  const empty = await show();
  form = await openAdd(empty);
  expect(saveEnabled(form)).toBe(false);
  expect(
    form.querySelector(`a[data-discord-invite="${BOT}"]`)?.getAttribute("href"),
  ).toContain(`client_id=${BOT}`);
});

it("a refused add keeps the form open with a line; a full list or a taken place and another failure differ", async () => {
  bots = [bot(BOT)];
  guilds = { [BOT]: GUILDS };
  const s = await show();
  const form = await openAdd(s);
  await change(field(form, "discordRouteGuild"), GUILD);
  await change(field(form, "discordRouteTarget"), SIDE);
  const lineFor = async (status: number, code: string) => {
    routeAnswer = async () => {
      throw new ApiError(status, code, "refused");
    };
    await s.click("[data-discord-route-form] [data-panel-save]");
    expect(s.q("form[data-discord-route-form]")).not.toBeNull();
    return s.q('[role="alert"]')?.textContent ?? null;
  };
  const taken = await lineFor(409, "conflict");
  const other = await lineFor(500, "internal");
  expect(taken).not.toBeNull();
  expect(other).not.toBeNull();
  expect(taken).not.toBe(other);
});

it("Edit opens the form on the route as it is, with its place fixed; Save sends one PATCH with every setting, and false and an empty prefix clear them", async () => {
  bots = [bot(BOT)];
  guilds = { [BOT]: GUILDS };
  routes = [
    route("d_1", {
      name: "General talk",
      trigger: "all",
      replyMode: "bot",
      prefix: "[H]",
      includeBots: true,
      react: true,
    }),
  ];
  const s = await show();
  await s.click('[data-discord-route-edit="d_1"]');
  const form = s.q("form[data-discord-route-form]")!;
  for (const name of [
    "discordRouteBot",
    "discordRouteGuild",
    "discordRouteTarget",
  ])
    expect({ name, el: form.querySelector(`[name="${name}"]`) }).toEqual({
      name,
      el: null,
    });
  expect((field(form, "discordRouteName") as HTMLInputElement).value).toBe(
    "General talk",
  );
  expect((field(form, "discordRoutePrefix") as HTMLInputElement).value).toBe(
    "[H]",
  );
  const box = (name: string) =>
    form.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  expect([
    box("discordRouteIncludeBots").checked,
    box("discordRouteReact").checked,
  ]).toEqual([true, true]);
  expect(checkedReplies(form)).toBe("bot");
  await change(field(form, "discordRoutePrefix"), "");
  await s.click(box("discordRouteIncludeBots"));
  await s.click(box("discordRouteReact"));
  await choose(s, "data-discord-route-trigger", "mention");
  await choose(s, "data-discord-route-replies", "ask");
  await change(field(form, "discordRouteAgent"), "a-std");
  await s.click("[data-discord-route-form] [data-panel-save]");
  expect(writes()).toEqual([
    {
      method: "PATCH",
      path: "/api/discord/routes/d_1",
      body: {
        name: "General talk",
        agentId: "a-std",
        trigger: "mention",
        replyMode: "ask",
        prefix: "",
        includeBots: false,
        react: false,
      },
    },
  ]);
  expect(s.q("form[data-discord-route-form]")).toBeNull();
});

// --- Read-only packs and the held layout ---

it("at environment read, the card shows the bots and routes and no action", async () => {
  const member = asMember("read");
  const record = { ...selfUserRecord(null), ...member.record };
  bots = [bot(BOT), bot(BOT2, { state: "dead", reason: "token_invalid" })];
  guilds = { [BOT]: GUILDS };
  routes = [route("d_1")];
  const s = await show({
    ...member.state,
    users: new Map([[record.name.toLowerCase(), record]]),
  });
  expect(s.all("[data-discord-bot]")).toHaveLength(2);
  expect(s.all("[data-discord-route]")).toHaveLength(1);
  expect(s.all("button")).toHaveLength(0);
  expect(s.q("form")).toBeNull();

  bots = [];
  s.view.unmount();
  const none = await show({
    ...member.state,
    users: new Map([[record.name.toLowerCase(), record]]),
  });
  expect(none.q("form[data-discord-connect-form]")).toBeNull();
  expect(none.all("button")).toHaveLength(0);
});

function gate(): [Promise<void>, () => Promise<void>] {
  let open!: () => void;
  const held = new Promise<void>((resolve) => (open = resolve));
  return [
    held,
    async () => {
      open();
      await settle();
    },
  ];
}

it("a load is remembered with its bot and route counts, and the next load holds that many rows, with nothing to use, until the bots answer", async () => {
  bots = [bot(BOT), bot(BOT2)];
  guilds = { [BOT]: GUILDS, [BOT2]: GUILDS };
  routes = [
    route("d_1"),
    route("d_2", { targetId: SIDE }),
    route("d_3", { targetId: LOOSE }),
  ];
  const first = await show();
  expect(live(section(first), "[data-discord-route]")).toHaveLength(3);
  expect(getDiscordLayout()).toEqual({ bots: 2, rows: 3 });
  first.view.unmount();

  calls = [];
  const [held, release] = gate();
  botsGate = held;
  const s = await show();
  expect(section(s).getAttribute("aria-busy")).toBe("true");
  expect(inHeld(section(s), "[data-discord-bot]")).toBe(2);
  expect(inHeld(section(s), "[data-discord-route]")).toBe(3);
  for (const block of section(s).querySelectorAll("[data-reserved]")) {
    expect(block.getAttribute("aria-hidden")).toBe("true");
    expect(block.hasAttribute("inert")).toBe(true);
  }
  expect(live(section(s), "[data-discord-route]")).toHaveLength(0);
  expect(live(section(s), "button")).toHaveLength(0);
  expect(live(section(s), "input")).toHaveLength(0);

  await release();
  expect(section(s).getAttribute("aria-busy")).toBe("false");
  expect(section(s).querySelectorAll("[data-reserved]")).toHaveLength(0);
  expect(live(section(s), "[data-discord-bot]")).toHaveLength(2);
  expect(live(section(s), "[data-discord-route]")).toHaveLength(3);
});

it("a first visit holds the connect form; a failed read holds nothing and shows its line", async () => {
  const [held, release] = gate();
  botsGate = held;
  const s = await show();
  expect(inHeld(section(s), "[data-discord-connect-form]")).toBe(1);
  expect(live(section(s), "input")).toHaveLength(0);
  await release();
  expect(live(section(s), "form[data-discord-connect-form]")).toHaveLength(1);
  expect(getDiscordLayout()).toEqual({ bots: 0, rows: 0 });
  s.view.unmount();

  setDiscordLayout({ bots: 2, rows: 2 });
  botsFail = true;
  const failed = await show();
  expect(section(failed).querySelectorAll("[data-reserved]")).toHaveLength(0);
  expect(failed.q('[role="alert"]')).not.toBeNull();
  // Not busy: nothing more is coming.
  expect(section(failed).getAttribute("aria-busy")).toBe("false");
});

it("a failed routes read holds no route rows and shows its line; the bots still show", async () => {
  setDiscordLayout({ bots: 1, rows: 3 });
  bots = [bot(BOT)];
  guilds = { [BOT]: GUILDS };
  routesFail = true;
  const s = await show();
  expect(live(section(s), "[data-discord-bot]")).toHaveLength(1);
  expect(section(s).querySelectorAll("[data-reserved]")).toHaveLength(0);
  expect(s.q('[role="alert"]')).not.toBeNull();
  expect(section(s).getAttribute("aria-busy")).toBe("false");
});
