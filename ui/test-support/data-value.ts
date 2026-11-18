// A value inside a sentence renders through the Data component (AGENTS.md
// "UI rules", ui/components/Data.tsx): these find a value in a rendered tree
// and check it sits in a Data span of its own, with words of the sentence
// around it.
import { expect } from "bun:test";

const DATA = "data-integrations-data";

// The deepest element under root whose text holds value: the Data span when
// the value is one, else the element that holds the whole sentence.
function deepest(root: Element, value: string): Element | null {
  if (!(root.textContent ?? "").includes(value)) return null;
  let el = root;
  for (;;) {
    const child = [...el.children].find((c) =>
      (c.textContent ?? "").includes(value),
    );
    if (!child) return el;
    el = child;
  }
}

// The line's words with each Data span taken out.
export function textOutsideData(line: Element): string {
  const copy = line.cloneNode(true) as Element;
  for (const span of copy.querySelectorAll(`[${DATA}]`)) span.remove();
  return copy.textContent ?? "";
}

// Asserts that value shows under root as a Data span that holds the value
// and nothing else, in a line that has words of its own. Returns the line.
// The first match counts: scope root to the line's own container.
export function expectValueAsData(root: Element, value: string): HTMLElement {
  const el = deepest(root, value);
  expect(el === null ? "value not rendered" : "rendered").toBe("rendered");
  // Not the bare sentence element: a Data span.
  expect(
    el!.hasAttribute(DATA) ? "Data" : `<${el!.tagName.toLowerCase()}>`,
  ).toBe("Data");
  expect(el!.textContent).toBe(value);
  const line = el!.parentElement!;
  expect(textOutsideData(line).trim().length).toBeGreaterThan(0);
  return line;
}

// The text of each Data span under root, in order.
export const dataTexts = (root: Element): string[] =>
  [...root.querySelectorAll(`[${DATA}]`)].map((el) => el.textContent ?? "");
