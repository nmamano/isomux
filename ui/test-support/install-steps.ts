// The iPhone Add to Home Screen steps (task 1a3fe9d7) as a member reads them:
// one sentence with the Share, More (Safari only) and Add to Home Screen
// icons inside it, in that order. Each browser gets its own steps (task
// 5765f58e). Used by every surface that shows the steps.

import { expect } from "bun:test";
import type { StepsBrowser } from "../app-install.ts";
import { en } from "../../shared/i18n/en.ts";

// The catalog entry each browser's steps come from: Firefox, Edge and an
// unknown browser share the menu route.
const STEPS_KEY = {
  safari: "appWidget.installSteps.safari",
  chrome: "appWidget.installSteps.chrome",
  firefox: "appWidget.installSteps.menu",
  edge: "appWidget.installSteps.menu",
  other: "appWidget.installSteps.menu",
} as const satisfies Record<StepsBrowser, string>;

// The words of a browser's steps, with the icons' placeholders left out (an
// icon has no text).
function stepsWords(browser: StepsBrowser): string {
  const text = (en as Record<string, string | undefined>)[STEPS_KEY[browser]];
  expect(typeof text).toBe("string");
  return text!.replace(/\{\w+\}/g, "");
}

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

export function expectInlineInstallSteps(
  root: HTMLElement,
  browser: StepsBrowser = "safari",
): void {
  // Each icon once, inside the sentence: no leading icon before the text,
  // and text between two icons. Only Safari's steps name its ••• button.
  const order = readingOrder(root);
  expect(order[0]).toBe("text");
  expect(order.filter((part) => part !== "text")).toEqual(
    browser === "safari" ? ["share", "more", "add"] : ["share", "add"],
  );
  expect(order.join()).not.toMatch(/(share|more|add),(share|more|add)/);
  // Every placeholder is filled: a t() call would leave "{share}" in view.
  expect(root.textContent).not.toContain("{");
  // This browser's steps, and no other route's. The condition: the step
  // texts differ.
  const own = stepsWords(browser);
  for (const other of ["safari", "chrome", "other"] as const) {
    const words = stepsWords(other);
    if (STEPS_KEY[other] === STEPS_KEY[browser])
      expect(root.textContent).toContain(own);
    else {
      expect(own).not.toContain(words);
      expect(root.textContent).not.toContain(words);
    }
  }
}
