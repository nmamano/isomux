// The layout diff of scripts/loading-check.mjs (task d3593a12): which
// elements jump when a view's held data arrives. Rules under test:
// - moved: place relative to the parent changed by more than the tolerance;
//   an element that moves with its parent is not reported (origin only).
// - resized: size changed past the tolerance (dx, dy still filled).
// - appeared: new, parent present while held, area > 0, and the removed held
//   origins cover less than half of it (a placeholder swap is not reported).
// - removed elements are not reported; ignored ids count nowhere.
// - with a viewport (task 73b5c130), a resize is reported only when the
//   box's part inside the viewport changes; moves and appearances are as
//   without one.
import { describe, expect, it } from "bun:test";
import {
  layoutChanges,
  unstableIds,
  type Box,
  type Change,
} from "./loading-check-diff.ts";

function box(
  id: number,
  parent: number | null,
  x: number,
  y: number,
  w: number,
  h: number,
): Box {
  return { id, parent, label: `el${id}`, x, y, w, h };
}

// [kind, label] per change, sorted, so the order of the report is free.
function summary(changes: Change[]): [string, string][] {
  return changes
    .map((c): [string, string] => [c.kind, c.label])
    .sort((a, b) => a[1].localeCompare(b[1]));
}

const ROOT = box(1, null, 0, 0, 800, 600);

describe("layoutChanges", () => {
  it("reports nothing when the layout is the same", () => {
    const snap = [ROOT, box(2, 1, 10, 10, 100, 20), box(3, 2, 12, 12, 50, 10)];
    expect(
      layoutChanges(
        snap,
        snap.map((b) => ({ ...b })),
      ),
    ).toStrictEqual([]);
  });

  it("reports the origin of a push, not the elements pushed with it", () => {
    // 2 grows by 40 px; its sibling 3 moves down with it; 4 and 5 inside 3
    // move with their parent and keep their place in it.
    const heldSnap = [
      ROOT,
      box(2, 1, 0, 0, 800, 20),
      box(3, 1, 0, 20, 800, 100),
      box(4, 3, 10, 30, 100, 20),
      box(5, 4, 15, 35, 20, 10),
    ];
    const loadedSnap = [
      ROOT,
      box(2, 1, 0, 0, 800, 60),
      box(3, 1, 0, 60, 800, 100),
      box(4, 3, 10, 70, 100, 20),
      box(5, 4, 15, 75, 20, 10),
    ];
    const changes = layoutChanges(heldSnap, loadedSnap);
    expect(summary(changes)).toStrictEqual([
      ["resized", "el2"],
      ["moved", "el3"],
    ]);
    const moved = changes.find((c) => c.label === "el3")!;
    expect([moved.dx, moved.dy, moved.dw, moved.dh]).toStrictEqual([
      0, 40, 0, 0,
    ]);
    expect(moved.before?.id).toBe(3);
    expect(moved.after.id).toBe(3);
  });

  it("measures a move relative to the parent", () => {
    // 2 moves down 10; its child 3 moves down 30, so 20 within its parent.
    const heldSnap = [ROOT, box(2, 1, 0, 0, 400, 200), box(3, 2, 0, 0, 50, 50)];
    const loadedSnap = [
      ROOT,
      box(2, 1, 0, 10, 400, 200),
      box(3, 2, 0, 30, 50, 50),
    ];
    const changes = layoutChanges(heldSnap, loadedSnap);
    expect(summary(changes)).toStrictEqual([
      ["moved", "el2"],
      ["moved", "el3"],
    ]);
    const child = changes.find((c) => c.label === "el3")!;
    expect([child.dx, child.dy]).toStrictEqual([0, 20]);
  });

  it("reports a resize with its move filled in", () => {
    const heldSnap = [ROOT, box(2, 1, 0, 0, 100, 50)];
    const loadedSnap = [ROOT, box(2, 1, 5, 20, 100, 80)];
    const [c, ...rest] = layoutChanges(heldSnap, loadedSnap);
    expect(rest).toHaveLength(0);
    expect(c.kind).toBe("resized");
    expect([c.dx, c.dy, c.dw, c.dh]).toStrictEqual([5, 20, 0, 30]);
  });

  it("does not report an element removed at release", () => {
    const heldSnap = [ROOT, box(2, 1, 0, 0, 100, 50), box(3, 2, 0, 0, 10, 10)];
    expect(layoutChanges(heldSnap, [ROOT])).toStrictEqual([]);
  });

  it("applies the tolerance: within it is still, past it is a change", () => {
    const heldSnap = [ROOT, box(2, 1, 0, 0, 100, 50)];
    expect(
      layoutChanges(heldSnap, [ROOT, box(2, 1, 1, 1, 101, 51)]),
    ).toStrictEqual([]);
    expect(
      summary(layoutChanges(heldSnap, [ROOT, box(2, 1, 0, 1.5, 100, 50)])),
    ).toStrictEqual([["moved", "el2"]]);
    expect(
      summary(layoutChanges(heldSnap, [ROOT, box(2, 1, 0, 0, 100, 51.5)])),
    ).toStrictEqual([["resized", "el2"]]);
    const wide = { tolerancePx: 3 };
    expect(
      layoutChanges(heldSnap, [ROOT, box(2, 1, 0, 3, 100, 53)], wide),
    ).toStrictEqual([]);
    expect(
      summary(layoutChanges(heldSnap, [ROOT, box(2, 1, 0, 4, 100, 50)], wide)),
    ).toStrictEqual([["moved", "el2"]]);
  });
});

