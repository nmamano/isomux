import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import type { ProviderAccountWire } from "../../shared/types.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ProviderSignInCard } = await import("./ProviderSignInCard.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { StoreProvider, useAppState } = await import("../store.tsx");
const { setShim, shimEmit } = await import("../ws.ts");
const { useProviderAccounts } =
  await import("../integrations/ProvidersSection.tsx");
const t = translatorFor("en").t;
// No server: the store's connect() fires no message; pushes go by shimEmit.
setShim(
  () => {},
  () => {},
);
afterAll(() => {
  setApiShim(null);
  setShim(null);
});

it("keeps browser sign-in available when the account check is unavailable", () => {
  const view = render(
    createElement(ProviderSignInCard, {
      provider: "codex",
      scopes: ["office"],
      canChangeOffice: true,
      accounts: [
        {
          provider: "codex",
          scope: "office",
          accountStatus: "unavailable",
          loginStatus: "idle",
          canBrowserLogin: true,
          error: "",
        },
      ],
    }),
  );

  expect(
    view.container.querySelector("[data-start-provider-login]"),
  ).not.toBeNull();
});

it("shows a shared login queue to members and reserves its cancel control for owners", async () => {
  const account = {
    provider: "claude" as const,
    scope: "office" as const,
    accountStatus: "not_connected" as const,
    loginStatus: "waiting_external" as const,
    canBrowserLogin: true,
    loginQueue: {
      holderName: "Ana",
      startedAt: Date.now() - 4 * 60_000,
    },
  };
  const card = (canCancelSharedLogin: boolean) =>
    createElement(ProviderSignInCard, {
      provider: "claude",
      scopes: ["office"],
      accounts: [account],
      canCancelSharedLogin,
    });
  const view = render(card(false));
  const queue = view.container.querySelector("[data-provider-login-queue]")!;
  expect(queue.textContent).toContain("Ana");
  expect(queue.textContent).toContain("Claude");
  expect(queue.textContent).toContain("4");
  expect(view.container.querySelector("[data-cancel-shared-login]")).toBeNull();
  expect(view.container.querySelector("[data-own-login-controls]")).toBeNull();
  expect(
    view.container.querySelector("[data-start-provider-login]"),
  ).toBeNull();

  let canceled = false;
  setApiShim(async (_method, path) => {
    if (path.endsWith("/cancel")) {
      canceled = true;
      return { canceled: true };
    }
    if (path.endsWith("/refresh")) return { accounts: [] };
    throw new Error(`unexpected ${path}`);
  });
  view.rerender(card(true));
  await act(async () => {
    fireEvent.click(
      view.container.querySelector("[data-cancel-shared-login]")!,
    );
  });
  expect(canceled).toBe(true);
});

it("composes a provider-aware queue explanation from structured 409 data", async () => {
  setApiShim(async (_method, path) => {
    if (path.endsWith("/login"))
      throw new ApiError(409, "shared_login_in_progress", "Conflict", {
        code: "shared_login_in_progress",
        holderName: "Ana",
        startedAt: Date.now() - 4 * 60_000,
      });
    throw new Error(`unexpected ${path}`);
  });
  const view = render(
    createElement(ProviderSignInCard, {
      provider: "claude",
      scopes: ["office"],
      canChangeOffice: true,
      accounts: [
        {
          provider: "claude",
          scope: "office",
          accountStatus: "not_connected",
          loginStatus: "idle",
          canBrowserLogin: true,
        },
      ],
    }),
  );
  await act(async () => {
    fireEvent.click(
      view.container.querySelector("[data-start-provider-login]")!,
    );
  });
  const alert = view.getByRole("alert");
  expect(alert.textContent).toContain("Ana");
  expect(alert.textContent).toContain("Claude");
  expect(alert.textContent).toContain("4");
  expect(alert.textContent).not.toContain("Codex");
});

// The card draws a sign-in from the account it is given, which the store
// holds (task da3fcc0b): the login answer and the server's push both land
// there, so the chat card, whose parent passes the store and nothing else,
// follows the server like the Integrations page.
function stubWindowOpen(): () => void {
  const originalOpen = window.open;
  window.open = () =>
    ({
      close() {},
      location: { href: "" },
      opener: null,
    }) as unknown as Window;
  return () => {
    window.open = originalOpen;
  };
}

