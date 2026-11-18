// The in-page half of scripts/loading-check.mjs (task e5fe2385): the root
// wait and the snapshot. At phone width the demo's body is 390 x 0 (the app
// shell is fixed-position), so a root with no box must still be waited for,
// recorded, and be the parent of its top-level children. A hidden root
// (display: none, opacity 0) is the one the check refuses.
//
// happy-dom has no layout: each element gets its rect from a stub on the
// element itself (never on the prototype, which would outlive this file).
// happy-dom also computes opacity as "" for an element with no opacity set,
// which the snapshot reads as 0 (Chrome gives "1"), so every fixture element
// sets opacity: 1 before its own style.

import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../ui/test-support/dom.ts";

setUpDomTestFile();

const { rootShown, snapshot } = await import("./loading-check-snapshot.ts");
const { layoutChanges } = await import("./loading-check-diff.ts");

type Rect = [x: number, y: number, w: number, h: number];

/** An element with a fixed rect, appended to parent. */
function box(
  parent: Element,
  rect: Rect,
  attrs: Record<string, string> = {},
  style = "",
  tag = "div",
): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.setAttribute("style", `opacity: 1; ${style}`);
  const [x, y, width, height] = rect;
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      width,
      height,
      top: y,
      left: x,
      right: x + width,
      bottom: y + height,
    }) as DOMRect;
  parent.appendChild(el);
  return el;
}

/** The test root: a div under body with the given rect and inline style. */
function makeRoot(rect: Rect, style = ""): HTMLElement {
  return box(document.body, rect, { id: "lc-root" }, style);
}

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as { __lcNext?: number }).__lcNext;
});

describe("rootShown", () => {
  it("is true for a root with no box: the phone body is 390 x 0", () => {
    makeRoot([0, 0, 390, 0]);
    expect(rootShown("#lc-root")).toBe(true);
  });

  it("is true for a root at visibility: hidden (a child can set visible)", () => {
    makeRoot([0, 0, 390, 844], "visibility: hidden");
    expect(rootShown("#lc-root")).toBe(true);
  });

  it("is false while nothing matches, and for a display: none or opacity 0 root", () => {
    expect(rootShown("#lc-root")).toBe(false);
    const root = makeRoot([0, 0, 390, 844], "display: none");
    expect(rootShown("#lc-root")).toBe(false);
    root.setAttribute("style", "opacity: 0");
    expect(rootShown("#lc-root")).toBe(false);
    root.setAttribute("style", "opacity: 1");
    expect(rootShown("#lc-root")).toBe(true);
  });
});

describe("snapshot", () => {
  for (const rect of [
    [0, 0, 390, 0],
    [0, 0, 0, 0],
  ] as Rect[]) {
    it(`records a ${rect[2]} x ${rect[3]} root, and its children hang off it`, () => {
      const root = makeRoot(rect);
      box(root, [0, 10, 390, 40], { "data-lc": "top" });
      // A boxless wrapper (like #root on the phone) is not recorded; its
      // child hangs off the nearest recorded ancestor, the root.
      const wrapper = box(root, [0, 0, 0, 0], { "data-lc": "wrapper" });
      box(wrapper, [0, 60, 390, 40], { "data-lc": "inner" });

      const snap = snapshot("#lc-root")!;
      expect(snap.rootId).not.toBeNull();
      const byLabel = (prefix: string) =>
        snap.boxes.filter((b) => b.label.startsWith(prefix));
      const rootBoxes = byLabel("div#lc-root");
      expect(rootBoxes).toHaveLength(1);
      expect(rootBoxes[0]!.id).toBe(snap.rootId!);
      expect([rootBoxes[0]!.w, rootBoxes[0]!.h]).toEqual([rect[2], rect[3]]);
      expect(rootBoxes[0]!.parent).toBeNull();
      expect(byLabel('div[data-lc="wrapper"]')).toHaveLength(0);
      for (const name of ["top", "inner"]) {
        const kids = byLabel(`div[data-lc="${name}"]`);
        expect(kids).toHaveLength(1);
        expect(kids[0]!.parent).toBe(snap.rootId!);
      }
    });
  }

  it("keeps a boxless root's id across snapshots, and a replaced root gets a new one", () => {
    const first = makeRoot([0, 0, 390, 0]);
    const a = snapshot("#lc-root")!.rootId;
    const b = snapshot("#lc-root")!.rootId;
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    first.remove();
    makeRoot([0, 0, 390, 0]);
    const c = snapshot("#lc-root")!.rootId;
    expect(c).not.toBeNull();
    expect(c).not.toBe(a);
  });

  it("records a root at visibility: hidden", () => {
    const root = makeRoot([0, 0, 390, 0], "visibility: hidden");
    box(root, [0, 10, 390, 40], { "data-lc": "top" }, "visibility: visible");
    const snap = snapshot("#lc-root")!;
    expect(snap.rootId).not.toBeNull();
    const top = snap.boxes.filter((b) =>
      b.label.startsWith('div[data-lc="top"]'),
    );
    expect(top).toHaveLength(1);
    expect(top[0]!.parent).toBe(snap.rootId!);
  });

  it("gives no root id for a display: none or opacity 0 root, as rootShown says", () => {
    for (const style of ["display: none", "opacity: 0"]) {
      document.body.innerHTML = "";
      const root = makeRoot([0, 0, 390, 844], style);
      box(root, [0, 10, 390, 40]);
      expect(rootShown("#lc-root")).toBe(false);
      const snap = snapshot("#lc-root")!;
      expect(snap.rootId).toBeNull();
      expect(snap.boxes).toHaveLength(0);
    }
  });

  it("lets the diff report a top-level element that appears under a boxless root", () => {
    // The reason the root must be recorded: an element with parent null is
    // never reported as appeared.
    const root = makeRoot([0, 0, 390, 0]);
    box(root, [0, 0, 390, 40], { "data-lc": "header" });
    const held = snapshot("#lc-root")!;
    box(root, [0, 40, 390, 30], { "data-lc": "tabs" });
    const loaded = snapshot("#lc-root")!;
    expect(loaded.rootId).toBe(held.rootId);
    const changes = layoutChanges(held.boxes, loaded.boxes);
    expect(changes.map((c) => [c.kind, c.label])).toEqual([
      ["appeared", 'div[data-lc="tabs"]'],
    ]);
  });
});

