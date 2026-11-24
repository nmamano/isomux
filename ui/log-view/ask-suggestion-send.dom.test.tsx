// The tag suggestions as two-tap sends (task 6439c0f5): a suggestion whose
// words the reply field holds carries the options' send mark, and its tap
// sends the field with the tag, as the tag's own button does. A suggestion
// that asks for words after it (Circle back at, Answer this) never sends, in
// every language. Nothing sends from the field while the automate section is
// open.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { StoreProvider } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { AsksStack } = await import("./AsksStack.tsx");
const { NOW, Seed, seeded } =
  await import("../test-support/asks-stack-fixture.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: { path: string; text: unknown }[] = [];
// A POST that the test answers later; null answers at once.
let hold: Promise<void> | null = null;
beforeEach(() => {
  posts = [];
  hold = null;
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push({
        path,
        text: (body as { text?: unknown } | undefined)?.text,
      });
      if (hold) await hold;
    }
    return undefined;
  });
});
afterAll(() => setApiShim(null));

const AGENT = "t1";
const ask = (id: string): AskEntry => ({
  id,
  agentId: AGENT,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
});

// The browser's language decides the UI's when the member chose none.
function onBrowserLanguage(language: string): () => void {
  const own = Object.getOwnPropertyDescriptor(navigator, "language");
  Object.defineProperty(navigator, "language", {
    configurable: true,
    get: () => language,
  });
  return () => {
    if (own) Object.defineProperty(navigator, "language", own);
    else delete (navigator as { language?: string }).language;
  };
}

// The stack of agent t1 with this ask, opened, in the browser's language.
async function stack(id: string) {
  const view = render(
    <StoreProvider>
      <LanguageProvider>
        <Seed>
          <AsksStack agentId={AGENT} isMobile={false} />
        </Seed>
      </LanguageProvider>
    </StoreProvider>,
  );
  await act(async () => {
    seeded({ type: "ask_upserted", entry: ask(id) as never });
  });
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  const collapsed = view.container.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  );
  if (collapsed) await act(async () => void fireEvent.click(collapsed));
  await waitFor(() =>
    expect(view.container.querySelectorAll(`[data-ask="${id}"]`).length).toBe(
      1,
    ),
  );
  return view;
}

const card = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
const input = (root: HTMLElement, id: string) =>
  card(root, id).querySelector<HTMLTextAreaElement>("[data-ask-reply-input]")!;
const tagButton = (root: HTMLElement, id: string, tag: string) =>
  card(root, id).querySelector<HTMLButtonElement>(`[data-ask-tag="${tag}"]`)!;
const suggestion = (root: HTMLElement, id: string, name: string) =>
  card(root, id).querySelector<HTMLButtonElement>(
    `[data-ask-suggestion="${name}"]`,
  )!;
// Scalars only: a failed toBe on two DOM nodes serialises both.
const sendingSuggestions = (root: HTMLElement, id: string) =>
  [
    ...card(root, id).querySelectorAll<HTMLElement>(
      "[data-ask-suggestion][data-ask-suggestion-sends]",
    ),
  ].map((b) => b.dataset.askSuggestion);
// A button's mark, as the path it draws.
const markOf = (button: HTMLElement | null) =>
  button?.querySelector("svg path")?.getAttribute("d") ?? null;
// The two marks, read off the tag row: the tag that sends has the send
// arrow, the others the pencil.
const marks = (root: HTMLElement, id: string) => {
  const c = card(root, id);
  return {
    send: markOf(c.querySelector("[data-ask-tag][data-ask-tag-sends]")),
    pencil: markOf(c.querySelector("[data-ask-tag]:not([data-ask-tag-sends])")),
  };
};
const click = (el: HTMLElement) => act(async () => void fireEvent.click(el));
const type = (root: HTMLElement, id: string, value: string) =>
  act(async () => {
    fireEvent.change(input(root, id), { target: { value } });
  });
const opener = (root: HTMLElement, id: string) =>
  card(root, id).querySelector<HTMLButtonElement>("[data-ask-automate-open]")!;

it("Rewrite: a tap on Simplify marks it as the one that sends, with the send arrow; a second tap sends the rewrite with its words", async () => {
  const id = "sugg0001";
  const view = await stack(id);
  const root = view.container;
  await click(tagButton(root, id, "rewrite"));
  const m = marks(root, id);
  expect(m.send).not.toBeNull();
  expect(m.pencil).not.toBeNull();
  expect(m.send).not.toBe(m.pencil);
  // Before the tap: a pencil, and nothing sends.
  expect(sendingSuggestions(root, id)).toEqual([]);
  expect(markOf(suggestion(root, id, "simplify"))).toBe(m.pencil);
  await click(suggestion(root, id, "simplify"));
  const words = input(root, id).value;
  expect(words.trim()).not.toBe("");
  expect(posts).toEqual([]);
  expect(sendingSuggestions(root, id)).toEqual(["simplify"]);
  expect(markOf(suggestion(root, id, "simplify"))).toBe(m.send);
  expect(markOf(suggestion(root, id, "context"))).toBe(m.pencil);
  await click(suggestion(root, id, "simplify"));
  expect(posts).toEqual([{ path: `/api/asks/${id}/rewrite`, text: words }]);
  view.unmount();
});