function renderInStore(
  props: Omit<Parameters<typeof ProviderSignInCard>[0], "accounts">,
) {
  function StoreParent() {
    const { providerAccounts } = useAppState();
    return createElement(ProviderSignInCard, {
      ...props,
      accounts: providerAccounts,
    });
  }
  return render(
    createElement(StoreProvider, { children: createElement(StoreParent) }),
  );
}

const push = (accounts: ProviderAccountWire[]) =>
  act(async () => {
    shimEmit({ type: "provider_accounts_updated", accounts } as never);
  });

const claudeOffice: ProviderAccountWire = {
  provider: "claude",
  scope: "office",
  accountStatus: "not_connected",
  loginStatus: "idle",
  canBrowserLogin: true,
};
const claudeWaiting: ProviderAccountWire = {
  ...claudeOffice,
  loginStatus: "waiting_external",
  login: { phase: "waiting", authUrl: "https://example.test/login" },
};

it("shows the code field from the login answer alone, and drops it when the server ends the sign-in", async () => {
  const restoreOpen = stubWindowOpen();
  try {
    setApiShim(async (_method, path) => {
      if (path.endsWith("/login"))
        return {
          account: claudeWaiting,
          authUrl: "https://example.test/login",
        };
      throw new Error(`unexpected ${path}`);
    });
    const view = renderInStore({
      provider: "claude",
      scopes: ["office"],
      canChangeOffice: true,
    });
    await push([claudeOffice]);
    await act(async () => {
      fireEvent.click(
        view.container.querySelector("[data-start-provider-login]")!,
      );
    });
    // No push yet: the answer alone draws the waiting sign-in.
    expect(view.queryByRole("textbox")).not.toBeNull();
    expect(
      view.queryByRole("button", { name: t("settings.signIn.copyLink") }),
    ).not.toBeNull();

    // Another tab cancelled it, or it timed out: the server says idle.
    await push([claudeOffice]);
    expect(
      view.container.querySelector("[data-own-login-controls]"),
    ).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
    expect(
      view.container.querySelector("[data-start-provider-login]"),
    ).not.toBeNull();
  } finally {
    restoreOpen();
  }
});

it("keeps the typed code across a push while Claude waits for it, and stops asking once Claude has it", async () => {
  const view = renderInStore({
    provider: "claude",
    scopes: ["office"],
    canChangeOffice: true,
  });
  await push([claudeWaiting]);
  await act(async () => {
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "code#state" },
    });
  });
  // A refresh or another member's change pushes the same sign-in again.
  await push([{ ...claudeWaiting }]);
  expect((view.getByRole("textbox") as HTMLInputElement).value).toBe(
    "code#state",
  );

  // The code went in from another tab, or this page loaded after it did.
  await push([{ ...claudeWaiting, login: { phase: "verifying" } }]);
  expect(view.queryByRole("textbox")).toBeNull();
  expect(
    view.queryByRole("button", { name: t("settings.signIn.submitCode") }),
  ).toBeNull();
  expect(
    view.queryByRole("button", { name: t("settings.signIn.cancelSignIn") }),
  ).not.toBeNull();
  expect(
    view.container
      .querySelector("[data-provider-account-state]")
      ?.getAttribute("data-provider-account-state"),
  ).toBe("waiting");
});

