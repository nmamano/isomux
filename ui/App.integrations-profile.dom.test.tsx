// The Integrations link on a member's profile in Settings is an owner's, on
// someone else's profile (Lead, ruling 2). Your own profile has none, for an
// owner or a member, and asks the server for no member's names.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { IntegrationsFake } =
  await import("./test-support/integrations-fake.ts");
const { createElement } = await import("react");
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
    createdAt: 0,
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

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Beth",
  ]).install();
  window.history.replaceState(null, "", "/settings");
});

async function openProfile(state: typeof initialState, name: string) {
  const view = render(
    createElement(StateCtx.Provider, { value: state }, createElement(App, {})),
  );
  const row = view
    .getAllByRole("button")
    .find((el) => (el.textContent ?? "").startsWith(name));
  expect(row).toBeDefined();
  await act(async () => {
    fireEvent.click(row!);
  });
  return view;
}

for (const [who, id, role, rowName] of [
  ["an owner", "u1", "owner", "Profile"],
  ["a member", "u2", "member", "Beth"],
] as const)
  it(`gives ${who} no Integrations link on their own profile, and asks for no names`, async () => {
    const view = await openProfile(
      signedInAs(who === "an owner" ? "Ricky" : "Beth", id, role),
      rowName,
    );
    // The profile pane is up: the absence below is about the link.
    expect(view.container.querySelectorAll("h5").length).toBeGreaterThan(0);
    expect(
      view.container.querySelector("[data-member-integrations-link]"),
    ).toBeNull();
    expect(fake.requests("GET", /\/env\/names$/)).toHaveLength(0);
  });
