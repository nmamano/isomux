// A secret request in the asks stack: the masked form in place of the reply
// field, the save and decline routes, and the card leaving once the request
// closed. Mounted through AsksStack, the path every ask list renders.
import { afterAll, beforeEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { expectMasked } from "../test-support/masked.ts";
import { expectPortalLink } from "../test-support/discord-portal.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { takeSignIn } = await import("../integrations/sign-in-return.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { discordInviteUrl } = await import("../../shared/discord.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;
type SecretValueRequest = import("../../shared/types.ts").SecretValueRequest;

const { t } = translatorFor("en");
const FAKE = "fake-requested-value-0000-ui";
const NOW = Date.now();
const SECRET_ASK: AskEntry = {
  id: "aaaa0001",
  agentId: "a 1",
  memberUserId: "u1",
  prompt: "To open the pull request.",
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  secret: {
    requestId: "req-1",
    scope: "personal",
    name: "GH_TOKEN",
    hosts: ["api.github.com"],
    form: { kind: "authorization" },
    reason: "To open the pull request.",
  },
};

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: { path: string; body: unknown }[] = [];
let gets: string[] = [];
let answer: (path: string) => Promise<unknown> = async () => undefined;
// The secrets a scope's list answers with (an MCP server request's
// credential choice): one for the server's host, one for another.
const SCOPE_SECRETS = [
  ["DOCS_TOKEN", "mcp.example.com"],
  ["GH_TOKEN", "api.github.com"],
].map(([name, host]) => ({
  name,
  hosts: [host],
  form: { kind: "authorization" },
  createdAt: 1,
  valueSetAt: 1,
  updatedAt: 1,
  note: null,
  apps: [],
}));
beforeEach(() => {
  // The viewer has a name here, so a fold of the stack is kept per browser.
  localStorage.clear();
  posts = [];
  gets = [];
  answer = async () => ({ name: "GH_TOKEN" });
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push({ path, body });
      return answer(path);
    }
    gets.push(path);
    if (path.endsWith("/secrets")) return { secrets: SCOPE_SECRETS };
    return undefined;
  });
});
afterAll(() => setApiShim(null));

// A request for an app's secret (task 315a62c0): the value goes to the app's
// environment, so it has no hosts.
const APP_ASK: AskEntry = {
  ...SECRET_ASK,
  secret: {
    ...(SECRET_ASK.secret as SecretValueRequest),
    name: "YOUTUBE_CLIENT_SECRET",
    hosts: [],
    app: { name: "game-video", createdAt: 1000 },
    ownerUserId: "u2",
  },
};

// The members the cards name: u1 is the manager, u2 an office owner.
const USERS = [
  { id: "u1", name: "alice", role: "member" },
  { id: "u2", name: "nil", role: "owner" },
].map((u) => ({
  ...u,
  avatarColor: "#336699",
  avatarVariant: 0,
  createdAt: 1,
})) as unknown as import("../../shared/types.ts").UserPublicWire[];

function Seed({
  entry,
  children,
}: {
  entry: AskEntry;
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({ type: "users_list", users: USERS });
    // The viewer is alice, the manager.
    dispatch({
      type: "session_context",
      context: {
        userId: "u1",
        username: "alice",
        role: "member",
      } as import("../../shared/types.ts").SessionContext,
    });
    dispatch({ type: "asks_loaded", entries: [entry], revision: 0 });
  }, [dispatch, entry]);
  return <>{children}</>;
}