// The push and an HTTP answer travel apart: an answer computed before the
// sign-in ended can land after the push that ended it. Only the push moves
// the card, so the late answer cannot take it back to "verifying".
it("stays connected when an answer older than the success push lands after it", async () => {
  const stale: Array<() => void> = [];
  const verifying = {
    ...claudeWaiting,
    login: { phase: "verifying" as const },
  };
  setApiShim(async (_method, path) => {
    if (path.endsWith("/callback")) return { submitted: true };
    if (path.endsWith("/refresh"))
      return new Promise((resolveRefresh) => {
        stale.push(() => resolveRefresh({ accounts: [verifying] }));
      });
    throw new Error(`unexpected ${path}`);
  });
  const view = renderInStore({
    provider: "claude",
    scopes: ["office"],
    canChangeOffice: true,
    onStartNewConversation: async () => {},
  });
  await push([claudeWaiting]);
  await act(async () => {
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "code#state" },
    });
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: t("settings.signIn.submitCode") }),
    );
  });
  await push([verifying]);
  await push([
    {
      ...claudeOffice,
      accountStatus: "connected",
      loginStatus: "succeeded",
      accountLabel: "owner@example.test",
    },
  ]);
  await act(async () => {
    for (const answer of stale) answer();
  });
  expect(
    view.container
      .querySelector("[data-provider-account-state]")
      ?.getAttribute("data-provider-account-state"),
  ).toBe("connected");
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.container.querySelector("[data-own-login-controls]")).toBeNull();
  expect(
    view.queryByRole("button", {
      name: t("settings.signIn.startConversation"),
    }),
  ).not.toBeNull();
});

// The Integrations page's Refresh: the route pushes its answer, and the
// answer itself can be older than a push that overtook it.
it("does not let a Refresh answer older than a push replace it in the store", async () => {
  let answer!: () => void;
  setApiShim(async (_method, path) => {
    if (path.endsWith("/refresh"))
      return new Promise((resolveRefresh) => {
        answer = () => resolveRefresh({ accounts: [claudeWaiting] });
      });
    if (path === "/api/me/provider-accounts")
      return { accounts: [claudeWaiting] };
    throw new Error(`unexpected ${path}`);
  });
  let refresh!: () => void;
  function Page() {
    const accounts = useProviderAccounts(true);
    refresh = accounts.refresh;
    return createElement(ProviderSignInCard, {
      provider: "claude",
      scopes: ["office"],
      canChangeOffice: true,
      accounts: accounts.accounts,
      loaded: accounts.loaded,
    });
  }
  const view = render(
    createElement(StoreProvider, { children: createElement(Page) }),
  );
  await act(async () => {});
  await act(async () => refresh());
  const connected: ProviderAccountWire = {
    ...claudeOffice,
    accountStatus: "connected",
    loginStatus: "succeeded",
    accountLabel: "owner@example.test",
  };
  await push([connected]);
  await act(async () => answer());
  expect(
    view.container
      .querySelector("[data-provider-account-state]")
      ?.getAttribute("data-provider-account-state"),
  ).toBe("connected");
});

for (const late of [false, true]) {
  it(`clears a rejected code ${late ? "after" : "before"} the successful personal sign-in push`, async () => {
    const rejection =
      "Claude rejected this sign-in code. Click Sign in again and paste the code from the tab that opens.";
    let rejectCallback!: (error: Error) => void;
    setApiShim(async (_method, path) => {
      if (path.endsWith("/callback")) {
        return new Promise((_resolve, reject) => {
          rejectCallback = reject;
        });
      }
      throw new ApiError(502, "provider_error", "Sign-out failed");
    });
    const account = {
      provider: "claude" as const,
      scope: "personal" as const,
      accountStatus: "not_connected" as const,
      loginStatus: "waiting_external" as const,
      canBrowserLogin: true,
      login: {
        phase: "waiting" as const,
        authUrl: "https://example.test/login",
      },
    };
    const card = (overrides: object = {}) =>
      createElement(ProviderSignInCard, {
        provider: "claude",
        scopes: ["personal"],
        accounts: [{ ...account, ...overrides }],
        onStartNewConversation: async () => {},
      });
    const view = render(card());
    await act(async () => {
      fireEvent.change(view.getByRole("textbox"), {
        target: { value: "code#state" },
      });
    });
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: t("settings.signIn.submitCode") }),
      );
    });
    if (!late) {
      await act(async () => {
        rejectCallback(new ApiError(502, "provider_error", rejection));
      });
      expect(view.getByRole("alert").textContent).toBe(rejection);
    }
    await act(async () => {
      view.rerender(
        card({
          accountStatus: "connected",
          loginStatus: "succeeded",
          accountLabel: "person@example.test",
          login: undefined,
        }),
      );
    });
    if (late) {
      await act(async () => {
        rejectCallback(new ApiError(502, "provider_error", rejection));
      });
    }
    expect(
      view.container.querySelector('[data-provider-account-state="connected"]')
        ?.textContent,
    ).toContain(
      t("settings.signIn.connectedAs", { account: "person@example.test" }),
    );
    expect(view.queryByRole("alert")).toBeNull();
    expect(
      view.queryByRole("button", {
        name: t("settings.signIn.startConversation"),
      }),
    ).not.toBeNull();
    // Signed out from another tab: the old rejection must have been
    // cleared, not merely hidden by Connected.
    await act(async () => {
      view.rerender(card({ loginStatus: "idle", login: undefined }));
    });
    expect(view.queryByText(rejection)).toBeNull();
    await act(async () => {
      view.rerender(
        card({
          accountStatus: "connected",
          loginStatus: "succeeded",
          accountLabel: "person@example.test",
          login: undefined,
        }),
      );
    });
    // A new operational failure must still be visible while connected.
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: t("common.signOut") }));
    });
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: t("settings.signIn.confirmSignOut") }),
      );
    });
    expect(view.getByRole("alert").textContent).toBe("Sign-out failed");
    // Nor does it come back after this card's own sign-out.
    await act(async () => {
      view.rerender(card({ loginStatus: "idle", login: undefined }));
    });
    expect(view.queryByText(rejection)).toBeNull();
  });
}

