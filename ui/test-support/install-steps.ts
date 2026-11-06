// The iPhone Add to Home Screen steps (task 1a3fe9d7) as a member reads them:
// one sentence with the Share, More and Add to Home Screen icons inside it,
// in that order. Used by every surface that shows the steps.

import { expect } from "bun:test";

// The text runs and the marked install icons under `root`, in document order.
// A run of text becomes "text"; unmarked SVGs (a close button) are skipped.
function readingOrder(root: Node): string[] {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent!.trim() !== "" && out.at(-1) !== "text")
        out.push("text");
      return;
    }
    const icon =
      node instanceof Element ? node.getAttribute("data-install-icon") : null;
    if (icon !== null) {
      out.push(icon);
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}

export function expectInlineInstallSteps(root: HTMLElement): void {
  // Each icon once, inside the sentence: no leading icon before the text.
  expect(readingOrder(root)).toEqual([
    "text",
    "share",
    "text",
    "more",
    "text",
    "add",
    "text",
  ]);
  // Every placeholder is filled: a t() call would leave "{share}" in view.
  expect(root.textContent).not.toContain("{");
}
