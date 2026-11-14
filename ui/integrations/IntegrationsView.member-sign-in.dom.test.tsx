// An owner who picks a member signs that member in to or out of their own
// Claude and Codex accounts on Model providers (task f183fac3). Pins: the
// member's card offers the sign-in, sign-out and cancel of their personal
// sign-ins only, through the member's routes and never the owner's own; the
// member's sign-in never enters the owner's own store; the card says whose
// account the sign-in takes; with no push for the owner, the card reads the
// member's sign-ins again while one waits, stops when it ends or the owner
// leaves the member, and an older read never undoes a newer one; the member's
// own card lists an owner's sign-out under "changed for you".

import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const { IntegrationsFake, memberSignInLink } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { DispatchCtx } = await import("../store.tsx");
const { MEMBER, OWNER, card, click, open, page, pick, tab, type } =
  await import("../test-support/integrations-page-fixture.ts");

const { t } = translatorFor("en");
const OWNER_ACCOUNT = "ricky-own@example.com";
const MEMBER_CODEX = "stephen-codex@example.com";
const LINK = memberSignInLink("Stephen");
const MEMBER_PATH = "/api/users/Stephen/provider-accounts";

let fake: InstanceType<typeof IntegrationsFake>;
let dispatched: unknown[];
let restoreOpen: () => void;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
    "Lena",
  ]).install();
  fake.accounts = [
    {
      provider: "claude",
      scope: "personal",
      accountStatus: "connected",
      accountLabel: OWNER_ACCOUNT,
      loginStatus: "idle",
      canBrowserLogin: true,
    },
  ];
  fake.memberAccounts.set("stephen", [
    {
      provider: "claude",
      scope: "personal",
      accountStatus: "not_connected",
      loginStatus: "idle",
      canBrowserLogin: true,
    },
    {
      provider: "codex",
      scope: "personal",
      accountStatus: "connected",
      accountLabel: MEMBER_CODEX,
      loginStatus: "idle",
      canBrowserLogin: true,
    },
  ]);
  fake.memberAccounts.set("lena", []);
  dispatched = [];
  // A start opens the link in a new tab: no real window here.
  const original = window.open;
  window.open = () =>
    ({ close() {}, location: { href: "" }, opener: null }) as never;
  restoreOpen = () => {
    window.open = original;
  };
});
afterEach(() => {
  jest.useRealTimers();
  restoreOpen();
});
afterAll(() => setApiShim(null));

// The page, with every action it sends to the owner's own store recorded.
async function openPage() {
  const view = render(
    createElement(
      DispatchCtx.Provider,
      { value: (action: unknown) => dispatched.push(action) },
      page(OWNER),
    ),
  );
  await act(async () => {});
  await tab(view, "providers");
  return view;
}

async function onStephen() {
  const view = await openPage();
  await pick(view, "Stephen");
  return view;
}

const providerCard = (
  view: Awaited<ReturnType<typeof openPage>>,
  provider: "claude" | "codex",
) =>
  card(view, "personal").querySelector<HTMLElement>(
    `[data-provider-card="${provider}"]`,
  );

const copyLinks = (root: Element | null) =>
  [...(root?.querySelectorAll("button") ?? [])].filter(
    (button) => button.textContent === t("settings.signIn.copyLink"),
  ).length;