// A sign-out or cancel can push the not-connected account before its POST
// returns: the Sign in button is back while the action still runs. It must
// name that action, never "Signing in…" (task 5b0f2234).
it("names a running sign-out on the Sign in button that the push brings back", async () => {
  let finishSignOut!: () => void;
  const signedOut = {
    provider: "claude" as const,
    scope: "office" as const,
    accountStatus: "not_connected" as const,
    loginStatus: "idle" as const,
    canBrowserLogin: true,
  };
  setApiShim(async (_method, path) => {
    if (path.endsWith("/disconnect"))
      return new Promise((resolveSignOut) => {
        finishSignOut = () => resolveSignOut({ accounts: [signedOut] });
      });
    throw new Error(`unexpected ${path}`);
  });
  const card = (account: object) =>
    createElement(ProviderSignInCard, {
      provider: "claude",
      scopes: ["office"],
      canChangeOffice: true,
      pageLook: true,
      accounts: [account as typeof signedOut],
    });
  const view = render(
    card({
      ...signedOut,
      accountStatus: "connected",
      accountLabel: "office@example.test",
    }),
  );
  await act(async () => {
    fireEvent.click(view.container.querySelector("[data-provider-sign-out]")!);
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: t("settings.signIn.confirmSignOut") }),
    );
  });
  await act(async () => view.rerender(card(signedOut)));
  const button = () =>
    view.container.querySelector<HTMLButtonElement>(
      "[data-start-provider-login]",
    )!;
  expect(button().textContent).toBe(t("settings.signIn.signingOut"));
  expect(button().disabled).toBe(true);

  await act(async () => finishSignOut());
  expect(button().textContent).toBe(t("settings.signIn.signIn"));
  expect(button().disabled).toBe(false);
});

it("does not say signing in while a cancel the push already ended still runs", async () => {
  let finishCancel!: () => void;
  const idle = {
    provider: "claude" as const,
    scope: "office" as const,
    accountStatus: "not_connected" as const,
    loginStatus: "idle" as const,
    canBrowserLogin: true,
  };
  setApiShim(async (_method, path) => {
    if (path.endsWith("/cancel"))
      return new Promise((resolveCancel) => {
        finishCancel = () => resolveCancel({ canceled: true });
      });
    if (path.endsWith("/refresh")) return { accounts: [idle] };
    throw new Error(`unexpected ${path}`);
  });
  const card = (account: object) =>
    createElement(ProviderSignInCard, {
      provider: "claude",
      scopes: ["office"],
      canChangeOffice: true,
      accounts: [account as typeof idle],
    });
  const view = render(
    card({
      ...idle,
      loginStatus: "waiting_external",
      login: { phase: "waiting", authUrl: "https://example.test/login" },
    }),
  );
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: t("settings.signIn.cancelSignIn") }),
    );
  });
  await act(async () => view.rerender(card(idle)));
  const button = () =>
    view.container.querySelector<HTMLButtonElement>(
      "[data-start-provider-login]",
    )!;
  expect(button().textContent).toBe(t("settings.signIn.signIn"));
  expect(button().disabled).toBe(true);

  await act(async () => finishCancel());
  expect(button().textContent).toBe(t("settings.signIn.signIn"));
  expect(button().disabled).toBe(false);
});

