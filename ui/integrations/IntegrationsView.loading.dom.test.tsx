// While the page reads its data, the lines that the answers bring hold their
// space, so a card does not grow when they arrive (task 0eab60fd): the
// sign-in buttons, a member's included. OpenCode's rows are in
// IntegrationsView.opencode.dom.test.tsx.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { act } = await import("@testing-library/react");
const { card, open, pick } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
});

const held = (root: Element) => root.querySelectorAll("[data-reserved]");

it("holds the sign-in buttons until the reads answer", async () => {
  const releases = [
    fake.hold("/api/me/provider-accounts"),
    fake.hold("/api/me/connections"),
    fake.hold("/api/office/settings"),
  ];
  const view = await open();
  // Codex and Claude, on the office card and on yours, say they are checking.
  expect(
    view.container.querySelectorAll('[data-provider-account-state="checking"]'),
  ).toHaveLength(4);
  const yours = card(view, "personal");
  // Codex and Claude sign-ins.
  const signIns = [...held(yours)].filter(
    (node) => !node.closest('[data-provider-block="opencode"]'),
  );
  expect(signIns).toHaveLength(2);
  for (const node of held(yours)) {
    expect(node.getAttribute("aria-hidden")).toBe("true");
    expect(node.hasAttribute("inert")).toBe(true);
  }
  // Held sign-in rows offer nothing to start.
  expect(
    view.container.querySelector("[data-start-provider-login]"),
  ).toBeNull();

  await act(async () => {
    for (const release of releases) release();
  });
  expect(held(view.container)).toHaveLength(0);
});

it("holds a member's sign-in buttons and OpenCode row until their reads answer", async () => {
  fake.memberAccounts.set("stephen", [
    {
      provider: "claude",
      scope: "personal",
      accountStatus: "not_connected",
      loginStatus: "idle",
      canBrowserLogin: true,
    },
  ]);
  const view = await open();
  const releases = [
    fake.hold("/api/users/Stephen/provider-accounts"),
    fake.hold("/api/users/Stephen/env/names"),
  ];
  await pick(view, "Stephen");
  const theirs = () => card(view, "personal");
  const checking = () =>
    theirs().querySelectorAll('[data-provider-account-state="checking"]')
      .length;
  expect(checking()).toBe(2);
  expect(theirs().querySelectorAll("[data-start-provider-login]").length).toBe(
    0,
  );
  // OpenCode's row holds its key state.
  const openCode = () =>
    theirs().querySelector('[data-member-provider="opencode"]')!;
  expect(held(openCode()).length).toBeGreaterThan(0);

  await act(async () => {
    for (const release of releases) release();
  });
  expect(checking()).toBe(0);
  expect(theirs().querySelectorAll("[data-start-provider-login]").length).toBe(
    1,
  );
  expect(held(theirs()).length).toBe(0);
});