const buttonNamed = (root: Element | null, label: string) =>
  [...(root?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === label,
  ) ?? null;

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

it("offers the owner the member's own sign-ins, and runs a start on the member's route", async () => {
  const view = await onStephen();
  const theirs = card(view, "personal");
  // The member's two personal sign-ins, and no office one.
  expect(providerCard(view, "claude")).not.toBeNull();
  expect(providerCard(view, "codex")).not.toBeNull();
  expect(theirs.querySelectorAll('[data-sign-in-scope="office"]').length).toBe(
    0,
  );
  expect(providerCard(view, "codex")!.textContent).toContain(MEMBER_CODEX);
  expect(theirs.textContent).not.toContain(OWNER_ACCOUNT);
  // The card says whose account the sign-in takes.
  expect(providerCard(view, "claude")!.textContent).toContain("Stephen");

  await click(
    providerCard(view, "claude")!.querySelector("[data-start-provider-login]"),
  );
  expect(fake.requests("POST", `${MEMBER_PATH}/claude/login`).length).toBe(1);
  expect(
    fake.requests("POST", "/api/me/provider-accounts/claude/login").length,
  ).toBe(0);
  // The member's sign-in waits on the member's card, with its link.
  expect(copyLinks(providerCard(view, "claude"))).toBe(1);
  // Nothing of the member's reached the owner's own store.
  const sent = JSON.stringify(dispatched);
  expect(sent).not.toContain(LINK);
  expect(sent).not.toContain(MEMBER_CODEX);
  expect(
    dispatched.filter(
      (action) =>
        (action as { type?: string }).type === "provider_login_started",
    ).length,
  ).toBe(0);
});

it("cancels the member's sign-in and signs the member out on the member's routes", async () => {
  const view = await onStephen();
  await click(
    providerCard(view, "claude")!.querySelector("[data-start-provider-login]"),
  );
  await click(
    buttonNamed(
      providerCard(view, "claude"),
      t("settings.signIn.cancelSignIn"),
    ),
  );
  expect(fake.requests("POST", `${MEMBER_PATH}/claude/cancel`).length).toBe(1);
  expect(
    fake.requests("POST", "/api/me/provider-accounts/claude/cancel").length,
  ).toBe(0);
  // The cancel's end shows with no push: the link is gone, Sign in is back.
  expect(copyLinks(providerCard(view, "claude"))).toBe(0);
  expect(
    providerCard(view, "claude")!.querySelector("[data-start-provider-login]"),
  ).not.toBeNull();

  await click(
    providerCard(view, "codex")!.querySelector("[data-provider-sign-out]"),
  );
  const dialog = providerCard(view, "codex")!.querySelector('[role="dialog"]');
  await click(dialog!.querySelectorAll("button")[1]);
  expect(fake.requests("POST", `${MEMBER_PATH}/codex/disconnect`).length).toBe(
    1,
  );
  expect(
    fake.requests("POST", "/api/me/provider-accounts/codex/disconnect").length,
  ).toBe(0);
  expect(providerCard(view, "codex")!.textContent).not.toContain(MEMBER_CODEX);
});

it("sends the Claude code on the member's route", async () => {
  const view = await onStephen();
  await click(
    providerCard(view, "claude")!.querySelector("[data-start-provider-login]"),
  );
  await type(providerCard(view, "claude")!.querySelector("input"), "the-code");
  await click(
    buttonNamed(providerCard(view, "claude"), t("settings.signIn.submitCode")),
  );
  const sent = fake.requests("POST", `${MEMBER_PATH}/claude/callback`);
  expect(sent.length).toBe(1);
  expect((sent[0].body as { code?: string }).code).toBe("the-code");
  expect(
    fake.requests("POST", "/api/me/provider-accounts/claude/callback").length,
  ).toBe(0);
});

it("reads the member's sign-ins again while one waits, and stops once it ends", async () => {
  const view = await onStephen();
  // Before the start: the wait's timer is armed when the start's answer
  // lands, and bun fakes only the timers made after useFakeTimers.
  jest.useFakeTimers();
  await click(
    providerCard(view, "claude")!.querySelector("[data-start-provider-login]"),
  );
  const reads = () => fake.requests("GET", MEMBER_PATH).length;
  const before = reads();
  // The member finishes it in their browser: only a read can show it.
  fake.memberAccounts.set("stephen", [
    {
      provider: "claude",
      scope: "personal",
      accountStatus: "connected",
      accountLabel: "stephen-claude@example.com",
      loginStatus: "succeeded",
      canBrowserLogin: true,
    },
  ]);
  await advance(3000);
  expect(reads()).toBeGreaterThan(before);
  expect(providerCard(view, "claude")!.textContent).toContain(
    "stephen-claude@example.com",
  );
  expect(copyLinks(providerCard(view, "claude"))).toBe(0);
  // Ended: no more reads.
  const settled = reads();
  await advance(30_000);
  expect(reads()).toBe(settled);
});

it("stops reading a member's waiting sign-in once the owner picks another member", async () => {
  const view = await onStephen();
  // Before the start: the wait's timer is armed when the start's answer
  // lands, and bun fakes only the timers made after useFakeTimers.
  jest.useFakeTimers();
  await click(
    providerCard(view, "claude")!.querySelector("[data-start-provider-login]"),
  );
  await advance(3000);
  const reads = () => fake.requests("GET", MEMBER_PATH).length;
  // The enabling condition: the read does repeat while it waits.
  expect(reads()).toBeGreaterThan(1);
  await pick(view, "Lena");
  const left = reads();
  await advance(30_000);
  expect(reads()).toBe(left);
});

it("never lets an older read of the member's sign-ins undo a newer one", async () => {
  const view = await onStephen();
  // Before the start: the wait's timer is armed when the start's answer
  // lands, and bun fakes only the timers made after useFakeTimers.
  jest.useFakeTimers();
  await click(
    providerCard(view, "claude")!.querySelector("[data-start-provider-login]"),
  );
  // Hold the next read: it answers "waiting", as the state is when it is
  // sent.
  const shim = fake.handle.bind(fake);
  let releaseStale!: () => void;
  let holding = true;
  setApiShim(async (method, path, body) => {
    if (holding && method === "GET" && path === MEMBER_PATH) {
      holding = false;
      const answer = await shim(method, path, body);
      await new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      return answer;
    }
    return shim(method, path, body);
  });
  await advance(3000);
  // The enabling condition: a read is in flight with the waiting state.
  expect(typeof releaseStale).toBe("function");
  jest.useRealTimers();
  // The owner cancels; the cancel's own read says the sign-in ended.
  await click(
    buttonNamed(
      providerCard(view, "claude"),
      t("settings.signIn.cancelSignIn"),
    ),
  );
  expect(copyLinks(providerCard(view, "claude"))).toBe(0);
  // The older read lands after it.
  await act(async () => releaseStale());
  await act(async () => {});
  expect(copyLinks(providerCard(view, "claude"))).toBe(0);
  expect(
    providerCard(view, "claude")!.querySelector("[data-start-provider-login]"),
  ).not.toBeNull();
});

it("lists an owner's sign-out on the member's own Model providers tab, with who did it", async () => {
  fake = new IntegrationsFake({ username: "Stephen", owner: false }, [
    "Ricky",
    "Stephen",
  ]).install();
  fake.changes = [
    {
      time: Date.now() - 60 * 60 * 1000,
      by: "Ricky",
      kind: "provider",
      action: "removed",
      name: "claude",
    },
  ];
  const view = await open(MEMBER);
  const listed = () =>
    [
      ...card(view, "personal").querySelectorAll("[data-integration-change]"),
    ].map((el) => el.textContent ?? "");
  await tab(view, "providers");
  const lines = listed();
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("Ricky");
  expect(lines[0].toLowerCase()).toContain("claude");
  // On its own tab only.
  await tab(view, "variables");
  expect(listed().length).toBe(0);
});