it("leaves a member only the status and Test of an office sign-in", () => {
  const account = (
    scope: "office" | "personal",
    accountStatus: "connected" | "not_connected",
  ) => ({
    provider: "codex" as const,
    scope,
    accountStatus,
    accountLabel: accountStatus === "connected" ? "ana@example.com" : undefined,
    loginStatus: "idle" as const,
    canBrowserLogin: true,
  });
  const card = (
    canChangeOffice: boolean,
    accountStatus: "connected" | "not_connected",
    pageLook: boolean,
  ) =>
    createElement(ProviderSignInCard, {
      provider: "codex",
      accounts: [
        account("office", accountStatus),
        account("personal", accountStatus),
      ],
      canChangeOffice,
      pageLook,
    });
  const half = (
    view: ReturnType<typeof render>,
    scope: "office" | "personal",
  ) =>
    view.container.querySelector(`[data-sign-in-scope="${scope}"]`)!
      .parentElement!;
  const controls = (root: Element) => ({
    signIn: !!root.querySelector("[data-start-provider-login]"),
    signOut: !!root.querySelector("[data-provider-sign-out]"),
    test: !!root.querySelector("[data-sign-in-test]"),
    askOwner: !!root.querySelector("[data-ask-office-owner]"),
  });

  // The chat card: signed out.
  const member = render(card(false, "not_connected", false));
  expect(controls(half(member, "office"))).toEqual({
    signIn: false,
    signOut: false,
    test: false,
    askOwner: true,
  });
  expect(controls(half(member, "personal"))).toEqual({
    signIn: true,
    signOut: false,
    test: false,
    askOwner: false,
  });
  member.rerender(card(true, "not_connected", false));
  expect(controls(half(member, "office"))).toEqual({
    signIn: true,
    signOut: false,
    test: false,
    askOwner: false,
  });

  // An owner's sign-in in progress: the queue speaks, not the line.
  member.rerender(
    createElement(ProviderSignInCard, {
      provider: "codex",
      scopes: ["office"],
      accounts: [
        {
          ...account("office", "not_connected"),
          loginStatus: "waiting_external" as const,
          loginQueue: { holderName: "Ana", startedAt: Date.now() },
        },
      ],
    }),
  );
  expect(controls(half(member, "office"))).toEqual({
    signIn: false,
    signOut: false,
    test: false,
    askOwner: false,
  });
  expect(
    member.container.querySelector("[data-provider-login-queue]"),
  ).not.toBeNull();

  // The Integrations page: signed in.
  member.rerender(card(false, "connected", true));
  expect(controls(half(member, "office"))).toEqual({
    signIn: false,
    signOut: false,
    test: true,
    askOwner: false,
  });
  expect(half(member, "office").textContent).toContain("ana@example.com");
  expect(controls(half(member, "personal"))).toEqual({
    signIn: false,
    signOut: true,
    test: true,
    askOwner: false,
  });
  member.rerender(card(true, "connected", true));
  expect(controls(half(member, "office"))).toEqual({
    signIn: false,
    signOut: true,
    test: true,
    askOwner: false,
  });
});

