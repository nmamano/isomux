// Step asks, part 6 (task e3d1bc63): the four Integrations steps (a provider
// sign-in, an MCP server sign-in, the browser pairing, a room's GitHub link)
// are done inside the ask card, not on a page the card opens. A control acts
// as the viewer, so a step on the member's own account has no control on
// another member's ask. The way back from an MCP sign-in is in
// ui/App.ask-mcp-sign-in.dom.test.tsx.
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { OfficeLinkOpener } = await import("../office-link.tsx");
const { GITHUB_HOST } = await import("../../shared/github-sync.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;

const NOW = Date.now();
const AUTHORIZE = "https://auth.example.test/authorize?state=s1";
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

// Every call that is not a GET, with its body.
let writes: { method: string; path: string; body: unknown }[] = [];
// The path of each GET.
let reads: string[] = [];
let assign: ReturnType<typeof spyOn<Location, "assign">>;
beforeEach(() => {
  writes = [];
  reads = [];
  assign = spyOn(window.location, "assign").mockImplementation(() => {});
  setApiShim(async (method, path, body) => {
    if (method !== "GET") {
      writes.push({ method, path, body });
      if (path.endsWith("/sign-in")) return { authorizationUrl: AUTHORIZE };
      if (path.endsWith("/github-link"))
        return {
          link: {
            roomId: "r9",
            repo: "acme/app",
            labels: [],
            collaboratorsOnly: false,
            secretName: "GH_TOKEN",
            status: { kind: "ok", reason: "" },
          },
        };
      return {};
    }
    reads.push(path);
    if (path === "/api/me/browser")
      return {
        paired: false,
        online: false,
        member: { name: "Morgan" },
        version: "1.0.0",
        browsers: [],
      };
    if (path === "/api/office/secrets")
      return {
        secrets: [{ name: "GH_TOKEN", hosts: [GITHUB_HOST] }],
      };
    if (path.endsWith("/github-link")) return { link: null };
    return undefined;
  });
});
afterEach(() => assign.mockRestore());
afterAll(() => setApiShim(null));

// Morgan (u1) is the viewer and an office owner; Casey (u2) a member.
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
  member("u2", "Casey", "member"),
];
const ROOMS = [
  { id: "r1", name: "Studio" },
  { id: "r9", name: "Garage" },
] as never[];

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
    dispatch({ type: "users_list", users: MEMBERS });
    dispatch({
      type: "session_context",
      context: {
        userId: "u1",
        username: "Morgan",
        role: "owner",
      } as import("../../shared/types.ts").SessionContext,
    });
    for (const room of ROOMS) dispatch({ type: "room_created", room });
    dispatch({ type: "all_rooms_list", rooms: ROOMS });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

async function mount(entries: AskEntry[]) {
  const view = render(
    // An opener, as App gives one: without it no ask draws its link, and
    // every "no link" check below would pass for want of it.
    <OfficeLinkOpener.Provider value={() => {}}>
      <StoreProvider>
        <Seed entries={entries}>
          <AsksStack agentId="a1" isMobile={false} />
        </Seed>
      </StoreProvider>
    </OfficeLinkOpener.Provider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-ask]").length).toBe(
      entries.length,
    ),
  );
  const card = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
  // An element of the step's control, inside its own card only; null when
  // the card has no such control.
  const inStep = <E extends Element = HTMLElement>(
    id: string,
    kind: string,
    selector: string,
  ) => card(id).querySelector<E>(`[data-ask-step="${kind}"] ${selector}`);
  return { view, card, inStep };
}

// An ask as the server sends it: the step and its Integrations link, which
// older clients still open. `forOther` makes it Casey's ask, which the owner
// sees on the Inbox.
const stepAsk = (
  id: string,
  step: Record<string, unknown>,
  link: string,
  forOther = false,
): AskEntry =>
  ({
    id,
    agentId: "a1",
    memberUserId: forOther ? "u2" : "u1",
    ...(forOther ? { member: "Casey" } : {}),
    prompt: "Please do this step.",
    createdAt: NOW,
    updatedAt: NOW,
    step,
    link,
  }) as AskEntry;

it("draws each of the four steps' controls in the card, with no button to the Integrations page", async () => {
  const { view, card, inStep } = await mount([
    stepAsk(
      "0000aa01",
      { kind: "provider-sign-in", provider: "codex", scope: "office" },
      "/integrations/providers",
    ),
    stepAsk(
      "0000aa02",
      { kind: "mcp-sign-in", name: "mail", scope: "office" },
      "/integrations/mcp",
    ),
    stepAsk("0000aa03", { kind: "browser-pairing" }, "/integrations/browser"),
    stepAsk(
      "0000aa04",
      { kind: "github-link", roomId: "r9" },
      "/integrations/github",
    ),
  ]);
  // The provider of the step, at the scope of the step only.
  const provider = inStep(
    "0000aa01",
    "provider-sign-in",
    "[data-provider-card]",
  );
  expect(provider?.getAttribute("data-provider-card") ?? null).toBe("codex");
  expect(
    [...provider!.querySelectorAll("[data-sign-in-scope]")].map((el) =>
      el.getAttribute("data-sign-in-scope"),
    ),
  ).toEqual(["office"]);
  expect(
    inStep("0000aa02", "mcp-sign-in", "[data-ask-mcp-sign-in]"),
  ).not.toBeNull();
  await waitFor(() =>
    expect(
      inStep("0000aa03", "browser-pairing", '[data-testid="browser-pair"]'),
    ).not.toBeNull(),
  );
  await waitFor(() =>
    expect(
      inStep("0000aa04", "github-link", "[data-github-link-repo]"),
    ).not.toBeNull(),
  );
  for (const id of ["0000aa01", "0000aa02", "0000aa03", "0000aa04"])
    expect(card(id).querySelector("[data-ask-office-link]")).toBeNull();
  view.unmount();
});