async function mount(isMobile = false, entry: AskEntry = SECRET_ASK) {
  const view = render(
    <StoreProvider>
      <Seed entry={entry}>
        <AsksStack agentId="a 1" isMobile={isMobile} />
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  return view;
}

const card = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLElement>('[data-ask="aaaa0001"]');
const valueInput = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLInputElement>("[data-masked-credential]");
const saveButton = (view: ReturnType<typeof render>) =>
  view.getByRole("button", {
    name: t("cards.secretRequest.save"),
  }) as HTMLButtonElement;

it("draws the masked form, not a reply field, and the collapsed bar names the secret", async () => {
  const view = await mount();
  expect(card(view)?.dataset.secretRequest).toBe("req-1");
  expect(card(view)?.textContent).toContain(SECRET_ASK.prompt);
  expectMasked(valueInput(view));
  expect(card(view)?.querySelector("form")).toBeNull();
  view.unmount();
  const phone = await mount(true);
  const bar = phone.container.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  )!;
  expect(bar.textContent).toContain(
    t("cards.secretRequest.title", { name: "GH_TOKEN" }),
  );
  phone.unmount();
});

it("saves the typed value with the edited hosts, then the card goes and the value with it", async () => {
  const view = await mount();
  expect(saveButton(view).disabled).toBe(true);
  fireEvent.change(view.getByLabelText(t("settings.secrets.hosts")), {
    target: { value: "api.github.com\nuploads.github.com" },
  });
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts).toEqual([
    {
      path: "/api/agents/a%201/secret-requests/req-1/save",
      body: { value: FAKE, hosts: ["api.github.com", "uploads.github.com"] },
    },
  ]);
  expect(card(view)).toBeNull();
  expect(view.container.innerHTML).not.toContain(FAKE);
  view.unmount();
});

it("declines with no body, and the card goes", async () => {
  const view = await mount();
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: t("cards.secretRequest.decline") }),
    );
  });
  expect(posts).toEqual([
    {
      path: "/api/agents/a%201/secret-requests/req-1/decline",
      body: undefined,
    },
  ]);
  expect(card(view)).toBeNull();
  view.unmount();
});

it("a refusal keeps the field and names the reason; a closed request takes the card away", async () => {
  answer = async () => {
    throw new ApiError(403, "forbidden", "forbidden");
  };
  const view = await mount();
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(view.getByRole("alert").textContent).toBe(
    t("cards.secretRequest.forbidden"),
  );
  expect(valueInput(view)!.value).toBe(FAKE);

  answer = async () => {
    throw new ApiError(404, "not_found", "Not found");
  };
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(card(view)).toBeNull();
  expect(view.container.innerHTML).not.toContain(FAKE);
  view.unmount();
});

it("a failed decline says the decline failed, not the save, and the card stays", async () => {
  answer = async () => {
    throw new ApiError(500, "request_failed", "request failed");
  };
  const view = await mount();
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: t("cards.secretRequest.decline") }),
    );
  });
  expect(view.getByRole("alert").textContent).toBe(
    t("cards.secretRequest.declineFailed"),
  );
  expect(card(view)).not.toBeNull();
  view.unmount();
});

it("an app request names the app, has no hosts field, and saves the value with no hosts", async () => {
  const view = await mount(false, APP_ASK);
  expect(card(view)?.textContent).toContain("game-video");
  expect(view.queryByLabelText(t("settings.secrets.hosts"))).toBeNull();
  expectMasked(valueInput(view));
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts).toHaveLength(1);
  const { path, body } = posts[0] as {
    path: string;
    body: { value: string; hosts?: string[] };
  };
  expect(path).toBe("/api/agents/a%201/secret-requests/req-1/save");
  expect([body.value, body.hosts ?? []]).toEqual([FAKE, []]);
  expect(card(view)).toBeNull();
  view.unmount();
});

it("an app gone since the request keeps the card and says why, not a bare failure", async () => {
  answer = async () => {
    throw new ApiError(409, "app_gone", "app gone");
  };
  const view = await mount(false, APP_ASK);
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  const alert = view.getByRole("alert").textContent ?? "";
  expect(alert.length).toBeGreaterThan(0);
  expect(alert).not.toBe(t("settings.secrets.saveFailed"));
  expect(card(view)).not.toBeNull();
  view.unmount();
});