// A member whose permission pack gives environment at read only (task
// 119d0b47): every sign-in route is environment write, so neither scope has a
// control. The chat card's line about an office owner keeps the office rule:
// an owner cannot sign in a member's personal account.
it("leaves a member at environment read the status of each sign-in and no control", async () => {
  const { StateCtx } = await import("../store.tsx");
  const { selfUserRecord, stateWithSelfUser } =
    await import("../test-support/language-fixture.tsx");
  const atLevel = (level: "read" | "write") => {
    const record = {
      ...selfUserRecord("en"),
      role: "member" as const,
      pack: { areas: { environment: level }, agentCeiling: "office" },
    };
    const base = stateWithSelfUser("en");
    return {
      ...base,
      users: new Map([[record.name.toLowerCase(), record]]),
      sessionContext: { ...base.sessionContext!, role: "member" as const },
    } as typeof base;
  };
  const account = (
    scope: "office" | "personal",
    accountStatus: "connected" | "not_connected",
  ) => ({
    provider: "codex" as const,
    scope,
    accountStatus,
    accountLabel: accountStatus === "connected" ? "ana@example.com" : undefined,
    loginStatus: "idle" as const,
    canBrowserLogin: true,
  });
  const card = (
    level: "read" | "write",
    accountStatus: "connected" | "not_connected",
    pageLook: boolean,
  ) =>
    createElement(
      StateCtx.Provider,
      { value: atLevel(level) },
      createElement(ProviderSignInCard, {
        provider: "codex",
        accounts: [
          account("office", accountStatus),
          account("personal", accountStatus),
        ],
        canChangeOffice: false,
        pageLook,
      }),
    );
  const controls = (
    view: ReturnType<typeof render>,
    scope: "office" | "personal",
  ) => {
    const root = view.container.querySelector(
      `[data-sign-in-scope="${scope}"]`,
    )!.parentElement!;
    return {
      signIn: !!root.querySelector("[data-start-provider-login]"),
      signOut: !!root.querySelector("[data-provider-sign-out]"),
      test: !!root.querySelector("[data-sign-in-test]"),
      askOwner: !!root.querySelector("[data-ask-office-owner]"),
      status: !!root.querySelector("[data-provider-account-state]"),
    };
  };
  const none = { signIn: false, signOut: false, test: false };

  // The chat card, signed out: at write the member signs in their own.
  const view = render(card("write", "not_connected", false));
  expect(controls(view, "personal")).toEqual({
    ...none,
    signIn: true,
    askOwner: false,
    status: true,
  });
  view.rerender(card("read", "not_connected", false));
  expect(controls(view, "office")).toEqual({
    ...none,
    askOwner: true,
    status: true,
  });
  expect(controls(view, "personal")).toEqual({
    ...none,
    askOwner: false,
    status: true,
  });

  // The Integrations page, signed in: Test and Sign out at write only.
  view.rerender(card("write", "connected", true));
  expect(controls(view, "office")).toEqual({
    ...none,
    test: true,
    askOwner: false,
    status: true,
  });
  expect(controls(view, "personal")).toEqual({
    ...none,
    signOut: true,
    test: true,
    askOwner: false,
    status: true,
  });
  view.rerender(card("read", "connected", true));
  for (const scope of ["office", "personal"] as const)
    expect(controls(view, scope)).toEqual({
      ...none,
      askOwner: false,
      status: true,
    });
});

