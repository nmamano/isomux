// The snapshot of scripts/loading-check.mjs (task d3593a12, moved here in
// task e5fe2385): the boxes the layout diff compares. These functions run in
// the page through page.evaluate, which sends their source text: each one
// must stand alone, with no reference to module scope.

import type { Box } from "./loading-check-diff.ts";

/** An element with the id the snapshot keeps on it across snapshots. */
type Tagged = Element & { __lcId?: number };

/** The boxes under the root, and the root's id. */
export type Snapshot = { rootId: number | null; boxes: Box[] };

/**
 * In the page: the root matches and is shown: not display: none, not at
 * opacity 0. It may have no box (at phone width the body is 0 px high: the
 * app shell is fixed-position), and visibility: hidden counts as shown, since
 * a child can set visible. The load check waits for it before the held
 * snapshot. snapshot() makes the same two checks: it cannot call this.
 */
export function rootShown(sel: string): boolean {
  const root = document.querySelector(sel);
  if (!root) return false;
  const cs = getComputedStyle(root);
  return cs.display !== "none" && Number(cs.opacity) !== 0;
}

// In the page: the root and every visible element under it, each with an id
// that stays on the element across snapshots, and the root's id. The root is
// recorded when it is shown (rootShown), also with no box: then its box is
// its real 0-size rect, and its children's places are relative to it. The
// root's id is null only when it is hidden. An svg is one box (its parts
// animate). An element at opacity 0 hides its subtree (opacity does not
// inherit, so its children read as visible); visibility: hidden does not,
// since a child can set visible.
export function snapshot(sel: string): Snapshot | null {
  const root = document.querySelector<Tagged>(sel);
  if (!root) return null;
  const w = window as unknown as { __lcNext: number };
  w.__lcNext ??= 1;
  const boxes: Box[] = [];
  const label = (el: Element) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const data = [...el.attributes].find((a) => a.name.startsWith("data-"));
    if (data)
      s += data.value
        ? `[${data.name}="${data.value.slice(0, 30)}"]`
        : `[${data.name}]`;
    else if (typeof el.className === "string" && el.className.trim())
      s += `.${el.className.trim().split(/\s+/)[0]}`;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) s += ` "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`;
    return s;
  };
  // Plain inline text: display inline, a direct non-blank text node, and no
  // background, border or shadow (a pill or badge is not plain). An unset
  // property ("") counts as none.
  const plainText = (el: Element, cs: CSSStyleDeclaration) => {
    if (cs.display !== "inline") return false;
    const text = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim(),
    );
    if (!text) return false;
    const bg = cs.backgroundColor.trim();
    const m = /^rgba?\(([^)]*)\)$/.exec(bg);
    const parts = m ? m[1]!.split(/[\s,/]+/).filter(Boolean) : [];
    const alpha =
      bg === "" || bg === "transparent"
        ? 0
        : !m
          ? 1
          : parts.length > 3
            ? parseFloat(parts[3]!) * (parts[3]!.endsWith("%") ? 0.01 : 1)
            : 1;
    if (!(alpha === 0)) return false;
    const none = (v: string) => v === "" || v === "none";
    if (!none(cs.backgroundImage) || !none(cs.boxShadow)) return false;
    return [
      cs.borderTopWidth,
      cs.borderRightWidth,
      cs.borderBottomWidth,
      cs.borderLeftWidth,
    ].every((v) => !(parseFloat(v) > 0));
  };
  const walk = (el: Tagged, parent: number | null) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    let id = parent;
    if (cs.display === "none" || Number(cs.opacity) === 0) return;
    if (
      el === root ||
      (r.width > 0 && r.height > 0 && cs.visibility !== "hidden")
    ) {
      el.__lcId ??= w.__lcNext++;
      id = el.__lcId;
      boxes.push({
        id,
        parent,
        label: label(el),
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        plainText: plainText(el, cs),
      });
    }
    if (el.tagName.toLowerCase() === "svg") return;
    for (const c of el.children) walk(c as Tagged, id);
  };
  walk(root, null);
  return {
    rootId:
      root.__lcId !== undefined && boxes[0]?.id === root.__lcId
        ? root.__lcId
        : null,
    boxes,
  };
}

/**
 * In the page: where scripts/loading-check.mjs clicks an element with the
 * mouse. Null when the element takes pointer events (a normal click); else
 * the center of its box, so the click lands on what is drawn under it (the
 * lobby's keyboard controls over their props).
 */
export function clickPoint(el: Element): { x: number; y: number } | null {
  if (getComputedStyle(el).pointerEvents !== "none") return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
