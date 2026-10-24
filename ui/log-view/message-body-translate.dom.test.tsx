// What a member or agent wrote stays out of browser page translation, while the
// chrome around it, in the reader's language, stays translatable (task
// bb040257). The queued message, the ask card and the document language are
// asserted with their own surfaces: ui/logview.i18n.dom.test.tsx,
// ui/log-view/AsksStack.dom.test.tsx and ui/i18n.dom.test.tsx.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { LogEntryCard, UserMessage } = await import("./LogEntryCard.tsx");
const { PinnedMessageStrip } =
  await import("../members-chat/PinnedMessageStrip.tsx");
const { ReplyQuote } = await import("../members-chat/ReplyQuote.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

// The nearest translate attribute decides (HTML spec); none means translate.
const translated = (element: Element) =>
  element.closest("[translate]")?.getAttribute("translate") !== "no";

const BODY = "funcionen be";

it("keeps a chat message's body untranslated in both chats, and not its surroundings", () => {
  // The agent chat: a member's message with content above and below the body.
  const agentChat = render(
    onLanguage(
      "ca",
      <UserMessage
        content={BODY}
        username="Carles"
        beforeContent={<span>above</span>}
        footer={<span>below</span>}
      />,
    ),
  );
  expect(translated(agentChat.getByText(BODY))).toBe(false);
  expect(translated(agentChat.getByText("above"))).toBe(true);
  expect(translated(agentChat.getByText("below"))).toBe(true);
  agentChat.unmount();

  // The members chat renders its Markdown into the same body, with its
  // reaction beside it.
  const membersChat = render(
    onLanguage(
      "ca",
      <UserMessage
        variant="members-chat"
        content={`**${BODY}**`}
        username="Carles"
        renderedContent={<strong>{BODY}</strong>}
        inlineAccessory={<button type="button">reaction</button>}
      />,
    ),
  );
  expect(translated(membersChat.getByText(BODY))).toBe(false);
  expect(translated(membersChat.getByText("reaction"))).toBe(true);
  membersChat.unmount();
});

it("keeps an agent's reply untranslated", () => {
  const view = render(
    onLanguage(
      "ca",
      <LogEntryCard
        entry={{
          id: "t1",
          agentId: "agent",
          timestamp: 1,
          kind: "text",
          content: BODY,
        }}
      />,
    ),
  );
  expect(translated(view.getByText(BODY))).toBe(false);
  view.unmount();
});

it("keeps a pinned message's excerpt untranslated, and not the pin header", () => {
  const view = render(
    onLanguage(
      "ca",
      <PinnedMessageStrip
        message={{
          id: "202609-00000001",
          kind: "user",
          userId: "u1",
          userName: "Carles",
          content: BODY,
          attachments: [],
          timestamp: 1,
        }}
        count={3}
        author="Carles"
        loaded
        onJump={() => {}}
        onUnpin={() => {}}
      />,
    ),
  );
  const excerpt = view.getByText(BODY);
  expect(translated(excerpt)).toBe(false);
  // The header is the line above the excerpt: the pin count in Catalan, then
  // the author's name.
  const header = excerpt.previousElementSibling!;
  expect(header.textContent).toContain("Carles");
  expect(translated(header)).toBe(true);
  view.unmount();
});

it("keeps a reply quote's author and excerpt untranslated", () => {
  const view = render(
    onLanguage(
      "ca",
      <ReplyQuote
        reply={{ id: "202609-00000001", userName: "Carles", excerpt: BODY }}
      />,
    ),
  );
  expect(translated(view.getByText(BODY))).toBe(false);
  expect(translated(view.getByText("Carles"))).toBe(false);
  view.unmount();
});
