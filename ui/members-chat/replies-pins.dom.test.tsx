import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { MembersChatPanel } = await import("./MembersChatPanel.tsx");
const { PinnedMessageStrip } = await import("./PinnedMessageStrip.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const en = translatorFor("en");
afterAll(() => setApiShim(null));

const original = {
  id: "202609-00000001",
  kind: "user" as const,
  userId: "u1",
  userName: "Tester",
  content: "**original**",
  attachments: [],
  timestamp: 1,
};
const reply = {
  ...original,
  id: "202609-00000002",
  content: "reply",
  replyTo: { id: original.id, userName: "Tester", excerpt: "**original**" },
};
function replyPanel() {
  return onLanguage("en", createElement(MembersChatPanel), {
    isMobile: true,
    membersChat: {
      messages: [original, reply],
      loaded: true,
      hasMore: false,
      readPointer: reply.id,
      unread: 0,
    },
  });
}

it("quotes plain snapshot text, jumps to a loaded target, sends only its id and cancels a quote", async () => {
  const requests: unknown[] = [];
  setApiShim(async (_method, path, body) => {
    if (path !== "/api/members-chat") throw new Error(path);
    requests.push(body);
    return reply;
  });
  const view = render(replyPanel());
  const anchor = view.container.querySelector<HTMLElement>(
    `#members-chat-${original.id}`,
  )!;
  let scrolled = false;
  anchor.scrollIntoView = () => {
    scrolled = true;
  };
  const quote = view.container.querySelector<HTMLButtonElement>(
    "[data-members-chat-quote]",
  )!;
  expect(quote.textContent).toBe("Testeroriginal");
  expect(quote.querySelector("em") === null).toBe(true);
  expect(quote.querySelector("span strong") === null).toBe(true);
  expect(reply.replyTo.excerpt).toBe("**original**");
  fireEvent.click(quote);
  expect(scrolled).toBe(true);
  expect(document.activeElement === anchor).toBe(true);
  fireEvent.click(view.getAllByLabelText(en.t("membersChat.actions"))[0]);
  fireEvent.click(view.getAllByTitle(en.t("membersChat.reply"))[0]);
  const composer = view.getByPlaceholderText(en.t("membersChat.placeholder"));
  expect(document.activeElement === composer).toBe(true);
  expect(
    view.container.querySelector("[data-members-chat-composer-quote]")
      ?.textContent,
  ).toContain("Testeroriginal");
  fireEvent.change(composer, { target: { value: "my draft" } });
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: en.t("common.send") })),
  );
  expect(requests).toEqual([
    { text: "my draft", attachments: [], replyTo: original.id },
  ]);
  // A sent reply clears its quote.
  expect(
    view.container.querySelector("[data-members-chat-composer-quote]") === null,
  ).toBe(true);
  // Anchor first: a quote shows its Cancel reply control.
  fireEvent.click(view.getAllByLabelText(en.t("membersChat.actions"))[0]);
  fireEvent.click(view.getAllByTitle(en.t("membersChat.reply"))[0]);
  expect(view.queryByLabelText(en.t("membersChat.cancelReply")) !== null).toBe(
    true,
  );
  fireEvent.change(composer, { target: { value: "keep this" } });
  fireEvent.click(view.getByLabelText(en.t("membersChat.cancelReply")));
  expect(view.queryByLabelText(en.t("membersChat.cancelReply")) === null).toBe(
    true,
  );
  expect((composer as HTMLTextAreaElement).value).toBe("keep this");
});

it("retains a draft and its quote after a deleted target, with the reply-missing error", async () => {
  setApiShim(async () => {
    throw new ApiError(404, "reply_not_found", "");
  });
  const view = render(replyPanel());
  fireEvent.click(view.container.querySelector("summary")!);
  fireEvent.click(view.getAllByTitle(en.t("membersChat.reply"))[0]);
  const composer = view.getByRole("textbox");
  fireEvent.change(composer, { target: { value: "still here" } });
  await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
  // Which message the code picks: the reply-specific one, not "could not send".
  expect(
    en.t("membersChat.replyMissing") !== en.t("membersChat.sendFailed"),
  ).toBe(true);
  expect(view.getByRole("alert").textContent).toBe(
    en.t("membersChat.replyMissing"),
  );
  expect((composer as HTMLTextAreaElement).value).toBe("still here");
  expect(
    view.container.querySelector("[data-members-chat-composer-quote]") !== null,
  ).toBe(true);
});

const pinned = {
  id: "202608-00000001",
  kind: "user" as const,
  userId: "sam",
  userName: "Sam",
  content: "**Pinned text**",
  timestamp: 1,
  pinnedAt: 2,
  attachments: [],
};
const strip = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(
    "[data-members-chat-pinned] > button",
  )!;

it("jumps to a loaded pin and expands an unloaded pin in place with its unpin action", () => {
  let jumps = 0,
    unpins = 0;
  const props = {
    message: pinned,
    count: 1,
    author: "Sam",
    loaded: true,
    onJump: () => {
      jumps++;
    },
    onUnpin: () => {
      unpins++;
    },
  };
  const view = render(
    onLanguage("en", createElement(PinnedMessageStrip, props)),
  );
  // The strip names the author and previews the text without its markup.
  const text = strip(view.container).textContent ?? "";
  expect(text).toContain("Sam");
  expect(text).toContain("Pinned text");
  expect(text.includes("**")).toBe(false);
  expect(strip(view.container).querySelector("strong") === null).toBe(true);
  fireEvent.click(strip(view.container));
  expect(jumps).toBe(1);
  expect(
    view.container.querySelector("[data-members-chat-expanded-pin]") === null,
  ).toBe(true);
  view.rerender(
    onLanguage(
      "en",
      createElement(PinnedMessageStrip, { ...props, loaded: false }),
    ),
  );
  fireEvent.click(strip(view.container));
  expect(jumps).toBe(1);
  expect(
    view.container.querySelector("[data-members-chat-expanded-pin]") !== null,
  ).toBe(true);
  expect(view.container.querySelector("strong")?.textContent).toBe(
    "Pinned text",
  );
  fireEvent.click(view.getByLabelText(en.t("membersChat.actions")));
  fireEvent.click(
    view.getByRole("button", { name: en.t("membersChat.unpin") }),
  );
  expect(unpins).toBe(1);
});

it("shows exactly twenty and the twenty-first sentinel", () => {
  const props = {
    message: pinned,
    count: 20,
    author: "Sam",
    loaded: true,
    onJump: () => {},
    onUnpin: () => {},
  };
  const view = render(
    onLanguage("en", createElement(PinnedMessageStrip, props)),
  );
  const twenty = strip(view.container).textContent ?? "";
  expect(twenty).toContain(en.t("membersChat.pinned", { count: "20" }));
  expect(twenty.includes("+")).toBe(false);
  view.rerender(
    onLanguage(
      "en",
      createElement(PinnedMessageStrip, { ...props, count: 21 }),
    ),
  );
  expect(strip(view.container).textContent).toContain(
    en.t("membersChat.pinned", { count: "20+" }),
  );
});
