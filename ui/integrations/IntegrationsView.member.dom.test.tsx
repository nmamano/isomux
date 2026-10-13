// Another member's card, beyond the picker itself: it stays on every tab,
// a member who leaves takes the card back to You with a notice, a Test on
// their secret goes through their route, and their provider status says only
// what the server knows.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const { IntegrationsFake, secret } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { OWNER, USERS, card, click, open, pick, stateFor, tab } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
    "Lena",
  ]).install();
});

it("keeps the member's title, accent and way back on every tab", async () => {
  const view = await open();
  await pick(view, "Stephen");
  for (const id of ["mcp", "secrets", "variables", "providers"]) {
    await tab(view, id);
    const theirs = card(view, "personal");
    expect(theirs.getAttribute("data-integrations-member"), id).toBe("Stephen");
    expect(
      theirs.querySelector("[data-card-title]")!.textContent,
      id,
    ).toContain(t("integrations.memberTitle", { member: "Stephen" }));
    expect(theirs.getAttribute("style"), id).toContain("var(--orange-border)");
    expect(theirs.querySelector("[data-back-to-yours]"), id).not.toBeNull();
  }
});

it("goes back to You with a notice when the member's route says they are gone", async () => {
  // The roster still lists Stephen; the server no longer knows him.
  fake.members = ["Ricky", "Lena"];
  const view = await open();
  await tab(view, "secrets");
  await pick(view, "Stephen");
  const card2 = card(view, "personal");
  expect(card2.getAttribute("data-integrations-member")).toBeNull();
  expect(card2.querySelector("[data-member-gone]")!.textContent).toBe(
    t("integrations.memberGone", { member: "Stephen" }),
  );
  expect(card2.textContent).not.toContain(
    t("integrations.memberTitle", { member: "Stephen" }),
  );
  // Picking again clears the notice.
  await pick(view, "Lena");
  expect(card(view, "personal").querySelector("[data-member-gone]")).toBeNull();
});

it("goes back to You when the member leaves the roster", async () => {
  const view = await open();
  await pick(view, "Lena");
  const without = new Map(USERS);
  without.delete("lena");
  view.rerender(
    (await import("../test-support/integrations-page-fixture.ts")).page(
      stateFor("Ricky", "u1", "owner", without),
    ),
  );
  const mine = card(view, "personal");
  expect(mine.getAttribute("data-integrations-member")).toBeNull();
  expect(mine.querySelector("[data-member-gone]")!.textContent).toBe(
    t("integrations.memberGone", { member: "Lena" }),
  );
});

it("tests a member's secret through the member's route, and a switch clears the result", async () => {
  fake
    .scope("Stephen")
    .secrets.push(secret("GH_TOKEN", { hosts: ["api.github.com"] }));
  const view = await open();
  await tab(view, "secrets");
  await pick(view, "Stephen");
  await click(card(view, "personal").querySelector("[data-connection-test]"));
  expect(
    fake.requests("POST", "/api/users/Stephen/secrets/GH_TOKEN/test"),
  ).toHaveLength(1);
  expect(
    card(view, "personal").querySelector("[data-connection-test-result]"),
  ).not.toBeNull();
  await pick(view, "Lena");
  await pick(view, "Stephen");
  expect(
    card(view, "personal").querySelector("[data-connection-test-result]"),
  ).toBeNull();
});

it("says a member has no personal sign-in, or that the check failed, never more", async () => {
  fake.providers = [
    { provider: "claude", status: "unknown" },
    { provider: "codex", status: "not_connected" },
  ];
  const view = await open();
  await pick(view, "Stephen");
  const theirs = card(view, "personal");
  expect(
    theirs.querySelector('[data-member-provider="claude"]')!.textContent,
  ).toContain(t("settings.memberConnections.unknown"));
  expect(
    theirs.querySelector('[data-member-provider="codex"]')!.textContent,
  ).toContain(t("integrations.providers.noPersonal"));
  expect(theirs.textContent).not.toContain(t("settings.signIn.notConnected"));
});

it("never asks for a member's names on your own card", async () => {
  await open(OWNER);
  await open(stateFor("Stephen", "u2", "member"));
  expect(
    fake
      .requests("GET", /\/env\/names$/)
      .filter((c) => c.path.startsWith("/api/users/")),
  ).toHaveLength(0);
});
