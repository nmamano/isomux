// While the page reads its data, the lines that the answers bring hold their
// space, so a card does not grow when they arrive (task 0eab60fd): the
// sign-in buttons, the OpenCode key line, and a member's provider rows.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { act } = await import("@testing-library/react");
const { card, open, pick } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
});

const held = (root: Element) => root.querySelectorAll("[data-reserved]");

it("holds the sign-in buttons and the OpenCode key line until the reads answer", async () => {
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
  // Codex and Claude sign-ins, and the OpenCode key line.
  expect(held(yours)).toHaveLength(3);
  for (const node of held(yours)) {
    expect(node.getAttribute("aria-hidden")).toBe("true");
    expect(node.hasAttribute("inert")).toBe(true);
  }
  for (const which of ["office", "personal"] as const) {
    const block = card(view, which).querySelector(
      '[data-provider-block="opencode"]',
    )!;
    expect(held(block)).toHaveLength(1);
    // Held space says nothing about the key.
    expect(block.querySelector("[data-opencode-key]")).toBeNull();
  }
  // Held sign-in rows offer nothing to start.
  expect(
    view.container.querySelector("[data-start-provider-login]"),
  ).toBeNull();

  await act(async () => {
    for (const release of releases) release();
  });
  expect(held(view.container)).toHaveLength(0);
  for (const which of ["office", "personal"] as const)
    expect(
      card(view, which).querySelector(
        '[data-provider-block="opencode"] [data-opencode-key]',
      ),
    ).not.toBeNull();
});

it("keeps a member's provider rows in place while their status loads", async () => {
  const view = await open();
  const release = fake.hold("/api/users/Stephen/env/names");
  await pick(view, "Stephen");
  const rows = () =>
    card(view, "personal").querySelector("[data-member-providers]")!;
  expect(rows().getAttribute("aria-busy")).toBe("true");
  for (const provider of ["claude", "codex"]) {
    const row = rows().querySelector(`[data-member-provider="${provider}"]`)!;
    expect(row.textContent).toContain(t("common.loading"));
  }
  expect(held(rows())).toHaveLength(1);

  await act(async () => release());
  expect(rows().getAttribute("aria-busy")).toBe("false");
  expect(rows().textContent).not.toContain(t("common.loading"));
  expect(held(rows())).toHaveLength(0);
});
