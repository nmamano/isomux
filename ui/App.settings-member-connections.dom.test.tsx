// An office owner opens a member's profile from the roster and sees WHICH
// managed variables that member has set. Names only: the values live in the
// member's own managed env file, and GET /api/users/:username/env/names is the
// only thing this section ever reads.
//
// The member half of the same behaviour is here too, because "owners only" is
// half a rule until something proves the other half: a member's own profile
// shows no such section, and the shim would answer if it were asked.
//
// Its own file because it renders the settings page twice and the 5 s cap is
// per file. The route's refusal is pinned server-side in
// server/test-support/routes-user-env-rest.test.ts.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

// Every path the settings detail pane touches on mount. The names route
// answers for ANY username, so a member render that wrongly asked for it would
// show the chips rather than fail silently.
const asked: string[] = [];
setApiShim(async (_method, path) => {
  asked.push(path);
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path.startsWith("/api/me/provider-accounts")) return { accounts: [] };
  if (path.endsWith("/env/names")) return { names: ["GH_TOKEN", "ZED_TOKEN"] };
  return {};
});
afterAll(() => setApiShim(null));

function user(over: Record<string, unknown>) {
  return {
    allowedRooms: [],
    notifRooms: [],
    hidden: [],
    order: [],
    envFile: null,
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
  window.history.replaceState(null, "", "/settings");
});

async function openProfile(state: typeof initialState, name: string) {
  const view = render(
    createElement(StateCtx.Provider, { value: state }, createElement(App, {})),
  );
  // The roster row is a button whose text is the display name followed by an
  // optional "(you)" and the lowercase role badge, so a startsWith on the name
  // picks exactly one row and never a sidebar section.
  const row = view
    .getAllByRole("button")
    .find((el) => (el.textContent ?? "").startsWith(name));
  expect(row).toBeDefined();
  await act(async () => {
    fireEvent.click(row!);
  });
  return view;
}

describe("individual connections on a member's profile", () => {
  it("shows an owner the member's variable names and no values", async () => {
    const view = await openProfile(signedInAs("Ricky", "u1", "owner"), "Beth");

    expect(
      view.queryByRole("heading", { name: "Individual Connections", level: 5 }),
    ).not.toBeNull();
    expect(view.queryByText("GH_TOKEN")).not.toBeNull();
    expect(view.queryByText("ZED_TOKEN")).not.toBeNull();
    // The subject is BETH's file, not the owner's own.
    expect(asked).toContain("/api/users/Beth/env/names");
  });

  it("shows a member nothing on their own profile, and asks for nothing", async () => {
    const view = await openProfile(signedInAs("Beth", "u2", "member"), "Beth");

    // The profile pane really did mount - otherwise the absence below proves
    // nothing about the section.
    expect(
      view.queryByRole("heading", { name: "Identity", level: 5 }),
    ).not.toBeNull();
    expect(
      view.queryByRole("heading", { name: "Individual Connections", level: 5 }),
    ).toBeNull();
    expect(view.queryByText("GH_TOKEN")).toBeNull();
    expect(asked.some((path) => path.endsWith("/env/names"))).toBe(false);
  });
});
