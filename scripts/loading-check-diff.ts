// The layout diff of scripts/loading-check.mjs (task d3593a12): what moved,
// changed size or appeared when the held data of a view arrived. A pure
// module, so the rules are tested without Chrome.

/**
 * One visible element in one snapshot. x, y, w, h are viewport coordinates
 * (getBoundingClientRect, no scroll offset): layoutChanges' viewport option
 * needs them.
 * id names the same DOM element in every snapshot; parent is the id of its
 * nearest recorded ancestor, or null.
 */
export type Box = {
  id: number;
  parent: number | null;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Plain inline text: display inline, with a direct non-blank text node and
   * no background, border or shadow. Absent means false.
   */
  plainText?: boolean;
};

/**
 * One jump. moved: its place relative to its parent changed. resized: its
 * size changed (it may also have moved; dx, dy say so); with a viewport,
 * only when its part in view changed. appeared: it is new,
 * its parent was there while held, and no removed element held its place.
 * dx and dy are relative to the parent; for appeared all four are 0.
 */
export type Change = {
  kind: "moved" | "resized" | "appeared";
  label: string;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  before: Box | null;
  after: Box;
};

/** The two boxes differ past the tolerance in place or size. */
function differs(a: Box, b: Box, tolerancePx: number): boolean {
  return (
    Math.abs(a.x - b.x) > tolerancePx ||
    Math.abs(a.y - b.y) > tolerancePx ||
    Math.abs(a.w - b.w) > tolerancePx ||
    Math.abs(a.h - b.h) > tolerancePx
  );
}

/** The part of a box inside the viewport, or null when none is. */
function inView(
  b: Box,
  view: { w: number; h: number },
): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = Math.max(b.x, 0);
  const y0 = Math.max(b.y, 0);
  const x1 = Math.min(b.x + b.w, view.w);
  const y1 = Math.min(b.y + b.h, view.h);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** The two boxes' parts inside the viewport are the same, past nothing but
 *  the tolerance: a size change there happens out of sight. */
function sameInView(
  a: Box,
  b: Box,
  view: { w: number; h: number },
  tolerancePx: number,
): boolean {
  const p = inView(a, view);
  const q = inView(b, view);
  if (!p || !q) return p === q;
  return (["x0", "y0", "x1", "y1"] as const).every(
    (k) => Math.abs(p[k] - q[k]) <= tolerancePx,
  );
}

/**
 * The ids that are not still after the data arrived: their box differs
 * between two loaded snapshots taken apart, or they are in only one of them.
 */
export function unstableIds(
  loaded: Box[],
  loaded2: Box[],
  tolerancePx = 1,
): Set<number> {
  const second = new Map(loaded2.map((b) => [b.id, b]));
  const out = new Set<number>();
  for (const a of loaded) {
    const b = second.get(a.id);
    if (!b || differs(a, b, tolerancePx)) out.add(a.id);
    second.delete(a.id);
  }
  for (const id of second.keys()) out.add(id);
  return out;
}

/** The area two boxes share. */
function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The jumps between the held and the loaded snapshot, ignored ids left out
 * of both before anything else.
 *
 * Positions are relative to the parent, so an element that moves with its
 * parent is not reported, and a child that moves inside its parent is, even
 * when the parent also moved or changed size (centred content in a panel
 * that grows reads as its own line). A root, or an element whose parent is
 * ignored, is measured in viewport coordinates. An element whose parent is
 * ignored cannot be reported as appeared: it has no held parent. With a
 * viewport, a size change whose part in view stays the same (a list that
 * grows below the fold) is not reported; if it also moved, it is a move.
 *
 * A plain inline text (Box.plainText in both snapshots) that only gets wider
 * (dx, dy, dh within the tolerance) is not a jump: its end grows and moves
 * nothing. It is still reported when a change it can cause is: a kept change
 * on a sibling, an ancestor or a descendant. Two such texts do not keep each
 * other. A text that shrinks or wraps stays a jump.
 */