// Codex uses an OPENAI_API_KEY in the agents' env over a stored sign-in
// (task a704657a). The card names where the key comes from on both scopes;
// only the personal scope trades "not connected" for the key state, since the
// office scope still tells an owner whether the office has a sign-in.
it("says where Codex agents get OPENAI_API_KEY, next to each scope's sign-in", () => {
  type Source = NonNullable<
    import("../../shared/types.ts").ProviderAccountWire["apiKeySource"]
  >;
  const account = (
    scope: "office" | "personal",
    accountStatus: "connected" | "not_connected",
    apiKeySource?: Source,
  ) => ({
    provider: "codex" as const,
    scope,
    accountStatus,
    accountLabel: accountStatus === "connected" ? "ana@example.com" : undefined,
    loginStatus: "idle" as const,
    canBrowserLogin: true,
    ...(apiKeySource ? { apiKeySource } : {}),
  });
  const card = (
    accountStatus: "connected" | "not_connected",
    apiKeySource: Source | undefined,
    pageLook: boolean,
  ) =>
    createElement(ProviderSignInCard, {
      provider: "codex",
      accounts: [
        account("office", accountStatus, apiKeySource),
        account("personal", accountStatus, apiKeySource),
      ],
      canChangeOffice: true,
      pageLook,
    });
  const half = (
    view: ReturnType<typeof render>,
    scope: "office" | "personal",
  ) =>
    view.container.querySelector(`[data-sign-in-scope="${scope}"]`)!
      .parentElement!;
  const seen = (
    view: ReturnType<typeof render>,
    scope: "office" | "personal",
  ) => {
    const root = half(view, scope);
    const lines = root.querySelectorAll("[data-codex-api-key-source]");
    return {
      state: root
        .querySelector("[data-provider-account-state]")
        ?.getAttribute("data-provider-account-state"),
      source:
        lines.length === 1
          ? lines[0].getAttribute("data-codex-api-key-source")
          : lines.length === 0
            ? null
            : `${lines.length} lines`,
      signIn: !!root.querySelector("[data-start-provider-login]"),
    };
  };

  for (const pageLook of [false, true]) {
    const view = render(card("not_connected", "office_variable", pageLook));
    expect(seen(view, "office")).toEqual({
      state: "not_connected",
      source: "office_variable",
      signIn: true,
    });
    // A sign-in still serves agents once the key is gone.
    expect(seen(view, "personal")).toEqual({
      state: "apiKey",
      source: "office_variable",
      signIn: true,
    });

    view.rerender(card("connected", "member_secret", pageLook));
    expect(seen(view, "office")).toEqual({
      state: "connected",
      source: "member_secret",
      signIn: false,
    });
    expect(seen(view, "personal")).toEqual({
      state: "connected",
      source: "member_secret",
      signIn: false,
    });
    expect(half(view, "personal").textContent).toContain("ana@example.com");

    view.rerender(card("not_connected", undefined, pageLook));
    expect(seen(view, "office")).toEqual({
      state: "not_connected",
      source: null,
      signIn: true,
    });
    expect(seen(view, "personal")).toEqual({
      state: "not_connected",
      source: null,
      signIn: true,
    });
    view.unmount();
  }

  // Each source reads differently, and the line names the variable.
  const sources: Source[] = [
    "server",
    "office_variable",
    "office_secret",
    "member_variable",
    "member_secret",
  ];
  const texts = sources.map((source) => {
    const view = render(card("connected", source, true));
    const text = half(view, "personal").querySelector(
      `[data-codex-api-key-source="${source}"]`,
    )?.textContent;
    view.unmount();
    expect(text).toContain("OPENAI_API_KEY");
    return text;
  });
  expect(new Set(texts).size).toBe(sources.length);
});

// A refused code keeps the field for another paste. A code that reaches no
// sign-in (it ended on the server) leaves the form, so its error never sits
// next to a code field (task 457a18a6). The card that took the code stops
// asking for it on the server's verifying phase (the test above).
{
  const form = (view: ReturnType<typeof render>) => ({
    field: view.queryAllByRole("textbox").length,
    submit: view.queryAllByRole("button", {
      name: t("settings.signIn.submitCode"),
    }).length,
    cancel: view.queryAllByRole("button", {
      name: t("settings.signIn.cancelSignIn"),
    }).length,
    state: view.container
      .querySelector("[data-provider-account-state]")
      ?.getAttribute("data-provider-account-state"),
  });
  async function submit(view: ReturnType<typeof render>) {
    await act(async () => {
      fireEvent.change(view.getByRole("textbox"), {
        target: { value: "code#state" },
      });
    });
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: t("settings.signIn.submitCode") }),
      );
    });
  }

  it("keeps the code field once Claude refused the code", async () => {
    setApiShim(async (_method, path) => {
      if (path.endsWith("/callback"))
        throw new ApiError(502, "provider_error", "Refused");
      throw new Error(`unexpected ${path}`);
    });
    const view = renderInStore({
      provider: "claude",
      scopes: ["office"],
      canChangeOffice: true,
    });
    await push([claudeWaiting]);
    await submit(view);
    expect(view.getByRole("alert").textContent).toBe("Refused");
    expect(form(view)).toEqual({
      field: 1,
      submit: 1,
      cancel: 1,
      state: "waiting",
    });
  });

  for (const started of ["by the push", "on this card"] as const) {
    it(`leaves the form when a code reaches no sign-in started ${started}`, async () => {
      const restoreOpen = stubWindowOpen();
      try {
        let refuse!: () => void;
        setApiShim(async (_method, path) => {
          if (path.endsWith("/login"))
            return {
              account: claudeWaiting,
              authUrl: "https://example.test/login",
            };
          if (path.endsWith("/callback"))
            return new Promise((_resolve, reject) => {
              refuse = () =>
                reject(
                  new ApiError(
                    409,
                    "no_login_in_progress",
                    "No sign-in is in progress.",
                  ),
                );
            });
          throw new Error(`unexpected ${path}`);
        });
        const view = renderInStore({
          provider: "claude",
          scopes: ["office"],
          canChangeOffice: true,
        });
        await push([started === "by the push" ? claudeWaiting : claudeOffice]);
        if (started === "on this card")
          await act(async () => {
            fireEvent.click(
              view.container.querySelector("[data-start-provider-login]")!,
            );
          });
        expect(form(view)).toEqual({
          field: 1,
          submit: 1,
          cancel: 1,
          state: "waiting",
        });
        await submit(view);
        // The sign-in ended on the server (a timeout, another tab) while
        // the code was on its way.
        await push([claudeOffice]);
        expect(form(view)).toEqual({
          field: 0,
          submit: 0,
          cancel: 0,
          state: "not_connected",
        });
        await act(async () => refuse());
        expect(view.getByRole("alert").textContent).toBe(
          "No sign-in is in progress.",
        );
        expect(form(view).field).toBe(0);
        expect(
          view.container.querySelector("[data-start-provider-login]"),
        ).not.toBeNull();
      } finally {
        restoreOpen();
      }
    });
  }
}