describe("layoutChanges: appeared", () => {
  // The section that pops in after the fetch: 3 is new, under a parent (2)
  // that was there while held. Its child 4 is new too and is not reported.
  const PANE = box(2, 1, 0, 0, 400, 600);
  const SECTION = box(3, 2, 0, 100, 100, 100);
  const SECTION_CHILD = box(4, 3, 10, 110, 50, 20);

  it("reports new content in empty space, origin only", () => {
    const changes = layoutChanges(
      [ROOT, PANE],
      [ROOT, PANE, SECTION, SECTION_CHILD],
    );
    expect(summary(changes)).toStrictEqual([["appeared", "el3"]]);
    const [c] = changes;
    expect(c.before).toBeNull();
    expect(c.after.id).toBe(3);
    expect([c.dx, c.dy, c.dw, c.dh]).toStrictEqual([0, 0, 0, 0]);
  });

  it("does not report a new element of zero area", () => {
    const empty = box(3, 2, 0, 100, 100, 0);
    expect(layoutChanges([ROOT, PANE], [ROOT, PANE, empty])).toStrictEqual([]);
  });

  it("does not report new content that takes a removed placeholder's place", () => {
    const placeholder = box(9, 2, 0, 100, 100, 100);
    const placeholderBar = box(10, 9, 0, 100, 100, 20);
    expect(
      layoutChanges(
        [ROOT, PANE, placeholder, placeholderBar],
        [ROOT, PANE, SECTION, SECTION_CHILD],
      ),
    ).toStrictEqual([]);
  });

  it("treats half covered as covered and less than half as empty space", () => {
    const half = box(9, 2, 0, 100, 100, 50);
    expect(
      layoutChanges([ROOT, PANE, half], [ROOT, PANE, SECTION]),
    ).toStrictEqual([]);
    const lessThanHalf = box(9, 2, 0, 100, 100, 49);
    expect(
      summary(layoutChanges([ROOT, PANE, lessThanHalf], [ROOT, PANE, SECTION])),
    ).toStrictEqual([["appeared", "el3"]]);
  });

  it("adds the cover of several removed origins", () => {
    // Two removed siblings of 25% each: 50% together.
    const top = box(9, 2, 0, 100, 100, 25);
    const bottom = box(10, 2, 0, 125, 100, 25);
    expect(
      layoutChanges([ROOT, PANE, top, bottom], [ROOT, PANE, SECTION]),
    ).toStrictEqual([]);
  });

  it("counts only removed origins, so a removed child does not double the cover", () => {
    // A removed 30% placeholder with a removed child on the same area: 30%.
    const placeholder = box(9, 2, 0, 100, 100, 30);
    const child = box(10, 9, 0, 100, 100, 30);
    expect(
      summary(
        layoutChanges([ROOT, PANE, placeholder, child], [ROOT, PANE, SECTION]),
      ),
    ).toStrictEqual([["appeared", "el3"]]);
  });

  it("counts only the part of a removed box that overlaps the new one", () => {
    // A big removed box that overlaps a quarter of the new section.
    const big = box(9, 2, 50, 150, 200, 200);
    expect(
      summary(layoutChanges([ROOT, PANE, big], [ROOT, PANE, SECTION])),
    ).toStrictEqual([["appeared", "el3"]]);
  });
});

describe("layoutChanges: ignore", () => {
  it("leaves an ignored id out of every kind of change", () => {
    const heldSnap = [ROOT, box(2, 1, 0, 0, 100, 50), box(3, 1, 0, 60, 50, 50)];
    const loadedSnap = [
      ROOT,
      box(2, 1, 0, 30, 100, 50), // moved
      box(3, 1, 0, 60, 80, 50), // resized
      box(4, 1, 300, 300, 50, 50), // appeared
    ];
    expect(
      summary(layoutChanges(heldSnap, loadedSnap)).map(([k]) => k),
    ).toStrictEqual(["moved", "resized", "appeared"]);
    expect(
      layoutChanges(heldSnap, loadedSnap, { ignore: new Set([2, 3, 4]) }),
    ).toStrictEqual([]);
  });

  it("does not count an ignored removed box as cover", () => {
    const pane = box(2, 1, 0, 0, 400, 600);
    const ghost = box(9, 2, 0, 100, 100, 100);
    const section = box(3, 2, 0, 100, 100, 100);
    expect(
      layoutChanges([ROOT, pane, ghost], [ROOT, pane, section]),
    ).toStrictEqual([]);
    expect(
      summary(
        layoutChanges([ROOT, pane, ghost], [ROOT, pane, section], {
          ignore: new Set([9]),
        }),
      ),
    ).toStrictEqual([["appeared", "el3"]]);
  });
});