// The reason is the agent's prompt: a web URL in it opens in a new tab, as in
// any ask, and an unsafe link stays text. The reason keeps its own words
// under page translation; the card's own copy does not.
const translated = (element: Element) =>
  element.closest("[translate]")?.getAttribute("translate") !== "no";

it("a URL in the reason is a link that opens in a new tab; a javascript: link is not", async () => {
  const url = "https://github.com/settings/tokens";
  const linked = `Make one at ${url} with repo scope.`;
  const view = await mount(false, {
    ...SECRET_ASK,
    prompt: linked,
    secret: { ...SECRET_ASK.secret!, reason: linked },
  });
  expect(card(view)?.textContent).toContain(linked);
  const links = [...card(view)!.querySelectorAll("a")];
  expect(
    links.map((a) => ({
      href: a.getAttribute("href"),
      target: a.target,
      noopener: a.rel.split(" ").includes("noopener"),
      translated: translated(a),
    })),
  ).toEqual([
    { href: url, target: "_blank", noopener: true, translated: false },
  ]);
  const scopeHint = [...card(view)!.querySelectorAll("p")].find((p) =>
    p.textContent?.includes(t("cards.secretRequest.personal")),
  );
  expect(scopeHint && translated(scopeHint)).toBe(true);
  view.unmount();

  const unsafe = "Run [this](javascript:alert(1)) first.";
  const bad = await mount(false, {
    ...SECRET_ASK,
    prompt: unsafe,
    secret: { ...SECRET_ASK.secret!, reason: unsafe },
  });
  expect(card(bad)?.querySelectorAll("a").length).toBe(0);
  expect(card(bad)?.textContent).toContain("javascript:alert(1)");
  bad.unmount();
});

// Value requests for the other Integrations settings (task c71cb60f): a
// variable and an MCP server, on the same card, routes and rules.
const VARIABLE_ASK = (name: string): AskEntry => ({
  ...SECRET_ASK,
  secret: {
    requestId: "req-1",
    kind: "variable",
    scope: "personal",
    name,
    hosts: [],
    form: { kind: "authorization" },
    reason: "OpenCode needs it.",
    ownerUserId: "u1",
  },
});
const MCP_URL = "https://mcp.example.com/mcp";
const MCP_ASK = (scope: "personal" | "office"): AskEntry => ({
  ...SECRET_ASK,
  ...(scope === "office" ? { memberUserId: undefined } : {}),
  secret: {
    requestId: "req-1",
    kind: "mcp-server",
    scope,
    name: "docs",
    url: MCP_URL,
    hosts: [],
    form: { kind: "authorization" },
    reason: "To read the docs server.",
    ...(scope === "personal" ? { ownerUserId: "u1" } : {}),
  },
});
const inputs = (view: ReturnType<typeof render>) => [
  ...card(view)!.querySelectorAll<HTMLInputElement>("input"),
];

it("a variable request for a model key: one masked value field, no hosts, and the save sends the value alone", async () => {
  const view = await mount(false, VARIABLE_ASK("OPENAI_API_KEY"));
  expect(card(view)?.textContent).toContain("OPENAI_API_KEY");
  expect(view.queryByLabelText(t("settings.secrets.hosts"))).toBeNull();
  expect(inputs(view)).toHaveLength(1);
  expectMasked(valueInput(view));
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts).toEqual([
    {
      path: "/api/agents/a%201/secret-requests/req-1/save",
      body: { value: FAKE },
    },
  ]);
  expect(card(view)).toBeNull();
  expect(view.container.innerHTML).not.toContain(FAKE);
  view.unmount();
});

