// Task 3abb740b: the sign-in card under a chat entry, for the agent's owner.
// It leads with the account the agent actually uses (the wire's `effective`
// flag), shows one sign-in and keeps the others collapsed; on OpenCode's free
// limit it shows one row per engine, to switch the agent to an engine whose
// effective account is connected, or to sign in to it.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import {
  DEFAULT_AGENT_CAPABILITIES,
  type ProviderAccountWire,
} from "../../shared/types.ts";

setUpDomTestFile();
const { act, cleanup, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StoreProvider } = await import("../store.tsx");
const { LogView } = await import("./LogView.tsx");
const { setShim, shimEmit, connect } = await import("../ws.ts");
const { ApiError, setApiShim } = await import("../api.ts");
const { t } = (await import("../../shared/i18n/translate.ts")).translatorFor(
  "en",
);
setShim(() => {});
setApiShim(async () => ({}));
afterEach(() => {
  cleanup();
  setApiShim(async () => ({}));
});
afterAll(() => {
  setApiShim(null);
  setShim(() => {});
  connect(
    () => {},
    () => {},
  );
});

const OWNER = "agent-owner";
type Provider = "claude" | "codex";

function wire(
  provider: Provider,
  scope: "office" | "personal",
  state: {
    connected?: boolean;
    effective?: boolean;
  } & Partial<ProviderAccountWire> = {},
): ProviderAccountWire {
  const { connected, ...rest } = state;
  return {
    provider,
    scope,
    accountStatus: connected ? "connected" : "not_connected",
    loginStatus: "idle",
    canBrowserLogin: true,
    ...rest,
  };
}

function agentOf(agentType: string) {
  return {
    id: `${agentType}-agent`,
    name: "Agent",
    userId: OWNER,
    username: "Owner",
    agentType,
    roomId: "room",
    cwd: "/tmp",
    state: "waiting_for_response",
    permissionMode: "default",
    modelFamily: agentType === "opencode" ? "opencode/free-model" : "model",
    effort: "high",
    topic: null,
    sessionId: null,
    customPrompt: null,
    outfit: {},
    capabilities: DEFAULT_AGENT_CAPABILITIES,
  } as unknown as Parameters<typeof LogView>[0]["agent"];
}

/** The chat of one agent with one entry, seen by the agent's owner with
 * `role` in the office, and the accounts `accounts`. */
async function show(
  entry: { agentType: string; metadata: Record<string, unknown> },
  role: "owner" | "member",
  accounts: ProviderAccountWire[],
) {
  const agent = agentOf(entry.agentType);
  const view = render(
    createElement(StoreProvider, {
      children: createElement(LogView, {
        agent,
        logs: [
          {
            id: "entry",
            agentId: agent.id,
            timestamp: Date.now(),
            kind: "system" as const,
            content: "The agent cannot answer.",
            metadata: entry.metadata,
          },
        ],
        onBack: () => {},
        onEditAgent: () => {},
      }),
    }),
  );
  await act(async () => {
    shimEmit({
      type: "session_context",
      context: { userId: OWNER, username: "Owner", role },
    } as never);
    shimEmit({ type: "provider_accounts_updated", accounts });
  });
  const root = view.container;
  const all = (selector: string) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ];
  return {
    view,
    agent,
    all,
    one: (selector: string) => root.querySelector<HTMLElement>(selector),
    scopes: () =>
      all("[data-sign-in-scope]").map((el) => el.dataset.signInScope),
    push: (next: ProviderAccountWire[]) =>
      act(async () => {
        shimEmit({ type: "provider_accounts_updated", accounts: next });
      }),
    click: (el: HTMLElement | null) =>
      act(async () => {
        if (!el) throw new Error("nothing to click");
        el.click();
      }),
  };
}

const ownEngine = (provider: Provider) => ({
  agentType: provider,
  metadata: { providerLogin: provider },
});
const freeLimit = {
  agentType: "opencode",
  metadata: { openCodeFreeLimit: true, providerLogins: ["claude", "codex"] },
};

