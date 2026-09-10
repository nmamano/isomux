import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StoreProvider } = await import("../store.tsx");
const { LogView } = await import("./LogView.tsx");
const { setShim, shimEmit, connect } = await import("../ws.ts");
const { setApiShim } = await import("../api.ts");
setShim(() => {});
setApiShim(async () => ({}));
afterAll(() => {
  setApiShim(null);
  setShim(() => {});
  connect(
    () => {},
    () => {},
  );
});

it("applies pushed full account snapshots to an already mounted chat card", async () => {
  const agent = {
    id: "auth-agent",
    name: "Claude test",
    userId: "auth-owner",
    username: "Owner",
    agentType: "claude",
    roomId: "room",
    cwd: "/tmp",
    state: "waiting_for_response",
    permissionMode: "default",
    modelFamily: "claude-opus-5",
    effort: "high",
    topic: null,
    sessionId: null,
    customPrompt: null,
    outfit: {},
  } as unknown as Parameters<typeof LogView>[0]["agent"];
  const logs = [
    {
      id: "signin",
      agentId: agent.id,
      timestamp: Date.now(),
      kind: "system" as const,
      content: "Sign in",
      metadata: { providerLogin: "claude" },
    },
  ];
  const view = render(
    createElement(StoreProvider, {
      children: createElement(LogView, {
        agent,
        logs,
        onBack: () => {},
        onEditAgent: () => {},
      }),
    }),
  );
  await act(async () => {
    shimEmit({
      type: "session_context",
      context: { userId: "auth-owner", username: "Owner", role: "owner" },
    } as never);
    shimEmit({
      type: "provider_accounts_updated",
      accounts: [
        {
          provider: "claude",
          scope: "office",
          accountStatus: "not_connected",
          loginStatus: "idle",
          canBrowserLogin: true,
        },
        {
          provider: "claude",
          scope: "personal",
          accountStatus: "not_connected",
          loginStatus: "idle",
          canBrowserLogin: true,
        },
      ],
    });
  });
  expect(view.getAllByRole("button", { name: /^Sign in$/ })).toHaveLength(2);
  await act(async () => {
    shimEmit({
      type: "provider_accounts_updated",
      accounts: [
        {
          provider: "claude",
          scope: "office",
          accountStatus: "not_connected",
          loginStatus: "waiting_external",
          canBrowserLogin: true,
        },
        {
          provider: "claude",
          scope: "personal",
          accountStatus: "not_connected",
          loginStatus: "idle",
          canBrowserLogin: true,
        },
      ],
    });
  });
  expect(view.getByText(/Waiting for provider…/)).toBeDefined();
  await act(async () => {
    shimEmit({
      type: "provider_accounts_updated",
      accounts: [
        {
          provider: "claude",
          scope: "office",
          accountStatus: "connected",
          accountLabel: "probe@example.test",
          loginStatus: "succeeded",
          canBrowserLogin: true,
        },
        {
          provider: "claude",
          scope: "personal",
          accountStatus: "not_connected",
          loginStatus: "idle",
          canBrowserLogin: true,
        },
      ],
    });
  });
  expect(view.getByText(/Connected as probe@example.test/)).toBeDefined();
  expect(view.getAllByRole("button", { name: /^Sign in$/ })).toHaveLength(1);
  // A refreshed connected account has idle login status. The auth-error card
  // must still expose the existing clear action.
  await act(async () => {
    shimEmit({
      type: "provider_accounts_updated",
      accounts: [
        {
          provider: "claude",
          scope: "personal",
          accountStatus: "connected",
          loginStatus: "idle",
          canBrowserLogin: true,
        },
      ],
    });
  });
  let cleared = false;
  setApiShim(async (method, path) => {
    cleared =
      method === "POST" && path === `/api/agents/${agent.id}/new-conversation`;
    return {};
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: "Start a new conversation" }),
    );
  });
  expect(cleared).toBe(true);
});
