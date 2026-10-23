// Nil's feedback on the live page (2026-10-13): the last tab is remembered,
// the Secrets tab says where model keys go, each sign-in has a Test, OpenCode
// shows on Model providers.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake, EMPTY_CONNECTIONS } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { OWNER, card, click, open, pick, selectedTab, tab } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");
const TAB_KEY = "isomux-integrations-tab";

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
});

type View = Awaited<ReturnType<typeof open>>;
const selected = selectedTab;

describe("the last tab", () => {
  it("opens on the tab picked last on this device", async () => {
    const first = await open();
    expect(selected(first)).toBe("providers");
    await tab(first, "secrets");
    expect(window.localStorage.getItem(TAB_KEY)).toBe("secrets");
    first.unmount();
    const next = await open();
    expect(selected(next)).toBe("secrets");
  });

  it("opens on Model providers for a stored value that is no tab", async () => {
    window.localStorage.setItem(TAB_KEY, "connections");
    const view = await open();
    expect(selected(view)).toBe("providers");
    expect(view.container.querySelector("[data-provider-card]")).not.toBeNull();
  });

  // App clears its request only when the page reports it handled; a request
  // left set opens its tab again the next time the page mounts.
  it("opens on a requested tab over the remembered one, and reports it handled once", async () => {
    window.localStorage.setItem(TAB_KEY, "secrets");
    let handled = 0;
    const view = await open(OWNER, {
      request: { tab: "browser" },
      onRequestHandled: () => handled++,
    });
    expect(selected(view)).toBe("browser");
    expect(handled).toBe(1);
    expect(window.localStorage.getItem(TAB_KEY)).toBe("browser");
  });
});

it("says on the Secrets tab that model keys go in Variables, with a way there", async () => {
  const view = await open();
  await tab(view, "secrets");
  const note = view.container.querySelector("[data-secrets-model-keys]")!;
  expect(note.querySelector("[data-integrations-data]")!.textContent).toBe(
    "ANTHROPIC_API_KEY",
  );
  await click(note.querySelector("[data-go-variables]"));
  expect(selected(view)).toBe("variables");
});

describe("a Test on each sign-in", () => {
  const claude = (connected: boolean) =>
    ({
      provider: "claude",
      scope: "office",
      accountStatus: connected ? "connected" : "not_connected",
      loginStatus: "idle",
      shared: true,
      canBrowserLogin: true,
      accountLabel: connected ? "morgan@example.com" : undefined,
    }) as never;
  // The page reads the accounts from the store, which this harness holds
  // still; the fake answers the Test's refresh.
  const signedIn = () => open({ ...OWNER, providerAccounts: [claude(true)] });

  it("names the account the provider sees, as data", async () => {
    fake.accounts = [claude(true)];
    const view = await signedIn();
    const office = card(view, "office");
    await click(office.querySelector("[data-sign-in-test]"));
    const result = office.querySelector('[data-sign-in-test-result="works"]')!;
    expect(result.textContent).toContain(t("settings.connections.test.works"));
    expect(result.querySelector("[data-integrations-data]")!.textContent).toBe(
      "morgan@example.com",
    );
    // What Works means for a Claude sign-in, behind its (?).
    await click(result.querySelector("[data-help-tip]"));
    expect(result.querySelector('[role="note"]')!.textContent).toBe(
      t("settings.connections.test.help.claude"),
    );
    expect(
      fake.requests("POST", "/api/me/provider-accounts/refresh"),
    ).toHaveLength(1);
  });

  it("says when the sign-in is gone", async () => {
    fake.accounts = [claude(true)];
    const view = await signedIn();
    fake.accounts = [claude(false)];
    const office = card(view, "office");
    await click(office.querySelector("[data-sign-in-test]"));
    expect(
      office.querySelector('[data-sign-in-test-result="signedOut"]')!
        .textContent,
    ).toBe(t("integrations.providers.testSignedOut"));
  });

  it("runs once while a test is out", async () => {
    fake.accounts = [claude(true)];
    const view = await signedIn();
    const release = fake.hold("/api/me/provider-accounts/refresh");
    const button = card(view, "office").querySelector<HTMLButtonElement>(
      "[data-sign-in-test]",
    )!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(button.disabled).toBe(true);
    await act(async () => release());
    expect(
      fake.requests("POST", "/api/me/provider-accounts/refresh"),
    ).toHaveLength(1);
  });

  it("states each card's own sign-in, not the other scope's", async () => {
    const personal = (connected: boolean) =>
      ({
        provider: "claude",
        scope: "personal",
        accountStatus: connected ? "connected" : "not_connected",
        loginStatus: "idle",
        shared: false,
        canBrowserLogin: true,
        accountLabel: connected ? "me@example.com" : undefined,
      }) as never;
    // Both shown connected; the refresh finds the personal one gone.
    const view = await open({
      ...OWNER,
      providerAccounts: [claude(true), personal(true)],
    });
    fake.accounts = [claude(true), personal(false)];
    const mine = card(view, "personal");
    await click(mine.querySelector("[data-sign-in-test]"));
    expect(
      mine
        .querySelector("[data-sign-in-test-result]")!
        .getAttribute("data-sign-in-test-result"),
    ).toBe("signedOut");
    const office = card(view, "office");
    await click(office.querySelector("[data-sign-in-test]"));
    expect(
      office.querySelector('[data-sign-in-test-result="works"]')!.textContent,
    ).toContain("morgan@example.com");
  });
});

describe("OpenCode on Model providers", () => {
  const block = (view: View, which: "office" | "personal") =>
    card(view, which).querySelector('[data-provider-block="opencode"]')!;

  it("says whether each card's OPENCODE_API_KEY is set", async () => {
    fake.connections = {
      ...EMPTY_CONNECTIONS,
      variables: [{ scope: "office", name: "OPENCODE_API_KEY", note: null }],
    };
    const view = await open();
    expect(block(view, "office").textContent).toContain(
      t("integrations.providers.opencode.bundled"),
    );
    expect(
      block(view, "office")
        .querySelector("[data-opencode-key]")!
        .getAttribute("data-opencode-key"),
    ).toBe("set");
    const mine = block(view, "personal");
    expect(mine.textContent).not.toContain(
      t("integrations.providers.opencode.bundled"),
    );
    expect(
      mine
        .querySelector("[data-opencode-key]")!
        .getAttribute("data-opencode-key"),
    ).toBe("none");
    await click(mine.querySelector("[data-go-variables]"));
    expect(selected(view)).toBe("variables");
  });

  it("reads a member's key from their variable names", async () => {
    fake.scope("Stephen").values = { OPENCODE_API_KEY: "x" };
    const view = await open();
    await pick(view, "Stephen");
    expect(
      block(view, "personal")
        .querySelector("[data-opencode-key]")!
        .getAttribute("data-opencode-key"),
    ).toBe("set");
  });

  it("says when this host cannot run it", async () => {
    const view = await open({
      ...OWNER,
      unavailableEngines: { opencode: "needs_linux" },
    });
    expect(
      block(view, "office").querySelector("[data-opencode-unavailable]")!
        .textContent,
    ).toBe(t("dialogs.agent.engineNeedsLinux"));
  });
});