it("signs in to an MCP server from the card with the ask's id, for the scope the step names", async () => {
  const { view, inStep } = await mount([
    stepAsk(
      "0000bb01",
      { kind: "mcp-sign-in", name: "mail", scope: "office" },
      "/integrations/mcp",
    ),
    // Casey's server: the owner signs it in for her.
    stepAsk(
      "0000bb02",
      {
        kind: "mcp-sign-in",
        name: "notes",
        scope: "personal",
        ownerUserId: "u2",
      },
      "/integrations/mcp",
      true,
    ),
    // The viewer's own server.
    stepAsk(
      "0000bb03",
      {
        kind: "mcp-sign-in",
        name: "drive",
        scope: "personal",
        ownerUserId: "u1",
      },
      "/integrations/mcp",
    ),
  ]);
  const click = async (id: string) => {
    const button = inStep(id, "mcp-sign-in", "[data-ask-mcp-sign-in]");
    expect(button).not.toBeNull();
    await act(async () => fireEvent.click(button!));
  };
  await click("0000bb01");
  await click("0000bb02");
  await click("0000bb03");
  await waitFor(() => expect(assign).toHaveBeenCalledTimes(3));
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/api/office/mcp-servers/mail/sign-in",
      body: { askId: "0000bb01" },
    },
    {
      method: "POST",
      path: "/api/users/Casey/mcp-servers/notes/sign-in",
      body: { askId: "0000bb02" },
    },
    {
      method: "POST",
      path: "/api/users/Morgan/mcp-servers/drive/sign-in",
      body: { askId: "0000bb03" },
    },
  ]);
  // Same tab: the browser leaves for the authorization server.
  expect(assign).toHaveBeenCalledWith(AUTHORIZE);
  view.unmount();
});

it("links the room the step names, not the asking agent's room", async () => {
  const { view, inStep } = await mount([
    stepAsk(
      "0000cc01",
      { kind: "github-link", roomId: "r9" },
      "/integrations/github",
    ),
  ]);
  let repo: HTMLInputElement | null = null;
  await waitFor(() => {
    repo = inStep<HTMLInputElement>(
      "0000cc01",
      "github-link",
      "[data-github-link-repo]",
    );
    expect(repo).not.toBeNull();
  });
  await act(async () =>
    fireEvent.change(repo!, { target: { value: "acme/app" } }),
  );
  const save = inStep<HTMLButtonElement>(
    "0000cc01",
    "github-link",
    "[data-github-link-save]",
  )!;
  await waitFor(() => expect(save.disabled).toBe(false));
  await act(async () => fireEvent.click(save));
  await waitFor(() => expect(writes.length).toBe(1));
  expect(writes[0]).toMatchObject({
    method: "PUT",
    path: "/api/rooms/r9/github-link",
    body: { repo: "acme/app", secretName: "GH_TOKEN" },
  });
  view.unmount();
});

it("draws no control on another member's ask for a step on that member's own account", async () => {
  const { view, card, inStep } = await mount([
    stepAsk(
      "0000dd01",
      { kind: "provider-sign-in", provider: "claude", scope: "personal" },
      "/integrations/providers",
      true,
    ),
    stepAsk(
      "0000dd02",
      { kind: "browser-pairing" },
      "/integrations/browser",
      true,
    ),
    // The viewer's own: the control is there, so the case above is not
    // empty for want of a mount.
    stepAsk(
      "0000dd03",
      { kind: "provider-sign-in", provider: "claude", scope: "personal" },
      "/integrations/providers",
    ),
  ]);
  expect(
    inStep("0000dd03", "provider-sign-in", '[data-provider-card="claude"]'),
  ).not.toBeNull();
  // Let the browser status read land, as on the viewer's own ask.
  await act(async () => {});
  for (const id of ["0000dd01", "0000dd02"]) {
    expect(card(id).querySelector("[data-provider-card]")).toBeNull();
    expect(card(id).querySelector('[data-testid="browser-pair"]')).toBeNull();
    expect(card(id).querySelector('[data-testid="browser-name"]')).toBeNull();
    expect(card(id).querySelector("[data-ask-office-link]")).toBeNull();
  }
  // Nothing read the viewer's own browser for Casey's pairing.
  expect(reads).not.toContain("/api/me/browser");
  expect(writes).toEqual([]);
  view.unmount();
});

it("keeps the Integrations link of a step the card cannot draw: a later release's kind, a server of a member it does not know", async () => {
  const { view, card } = await mount([
    stepAsk("0000ff01", { kind: "vault-sign-in" }, "/integrations/mcp"),
    stepAsk(
      "0000ff02",
      {
        kind: "mcp-sign-in",
        name: "notes",
        scope: "personal",
        ownerUserId: "u7",
      },
      "/integrations/mcp",
    ),
    // A step the card draws: no link, so the two above are not a link
    // drawn on every step.
    stepAsk(
      "0000ff03",
      { kind: "mcp-sign-in", name: "mail", scope: "office" },
      "/integrations/mcp",
    ),
  ]);
  expect(card("0000ff03").querySelector("[data-ask-step]")).not.toBeNull();
  expect(card("0000ff03").querySelector("[data-ask-office-link]")).toBeNull();
  for (const id of ["0000ff01", "0000ff02"]) {
    expect(card(id).querySelector("[data-ask-step] button")).toBeNull();
    expect(
      card(id)
        .querySelector("[data-ask-office-link]")
        ?.getAttribute("data-ask-office-link") ?? null,
    ).toBe("/integrations/mcp");
  }
  view.unmount();
});