export function layoutChanges(
  held: Box[],
  loaded: Box[],
  opts: {
    tolerancePx?: number;
    ignore?: ReadonlySet<number>;
    // The viewport (task 73b5c130): a resize is a jump only when the box's
    // part inside it changes.
    viewport?: { w: number; h: number };
  } = {},
): Change[] {
  const tolerancePx = opts.tolerancePx ?? 1;
  const ignore = opts.ignore ?? new Set<number>();
  const before = new Map(
    held.filter((b) => !ignore.has(b.id)).map((b) => [b.id, b]),
  );
  const after = new Map(
    loaded.filter((b) => !ignore.has(b.id)).map((b) => [b.id, b]),
  );

  // Place relative to the parent in the same snapshot.
  const rel = (b: Box, snap: Map<number, Box>) => {
    const p = b.parent === null ? undefined : snap.get(b.parent);
    return p ? { x: b.x - p.x, y: b.y - p.y } : { x: b.x, y: b.y };
  };

  // Removed origins: held boxes gone at release whose parent is not gone.
  const removed = (b: Box) => !after.has(b.id);
  const removedOrigins = [...before.values()].filter(
    (b) =>
      removed(b) &&
      (b.parent === null ||
        !before.has(b.parent) ||
        !removed(before.get(b.parent)!)),
  );

  const changes: Change[] = [];
  for (const a of after.values()) {
    const b = before.get(a.id);
    if (b) {
      const ra = rel(a, after);
      const rb = rel(b, before);
      const dx = ra.x - rb.x;
      const dy = ra.y - rb.y;
      const dw = a.w - b.w;
      const dh = a.h - b.h;
      const past = (d: number) => Math.abs(d) > tolerancePx;
      const resized =
        (past(dw) || past(dh)) &&
        !(opts.viewport && sameInView(a, b, opts.viewport, tolerancePx));
      const kind = resized ? "resized" : past(dx) || past(dy) ? "moved" : null;
      if (kind) {
        changes.push({
          kind,
          label: a.label,
          dx,
          dy,
          dw,
          dh,
          before: b,
          after: a,
        });
      }
      continue;
    }
    // New: report only an origin (its parent was there while held) with area.
    const area = a.w * a.h;
    if (a.parent === null || !before.has(a.parent) || !after.has(a.parent))
      continue;
    if (area <= 0) continue;
    const cover = removedOrigins.reduce((sum, r) => sum + overlap(r, a), 0);
    if (cover * 2 >= area) continue;
    changes.push({
      kind: "appeared",
      label: a.label,
      dx: 0,
      dy: 0,
      dw: 0,
      dh: 0,
      before: null,
      after: a,
    });
  }
  return dropTextGrowth(changes, after, tolerancePx);
}

/** The changes without plain texts that only grow at their end and cause nothing. */
function dropTextGrowth(
  changes: Change[],
  after: Map<number, Box>,
  tolerancePx: number,
): Change[] {
  const past = (d: number) => Math.abs(d) > tolerancePx;
  const grows = (c: Change) =>
    c.kind === "resized" &&
    c.before?.plainText === true &&
    c.after.plainText === true &&
    c.dw > tolerancePx &&
    !past(c.dx) &&
    !past(c.dy) &&
    !past(c.dh);
  const kept = changes.filter((c) => !grows(c));
  if (kept.length === changes.length) return changes;
  // The ids above id in the loaded snapshot, up to a missing (ignored) parent.
  const ancestors = (id: number) => {
    const out = new Set<number>();
    let p = after.get(id)?.parent ?? null;
    while (p !== null && after.has(p) && !out.has(p)) {
      out.add(p);
      p = after.get(p)!.parent;
    }
    return out;
  };
  const near = (c: Change) => {
    const id = c.after.id;
    const up = ancestors(id);
    return kept.some(
      (k) =>
        k.after.parent === c.after.parent ||
        up.has(k.after.id) ||
        ancestors(k.after.id).has(id),
    );
  };
  return changes.filter((c) => !grows(c) || near(c));
}
