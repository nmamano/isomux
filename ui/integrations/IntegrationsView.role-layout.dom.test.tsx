// Nothing moves for another role (AGENTS.md "UI rules"): a member's
// Integrations page draws every control an owner's draws, in the same order,
// and what only an owner can use is disabled, not hidden (task 3d517a07).
// Both roles open the same office, so a difference is the role's alone. The
// office data here avoids what a member cannot read (an office secret's form,
// an MCP server's sign-in, the usage cap's value), which can still change an
// owner's row.

import { beforeAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake, secret, server } =
  await import("../test-support/integrations-fake.ts");
const { MEMBER, OWNER, open, selectedTab, tab } =
  await import("../test-support/integrations-page-fixture.ts");

const TABS = [
  "providers",
  "mcp",
  "secrets",
  "variables",
  "voice",
  "pager",
  "messaging",
] as const;

// The markers a control carries only while it can be used: they say "live",
// not what the control is, so the layout compare leaves them out.
const LIVE_MARKERS = new Set([
  "data-start-provider-login",
  "data-provider-sign-out",
  "data-sign-in-test",
]);

// On the owner's page, the controls of the Model providers office card that
// only an owner can use.
const OWNER_ONLY_PROVIDERS = [
  "[data-start-provider-login]",
  "[data-provider-sign-out]",
  "[data-opencode-key-edit]",
  "[data-opencode-key-remove]",
  "[data-member-usage-card] input",
  "[data-member-usage-card] button",
  "[data-account-usage-refresh]",
].join(", ");

type Control = {
  key: string;
  disabled: boolean;
  ownerOnly: boolean;
  indeterminate: boolean;
  value: string | null;
};
type Card = { name: string; controls: Control[] };
type Pass = {
  cards: Record<string, Card[]>;
  nav: { id: string; disabled: boolean }[];
  // The selected tab after a click on the GitHub issues row.
  afterGithubClick: string | null;
  settingsReads: number;
};

function fakeFor(owner: boolean) {
  const fake = new IntegrationsFake(
    { username: owner ? "Ricky" : "Stephen", owner },
    ["Ricky", "Stephen", "Lena"],
  );
  const office = fake.scope("office");
  office.secrets.push(secret("FLY_API_TOKEN"));
  office.servers.push(server("linear"));
  office.values = { TZ: "UTC" };
  office.notes = { TZ: "for logs" };
  fake.officeSettings = {
    version: "1",
    memberUsageCap: false,
    memberUsageShare: 50,
    providerFallback: false,
  };
  return fake.install();
}

// Office sign-ins: Claude signed out, Codex signed in, both by browser.
const ACCOUNTS = [
  {
    provider: "claude",
    scope: "office",
    accountStatus: "not_connected",
    loginStatus: "idle",
    canBrowserLogin: true,
  },
  {
    provider: "codex",
    scope: "office",
    accountStatus: "connected",
    accountLabel: "ops@example.com",
    loginStatus: "idle",
    canBrowserLogin: true,
  },
];

function controlsOf(card: Element, tabId: string): Control[] {
  const ownerOnlyHere =
    card.getAttribute("data-integrations-card") === "office"
      ? tabId === "providers"
        ? OWNER_ONLY_PROVIDERS
        : tabId === "secrets" || tabId === "variables" || tabId === "mcp"
          ? "*"
          : null
      : "[data-integrations-picker]";
  return [...card.querySelectorAll("button, select, input, textarea")].map(
    (el) => {
      const data = [...el.attributes]
        .map((a) => a.name)
        .filter((n) => n.startsWith("data-") && !LIVE_MARKERS.has(n))
        .sort();
      const field = el as HTMLInputElement;
      return {
        key: `${el.tagName.toLowerCase()}[${data.join(",")}]`,
        disabled: field.disabled,
        ownerOnly: ownerOnlyHere !== null && el.matches(ownerOnlyHere),
        indeterminate: field.indeterminate === true,
        value: el.tagName === "SELECT" ? field.value : null,
      };
    },
  );
}

async function walk(owner: boolean): Promise<Pass> {
  const fake = fakeFor(owner);
  const view = await open({
    ...(owner ? OWNER : MEMBER),
    providerAccounts: ACCOUNTS,
  } as never);
  const cards: Pass["cards"] = {};
  for (const id of TABS) {
    await tab(view, id);
    cards[id] = [
      ...view.container.querySelectorAll("[data-integrations-card]"),
    ].map((card) => ({
      name: card.getAttribute("data-integrations-card")!,
      controls: controlsOf(card, id),
    }));
  }
  const nav = [
    ...view.container.querySelectorAll<HTMLButtonElement>(
      "[data-integrations-tab]",
    ),
  ].map((row) => ({
    id: row.getAttribute("data-integrations-tab")!,
    disabled: row.disabled || row.getAttribute("aria-disabled") === "true",
  }));
  await tab(view, "secrets");
  const github = view.container.querySelector(
    '[data-integrations-tab="github"]',
  );
  if (github)
    await act(async () => {
      fireEvent.click(github);
    });
  const pass: Pass = {
    cards,
    nav,
    afterGithubClick: selectedTab(view),
    settingsReads: fake.requests("GET", "/api/office/settings").length,
  };
  view.unmount();
  setApiShim(null);
  return pass;
}

