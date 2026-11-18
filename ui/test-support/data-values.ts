// A value inside a sentence (a name, a path, a host) looks unlike the words
// around it: the Data component (ui/components/Data.tsx), through rich()
// (AGENTS.md "UI rules"). These helpers read that structure from the DOM, so
// a test asserts it without the sentence's wording. A Data element that page
// translation may touch reads as "(translatable) <text>", so the assertion
// names what is wrong.
import { expect } from "bun:test";

const ATTR = "data-integrations-data";
const DATA = `[${ATTR}]`;

/** The text of a Data element, marked when page translation may touch it. */
function chipText(el: Element): string {
  const text = el.textContent ?? "";
  const kept =
    el.getAttribute("translate") === "no" &&
    el.classList.contains("notranslate");
  return kept ? text : `(translatable) ${text}`;
}

/** The values a sentence shows as data: the text of each Data element under
 *  `root`, in order. */
export function dataChips(root: ParentNode | null | undefined): string[] {
  if (!root) return ["(no root)"];
  return [...root.querySelectorAll(DATA)].map(chipText);
}
/** The line's words with each Data element taken out. */
export function textOutsideData(line: Element): string {
  const copy = line.cloneNode(true) as Element;
  for (const v of copy.querySelectorAll(DATA)) v.remove();
  return copy.textContent ?? "";
}

// The deepest element under root whose text holds value: the Data element
// when the value is one, else the element that holds the whole sentence.
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

/** Asserts that `value` shows under `root` as a Data element that holds the
 *  value and nothing else, kept from page translation, in a line that has
 *  words of its own. Returns the line. The first match counts: scope `root`
 *  to the line's own container. */
export function expectValueAsData(root: Element, value: string): HTMLElement {
  const el = deepest(root, value);
  expect(el === null ? "value not rendered" : "rendered").toBe("rendered");
  // Not the bare sentence element: a Data element.
  expect(
    el!.hasAttribute(ATTR) ? "Data" : `<${el!.tagName.toLowerCase()}>`,
  ).toBe("Data");
  expect(chipText(el!)).toBe(value);
  const line = el!.parentElement!;
  expect(textOutsideData(line).trim().length).toBeGreaterThan(0);
  return line;
}

const SPLITS = new Set(["flex", "inline-flex", "grid", "inline-grid"]);
const LINES = "p, li, div, label, [role=note]";

/** The innermost line elements under `root` (or `root` itself) whose text
 *  holds `value`. */
export function linesWith(
  root: Element,
  value: string,
  selector: string = LINES,
): Element[] {
  const hits = [...root.querySelectorAll(selector)].filter((e) =>
    (e.textContent ?? "").includes(value),
  );
  const inner = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
  if (inner.length > 0) return inner;
  return (root.textContent ?? "").includes(value) ? [root] : [];
}

/**
 * The sentence that holds `values[0]`, read as data: how many lines hold it,
 * the text of each Data element in that line (sorted, read as dataChips
 * reads it), which of `values` still shows outside a Data element, whether a
 * `{placeholder}` is left, and whether a Data element sits right in a flex
 * or grid box, which lays each text run and value out as its own column
 * instead of one sentence. A line whose values each sit whole in their own
 * Data element, in the flow of the text, reads asData(values).
 */
export function sentenceValues(
  root: Element,
  values: string[],
  selector: string = LINES,
): {
  lines: number;
  values: string[];
  bare: string[];
  placeholder: boolean;
  split: boolean;
} {
  const lines = linesWith(root, values[0], selector);
  const line = lines[0];
  if (!line)
    return {
      lines: 0,
      values: [],
      bare: values,
      placeholder: false,
      split: false,
    };
  const found = [...line.querySelectorAll<HTMLElement>(DATA)];
  const data = found.map(chipText);
  const split = found.some(
    (v) =>
      !!v.parentElement &&
      SPLITS.has(getComputedStyle(v.parentElement).display),
  );
  const rest = textOutsideData(line);
  return {
    lines: lines.length,
    values: data.sort(),
    bare: values.filter((v) => rest.includes(v)),
    placeholder: /[{}]/.test(rest),
    split,
  };
}

/** What sentenceValues reads for a line whose values are all in Data. */
export const asData = (values: string[]) => ({
  lines: 1,
  values: [...values].sort(),
  bare: [] as string[],
  placeholder: false,
  split: false,
});