describe("the agent's own engine needs a sign-in", () => {
  it("shows the effective account's sign-in, and the others only on request", async () => {
    const card = await show(ownEngine("claude"), "owner", [
      wire("claude", "office", { effective: true }),
      wire("claude", "personal"),
    ]);
    expect(card.all('[data-chat-sign-in="ownEngine"]').length).toBe(1);
    expect(card.scopes()).toEqual(["office"]);
    expect(
      card.view.queryAllByText(t("settings.signIn.apiKeyNote")).length,
    ).toBe(0);
    await card.click(card.one("[data-other-sign-in-options]"));
    expect(card.scopes().sort()).toEqual(["office", "personal"]);
    expect(
      card.view.queryAllByText(t("settings.signIn.apiKeyNote")).length,
    ).toBe(1);
  });

  it("leads with an expired personal sign-in the agent still uses, not the connected office one", async () => {
    const card = await show(ownEngine("claude"), "owner", [
      wire("claude", "office", { connected: true }),
      wire("claude", "personal", { effective: true }),
    ]);
    expect(card.scopes()).toEqual(["personal"]);
  });

  it("names the sign-in it shows, without the long scope hint", async () => {
    const card = await show(ownEngine("codex"), "owner", [
      wire("codex", "office"),
      wire("codex", "personal", { effective: true }),
    ]);
    expect(card.scopes()).toEqual(["personal"]);
    expect(card.one("[data-sign-in-scope]")?.textContent?.trim()).not.toBe("");
    expect(
      card.view.queryAllByText(t("settings.signIn.personalHint")).length,
    ).toBe(0);
  });

  it("gives a member who cannot change the office sign-in their own sign-in", async () => {
    const card = await show(ownEngine("claude"), "member", [
      wire("claude", "office", { effective: true }),
      wire("claude", "personal"),
    ]);
    expect(card.scopes()).toEqual(["personal"]);
    expect(card.all("[data-ask-office-owner]").length).toBe(0);
  });

  it("keeps the office sign-in, with ask-the-owner, when a personal sign-in would not move the agent", async () => {
    // The member set their own directory: a personal sign-in there does not
    // switch the agent off the office account.
    const card = await show(ownEngine("claude"), "member", [
      wire("claude", "office", { effective: true }),
      wire("claude", "personal", { explicitDirectory: true }),
    ]);
    expect(card.scopes()).toEqual(["office"]);
    expect(card.all("[data-ask-office-owner]").length).toBe(1);
  });
});