it("a variable request for a plain setting: a plain value field", async () => {
  const view = await mount(false, VARIABLE_ASK("TZ"));
  expect(card(view)?.querySelector("[data-masked-credential]")).toBeNull();
  const [field] = inputs(view);
  expect(inputs(view)).toHaveLength(1);
  expect(field.type).toBe("text");
  expect(saveButton(view).disabled).toBe(true);
  fireEvent.change(field, { target: { value: "Europe/Madrid" } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts.map((p) => p.body)).toEqual([{ value: "Europe/Madrid" }]);
  view.unmount();
});

// The sign-in choice, as the Integrations form draws it.
const authChoice = (view: ReturnType<typeof render>, value: string) =>
  card(view)!.querySelector<HTMLElement>(`[data-choice="${value}"]`);
const checkedAuth = (view: ReturnType<typeof render>) =>
  [...card(view)!.querySelectorAll<HTMLElement>("[data-choice]")]
    .filter((b) => b.getAttribute("aria-checked") === "true")
    .map((b) => b.dataset.choice);
const secretOptions = (view: ReturnType<typeof render>) =>
  [...card(view)!.querySelector("select")!.options]
    .map((o) => o.value)
    .filter((v) => v !== "")
    .sort();

it("an MCP server request with no proposal starts at None, with no secret list; a saved secret is a choice, listed by the URL's host, and the save sends it", async () => {
  const view = await mount(false, MCP_ASK("personal"));
  expect(card(view)?.textContent).toContain("docs");
  // The owner's secrets, by their username.
  await waitFor(() => expect(gets).toContain("/api/users/alice/secrets"));
  const url = inputs(view).find((i) => i.value === MCP_URL);
  expect(url).toBeDefined();
  expect(checkedAuth(view)).toEqual(["none"]);
  expect(card(view)!.querySelector("select")).toBeNull();
  await waitFor(() => expect(authChoice(view, "saved")).not.toBeNull());
  await act(async () => {
    fireEvent.click(authChoice(view, "saved")!);
  });
  // GH_TOKEN goes to another host.
  expect(secretOptions(view)).toEqual(["DOCS_TOKEN"]);
  fireEvent.change(url!, { target: { value: `${MCP_URL}/v2` } });
  fireEvent.change(card(view)!.querySelector("select")!, {
    target: { value: "DOCS_TOKEN" },
  });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts).toEqual([
    {
      path: "/api/agents/a%201/secret-requests/req-1/save",
      body: { url: `${MCP_URL}/v2`, secret: "DOCS_TOKEN" },
    },
  ]);
  expect(card(view)).toBeNull();
  view.unmount();
});

it("a proposed secret starts picked and stays a choice when its hosts miss; the list follows the URL as it is edited", async () => {
  const entry = MCP_ASK("personal");
  const view = await mount(false, {
    ...entry,
    secret: { ...entry.secret!, secret: "GH_TOKEN" },
  } as AskEntry);
  await waitFor(() =>
    expect(secretOptions(view)).toEqual(["DOCS_TOKEN", "GH_TOKEN"]),
  );
  expect(checkedAuth(view)).toEqual(["saved"]);
  expect(card(view)!.querySelector("select")!.value).toBe("GH_TOKEN");
  const url = inputs(view).find((i) => i.value === MCP_URL)!;
  fireEvent.change(url, { target: { value: "https://other.example.com/mcp" } });
  expect(secretOptions(view)).toEqual(["GH_TOKEN"]);
  view.unmount();
  // No proposal and no secret for the host: no saved-secret choice.
  const other = await mount(false, {
    ...entry,
    secret: { ...entry.secret!, url: "https://other.example.com/mcp" },
  } as AskEntry);
  await waitFor(() => expect(gets).toContain("/api/users/alice/secrets"));
  await act(async () => {});
  expect(authChoice(other, "saved")).toBeNull();
  expect(checkedAuth(other)).toEqual(["none"]);
  other.unmount();
});

const OAUTH_ASK = (scope: "personal" | "office"): AskEntry => {
  const entry = MCP_ASK(scope);
  return { ...entry, secret: { ...entry.secret!, oauth: true } } as AskEntry;
};
const AUTHORIZE = "https://auth.example.com/authorize";
const signInAnswers = () => {
  answer = async (path) =>
    path.endsWith("/sign-in")
      ? { authorizationUrl: AUTHORIZE }
      : { name: "docs" };
};
const saveAndSignIn = (view: ReturnType<typeof render>) =>
  view.getByRole("button", { name: t("integrations.mcp.saveAndSignIn") });

