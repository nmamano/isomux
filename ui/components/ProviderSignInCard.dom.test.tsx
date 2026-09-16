import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ProviderSignInCard } = await import("./ProviderSignInCard.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
afterAll(() => setApiShim(null));

it("keeps browser sign-in available when the account check is unavailable", () => {
  const view = render(
    createElement(ProviderSignInCard, {
      provider: "codex",
      scopes: ["office"],
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
  expect(
    view.container.querySelector("[data-cancel-shared-login]"),
  ).toBeNull();
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

it("clears local waiting controls when a confirmed server slot disappears", async () => {
  const originalOpen = window.open;
  window.open = () =>
    ({
      close() {},
      location: { href: "" },
      opener: null,
    }) as unknown as Window;
  try {
    const idle = {
      provider: "claude" as const,
      scope: "office" as const,
      accountStatus: "not_connected" as const,
      loginStatus: "idle" as const,
      canBrowserLogin: true,
    };
    const waiting = { ...idle, loginStatus: "waiting_external" as const };
    const refreshed = [waiting];
    setApiShim(async (_method, path) => {
      if (path.endsWith("/login"))
        return { account: waiting, authUrl: "https://example.test/login" };
      if (path.endsWith("/refresh")) return { accounts: refreshed };
      throw new Error(`unexpected ${path}`);
    });
    const card = (account: typeof idle | typeof waiting) =>
      createElement(ProviderSignInCard, {
        provider: "claude",
        scopes: ["office"],
        accounts: [account],
      });
    const view = render(card(idle));
    await act(async () => {
      fireEvent.click(
        view.container.querySelector("[data-start-provider-login]")!,
      );
    });
    expect(
      view.container.querySelector("[data-own-login-controls]"),
    ).not.toBeNull();

    await act(async () => view.rerender(card(waiting)));
    await act(async () => view.rerender(card(idle)));
    expect(
      view.container.querySelectorAll("[data-own-login-controls]").length,
    ).toBe(0);
  } finally {
    window.open = originalOpen;
  }
});

it("keeps local waiting controls when the server never confirms the slot", async () => {
  const originalOpen = window.open;
  window.open = () =>
    ({
      close() {},
      location: { href: "" },
      opener: null,
    }) as unknown as Window;
  try {
    const idle = {
      provider: "claude" as const,
      scope: "office" as const,
      accountStatus: "not_connected" as const,
      loginStatus: "idle" as const,
      canBrowserLogin: true,
    };
    const interrupted = {
      ...idle,
      loginStatus: "interrupted" as const,
    };
    setApiShim(async (_method, path) => {
      if (path.endsWith("/login"))
        return {
          account: { ...idle, loginStatus: "waiting_external" as const },
          authUrl: "https://example.test/login",
        };
      if (path.endsWith("/refresh")) return { accounts: [idle] };
      throw new Error(`unexpected ${path}`);
    });
    const card = (account: typeof idle | typeof interrupted) =>
      createElement(ProviderSignInCard, {
        provider: "claude",
        scopes: ["office"],
        accounts: [account],
      });
    const view = render(card(interrupted));
    await act(async () => {
      fireEvent.click(
        view.container.querySelector("[data-start-provider-login]")!,
      );
    });
    await act(async () => view.rerender(card(idle)));
    expect(
      view.container.querySelector("[data-own-login-controls]"),
    ).not.toBeNull();
  } finally {
    window.open = originalOpen;
  }
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
      fireEvent.click(view.getByRole("button", { name: "Submit code" }));
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
        }),
      );
    });
    if (late) {
      await act(async () => {
        rejectCallback(new ApiError(502, "provider_error", rejection));
      });
    }
    expect(
      view.getByText(/Connected as person@example.test/).textContent,
    ).toContain("Connected as");
    expect(view.queryByRole("alert") === null).toBe(true);
    expect(
      view.getByRole("button", { name: "Start a new conversation" }) !== null,
    ).toBe(true);
    // A new operational failure must still be visible while connected.
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Sign out" }));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Confirm sign out" }));
    });
    expect(view.getByRole("alert").textContent).toBe("Sign-out failed");
    // The old rejection must have been cleared, not merely hidden by Connected.
    await act(async () => {
      view.rerender(card({ loginStatus: "idle" }));
    });
    expect(view.queryByText(rejection) === null).toBe(true);
  });
}
