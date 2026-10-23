import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { MembersChatPanel } = await import("./MembersChatPanel.tsx");
const { ThumbsUpReaction } = await import("./ThumbsUpReaction.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const en = translatorFor("en");
afterAll(() => setApiShim(null));

it("closes an outside menu, closes Edit, and closes confirmed Delete even when its request fails", async () => {
  const messages = [1, 2].map((n) => ({
    id: `202609-0000000${n}`,
    kind: "user" as const,
    userId: "u1",
    userName: "Tester",
    content: `message ${n}`,
    attachments: [],
    timestamp: n,
  }));
  setApiShim(async () => {
    throw new ApiError(500, "failed", "");
  });
  const view = render(
    onLanguage("en", createElement(MembersChatPanel), {
      membersChat: {
        messages,
        loaded: true,
        hasMore: false,
        readPointer: messages[1].id,
        unread: 0,
      },
    }),
  );
  const menus = Array.from(view.container.querySelectorAll("details"));
  const summaries = view.getAllByLabelText(en.t("membersChat.actions"));
  fireEvent.click(summaries[0]);
  expect(menus[0].open).toBe(true);
  fireEvent.click(summaries[1]);
  expect(menus[0].open).toBe(false);
  expect(menus[1].open).toBe(true);
  fireEvent.click(view.getByRole("textbox"));
  expect(menus[1].open).toBe(false);
  fireEvent.click(summaries[0]);
  fireEvent.click(view.getAllByTitle(en.t("common.edit"))[0]);
  expect(view.container.querySelector("details[open]") === null).toBe(true);
  fireEvent.click(view.getByRole("button", { name: en.t("common.cancel") }));
  const summary = view.getAllByLabelText(en.t("membersChat.actions"))[0];
  fireEvent.click(summary);
  fireEvent.click(view.getAllByTitle(en.t("common.delete"))[0]);
  expect(summary.closest("details")!.open).toBe(true);
  await act(async () =>
    fireEvent.click(view.getByTitle(en.t("membersChat.deleteAgain"))),
  );
  expect(summary.closest("details")!.open).toBe(false);
  expect(view.getByRole("alert").textContent).toContain(
    en.t("membersChat.deleteFailed"),
  );
});

it("groups only adjacent messages from the same author, kind and device within five minutes, keeping each time", () => {
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

it("toggles desired state and shows the reactor names by focus, hover and tap", async () => {
  const calls: boolean[] = [];
  const names = ["Helper", "Sam"];
  function Fixture() {
    const [active, setActive] = useState(false);
    return createElement(ThumbsUpReaction, {
      active,
      isMobile: true,
      names: active ? names : [],
      onChange: async (next) => {
        calls.push(next);
        setActive(next);
      },
    });
  }
  const view = render(onLanguage("en", createElement(Fixture)));
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { name: en.t("membersChat.thumbsUp") }),
    ),
  );
  expect(calls).toEqual([true]);
  expect(
    view
      .getByRole("button", { name: en.t("membersChat.removeThumbsUp") })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  const countName = en.t("membersChat.reactors", { count: 2 });
  const count = view.getByRole("button", { name: countName });
  const joined = count.getAttribute("title")!;
  for (const name of names) expect(joined).toContain(name);
  fireEvent.focus(count);
  expect(view.getByText(joined).textContent).toBe(joined);
  fireEvent.keyDown(count, { key: "Escape" });
  expect(view.queryByText(joined) === null).toBe(true);
  fireEvent.pointerEnter(count, { pointerType: "mouse" });
  expect(view.getByText(joined).textContent).toBe(joined);
  fireEvent.pointerLeave(count, { pointerType: "mouse" });
  expect(view.queryByText(joined) === null).toBe(true);
  fireEvent.pointerEnter(count, { pointerType: "touch" });
  fireEvent.pointerLeave(count, { pointerType: "touch" });
  fireEvent.click(count);
  fireEvent.mouseLeave(count);
  expect(view.getByText(joined).textContent).toBe(joined);
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { name: en.t("membersChat.removeThumbsUp") }),
    ),
  );
  expect(calls).toEqual([true, false]);
  expect(view.queryByRole("button", { name: countName }) === null).toBe(true);
});