it("an OAuth request starts at OAuth with no secret list; the save makes an OAuth server, then the browser goes to sign in, though the card is gone", async () => {
  // The sign-in start answers only once the card is gone.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  answer = async (path) => {
    if (!path.endsWith("/sign-in")) return { name: "docs" };
    await held;
    return { authorizationUrl: AUTHORIZE };
  };
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    const view = await mount(false, OAUTH_ASK("personal"));
    expect(checkedAuth(view)).toEqual(["oauth"]);
    expect(card(view)!.querySelector("select")).toBeNull();
    await act(async () => {
      fireEvent.click(saveAndSignIn(view));
    });
    // The save closed the ask: the card is gone while the start is pending.
    await waitFor(() => expect(card(view)).toBeNull());
    expect(posts.map((p) => p.path)).toEqual([
      "/api/agents/a%201/secret-requests/req-1/save",
      "/api/users/alice/mcp-servers/docs/sign-in",
    ]);
    expect(posts[0].body).toEqual({ url: MCP_URL, secret: null, oauth: true });
    expect(assign).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE));
    // The way back names the server and its owner.
    expect(takeSignIn()).toEqual({
      server: "docs",
      target: { kind: "self", username: "alice" },
    });
    view.unmount();
  } finally {
    assign.mockRestore();
  }
});

it("an office OAuth request signs in to the office server", async () => {
  signInAnswers();
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    const view = await mount(false, OAUTH_ASK("office"));
    await act(async () => {
      fireEvent.click(saveAndSignIn(view));
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE));
    expect(posts.map((p) => p.path)).toEqual([
      "/api/agents/a%201/secret-requests/req-1/save",
      "/api/office/mcp-servers/docs/sign-in",
    ]);
    expect(takeSignIn()).toEqual({
      server: "docs",
      target: { kind: "office" },
    });
    view.unmount();
  } finally {
    assign.mockRestore();
  }
});

it("the request's OAuth is only the starting choice: with None the save makes a plain server and no sign-in starts", async () => {
  signInAnswers();
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    const view = await mount(false, OAUTH_ASK("personal"));
    await act(async () => {
      fireEvent.click(authChoice(view, "none")!);
    });
    expect(checkedAuth(view)).toEqual(["none"]);
    await act(async () => {
      fireEvent.click(saveButton(view));
    });
    expect(posts).toEqual([
      {
        path: "/api/agents/a%201/secret-requests/req-1/save",
        body: { url: MCP_URL, secret: null },
      },
    ]);
    expect(assign).not.toHaveBeenCalled();
    expect(takeSignIn()).toBeNull();
    view.unmount();
  } finally {
    assign.mockRestore();
  }
});

it("an office MCP server request lists the office secrets, and None saves no secret", async () => {
  const view = await mount(false, MCP_ASK("office"));
  await waitFor(() => expect(gets).toContain("/api/office/secrets"));
  expect(gets.some((g) => g.startsWith("/api/users/"))).toBe(false);
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts.map((p) => p.body)).toEqual([{ url: MCP_URL, secret: null }]);
  view.unmount();
});

it("an MCP server refusal keeps the card and says why, not a bare failure", async () => {
  answer = async () => {
    throw new ApiError(422, "secret_host_mismatch", "host mismatch");
  };
  const view = await mount(false, MCP_ASK("personal"));
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  const alert = view.getByRole("alert").textContent ?? "";
  expect(alert.length).toBeGreaterThan(0);
  expect(alert).not.toBe(t("settings.secrets.saveFailed"));
  expect(alert).not.toBe(t("settings.mcpServers.saveFailed"));
  expect(card(view)).not.toBeNull();
  view.unmount();
});

