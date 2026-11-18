// A value inside a sentence (a name, a path, a host) looks unlike the words
// around it: the Data component (ui/components/Data.tsx), through rich()
// (AGENTS.md "UI rules"). These helpers read that structure from the DOM, so
// a test asserts it without the sentence's wording. A Data element that page
// translation may touch reads as "(translatable) <text>", so the assertion
// names what is wrong.

const DATA = "[data-integrations-data]";

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
  const copy = line.cloneNode(true) as Element;
  for (const v of copy.querySelectorAll(DATA)) v.remove();
  const rest = copy.textContent ?? "";
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