describe("OpenCode's free limit", () => {
  const rows = (card: Awaited<ReturnType<typeof show>>) =>
    card
      .all("[data-chat-sign-in-row]")
      .map((row) => [row.dataset.chatSignInRow, row.dataset.rowState]);

  it("shows one card with a row per engine, signed-in first, and no sign-in sections", async () => {
    const card = await show(freeLimit, "owner", [
      wire("claude", "office", { effective: true }),
      wire("claude", "personal"),
      wire("codex", "office", { connected: true, effective: true }),
      wire("codex", "personal"),
    ]);
    expect(card.all('[data-chat-sign-in="freeLimit"]').length).toBe(1);
    expect(
      card
        .one('[data-chat-sign-in="freeLimit"]')
        ?.closest('[data-chat-export="omit"]'),
    ).not.toBeNull();
    expect(rows(card)).toEqual([
      ["codex", "signedIn"],
      ["claude", "notSignedIn"],
    ]);
    expect(
      card.all("[data-switch-engine]").map((b) => b.dataset.switchEngine),
    ).toEqual(["codex"]);
    expect(
      card.all("[data-row-sign-in]").map((b) => b.dataset.rowSignIn),
    ).toEqual(["claude"]);
    expect(card.scopes().length).toBe(0);
    expect(
      card.view.queryAllByText(t("settings.signIn.apiKeyNote")).length,
    ).toBe(0);
    expect(
      card.view.queryAllByRole("button", {
        name: t("settings.signIn.startConversation"),
      }).length,
    ).toBe(0);
  });

  it("keeps its rows while the accounts load, with every control disabled and no state claimed", async () => {
    // AGENTS.md UI rules: a view draws its real controls, disabled, until the
    // data arrives. No account has arrived yet.
    const card = await show(freeLimit, "owner", []);
    expect(
      card
        .all("[data-chat-sign-in-row]")
        .map((row) => [row.dataset.chatSignInRow, row.dataset.rowState]),
    ).toEqual([
      ["claude", "loading"],
      ["codex", "loading"],
    ]);
    const buttons = card.all('[data-chat-sign-in="freeLimit"] button');
    expect(buttons.length).toBeGreaterThan(0);
    expect(
      buttons.filter((b) => !(b as HTMLButtonElement).disabled).length,
    ).toBe(0);
  });

  it("counts an engine as signed in only when the account the agent would use is connected", async () => {
    // Claude: the office account is connected, but the agent would use the
    // member's personal one, which is active and expired.
    const card = await show(freeLimit, "owner", [
      wire("claude", "office", { connected: true }),
      wire("claude", "personal", { effective: true }),
      wire("codex", "office", { effective: true }),
      wire("codex", "personal"),
    ]);
    expect(rows(card)).toContainEqual(["claude", "notSignedIn"]);
    expect(card.all("[data-switch-engine]").length).toBe(0);
  });

  it("switches the agent to the engine, and both switches wait for the answer", async () => {
    const card = await show(freeLimit, "owner", [
      wire("claude", "office", { connected: true, effective: true }),
      wire("codex", "office", { connected: true, effective: true }),
    ]);
    const calls: [string, string, unknown][] = [];
    let answer!: () => void;
    setApiShim((method, path, body) => {
      calls.push([method, path, body]);
      return new Promise((resolve) => {
        answer = () => resolve({});
      });
    });
    await card.click(card.one('[data-switch-engine="claude"]'));
    expect(calls).toEqual([
      ["PATCH", `/api/agents/${card.agent.id}`, { agentType: "claude" }],
    ]);
    expect(
      card
        .all("[data-switch-engine]")
        .map((b) => [
          b.dataset.switchEngine,
          (b as HTMLButtonElement).disabled,
        ]),
    ).toEqual([
      ["claude", true],
      ["codex", true],
    ]);
    await act(async () => answer());
  });

  it("shows a refused switch's reason on its row, and the row can try again", async () => {
    const card = await show(freeLimit, "owner", [
      wire("claude", "office", { connected: true, effective: true }),
      wire("codex", "office", { connected: true, effective: true }),
    ]);
    const reason = "server-refusal-reason";
    setApiShim(async () => {
      throw new ApiError(422, "engine_below_standard", reason);
    });
    await card.click(card.one('[data-switch-engine="codex"]'));
    expect(card.one('[data-switch-error="codex"]')?.textContent).toContain(
      reason,
    );
    expect(card.all("[data-switch-error]").length).toBe(1);
    expect(
      (card.one('[data-switch-engine="codex"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  for (const [role, scope] of [
    ["owner", "office"],
    ["member", "personal"],
  ] as const) {
    it(`opens one ${scope} sign-in for an office ${role}, and the row turns to Switch once it connects`, async () => {
      const card = await show(freeLimit, role, [
        wire("claude", "office", { connected: true, effective: true }),
        wire("codex", "office", { effective: true }),
        wire("codex", "personal"),
      ]);
      expect(card.all("[data-provider-card]").length).toBe(0);
      await card.click(card.one('[data-row-sign-in="codex"]'));
      expect(
        card.all("[data-provider-card]").map((c) => c.dataset.providerCard),
      ).toEqual(["codex"]);
      expect(card.scopes()).toEqual([scope]);
      await card.push([
        wire("claude", "office", { connected: true, effective: true }),
        wire("codex", "office", {
          connected: scope === "office",
          effective: scope === "office",
        }),
        wire("codex", "personal", {
          connected: scope === "personal",
          effective: scope === "personal",
        }),
      ]);
      expect(
        card.all("[data-switch-engine]").map((b) => b.dataset.switchEngine),
      ).toContain("codex");
    });
  }
});