// A kind from a later release (after a rollback): nothing to fill in here,
// so the card offers the decline alone.
it("a request of a kind this release does not know: no form and no save, the name, and a decline", async () => {
  const later = VARIABLE_ASK("FUTURE_SETTING");
  const entry = {
    ...later,
    secret: { ...later.secret, kind: "later-kind" },
  } as unknown as AskEntry;
  const view = await mount(false, entry);
  expect(card(view)?.textContent).toContain("FUTURE_SETTING");
  expect(card(view)!.querySelectorAll("input, textarea, select").length).toBe(
    0,
  );
  expect(
    view.queryByRole("button", { name: t("cards.secretRequest.save") }),
  ).toBeNull();
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: t("cards.secretRequest.decline") }),
    );
  });
  expect(posts).toEqual([
    {
      path: "/api/agents/a%201/secret-requests/req-1/decline",
      body: undefined,
    },
  ]);
  expect(card(view)).toBeNull();
  view.unmount();
});

// A Discord bot request (task c92d60f4): the member types the bot token,
// and the save connects the bot. One masked field; the save sends the token
// alone; a connect Discord refused keeps the card and says why.
const DISCORD_ASK: AskEntry = {
  ...SECRET_ASK,
  prompt: "To answer on your Discord server.",
  secret: {
    requestId: "req-1",
    kind: "discord-bot",
    scope: "personal",
    name: "Discord bot",
    hosts: [],
    form: { kind: "authorization" },
    reason: "To answer on your Discord server.",
    ownerUserId: "u1",
  },
};

it("a Discord bot request: one masked token field, no hosts, and the save sends the token alone", async () => {
  answer = async () => ({ name: "Discord bot" });
  const view = await mount(false, DISCORD_ASK);
  expect(view.queryByLabelText(t("settings.secrets.hosts"))).toBeNull();
  expect(card(view)!.querySelectorAll("input, textarea, select").length).toBe(
    1,
  );
  expectMasked(valueInput(view));
  expect(saveButton(view).disabled).toBe(true);
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts).toEqual([
    {
      path: "/api/agents/a%201/secret-requests/req-1/save",
      body: { value: FAKE },
    },
  ]);
  expect(card(view)).toBeNull();
  expect(view.container.innerHTML).not.toContain(FAKE);
  view.unmount();
});

it("a Discord bot request's steps hint links the Discord Developer Portal, in a new tab", async () => {
  const view = await mount(false, DISCORD_ASK);
  expectPortalLink(card(view)!);
  view.unmount();
});

// The agent made the application in the member's browser (task f242899f):
// the card links that application's Bot page, where the member resets and
// copies the token, and its invite, above Save. Protocol values: Discord's
// URLs for the application.
const APP_ID = "1100000000000000002";
const BOT_PAGE = `https://discord.com/developers/applications/${APP_ID}/bot`;
const anchors = (root: Element, href: string) =>
  [...root.querySelectorAll("a")].filter(
    (a) => a.getAttribute("href") === href,
  );
const newTab = (a: Element) => ({
  target: a.getAttribute("target"),
  noreferrer: (a.getAttribute("rel") ?? "").split(/\s+/).includes("noreferrer"),
  text: (a.textContent ?? "").trim().length > 0,
});