let owner: Pass;
let member: Pass;
beforeAll(async () => {
  owner = await walk(true);
  member = await walk(false);
});

const keys = (cards: Card[]) =>
  cards.map((card) => [card.name, ...card.controls.map((c) => c.key)]);
const card = (pass: Pass, tabId: string, name: string) =>
  pass.cards[tabId]!.find((c) => c.name === name)!;

describe("a member's Integrations page keeps the owner's layout", () => {
  it("draws the owner's controls in the owner's order on every tab", () => {
    // The owner's page has the controls the compare is about.
    const ownerKeys = (tabId: string) =>
      keys(owner.cards[tabId]!).flat().join(" ");
    for (const tabId of ["mcp", "secrets", "variables"])
      expect(ownerKeys(tabId)).toContain("[data-integrations-add]");
    expect(ownerKeys("providers")).toContain("[data-opencode-key-edit]");
    for (const tabId of ["secrets", "voice", "pager"])
      expect(ownerKeys(tabId)).toContain("[data-integrations-picker]");
    expect(
      card(owner, "providers", "office").controls.filter((c) => c.ownerOnly)
        .length,
    ).toBeGreaterThanOrEqual(6);

    for (const tabId of TABS)
      expect({ tab: tabId, cards: keys(member.cards[tabId]!) }).toEqual({
        tab: tabId,
        cards: keys(owner.cards[tabId]!),
      });
  });

  it("lists the same tabs, with GitHub issues disabled for a member", () => {
    expect(owner.nav.map((row) => row.id)).toContain("github");
    expect(member.nav.map((row) => row.id)).toEqual(
      owner.nav.map((row) => row.id),
    );
    expect(owner.nav.filter((row) => row.disabled).length).toBe(0);
    expect(
      member.nav.filter((row) => row.disabled).map((row) => row.id),
    ).toEqual(["github"]);
    // A click on it opens it for an owner only.
    expect(owner.afterGithubClick).toBe("github");
    expect(member.afterGithubClick).toBe("secrets");
  });

  it("disables for a member what only an owner can use, which an owner can use", () => {
    let paired = 0;
    for (const tabId of TABS) {
      const ownerCards = owner.cards[tabId]!;
      const memberCards = member.cards[tabId]!;
      // Paired by place: the test above proves the lists match.
      expect(memberCards.length).toBe(ownerCards.length);
      ownerCards.forEach((ownerCard, i) => {
        ownerCard.controls.forEach((theirs, j) => {
          if (!theirs.ownerOnly) return;
          const mine = memberCards[i]!.controls[j]!;
          expect({
            tab: tabId,
            key: mine.key,
            disabled: mine.disabled,
          }).toEqual({ tab: tabId, key: theirs.key, disabled: true });
          paired++;
        });
      });
    }
    // Office Add, Edit, Remove, Show on three tabs, the providers' office
    // controls and the picker on each tab that has one.
    expect(paired).toBeGreaterThanOrEqual(15);

    // An owner can use them: the Add rows, the row actions, the sign-ins,
    // the key, the usage switches and Save, and the picker.
    for (const tabId of ["mcp", "secrets", "variables"])
      expect(
        card(owner, tabId, "office")
          .controls.filter((c) => c.disabled)
          .map((c) => c.key),
      ).toEqual([]);
    const ownerProviders = card(owner, "providers", "office").controls.filter(
      (c) => c.ownerOnly,
    );
    // Cancel has nothing to undo yet.
    expect(ownerProviders.filter((c) => c.disabled).length).toBe(1);
    for (const tabId of ["secrets", "voice", "pager"]) {
      const picker = card(owner, tabId, "personal").controls.find(
        (c) => c.ownerOnly,
      )!;
      expect(picker.disabled).toBe(false);
    }
  });

  it("shows a member the picker on You and the usage switches as unknown", () => {
    for (const tabId of ["secrets", "voice", "pager"]) {
      const picker = card(member, tabId, "personal").controls.find(
        (c) => c.ownerOnly,
      );
      expect({ tab: tabId, value: picker?.value }).toEqual({
        tab: tabId,
        value: "",
      });
    }
    const switches = (pass: Pass) =>
      card(pass, "providers", "office").controls.filter(
        (c) => c.key === "input[]" && c.ownerOnly,
      );
    expect(switches(owner).length).toBe(2);
    expect(switches(owner).filter((c) => c.indeterminate).length).toBe(0);
    expect(switches(member).filter((c) => c.indeterminate).length).toBe(2);
  });

  it("reads the office settings for an owner only", () => {
    expect(owner.settingsReads).toBeGreaterThan(0);
    expect(member.settingsReads).toBe(0);
  });
});