it("Postpone: a second tap on File as a task sends the postpone with its words", async () => {
  const id = "sugg0002";
  const view = await stack(id);
  const root = view.container;
  await click(tagButton(root, id, "postpone"));
  await click(suggestion(root, id, "file"));
  const words = input(root, id).value;
  expect(words.trim()).not.toBe("");
  expect(posts).toEqual([]);
  expect(sendingSuggestions(root, id)).toEqual(["file"]);
  await click(suggestion(root, id, "file"));
  expect(posts).toEqual([{ path: `/api/asks/${id}/postpone`, text: words }]);
  view.unmount();
});

it("a suggestion the field no longer holds shows the pencil, and its tap puts its words back without sending", async () => {
  const id = "sugg0003";
  const view = await stack(id);
  const root = view.container;
  await click(tagButton(root, id, "rewrite"));
  const m = marks(root, id);
  await click(suggestion(root, id, "simplify"));
  const words = input(root, id).value;
  expect(sendingSuggestions(root, id)).toEqual(["simplify"]);
  await type(root, id, `${words} please`);
  expect(sendingSuggestions(root, id)).toEqual([]);
  expect(markOf(suggestion(root, id, "simplify"))).toBe(m.pencil);
  await click(suggestion(root, id, "simplify"));
  expect(posts).toEqual([]);
  expect(input(root, id).value).toBe(words);
  // Words typed to match it, with spaces around, send as well.
  await type(root, id, ` ${words} `);
  expect(sendingSuggestions(root, id)).toEqual(["simplify"]);
  view.unmount();
});

// A suggestion that asks for words after it never sends: a second tap would
// send it with nothing after it. zh ends these labels with a full-width
// colon, so a check on the label's last character misses them there.
for (const language of ["en-US", "zh-CN"] as const) {
  it(`${language}: Circle back at and Answer this never send, even on a second tap`, async () => {
    const restore = onBrowserLanguage(language);
    try {
      const code = language === "zh-CN" ? "zh" : "en";
      const { t } = translatorFor(code);
      const cases = [
        ["postpone", "circle-back", t("asks.suggest.circleBack")],
        ["rewrite", "answer", t("asks.suggest.answer")],
      ] as const;
      for (const [i, [tag, name, label]] of cases.entries()) {
        const id = `sugg01${code}${i}`;
        const view = await stack(id);
        const root = view.container;
        await click(tagButton(root, id, tag));
        const m = marks(root, id);
        // The card is in the language under test.
        expect(suggestion(root, id, name).textContent!.trim()).toBe(label);
        await click(suggestion(root, id, name));
        expect(input(root, id).value.trim()).toBe(label.trim());
        expect(sendingSuggestions(root, id)).toEqual([]);
        expect(markOf(suggestion(root, id, name))).toBe(m.pencil);
        await click(suggestion(root, id, name));
        await click(suggestion(root, id, name));
        expect(posts).toEqual([]);
        view.unmount();
      }
      // The zh labels end with no ASCII colon, which is the case this loop
      // is for.
      if (code === "zh")
        expect(cases.map(([, , label]) => label.endsWith(":"))).toEqual([
          false,
          false,
        ]);
    } finally {
      restore();
    }
  });
}

it("while the automate section is open, no suggestion sends", async () => {
  const id = "sugg0004";
  const view = await stack(id);
  const root = view.container;
  await click(tagButton(root, id, "rewrite"));
  await click(suggestion(root, id, "simplify"));
  expect(sendingSuggestions(root, id)).toEqual(["simplify"]);
  const pencil = marks(root, id).pencil;
  await click(opener(root, id));
  expect(
    card(root, id).querySelectorAll("[data-ask-automate-input]").length,
  ).toBe(1);
  expect(sendingSuggestions(root, id)).toEqual([]);
  expect(markOf(suggestion(root, id, "simplify"))).toBe(pencil);
  await click(suggestion(root, id, "simplify"));
  expect(posts).toEqual([]);
  view.unmount();
});

it("while its rewrite is on the way, the Simplify that sent it is disabled", async () => {
  const id = "sugg0005";
  let answer = () => {};
  hold = new Promise<void>((r) => (answer = r));
  const view = await stack(id);
  const root = view.container;
  await click(tagButton(root, id, "rewrite"));
  await click(suggestion(root, id, "simplify"));
  expect(suggestion(root, id, "simplify").disabled).toBe(false);
  await click(suggestion(root, id, "simplify"));
  expect(posts.map((p) => p.path)).toEqual([`/api/asks/${id}/rewrite`]);
  expect(sendingSuggestions(root, id)).toEqual(["simplify"]);
  expect(suggestion(root, id, "simplify").disabled).toBe(true);
  expect(suggestion(root, id, "context").disabled).toBe(false);
  await act(async () => {
    answer();
    await hold;
  });
  view.unmount();
});
