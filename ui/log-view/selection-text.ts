// The text of a chat selection, as the copy handler and the Cite pill take
// it. A formula KaTeX rendered comes out as its TeX source between dollars,
// not as its MathML and HTML spans (one character per line).
export function selectionText(sel: Selection): string {
  if (sel.rangeCount === 0) return sel.toString();
  const range = sel.getRangeAt(0);
  const common = elementOf(range.commonAncestorContainer);
  const inside = common?.closest(".katex-math");
  const touched = inside
    ? [inside]
    : [...(common?.querySelectorAll(".katex-math") ?? [])].filter((el) =>
        range.intersectsNode(el),
      );
  if (touched.length === 0) return sel.toString();

  // A formula the range only partly covers comes into the fragment as a
  // partly selected ancestor, with its source; a range inside one formula
  // takes the whole formula.
  const whole = range.cloneRange();
  if (inside) whole.selectNode(inside);

  const fragment = whole.cloneContents();
  for (const math of fragment.querySelectorAll<HTMLElement>(".katex-math")) {
    const display = math.dataset.katexDisplay === "true";
    const source = (math.dataset.katexSource ?? "").trim();
    const node = document.createElement(display ? "div" : "span");
    node.style.whiteSpace = "pre-wrap";
    node.textContent = display ? `$$${source}$$` : `$${source}$`;
    math.replaceWith(node);
  }

  // innerText, not textContent, keeps the line breaks between blocks; it
  // needs the text laid out, so the copy sits off screen where the selection
  // was, under the same inherited white-space and CSS.
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = "position: fixed; left: -100000px; top: 0;";
  box.append(fragment);
  const host = elementOf(whole.commonAncestorContainer) ?? document.body;
  try {
    host.append(box);
    return box.innerText;
  } finally {
    box.remove();
  }
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}
