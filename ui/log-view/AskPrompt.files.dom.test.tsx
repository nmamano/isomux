// Read files placed in an ask card's prompt (task 1097dbf0): a file the
// prompt places shows inside the prompt between the paragraphs around it,
// served from where the bottom row serves it, and not again in the bottom
// row; the other files stay in the bottom row. A name no file has, and any
// name on a surface with no files, shows as the name, never as the markup.
// The grammar is in ui/log-view/ask-prompt-files.test.ts.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
// The store's default contexts: no provider, so no socket.
const { FeaturesProvider } = await import("../store.tsx");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");
const { AskCard } = await import("./AskCard.tsx");
const { AskPrompt } = await import("./AskPrompt.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { t } = translatorFor("en");
type AskEntry = import("../../shared/types.ts").AskEntry;
type AskReadFile = import("../../shared/types.ts").AskReadFile;
type ReactNode = import("react").ReactNode;

const AGENT = "a1";
const ASK = "ask10970";

// A reference in place (served by the ask's route) and two copies (served
// from the agent's files dir).
const BEFORE: AskReadFile = {
  filename: "f1.png",
  originalName: "1-before.png",
  mediaType: "image/png",
  size: 7,
  path: "/w/1-before.png",
};
const AFTER: AskReadFile = {
  filename: "f2.png",
  originalName: "2 after.png",
  mediaType: "image/png",
  size: 7,
};
const OTHER: AskReadFile = {
  filename: "f3.png",
  originalName: "3-other.png",
  mediaType: "image/png",
  size: 7,
};
const BEFORE_SRC = `/api/asks/${ASK}/files/f1.png`;
const AFTER_SRC = `/api/files/${AGENT}/f2.png`;
const OTHER_SRC = `/api/files/${AGENT}/f3.png`;

const ask = (prompt: string, readFiles: AskReadFile[]): AskEntry => ({
  id: ASK,
  agentId: AGENT,
  memberUserId: "u1",
  prompt,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  readFiles,
});

const wrap = (children: ReactNode) =>
  createElement(FeaturesProvider, { features: PRODUCTION_FEATURES, children });

function mountCard(entry: AskEntry) {
  const view = render(wrap(createElement(AskCard, { entry, isMobile: false })));
  const card = view.container.querySelector<HTMLElement>(`[data-ask="${ASK}"]`);
  const prompt = card?.querySelector<HTMLElement>("[data-ask-prompt]");
  expect(card).not.toBeNull();
  expect(prompt).not.toBeNull();
  return { view, card: card!, prompt: prompt! };
}

const pathOf = (img: HTMLImageElement) =>
  new URL(img.getAttribute("src") ?? "", "http://office.test").pathname;
const srcs = (root: Element) => [...root.querySelectorAll("img")].map(pathOf);
// The card's images outside the prompt: the bottom row.
const bottomSrcs = (card: Element, prompt: Element) =>
  [...card.querySelectorAll("img")]
    .filter((img) => !prompt.contains(img))
    .map(pathOf);

// The prompt in document order: each text node with text, and each image as
// its served path.
function sequence(root: Element): string[] {
  const out: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, 0x1 | 0x4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      const text = n.textContent?.trim();
      if (text) out.push(text);
    } else if ((n as Element).tagName === "IMG") {
      out.push(`img:${pathOf(n as HTMLImageElement)}`);
    }
  }
  return out;
}
const at = (seq: string[], part: string) => {
  const i = seq.findIndex((s) => s.includes(part));
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
};

it("shows each placed file between the paragraphs around it, and the rest in the bottom row", () => {
  const { card, prompt } = mountCard(
    ask(
      "First the old layout.\n![](1-before.png)\nThen the new one.\n![](<2 after.png>)\nEnd of the story.",
      [BEFORE, AFTER, OTHER],
    ),
  );
  expect(srcs(prompt)).toStrictEqual([BEFORE_SRC, AFTER_SRC]);
  const seq = sequence(prompt);
  const order = [
    at(seq, "First the old layout."),
    at(seq, `img:${BEFORE_SRC}`),
    at(seq, "Then the new one."),
    at(seq, `img:${AFTER_SRC}`),
    at(seq, "End of the story."),
  ];
  expect(order).toStrictEqual([...order].sort((a, b) => a - b));
  expect(prompt.textContent).not.toContain("](");
  expect(bottomSrcs(card, prompt)).toStrictEqual([OTHER_SRC]);
});

it("shows no bottom row images when the prompt places every file", () => {
  const { card, prompt } = mountCard(
    ask("Compare:\n![](1-before.png) ![](<2 after.png>)\nDone.", [
      BEFORE,
      AFTER,
    ]),
  );
  expect(srcs(prompt)).toStrictEqual([BEFORE_SRC, AFTER_SRC]);
  expect(bottomSrcs(card, prompt)).toStrictEqual([]);
});

it("shows a file once in a row that names it twice", () => {
  const { prompt } = mountCard(
    ask("Look:\n![](1-before.png) ![](/w/1-before.png)\nDone.", [BEFORE]),
  );
  expect(srcs(prompt)).toStrictEqual([BEFORE_SRC]);
});

it("shows a name no file has as the name, with no image", () => {
  const { card, prompt } = mountCard(
    ask("Look:\n![](9-missing.png)\nDone.", [OTHER]),
  );
  expect(srcs(prompt)).toStrictEqual([]);
  expect(prompt.textContent).toContain("9-missing.png");
  expect(prompt.textContent).not.toContain("](");
  expect(bottomSrcs(card, prompt)).toStrictEqual([OTHER_SRC]);
});

it("places the files in the original prompt too, behind Show original", () => {
  const entry: AskEntry = {
    ...ask("Pick a layout.", [BEFORE, OTHER]),
    originalPrompt: "The old layout:\n![](1-before.png)\nPick one.",
  };
  const { view } = mountCard(entry);
  fireEvent.click(view.getByText(t("asks.showOriginal")));
  const original = view.container.querySelector("[data-ask-original]");
  expect(original).not.toBeNull();
  expect(srcs(original!)).toStrictEqual([BEFORE_SRC]);
  expect(original!.textContent).not.toContain("](");
});

it("shows the name, with no image, where the prompt has no files (a pinned ask, an ask link)", () => {
  const view = render(
    wrap(
      createElement(AskPrompt, { content: "Look:\n![](1-before.png)\nDone." }),
    ),
  );
  expect(srcs(view.container)).toStrictEqual([]);
  expect(view.container.textContent).toContain("1-before.png");
  expect(view.container.textContent).not.toContain("](");
});

it("measures the clamp again when a placed image loads", () => {
  const { view, prompt } = mountCard(
    ask("One line.\n![](1-before.png)\nOne more line.", [BEFORE]),
  );
  const showMore = () => view.queryByText(t("cards.toolResult.showMore"));
  // happy-dom lays nothing out: at mount the prompt is not cut.
  expect(showMore()).toBeNull();
  // The image loads and the prompt is now taller than the clamp.
  Object.defineProperty(prompt, "scrollHeight", {
    configurable: true,
    get: () => 300,
  });
  Object.defineProperty(prompt, "clientHeight", {
    configurable: true,
    get: () => 60,
  });
  expect(prompt.scrollHeight).toBeGreaterThan(prompt.clientHeight + 1);
  const img = prompt.querySelector("img");
  expect(img).not.toBeNull();
  act(() => {
    fireEvent.load(img!);
  });
  expect(showMore()).not.toBeNull();
});
