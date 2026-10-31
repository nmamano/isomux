// The ask's id on its card (task 03f5c534): a member reads it off the card
// and gives it to another agent, which reads the ask with GET /api/asks/:askId.
// A tap copies the bare id. AskCard is the card of the chat stack and of the
// Inbox, for a reply ask and for a secret request.
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AskCard } = await import("./AskCard.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;

const NOW = Date.now();
const REPLY_ASK: AskEntry = {
  id: "ab12cd34",
  agentId: "a1",
  memberUserId: "u1",
  prompt: "Ship it?",
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
};
const SECRET_ASK: AskEntry = {
  ...REPLY_ASK,
  id: "ef56ab78",
  prompt: "To open the pull request.",
  secret: {
    requestId: "req-1",
    scope: "personal",
    name: "GH_TOKEN",
    hosts: ["api.github.com"],
    form: { kind: "authorization" },
    reason: "To open the pull request.",
  },
};

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});
beforeEach(() => setApiShim(async () => undefined));
afterAll(() => setApiShim(null));

let copied: string[] = [];
const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
});
afterEach(() => {
  if (realClipboard)
    Object.defineProperty(navigator, "clipboard", realClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

function Seed({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({
      type: "users_list",
      users: [
        {
          id: "u1",
          name: "alice",
          role: "member",
          avatarColor: "#336699",
          avatarVariant: 0,
          createdAt: 1,
        },
      ] as unknown as import("../../shared/types.ts").UserPublicWire[],
    });
    dispatch({
      type: "session_context",
      context: {
        userId: "u1",
        username: "alice",
        role: "member",
      } as import("../../shared/types.ts").SessionContext,
    });
  }, [dispatch]);
  return <>{children}</>;
}

// The one button on the card whose text holds the id.
function idButton(view: ReturnType<typeof render>, id: string) {
  const buttons = [
    ...view.container.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((b) => b.textContent?.includes(id));
  expect(buttons.map((b) => b.textContent?.includes(id))).toEqual([true]);
  return buttons[0];
}

for (const entry of [REPLY_ASK, SECRET_ASK]) {
  for (const isMobile of [false, true]) {
    const kind = entry.secret ? "secret request" : "reply ask";
    const where = isMobile ? "phone" : "desktop";
    it(`shows the id on a ${kind} (${where}), and a tap copies the bare id`, async () => {
      const view = render(
        <StoreProvider>
          <Seed>
            <AskCard entry={entry} isMobile={isMobile} />
          </Seed>
        </StoreProvider>,
      );
      await waitFor(() =>
        expect(
          view.container.querySelector(`[data-ask="${entry.id}"]`),
        ).not.toBe(null),
      );
      const button = idButton(view, entry.id);
      // Not a word to translate.
      expect(button.closest(".notranslate")).not.toBe(null);
      const before = button.title;
      expect(before).not.toBe("");
      await act(async () => {
        fireEvent.click(button);
      });
      expect(copied).toEqual([entry.id]);
      // The tap tells the member it copied.
      await waitFor(() =>
        expect(idButton(view, entry.id).title).not.toBe(before),
      );
      view.unmount();
    });
  }
}