it("a Discord bot request with the agent's application links its Bot page and its invite above Save, in new tabs, without the create steps; the save sends the token alone", async () => {
  answer = async () => ({ name: "Discord bot" });
  const view = await mount(false, {
    ...DISCORD_ASK,
    secret: { ...DISCORD_ASK.secret!, applicationId: APP_ID } as NonNullable<
      AskEntry["secret"]
    >,
  });
  const root = card(view)!;
  const botPage = anchors(root, BOT_PAGE);
  const invite = anchors(root, discordInviteUrl(APP_ID));
  expect({
    botPage: botPage.map(newTab),
    invite: invite.map(newTab),
    portal: anchors(root, "https://discord.com/developers/applications").length,
  }).toEqual({
    botPage: [{ target: "_blank", noreferrer: true, text: true }],
    invite: [{ target: "_blank", noreferrer: true, text: true }],
    portal: 0,
  });
  // The invite comes before Save: the member can add the bot first.
  expect(
    invite[0].compareDocumentPosition(saveButton(view)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expectMasked(valueInput(view));
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts).toEqual([
    {
      path: "/api/agents/a%201/secret-requests/req-1/save",
      body: { value: FAKE },
    },
  ]);
  view.unmount();
});

it("a Discord bot request without an application keeps the create steps, with no Bot page and no invite", async () => {
  const view = await mount(false, DISCORD_ASK);
  const root = card(view)!;
  expectPortalLink(root);
  expect(
    [...root.querySelectorAll("a")].filter((a) =>
      /\/oauth2\/authorize|\/developers\/applications\/\d/.test(
        a.getAttribute("href") ?? "",
      ),
    ).length,
  ).toBe(0);
  view.unmount();
});

it("a Discord connect refused keeps the card and the token, and says why: each refusal its own reason, none the bare failure", async () => {
  const shown: string[] = [];
  for (const [status, code] of [
    [400, "token_refused"],
    [400, "not_a_bot"],
    [400, "check_failed"],
    [409, "bot_taken"],
  ] as const) {
    answer = async () => {
      throw new ApiError(status, code, "refused");
    };
    const view = await mount(false, DISCORD_ASK);
    expectMasked(valueInput(view));
    fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
    await act(async () => {
      fireEvent.click(saveButton(view));
    });
    const alert = view.getByRole("alert").textContent ?? "";
    expect({ code, empty: alert.length === 0 }).toEqual({ code, empty: false });
    expect(alert).not.toBe(t("settings.secrets.saveFailed"));
    expect(card(view)).not.toBeNull();
    expect(valueInput(view)!.value).toBe(FAKE);
    shown.push(alert);
    view.unmount();
  }
  expect(new Set(shown).size).toBe(shown.length);
});

// The page where the member gets the value (task 0355f4b7): a new-tab link
// under the reason, above the masked field, naming the page's site. A stored
// link this UI refuses draws nothing.
it("draws the request's outside page as a new-tab link above the masked field, and nothing for a link it refuses", async () => {
  const withLink = (link: string): AskEntry => ({
    ...SECRET_ASK,
    secret: { ...(SECRET_ASK.secret as SecretValueRequest), link },
  });
  const view = await mount(
    false,
    withLink("https://GitHub.com/settings/tokens/new?scopes=repo"),
  );
  const anchors = card(view)!.querySelectorAll<HTMLElement>(
    "[data-ask-outside-link]",
  );
  expect(anchors).toHaveLength(1);
  const a = anchors[0];
  expect({
    tag: a.tagName,
    href: a.getAttribute("href"),
    target: a.getAttribute("target"),
    rel: (a.getAttribute("rel") ?? "").split(/\s+/).sort(),
    namesSite: (a.textContent ?? "").includes("github.com"),
    // DOCUMENT_POSITION_FOLLOWING: the field comes after the link.
    aboveField: Boolean(a.compareDocumentPosition(valueInput(view)!) & 4),
  }).toEqual({
    tag: "A",
    href: "https://github.com/settings/tokens/new?scopes=repo",
    target: "_blank",
    rel: ["noopener", "noreferrer"],
    namesSite: true,
    aboveField: true,
  });
  view.unmount();

  for (const entry of [SECRET_ASK, withLink("javascript:alert(1)")]) {
    const other = await mount(false, entry);
    expectMasked(valueInput(other));
    expect(
      card(other)!.querySelectorAll("[data-ask-outside-link]"),
    ).toHaveLength(0);
    expect(card(other)!.innerHTML).not.toContain("javascript:");
    other.unmount();
  }
});
