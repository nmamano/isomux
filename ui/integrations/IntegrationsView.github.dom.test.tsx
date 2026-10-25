// A room's GitHub link moved from Room settings to an Integrations tab (task
// 7ac5ba2e, Nil at the sign-off of 7fc83592). The tab is for office owners
// only: a Room select picks the room, and the form below it shows that room's
// saved link and status, Save sends the link PUT and Unlink the DELETE. The
// token secret is picked from the office secrets allowed for api.github.com
// (task edcc3e34, Nil at the sign-off of 7ac5ba2e). The server rules:
// server/test-support/routes-github-sync-rest.test.ts.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake, secret } =
  await import("../test-support/integrations-fake.ts");
const { notifyConnectionsChanged } = await import("../connections-events.ts");
const { MEMBER, OWNER, open, selectedTab } =
  await import("../test-support/integrations-page-fixture.ts");
const { RoomPane } = await import("../components/RoomPane.tsx");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { LOBBY_ROOM } = await import("../../shared/types.ts");
type RoomWire = import("../../shared/types.ts").RoomWire;
type GithubLinkWire = import("../../shared/types.ts").GithubLinkWire;
afterAll(() => setApiShim(null));

const TAB_KEY = "isomux-integrations-tab";

const room = (id: string, name: string): RoomWire => ({
  id,
  name,
  type: "office",
  prompt: null,
  canCloseWhenEmpty: true,
});
const ROOMS = [LOBBY_ROOM, room("r1", "Alpha"), room("r2", "Beta")];

const saved = (roomId: string, repo: string): GithubLinkWire => ({
  id: `link-${roomId}`,
  roomId,
  repo,
  labels: ["isomux", "ready"],
  collaboratorsOnly: false,
  secretName: "GITHUB_SYNC_TOKEN",
  createdByUserId: "u1",
  createdAt: 1,
  status: { kind: "paused", reason: "missing" },
});

// The saved links, by room id; a room with none answers { link: null }.
let links: Record<string, GithubLinkWire> = {};
let fake: InstanceType<typeof IntegrationsFake>;
const LINK_PATH = /^\/api\/rooms\/([^/]+)\/github-link$/;

function install(owner: boolean) {
  fake = new IntegrationsFake(
    { username: owner ? "Ricky" : "Stephen", owner },
    ["Ricky", "Stephen"],
  ).install();
  // The fake records every call; the link routes answer from `links`.
  setApiShim(async (method, path, body) => {
    const match = LINK_PATH.exec(path);
    if (!match) return fake.handle(method, path, body);
    fake.calls.push({ method, path, body });
    const roomId = match[1];
    if (method === "GET") return { link: links[roomId] ?? null };
    if (method === "PUT")
      return { link: { ...saved(roomId, ""), ...(body as object) } };
    return undefined;
  });
}

// The host the sync checks a secret's hosts for, exactly.
const GITHUB = "api.github.com";
const officeSecrets = (...list: ReturnType<typeof secret>[]) => {
  fake.scope("office").secrets = list;
};

beforeEach(() => {
  links = {};
  install(true);
  officeSecrets(secret("GITHUB_SYNC_TOKEN", { hosts: [GITHUB] }));
});

const withRooms = (state: typeof OWNER, rooms: RoomWire[] = ROOMS) => ({
  ...state,
  rooms,
  allRooms: rooms,
});

type View = Awaited<ReturnType<typeof open>>;
const rows = (view: View) =>
  [...view.container.querySelectorAll("[data-integrations-tab]")].map((el) =>
    el.getAttribute("data-integrations-tab"),
  );
const linkCalls = (method?: string) =>
  fake.calls.filter(
    (c) => LINK_PATH.test(c.path) && (!method || c.method === method),
  );