// A refused code ends the sign-in with the callback's reason. When the
// account push carries the same reason, the card says it once (task
// 457a18a6).
it("says a refused code's reason once when the push carries it too", async () => {
  const reason = "Refused for a test reason.";
  setApiShim(async (_method, path) => {
    if (path.endsWith("/callback"))
      throw new ApiError(502, "provider_error", reason);
    throw new Error(`unexpected ${path}`);
  });
  const account: ProviderAccountWire = {
    provider: "claude",
    scope: "office",
    accountStatus: "not_connected",
    loginStatus: "waiting_external",
    canBrowserLogin: true,
    login: { phase: "waiting", authUrl: "https://example.test/login" },
  };
  const card = (overrides: Partial<ProviderAccountWire> = {}) =>
    createElement(ProviderSignInCard, {
      provider: "claude",
      scopes: ["office"],
      canChangeOffice: true,
      accounts: [{ ...account, ...overrides }],
    });
  const view = render(card());
  await act(async () => {
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "code#state" },
    });
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: t("settings.signIn.submitCode") }),
    );
  });
  await act(async () => {
    view.rerender(
      card({ loginStatus: "interrupted", error: reason, login: undefined }),
    );
  });
  expect(view.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
    reason,
  ]);
});

// The sign-in link and the device code belong to one sign-in, and they ride
// on its wire: a card mounted while it waits (another tab, a reload) offers
// them, and once the server says it ended the card stops offering them
// (tasks 457a18a6, da3fcc0b).
for (const provider of ["claude", "codex"] as const) {
  it(`offers the ${provider === "claude" ? "sign-in link" : "device code"} of a waiting sign-in from its wire, and drops it once the sign-in ends`, async () => {
    const waiting: ProviderAccountWire = {
      provider,
      scope: "office",
      accountStatus: "not_connected",
      loginStatus: "waiting_external",
      canBrowserLogin: true,
      login: {
        phase: "waiting",
        authUrl: "https://example.test/login",
        userCode: provider === "codex" ? "ABCD-1234" : undefined,
      },
    };
    const card = (account: ProviderAccountWire) =>
      createElement(ProviderSignInCard, {
        provider,
        scopes: ["office"],
        canChangeOffice: true,
        accounts: [account],
      });
    const offered = (view: ReturnType<typeof render>) =>
      provider === "claude"
        ? view.queryAllByRole("button", {
            name: t("settings.signIn.copyLink"),
          }).length
        : view.queryAllByText("ABCD-1234").length;
    const view = render(card(waiting));
    expect(offered(view)).toBe(1);
    await act(async () =>
      view.rerender(
        card({
          ...waiting,
          loginStatus: "interrupted",
          login: undefined,
          error: "Sign-in timed out. Start again.",
        }),
      ),
    );
    expect(
      view.container.querySelector("[data-start-provider-login]"),
    ).not.toBeNull();
    expect(offered(view)).toBe(0);
  });
}
