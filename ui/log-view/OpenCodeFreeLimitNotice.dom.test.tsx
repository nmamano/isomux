// Task a5c551e4: the office's notice for OpenCode's free usage limit. On an
// agent the office seeded (metadata.providerLogins), the agent's owner gets
// one card under it to switch the agent to Claude or Codex (task 3abb740b;
// its rows are ChatSignInCard.dom.test.tsx's); anyone else gets the line
// that asks the office owner, and no card.
import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";

setUpDomTestFile();
const { act, cleanup, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StoreProvider } = await import("../store.tsx");
const { LogView } = await import("./LogView.tsx");
const { setShim, shimEmit, connect } = await import("../ws.ts");
const { setApiShim } = await import("../api.ts");
const { t } = (await import("../../shared/i18n/translate.ts")).translatorFor(
  "en",
);
setShim(() => {});
setApiShim(async () => ({}));
afterEach(() => cleanup());
afterAll(() => {
  setApiShim(null);
  setShim(() => {});
  connect(
    () => {},
    () => {},
  );
});

const OWNER = "office-owner";
const agent = {
  id: "free-agent",
  name: "Free Welcome Agent",
  userId: OWNER,
  username: "Owner",
  agentType: "opencode",
  roomId: "room",
  cwd: "/tmp",
  state: "waiting_for_response",
  permissionMode: "default",
  modelFamily: "opencode/free-model",
  effort: "high",
  topic: null,
  sessionId: null,
  customPrompt: null,
  outfit: {},
  capabilities: DEFAULT_AGENT_CAPABILITIES,
} as unknown as Parameters<typeof LogView>[0]["agent"];

async function show(
  viewer: { userId: string; role: "owner" | "member" },
  providerLogins?: ("claude" | "codex")[],
) {
  const view = render(
    createElement(StoreProvider, {
      children: createElement(LogView, {
        agent,
        logs: [
          {
            id: "free-limit",
            agentId: agent.id,
            timestamp: Date.now(),
            kind: "system" as const,
            content: "OpenCode's free usage limit is used up.",
            metadata: {
              openCodeFreeLimit: true,
              ...(providerLogins ? { providerLogins } : {}),
            },
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
      context: { username: "Viewer", ...viewer },
    } as never);
    // The owner is already signed in to Claude: a connected card.
    shimEmit({
      type: "provider_accounts_updated",
      accounts: [
        {
          provider: "claude",
          scope: "personal",
          accountStatus: "connected",
          loginStatus: "idle",
          canBrowserLogin: true,
          effective: true,
        },
      ],
    });
  });
  const cards = [
    ...view.container.querySelectorAll<HTMLElement>("[data-chat-sign-in]"),
  ];
  return {
    cards: cards.map((c) => c.dataset.chatSignIn),
    exported: cards.filter((c) => !c.closest('[data-chat-export="omit"]'))
      .length,
    asks: view.queryAllByText(t("settings.signIn.askOfficeOwner")).length,
    // A new conversation of this OpenCode agent stays on the same limit.
    newConversation: view.queryAllByRole("button", {
      name: t("settings.signIn.startConversation"),
    }).length,
  };
}

it("shows the agent's owner one card to switch engines, kept out of the chat export", async () => {
  const shown = await show({ userId: OWNER, role: "owner" }, [
    "claude",
    "codex",
  ]);
  expect(shown.cards).toEqual(["freeLimit"]);
  expect(shown.exported).toBe(0);
  expect(shown.asks).toBe(0);
  expect(shown.newConversation).toBe(0);
});

it("tells anyone else to ask the office owner, with no card", async () => {
  const shown = await show({ userId: "visitor", role: "member" }, [
    "claude",
    "codex",
  ]);
  expect(shown.cards).toEqual([]);
  expect(shown.asks).toBe(1);
});

it("shows the notice alone on an agent the office did not seed", async () => {
  const shown = await show({ userId: OWNER, role: "owner" });
  expect(shown.cards).toEqual([]);
  expect(shown.asks).toBe(0);
});
