import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { MembersChatPanel } = await import("./MembersChatPanel.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
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
function panel(language: "en" | "es" | "ca" = "en") {
  return onLanguage(language, createElement(MembersChatPanel), {
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
  const view = render(panel());
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
  fireEvent.click(view.getAllByLabelText("Message actions")[0]);
  fireEvent.click(view.getAllByTitle("Reply")[0]);
  const composer = view.getByPlaceholderText("Message the members…");
  expect(document.activeElement === composer).toBe(true);
  expect(
    view.container.querySelector("[data-members-chat-composer-quote]")
      ?.textContent,
  ).toContain("Testeroriginal");
  fireEvent.change(composer, { target: { value: "my draft" } });
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Send" })),
  );
  expect(requests).toEqual([
    { text: "my draft", attachments: [], replyTo: original.id },
  ]);
  expect(view.queryByLabelText("Cancel reply") === null).toBe(true);
  fireEvent.click(view.getAllByLabelText("Message actions")[0]);
  fireEvent.click(view.getAllByTitle("Reply")[0]);
  fireEvent.change(composer, { target: { value: "keep this" } });
  fireEvent.click(view.getByLabelText("Cancel reply"));
  expect((composer as HTMLTextAreaElement).value).toBe("keep this");
});

for (const [language, replyLabel, error] of [
  [
    "en",
    "Reply",
    "The original message was deleted. Cancel the reply or choose another message.",
  ],
  [
    "es",
    "Responder",
    "El mensaje original se ha eliminado. Cancela la respuesta o elige otro mensaje.",
  ],
  [
    "ca",
    "Respon",
    "El missatge original s’ha suprimit. Cancel·la la resposta o tria un altre missatge.",
  ],
] as const) {
  it(`retains a draft after a deleted target with ${language} copy`, async () => {
    setApiShim(async () => {
      throw new ApiError(404, "reply_not_found", "");
    });
    const view = render(panel(language));
    fireEvent.click(view.container.querySelector("summary")!);
    fireEvent.click(view.getAllByTitle(replyLabel)[0]);
    const composer = view.getByRole("textbox");
    fireEvent.change(composer, { target: { value: "still here" } });
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    expect(view.getByRole("alert").textContent).toBe(error);
    expect((composer as HTMLTextAreaElement).value).toBe("still here");
    expect(
      view.container.querySelector("[data-members-chat-composer-quote]") !==
        null,
    ).toBe(true);
  });
}
