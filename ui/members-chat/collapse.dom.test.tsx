import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { MembersChatPanel } = await import("./MembersChatPanel.tsx");
const base = {
  id: "202609-ffffffff",
  userId: "sam",
  userName: "Sam",
  kind: "user" as const,
  device: "Laptop",
  timestamp: 1788973200000,
  content: "First",
  attachments: [],
};
it("groups only adjacent messages from the same author, kind and device within five minutes, keeping each time", () => {
  const messages = [
    base,
    {
      ...base,
      id: "202609-00000001",
      content: "Second",
      timestamp: base.timestamp + 300000,
    },
    {
      ...base,
      id: "202609-00000002",
      content: "Third",
      timestamp: base.timestamp + 600000,
    },
    {
      ...base,
      id: "202609-00000003",
      content: "Later",
      timestamp: base.timestamp + 900001,
    },
    {
      ...base,
      id: "202609-00000004",
      userId: "alex",
      userName: "Alex",
      content: "Other person",
      timestamp: base.timestamp + 900002,
    },
    {
      ...base,
      id: "202609-00000005",
      device: "Phone",
      content: "Other device",
      timestamp: base.timestamp + 900003,
    },
    {
      ...base,
      id: "202609-00000006",
      content: "Back on laptop",
      timestamp: base.timestamp + 900004,
    },
    {
      ...base,
      id: "202609-00000007",
      kind: "api" as const,
      content: "API",
      timestamp: base.timestamp + 900005,
    },
    {
      ...base,
      id: "202609-00000008",
      kind: "api" as const,
      content: "API again",
      timestamp: base.timestamp + 900006,
    },
  ];
  const view = render(
    onLanguage("en", createElement(MembersChatPanel), {
      membersChat: {
        messages,
        loaded: false,
        hasMore: false,
        readPointer: null,
        unread: 0,
      },
    }),
  );
  const cards = [
    ...view.container.querySelectorAll<HTMLDivElement>(
      "[data-members-chat-message]",
    ),
  ];
  expect(
    cards.map((card) => !!card.querySelector("[data-members-chat-author]")),
  ).toEqual([true, false, false, true, true, true, true, true, true]);
  expect(
    cards[0].querySelector("[data-members-chat-author]")!.textContent,
  ).toBe(cards[0].title);
  expect(cards[0].title).toContain("Sam");
  expect(cards[1].title).toContain("Sam");
  expect(cards[1].title === cards[0].title).toBe(false);
  expect(cards[1].textContent).toContain("Second");
});