describe("snapshot: plainText", () => {
  // Task f8e77177: plainText is true for display inline, a direct non-blank
  // text node, a background colour at alpha 0, no background image, all four
  // border widths 0 and no box shadow. happy-dom computes "" for a property
  // the style does not set, so each fixture first sets Chrome's computed
  // values for a plain span (CHROME_SPAN), then the one property under test.
  // The real-browser check is the loading-check run on the office view.
  const CHROME_SPAN =
    "display: inline; background-color: rgba(0, 0, 0, 0); " +
    "background-image: none; border-width: 0px; box-shadow: none";

  /** The plainText the snapshot records for el (a fixture under the root). */
  function plainTextOf(el: Element): boolean | undefined {
    el.setAttribute("data-lc", "probe");
    const snap = snapshot("#lc-root")!;
    const hits = snap.boxes.filter((b) =>
      b.label.startsWith(`${el.tagName.toLowerCase()}[data-lc="probe"]`),
    );
    expect(hits.length).toBe(1);
    return hits[0]!.plainText;
  }

  /** A span with text under a fresh root, with CHROME_SPAN then style. */
  function span(style: string, text = "(35 / 5000)"): HTMLElement {
    document.body.innerHTML = "";
    const root = makeRoot([0, 0, 800, 600]);
    const label = box(root, [0, 0, 800, 20]);
    const el = box(
      label,
      [40, 2, 200, 16],
      {},
      `${CHROME_SPAN}; ${style}`,
      "span",
    );
    el.textContent = text;
    return el;
  }

  it("is true for a plain inline span, also with a transparent colour other than black", () => {
    expect(plainTextOf(span(""))).toBe(true);
    expect(plainTextOf(span("background-color: rgba(255, 255, 255, 0)"))).toBe(
      true,
    );
  });

  it("is false when the span is drawn as a pill or badge", () => {
    const styles = [
      "background-color: rgb(255, 255, 255)",
      "background-color: rgba(0, 0, 0, 0.5)",
      "background-image: linear-gradient(red, blue)",
      "border-top-width: 1px",
      "border-right-width: 1px",
      "border-bottom-width: 1px",
      "border-left-width: 1px",
      "box-shadow: 0 0 0 1px red",
    ];
    for (const style of styles) {
      expect([style, plainTextOf(span(style)) ?? false]).toEqual([
        style,
        false,
      ]);
    }
  });

  it("is false for a box that is not inline", () => {
    for (const display of ["inline-block", "block", "inline-flex"]) {
      expect([
        display,
        plainTextOf(span(`display: ${display}`)) ?? false,
      ]).toEqual([display, false]);
    }
  });

  it("is false without a direct non-blank text node", () => {
    // Only blank text.
    expect(plainTextOf(span("", "  \n "))).not.toBe(true);
    // The text is in a child element, not in the span.
    const s = span("", "");
    const b = document.createElement("b");
    b.textContent = "35";
    s.appendChild(b);
    expect(plainTextOf(s)).not.toBe(true);
    // An inline svg: no border or background, and no text of its own.
    const host = span("", "");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("style", `opacity: 1; ${CHROME_SPAN}`);
    svg.getBoundingClientRect = host.getBoundingClientRect;
    host.replaceWith(svg);
    expect(plainTextOf(svg)).not.toBe(true);
  });
});