describe("layoutChanges: viewport", () => {
  // An 800 x 600 viewport. The sidebar's lists block starts in view at y 400
  // and runs past the bottom (task 73b5c130: on a first visit the loaded
  // lists outgrow the placeholders below the fold).
  const VIEWPORT = { viewport: { w: 800, h: 600 } };
  const PANE = box(2, 1, 0, 0, 240, 600);

  it("does not report a resize wholly past the viewport's edge, which it reported without a viewport", () => {
    const held = [ROOT, PANE, box(3, 2, 0, 400, 240, 300)];
    const loaded = [ROOT, PANE, box(3, 2, 0, 400, 240, 328)];
    // The rule's input: without the option, the same snapshots report it.
    expect(summary(layoutChanges(held, loaded))).toStrictEqual([
      ["resized", "el3"],
    ]);
    expect(layoutChanges(held, loaded, VIEWPORT)).toStrictEqual([]);
    // Past the right edge: the same.
    const wideHeld = [ROOT, PANE, box(3, 2, 700, 10, 200, 20)];
    const wideLoaded = [ROOT, PANE, box(3, 2, 700, 10, 260, 20)];
    expect(summary(layoutChanges(wideHeld, wideLoaded))).toStrictEqual([
      ["resized", "el3"],
    ]);
    expect(layoutChanges(wideHeld, wideLoaded, VIEWPORT)).toStrictEqual([]);
    // Wholly below the fold: nothing of it is in view before or after.
    const below = [ROOT, PANE, box(3, 2, 0, 650, 240, 40)];
    const belowGrown = [ROOT, PANE, box(3, 2, 0, 650, 240, 90)];
    expect(layoutChanges(below, belowGrown, VIEWPORT)).toStrictEqual([]);
  });

  it("still reports a resize whose part in view changes, with the full deltas", () => {
    // Grows from 150 to 300 px at y 400: in view it goes from 150 to 200.
    const held = [ROOT, PANE, box(3, 2, 0, 400, 240, 150)];
    const loaded = [ROOT, PANE, box(3, 2, 0, 400, 240, 300)];
    const changes = layoutChanges(held, loaded, VIEWPORT);
    expect(summary(changes)).toStrictEqual([["resized", "el3"]]);
    expect([changes[0].dw, changes[0].dh]).toStrictEqual([0, 150]);
    // Shrinks inside the view: reported.
    const shrunk = [ROOT, PANE, box(3, 2, 0, 400, 240, 100)];
    expect(summary(layoutChanges(held, shrunk, VIEWPORT))).toStrictEqual([
      ["resized", "el3"],
    ]);
    // Past the edge before and after, but its top in view moved: the part
    // in view changes.
    const tall = [ROOT, PANE, box(3, 2, 0, 400, 240, 300)];
    const tallLower = [ROOT, PANE, box(3, 2, 0, 450, 240, 400)];
    expect(summary(layoutChanges(tall, tallLower, VIEWPORT))).toStrictEqual([
      ["resized", "el3"],
    ]);
    // The tolerance applies to the part in view: 1 px in view is still.
    const edge = [ROOT, PANE, box(3, 2, 0, 400, 240, 199)];
    expect(layoutChanges(edge, loaded, VIEWPORT)).toStrictEqual([]);
  });

  it("leaves moves and appearances below the fold as they are without a viewport", () => {
    const held = [ROOT, PANE, box(3, 2, 0, 650, 240, 40)];
    const moved = [ROOT, PANE, box(3, 2, 0, 700, 240, 40)];
    expect(summary(layoutChanges(held, moved, VIEWPORT))).toStrictEqual([
      ["moved", "el3"],
    ]);
    const appeared = [ROOT, PANE, box(4, 2, 0, 700, 240, 40)];
    expect(
      summary(layoutChanges([ROOT, PANE], appeared, VIEWPORT)),
    ).toStrictEqual([["appeared", "el4"]]);
  });
});

describe("unstableIds", () => {
  it("names ids that change between two loaded snapshots or are in one only", () => {
    const a = [
      ROOT,
      box(2, 1, 0, 0, 100, 50), // still
      box(3, 1, 0, 60, 100, 50), // moves 1 px: within tolerance
      box(4, 1, 0, 120, 100, 50), // moves 10 px
      box(5, 1, 0, 180, 100, 50), // gone in the second
    ];
    const b = [
      ROOT,
      box(2, 1, 0, 0, 100, 50),
      box(3, 1, 0, 61, 100, 50),
      box(4, 1, 0, 130, 100, 50),
      box(6, 1, 0, 240, 100, 50), // new in the second
    ];
    expect([...unstableIds(a, b)].sort()).toStrictEqual([4, 5, 6]);
    expect([...unstableIds(a, b, 20)].sort()).toStrictEqual([5, 6]);
  });

  it("names an id whose size changes", () => {
    const a = [ROOT, box(2, 1, 0, 0, 100, 50)];
    const b = [ROOT, box(2, 1, 0, 0, 100, 60)];
    expect([...unstableIds(a, b)]).toStrictEqual([2]);
  });
});