function q<T extends Element>(view: View, selector: string): T {
  const el = view.container.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

const roomSelect = (view: View) =>
  q<HTMLSelectElement>(view, "select[data-github-link-room]");
const secretSelect = (view: View) =>
  q<HTMLSelectElement>(view, "select[data-github-link-secret]");
// The secrets the select offers, without the "pick one" placeholder.
const secretChoices = (view: View) =>
  [...secretSelect(view).options]
    .map((o) => o.value)
    .filter(Boolean)
    .sort();
const saveBtn = (view: View) =>
  q<HTMLButtonElement>(view, "[data-github-link-save]");

async function change(view: View, selector: string, value: string) {
  await act(async () => {
    fireEvent.change(q(view, selector), { target: { value } });
  });
}

async function pickRoom(view: View, roomId: string) {
  await act(async () => {
    fireEvent.change(roomSelect(view), { target: { value: roomId } });
  });
  await act(async () => {});
}

it("an owner has a GitHub tab; a member has none, and a remembered or requested one falls back without asking for a link", async () => {
  const owner = await open(withRooms(OWNER));
  expect(rows(owner)).toContain("github");
  // The viewer's own tabs stay last.
  expect(rows(owner).slice(-2)).toEqual(["pager", "api-tokens"]);
  owner.unmount();

  install(false);
  window.localStorage.setItem(TAB_KEY, "github");
  const remembered = await open(withRooms(MEMBER));
  expect(rows(remembered)).not.toContain("github");
  expect(selectedTab(remembered)).toBe("providers");
  remembered.unmount();

  const requested = await open(withRooms(MEMBER), {
    request: { tab: "github" },
  });
  expect(selectedTab(requested)).toBe("providers");
  expect(requested.container.querySelector("[data-github-link]")).toBeNull();
  expect(linkCalls()).toEqual([]);
});

it("lists the rooms without the lobby, names each linked repo, and opens on the first linked room", async () => {
  links = { r2: saved("r2", "Acme/Widgets") };
  const view = await open(withRooms(OWNER), { request: { tab: "github" } });
  expect(selectedTab(view)).toBe("github");

  const options = [...roomSelect(view).options];
  expect(options.map((o) => o.value)).toEqual(["r1", "r2"]);
  expect(options[0].textContent).toContain("Alpha");
  expect(options[0].textContent).not.toContain("Acme/Widgets");
  expect(options[1].textContent).toContain("Beta");
  expect(options[1].textContent).toContain("Acme/Widgets");

  // Beta is the first room with a link, so the form shows Beta's.
  expect(roomSelect(view).value).toBe("r2");
  expect(q<HTMLInputElement>(view, "[data-github-link-repo]").value).toBe(
    "Acme/Widgets",
  );
  expect(
    q<HTMLInputElement>(view, "[data-github-link-labels]")
      .value.split(",")
      .map((l) => l.trim()),
  ).toEqual(["isomux", "ready"]);
  expect(secretSelect(view).value).toBe("GITHUB_SYNC_TOKEN");
  const status = q<HTMLElement>(view, "[data-github-link-status]");
  expect(status.getAttribute("data-kind")).toBe("paused");
  expect((status.textContent ?? "").trim().length).toBeGreaterThan(0);
  // Never a request for the lobby.
  expect(linkCalls().some((c) => c.path.includes(LOBBY_ROOM.id))).toBe(false);
});

it("with no linked room, opens on the first room with an empty form", async () => {
  const view = await open(withRooms(OWNER), { request: { tab: "github" } });
  expect(roomSelect(view).value).toBe("r1");
  expect(q<HTMLInputElement>(view, "[data-github-link-repo]").value).toBe("");
  expect(secretSelect(view).value).toBe("GITHUB_SYNC_TOKEN");
  expect(view.container.querySelector("[data-github-link-unlink]")).toBeNull();
});

it("the picked room's form saves and unlinks that room's link", async () => {
  links = { r2: saved("r2", "Acme/Widgets") };
  const view = await open(withRooms(OWNER), { request: { tab: "github" } });

  // Alpha has no link: its form is empty, whatever Beta's held.
  await pickRoom(view, "r1");
  const repo = q<HTMLInputElement>(view, "[data-github-link-repo]");
  expect(repo.value).toBe("");
  expect(view.container.querySelector("[data-github-link-unlink]")).toBeNull();
  await act(async () => {
    fireEvent.change(repo, { target: { value: " acme/gadgets " } });
    fireEvent.change(q(view, "[data-github-link-labels]"), {
      target: { value: "a, b ,, " },
    });
    fireEvent.click(q(view, "[data-github-link-collaborators]"));
  });
  await act(async () => fireEvent.click(q(view, "[data-github-link-save]")));
  expect(linkCalls("PUT").map((c) => [c.path, c.body])).toEqual([
    [
      "/api/rooms/r1/github-link",
      {
        repo: "acme/gadgets",
        labels: ["a", "b"],
        collaboratorsOnly: true,
        secretName: "GITHUB_SYNC_TOKEN",
      },
    ],
  ]);

  await pickRoom(view, "r2");
  expect(q<HTMLInputElement>(view, "[data-github-link-repo]").value).toBe(
    "Acme/Widgets",
  );
  await act(async () => fireEvent.click(q(view, "[data-github-link-unlink]")));
  expect(linkCalls("DELETE").map((c) => c.path)).toEqual([
    "/api/rooms/r2/github-link",
  ]);
});

it("a missing secret's status links to the Secrets tab", async () => {
  links = { r1: saved("r1", "Acme/Widgets") };
  const view = await open(withRooms(OWNER), { request: { tab: "github" } });
  const status = q<HTMLElement>(view, "[data-github-link-status]");
  expect(status.getAttribute("data-kind")).toBe("paused");
  await act(async () => fireEvent.click(q(view, "[data-go-secrets]")));
  expect(selectedTab(view)).toBe("secrets");
  expect(view.container.querySelector("[data-github-link]")).toBeNull();
});

it("the secret select offers exactly the office secrets allowed for api.github.com, and Link saves the picked one", async () => {
  officeSecrets(
    secret("GITHUB_SYNC_TOKEN", { hosts: [GITHUB] }),
    secret("ORG_READER", { hosts: ["uploads.github.com", GITHUB] }),
    // The sync matches the host exactly: github.com is another host.
    secret("WEB_LOGIN", { hosts: ["github.com"] }),
    secret("STRIPE_KEY", { hosts: ["api.stripe.com"] }),
  );
  const view = await open(withRooms(OWNER), { request: { tab: "github" } });
  expect(fake.requests("GET", "/api/office/secrets").length).toBeGreaterThan(0);
  expect(secretChoices(view)).toEqual(["GITHUB_SYNC_TOKEN", "ORG_READER"]);
  expect(secretSelect(view).value).toBe("GITHUB_SYNC_TOKEN");

  await change(view, "[data-github-link-repo]", "acme/gadgets");
  await change(view, "[data-github-link-secret]", "ORG_READER");
  await act(async () => fireEvent.click(saveBtn(view)));
  expect(
    linkCalls("PUT").map((c) => (c.body as { secretName: string }).secretName),
  ).toEqual(["ORG_READER"]);
});

it("a saved link keeps its secret as the pick when the office no longer offers it", async () => {
  links = { r1: { ...saved("r1", "Acme/Widgets"), secretName: "OLD_TOKEN" } };
  const view = await open(withRooms(OWNER), { request: { tab: "github" } });
  expect(secretChoices(view)).toEqual(["GITHUB_SYNC_TOKEN", "OLD_TOKEN"]);
  expect(secretSelect(view).value).toBe("OLD_TOKEN");
  await act(async () => fireEvent.click(saveBtn(view)));
  expect(
    linkCalls("PUT").map((c) => (c.body as { secretName: string }).secretName),
  ).toEqual(["OLD_TOKEN"]);
});

it("a new link picks the only allowed secret, and with several and no GITHUB_SYNC_TOKEN waits for a pick", async () => {
  officeSecrets(secret("ORG_READER", { hosts: [GITHUB] }));
  const one = await open(withRooms(OWNER), { request: { tab: "github" } });
  expect(secretChoices(one)).toEqual(["ORG_READER"]);
  expect(secretSelect(one).value).toBe("ORG_READER");
  await change(one, "[data-github-link-repo]", "acme/gadgets");
  expect(saveBtn(one).disabled).toBe(false);
  one.unmount();

  officeSecrets(
    secret("ORG_READER", { hosts: [GITHUB] }),
    secret("BOT_READER", { hosts: [GITHUB] }),
  );
  const several = await open(withRooms(OWNER), { request: { tab: "github" } });
  expect(secretChoices(several)).toEqual(["BOT_READER", "ORG_READER"]);
  expect(secretSelect(several).value).toBe("");
  // A repo alone is not enough: the secret is still unpicked.
  await change(several, "[data-github-link-repo]", "acme/gadgets");
  expect(saveBtn(several).disabled).toBe(true);
  await act(async () => fireEvent.click(saveBtn(several)));
  expect(linkCalls("PUT")).toEqual([]);

  await change(several, "[data-github-link-secret]", "BOT_READER");
  expect(saveBtn(several).disabled).toBe(false);
  await act(async () => fireEvent.click(saveBtn(several)));
  expect(
    linkCalls("PUT").map((c) => (c.body as { secretName: string }).secretName),
  ).toEqual(["BOT_READER"]);
});

it("with no secret allowed for api.github.com, a line links to the Secrets tab and Link stays disabled", async () => {
  officeSecrets(secret("WEB_LOGIN", { hosts: ["github.com"] }));
  const view = await open(withRooms(OWNER), { request: { tab: "github" } });
  expect(view.container.querySelector("[data-github-link-secret]")).toBeNull();
  const none = q<HTMLElement>(view, "[data-github-link-no-secret]");
  expect((none.textContent ?? "").trim().length).toBeGreaterThan(0);

  await change(view, "[data-github-link-repo]", "acme/gadgets");
  expect(saveBtn(view).disabled).toBe(true);
  await act(async () => fireEvent.click(saveBtn(view)));
  expect(linkCalls("PUT")).toEqual([]);

  await act(async () =>
    fireEvent.click(q(view, "[data-github-link-no-secret] [data-go-secrets]")),
  );
  expect(selectedTab(view)).toBe("secrets");
});

it("a secret added or removed elsewhere changes the choices, and Link saves the secret the select shows", async () => {
  officeSecrets();
  const view = await open(withRooms(OWNER), { request: { tab: "github" } });
  q(view, "[data-github-link-no-secret]");
  await change(view, "[data-github-link-repo]", "acme/gadgets");

  // Added on the Secrets tab or by an agent: the select replaces the line.
  officeSecrets(
    secret("ORG_READER", { hosts: [GITHUB] }),
    secret("BOT_READER", { hosts: [GITHUB] }),
  );
  await act(async () => notifyConnectionsChanged());
  await act(async () => {});
  expect(view.container.querySelector("[data-github-link-no-secret]")).toBe(
    null,
  );
  expect(secretChoices(view)).toEqual(["BOT_READER", "ORG_READER"]);
  // The form keeps what was typed.
  expect(q<HTMLInputElement>(view, "[data-github-link-repo]").value).toBe(
    "acme/gadgets",
  );

  // The picked secret goes away: the save never sends a name the select
  // does not show.
  await change(view, "[data-github-link-secret]", "ORG_READER");
  officeSecrets(secret("BOT_READER", { hosts: [GITHUB] }));
  await act(async () => notifyConnectionsChanged());
  await act(async () => {});
  const shown = secretSelect(view).value;
  expect(shown).not.toBe("");
  await act(async () => fireEvent.click(saveBtn(view)));
  expect(
    linkCalls("PUT").map((c) => (c.body as { secretName: string }).secretName),
  ).toEqual([shown]);
});

it("an owner with no room besides the lobby gets a line instead of a select", async () => {
  const view = await open(withRooms(OWNER, [LOBBY_ROOM]), {
    request: { tab: "github" },
  });
  expect(selectedTab(view)).toBe("github");
  expect(view.container.querySelector("[data-github-link-room]")).toBeNull();
  expect(view.container.querySelector("[data-github-link]")).toBeNull();
  const empty = q<HTMLElement>(view, "[data-github-link-empty]");
  expect((empty.textContent ?? "").trim().length).toBeGreaterThan(0);
  expect(linkCalls()).toEqual([]);
});

it("Room settings no longer carry the link, for an owner", async () => {
  const base = stateWithSelfUser(null);
  const view = render(
    onLanguage(
      null,
      createElement(RoomPane, { roomId: "r1", onDeleted() {} }),
      {
        rooms: [room("r1", "Alpha")],
        sessionContext: { ...base.sessionContext!, role: "owner" },
      },
    ),
  );
  await act(async () => {});
  // The pane itself loaded.
  expect(fake.calls.some((c) => c.path.endsWith("/instructions"))).toBe(true);
  expect(view.container.querySelector("[data-github-link]")).toBeNull();
  expect(linkCalls()).toEqual([]);
  view.unmount();
});
