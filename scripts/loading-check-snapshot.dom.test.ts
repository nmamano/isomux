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
): HTMLElement {
  const el = document.createElement("div");
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
