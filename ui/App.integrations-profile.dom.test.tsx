// No profile in Settings has an Integrations section (Nil, 2026-10-14: the
// Integrations page is the one place), and Settings has no row for it. None
// asks the server for a member's names.

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
const { translatorFor } = await import("../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

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
  // Members starts collapsed (task db800fd8): its header opens it. The
  // device keeps it open for the next case.
  const members = view.container.querySelector(
    '[data-sidebar-group-toggle="members"][aria-expanded="false"]',
  );
  if (members)
    await act(async () => {
      fireEvent.click(members);
    });
  const row = view
    .getAllByRole("button")
    .find((el) => (el.textContent ?? "").startsWith(name));
  expect(row).toBeDefined();
  await act(async () => {
    fireEvent.click(row!);
  });
  return view;
}

// The owner sees every profile pane a member does and more, so the two owner
// views cover the member's own.
for (const [who, viewer, id, role, rowName] of [
  ["an owner's own profile", "Ricky", "u1", "owner", "Profile"],
  ["a member's profile under an owner", "Ricky", "u1", "owner", "Beth"],
] as const)
  it(`gives ${who} no Integrations section, and asks for no names`, async () => {
    const view = await openProfile(signedInAs(viewer, id, role), rowName);
    // The profile pane is up: the absence below is about the section.
    const headings = [...view.container.querySelectorAll("h5")].map(
      (h) => h.textContent,
    );
    expect(headings.length).toBeGreaterThan(0);
    expect(headings).not.toContain(t("common.integrations"));
    // Nor a sidebar row: the page's only door is the office bar.
    expect(
      view.queryByRole("button", { name: t("common.integrations") }),
    ).toBeNull();
    expect(fake.requests("GET", /\/env\/names$/)).toHaveLength(0);
  });
