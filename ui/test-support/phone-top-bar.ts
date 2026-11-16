// Checks for the phone's top bar (task d60726c7), shared by
// ui/App.phone-top-bar.dom.test.tsx and
// ui/App.phone-top-bar-overlays.dom.test.tsx (two files, for the DOM file
// time cap). iOS 26 blurs the top of a Home Screen app's page unless WebKit
// finds an opaque, fixed, full-width box more than 10 px tall at the top
// centre of the screen, 4 px down (LocalFrameView::fixedContainerEdges). So
// on a phone one such bar sits above every other layer, and every surface
// that started at the status bar starts below it: each use of the top inset
// counts an inset of 0 as the bar's height. happy-dom does no layout or hit
// test, and drops env() values: the bar and the insets are read from the
// style values the UI wrote (raw-style.ts; the test file calls
// recordRawStyles()), and the look is Nil's check on his iPhone.

import { expect } from "bun:test";
import { THEMES } from "../themes.ts";
import { rawStyle } from "./raw-style.ts";

type Shown = { baseElement: HTMLElement };

export const bars = (view: Shown) => [
  ...view.baseElement.querySelectorAll<HTMLElement>("[data-phone-top-bar]"),
];

// A CSS length expression as px, for a given top inset. The top inset is
// `inset`; every other env() is 0; a var() is its fallback or 0; a length in
// a unit other than px is a fixed stand-in, the same in every evaluation, so
// two evaluations differ only by what the top inset adds.
function evalPx(value: string, inset: number): number {
  let text = value.trim();
  for (let i = 0; i < 4; i++)
    text = text
      .replace(/env\(\s*safe-area-inset-top\s*(,[^()]*)?\)/g, `${inset}px`)
      .replace(/env\([^()]*\)/g, "0px")
      .replace(/var\(\s*--[\w-]+\s*,\s*([^()]*)\)/g, "$1")
      .replace(/var\(\s*--[\w-]+\s*\)/g, "0px");
  text = text
    .replace(/(-?\d*\.?\d+)px\b/g, "$1")
    .replace(
      /(-?\d*\.?\d+)(%|d?vh|s?vh|l?vh|vw|vmin|vmax|em|rem)/g,
      "(1000*$1)",
    )
    .replace(/\bcalc\(/g, "(")
    .replace(/\bmax\(/g, "Math.max(")
    .replace(/\bmin\(/g, "Math.min(")
    .replace(/\bclamp\(/g, "clampPx(");
  if (!/^(Math\.(max|min)|clampPx|[\d\s.+\-*/(),])*$/.test(text))
    throw new Error(`not a length expression: ${value}`);
  const clampPx = (lo: number, v: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  return Number(new Function("clampPx", `return (${text});`)(clampPx));
}

// The top-level space-separated parts of a value ("max(24px, env(x)) 20px 0"
// has three).
function parts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const describe = (el: Element) =>
  `<${el.tagName.toLowerCase()} ${[...el.attributes]
    .filter((a) => a.name.startsWith("data-") || a.name === "class")
    .map((a) => `${a.name}=${a.value}`)
    .join(" ")}>`;

// Every declaration on the page that uses the top inset, from inline styles
// and from the App's style sheets, as "<where> <property>: <value>".
function insetUses(
  view: Shown,
): { where: string; prop: string; value: string }[] {
  const uses: { where: string; prop: string; value: string }[] = [];
  const declarations = (text: string, where: string) => {
    for (const decl of text.split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim();
      const value = decl.slice(at + 1).trim();
      if (value.includes("safe-area-inset-top"))
        uses.push({ where, prop, value });
    }
  };
  for (const el of view.baseElement.querySelectorAll<HTMLElement>("*"))
    for (const [prop, value] of rawStyle(el))
      if (value.includes("safe-area-inset-top"))
        uses.push({ where: describe(el), prop, value });
  for (const sheet of document.querySelectorAll("style")) {
    const css = (sheet.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      declarations(rule[2], rule[1].trim());
  }
  return uses;
}

// A use that would let content start under the bar: some part of it grows
// when the inset goes from 0 to the bar's height, so at an inset of 0 it
// does not count the bar.
function rawInsetUses(view: Shown, barHeight: number): string[] {
  return insetUses(view)
    .filter(({ value }) =>
      parts(value).some(
        (part) =>
          part.includes("safe-area-inset-top") &&
          evalPx(part, 0) !== evalPx(part, barHeight),
      ),
    )
    .map(({ where, prop, value }) => `${where} ${prop}: ${value}`);
}

// A colour's alpha: 1 for a 3- or 6-digit hex and rgb(), the fourth value
// otherwise. A var() is resolved in the theme.
function alpha(color: string, vars: Record<string, string>): number {
  let text = color.trim();
  for (let i = 0; i < 4; i++) {
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/.exec(text);
    if (!m) break;
    text = (vars[m[1]] ?? m[2] ?? "").trim();
  }
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return 1;
  const hex8 = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(text);
  if (hex8) return parseInt(hex8[1], 16) / 255;
  const fn = /^rgba?\(([^)]*)\)$/i.exec(text);
  if (fn) {
    const nums = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (nums.length === 3) return 1;
    if (nums.length === 4)
      return nums[3].endsWith("%")
        ? parseFloat(nums[3]) / 100
        : Number(nums[3]);
  }
  throw new Error(`not a colour: ${color} (${text})`);
}

// The z-index of every other element that sets one, inline or from a rule
// of the App's style sheets, with where it is. (A z-index on a static box
// counts too: it errs on the side of a layer.)
function otherLayers(view: Shown, bar: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of view.baseElement.querySelectorAll<HTMLElement>("*")) {
    const z = parseInt(rawStyle(el).get("z-index") ?? "", 10);
    if (el !== bar && !Number.isNaN(z)) out.push(`${z} ${describe(el)}`);
  }
  for (const sheet of document.querySelectorAll("style")) {
    const css = (sheet.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const z = /(?:^|;)\s*z-index\s*:\s*(-?\d+)/.exec(rule[2]);
      if (!z) continue;
      let hits: Element[] = [];
      try {
        hits = [...view.baseElement.querySelectorAll(rule[1].trim())];
      } catch {
        continue; // an at-rule's prelude, not a selector
      }
      for (const el of hits)
        if (el !== bar) out.push(`${z[1]} ${describe(el)} (${rule[1].trim()})`);
    }
  }
  return out;
}

// Checks the bar on the page in view and returns its height for an inset
// of 0.
export function checkBar(view: Shown, page: string): number {
  const all = bars(view);
  expect({ page, bars: all.length }).toEqual({ page, bars: 1 });
  const bar = all[0];
  const raw = rawStyle(bar);
  const style = (prop: string) => raw.get(prop) ?? "";
  const computed = getComputedStyle(bar);

  // Fixed at the top edge, across the full width.
  expect(style("position")).toBe("fixed");
  expect(evalPx(style("top"), 0)).toBe(0);
  expect(evalPx(style("left"), 0)).toBe(0);
  if (style("right") === "") expect(style("width")).toBe("100%");
  else expect(evalPx(style("right"), 0)).toBe(0);

  // Taller than WebKit's 10 px floor with no inset, and at least the
  // status bar with one.
  const height = evalPx(style("height"), 0);
  expect(height).toBeGreaterThan(10);
  expect(evalPx(style("height"), 59)).toBeGreaterThanOrEqual(59);

  // A plain opaque box: WebKit reads a backdrop filter as glass, and skips
  // a box that is hidden, nearly transparent or lets the hit through.
  const glassy = [...raw].filter(
    ([prop, value]) =>
      /backdrop-filter|^filter$|mix-blend/.test(prop) ||
      (prop === "opacity" && Number(value) !== 1) ||
      (prop === "visibility" && value !== "visible") ||
      (prop === "pointer-events" && value === "none"),
  );
  expect(glassy).toEqual([]);
  expect(bar.childNodes.length).toBe(0);
  expect(computed.pointerEvents).not.toBe("none");
  expect(computed.visibility).not.toBe("hidden");
  const background = style("background-color") || style("background");
  expect(background).not.toBe("");
  for (const theme of THEMES)
    expect({ theme: theme.id, alpha: alpha(background, theme.vars) }).toEqual({
      theme: theme.id,
      alpha: 1,
    });

  // Above every other layer, in the root stacking context: no ancestor
  // makes one that could put a later layer over the bar.
  const z = parseInt(computed.zIndex, 10);
  expect(Number.isNaN(z)).toBe(false);
  expect(
    otherLayers(view, bar).filter((layer) => parseInt(layer, 10) >= z),
  ).toEqual([]);
  const contexts: string[] = [];
  for (let el = bar.parentElement; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    const positioned = s.position !== "static" && s.position !== "";
    if (
      (positioned && s.zIndex !== "auto" && s.zIndex !== "") ||
      (s.transform && s.transform !== "none") ||
      (s.filter && s.filter !== "none") ||
      (s.opacity !== "" && Number(s.opacity) < 1) ||
      s.isolation === "isolate"
    )
      contexts.push(`<${el.tagName.toLowerCase()} ${el.className}>`);
  }
  expect(contexts).toEqual([]);

  // Nothing on the page starts under the bar.
  expect({ page, raw: rawInsetUses(view, height) }).toEqual({ page, raw: [] });
  return height;
}
