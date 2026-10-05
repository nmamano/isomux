// Owners list and revoke a member's personal API tokens on the member's
// profile, through GET and DELETE /api/users/:username/api-tokens. A member's
// own profile and an owner's own profile ask for neither.
//
// Its own file because it renders the settings page and the 5 s cap is per
// file. The routes' refusals are pinned server-side in
// server/test-support/routes-api-tokens-rest.test.ts.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

function token(id: string, name: string) {
  return {
    id,
    name,
    tokenPrefix: "isomux_pat_abcdefgh",
    createdAt: 1_000,
    expiresAt: null,
    lastUsedAt: null,
  };
}

const TOKENS: Record<string, ReturnType<typeof token>[]> = {
  Beth: [token("b1", "Beth phone"), token("b2", "Beth laptop")],
  Carl: [token("c1", "Carl script")],
};
const asked: string[] = [];
// Set to hold Carl's list open, so a test sees the pane between the switch
// and the next member's answer.
let carlGate: Promise<void> | null = null;
setApiShim(async (method, path) => {
  asked.push(`${method} ${path}`);
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path.startsWith("/api/me/provider-accounts")) return { accounts: [] };
  if (path.endsWith("/env/names")) return { names: [], providers: [] };
  const list = /^\/api\/users\/([^/]+)\/api-tokens$/.exec(path);
  if (list && method === "GET") {
    const name = decodeURIComponent(list[1]);
    if (name === "Carl" && carlGate) await carlGate;
    return { apiTokens: TOKENS[name] ?? [] };
  }
  return {};
});
afterAll(() => setApiShim(null));

function user(over: Record<string, unknown>) {
  return {
    allowedRooms: [],
    notifRooms: [],
    hidden: [],
    order: [],
    memberPrompt: null,
    language: null,
    avatarColor: "#4A90D9",
    avatarVariant: 0,
    ...over,
  };
}

const USERS = new Map<string, unknown>([
  ["ricky", user({ id: "u1", name: "Ricky", role: "owner" })],
  ["beth", user({ id: "u2", name: "Beth", role: "member" })],
  ["carl", user({ id: "u3", name: "Carl", role: "member" })],
]);

function signedInAs(username: string, userId: string, role: string) {
  return {
    ...initialState,
    hasReceivedInitialState: true,
    sessionContext: { username, userId, role },
    users: USERS,
  } as unknown as typeof initialState;
}

beforeEach(() => {
  asked.length = 0;
  carlGate = null;
  window.history.replaceState(null, "", "/settings");
});

type View = ReturnType<typeof render>;

async function clickRow(view: View, name: string) {
  // A roster row's text starts with the display name.
  const row = view
    .getAllByRole("button")
    .find((el) => (el.textContent ?? "").startsWith(name));
  expect(row).toBeDefined();
  await act(async () => {
    fireEvent.click(row!);
  });
}

async function openProfile(state: typeof initialState, name: string) {
  const view = render(
    createElement(StateCtx.Provider, { value: state }, createElement(App, {})),
  );
  await clickRow(view, name);
  return view;
}

const cardIds = (view: View) =>
  [...view.container.querySelectorAll("[data-api-token]")].map((el) =>
    el.getAttribute("data-api-token"),
  );
const adminRequests = () =>
  asked.filter((request) => /\/api\/users\/[^/]+\/api-tokens/.test(request));

describe("API tokens on a member's profile", () => {
  it("lets an owner revoke one of the member's tokens", async () => {
    const view = await openProfile(signedInAs("Ricky", "u1", "owner"), "Beth");
    expect(cardIds(view)).toEqual(["b1", "b2"]);
    expect(adminRequests()).toEqual(["GET /api/users/Beth/api-tokens"]);

    const button = view.container.querySelector('[data-api-token="b1"] button');
    expect(button).not.toBeNull();
    await act(async () => {
      fireEvent.click(button!);
    });
    expect(adminRequests()).toContain("DELETE /api/users/Beth/api-tokens/b1");
    expect(cardIds(view)).toEqual(["b2"]);
  });

  it("shows the next member's tokens after a switch, never the previous ones", async () => {
    const view = await openProfile(signedInAs("Ricky", "u1", "owner"), "Beth");
    expect(cardIds(view)).toEqual(["b1", "b2"]);
    let release!: () => void;
    carlGate = new Promise<void>((resolve) => (release = resolve));
    await clickRow(view, "Carl");
    // Carl's answer is still out: Beth's tokens must already be gone.
    expect(cardIds(view)).toEqual([]);
    await act(async () => {
      release();
      await carlGate;
    });
    expect(cardIds(view)).toEqual(["c1"]);
    expect(adminRequests()).toEqual([
      "GET /api/users/Beth/api-tokens",
      "GET /api/users/Carl/api-tokens",
    ]);
  });

  it("asks for nothing on an owner's own profile or a member's own profile", async () => {
    const owner = await openProfile(
      signedInAs("Ricky", "u1", "owner"),
      "Profile",
    );
    expect(owner.container.querySelectorAll("h5").length).toBeGreaterThan(0);
    owner.unmount();
    const member = await openProfile(
      signedInAs("Beth", "u2", "member"),
      "Beth",
    );
    expect(member.container.querySelectorAll("h5").length).toBeGreaterThan(0);
    expect(adminRequests()).toEqual([]);
    expect(cardIds(member)).toEqual([]);
  });
});
