// The back room's walls (tasks f0af4677, 79c967a8, a442aa4f): the ladder
// at the right wall's end, the "BACK ROOM" stencil clear of it, the board on
// the left wall, and the lamps above the stencil and the board. The board's
// lines are in BackRoomScreen.board.dom.test.tsx.
import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../../test-support/dom.ts";

setUpDomTestFile();
const { cleanup } = await import("@testing-library/react");
const { backRoomSide } = await import("../../../shared/desks.ts");
const { backRoomLayout } = await import("./geometry.ts");
const { backAgents, show } =
  await import("../../test-support/back-room-fixture.tsx");

afterEach(() => {
  cleanup();
});

const matrixOf = (g: Element) =>
  /matrix\(([^)]+)\)/
    .exec(g.getAttribute("transform")!)![1]
    .split(/[ ,]+/)
    .map(Number);

/** The stencil's extent: centred text, matrix(k 0.5k 0 k x y), so it slants
 *  down to its right end and its left end is its highest point. */
function stencil(el: HTMLElement) {
  const g = el.querySelector("[data-back-sign]")!;
  const [k, b, , , x, y] = matrixOf(g);
  expect(b).toBeCloseTo(0.5 * k);
  const text = g.querySelector("text")!;
  expect(text.getAttribute("text-anchor")).toBe("middle");
  const font = Number(text.getAttribute("font-size"));
  const len = [...text.textContent].length;
  const w = len * (0.6 * font + Number(text.getAttribute("letter-spacing")));
  return {
    left: x - (k * w) / 2,
    right: x + (k * w) / 2,
    top: y - (k * w) / 4 - k * font,
  };
}

/** The board's extent: its frame from (0,0) to (w,h) under
 *  matrix(k -0.5k 0 k x y), so it rises to its right end. */
function board(el: HTMLElement) {
  const g = el.querySelector("[data-back-board]")!;
  const [k, b, , , x, y] = matrixOf(g);
  expect(b).toBeCloseTo(-0.5 * k);
  const w = Number(g.querySelector("rect")!.getAttribute("width"));
  return { left: x, right: x + k * w, top: y - 0.5 * k * w };
}

/** The lowest y a lamp shape reaches. Paths use absolute commands. */
function lowest(e: Element): number {
  const n = (a: string) => Number(e.getAttribute(a) ?? 0);
  switch (e.tagName.toLowerCase()) {
    case "circle":
      return n("cy") + n("r");
    case "ellipse":
      return n("cy") + n("ry");
    case "rect":
      return n("y") + n("height");
    case "line":
      return Math.max(n("y1"), n("y2"));
    case "path": {
      const d = e.getAttribute("d")!;
      expect([d, /^[MLHVCSQTZ\d\s.,-]*$/.test(d)]).toEqual([d, true]);
      const ys: number[] = [];
      for (const [, cmd, args] of d.matchAll(/([MLHVCSQTZ])([^MLHVCSQTZ]*)/g)) {
        const v = args
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        if (cmd === "V") ys.push(...v);
        else if (cmd !== "H" && cmd !== "Z")
          for (let i = 1; i < v.length; i += 2) ys.push(v[i]);
      }
      return Math.max(...ys);
    }
    default:
      // Text or a gradient stop: no extent of its own.
      return -Infinity;
  }
}

describe("BackRoomScreen walls", () => {
  // One render per size for all the wall checks: a 100-agent render costs
  // about 0.6 s.
  it("stands the ladder at the right wall's end, the stencil clear of it, the board on the left wall, and every lamp above both", () => {
    // At 3x3 and at 10x10 (the layout is linear in the side): the ladder's
    // right edge stays inside the wall, past its middle; the "BACK ROOM"
    // stencil stays between the back corner and the ladder; the board stays
    // between the left wall's two corners.
    for (const n of [1, 100]) {
      const agents = backAgents(n);
      const { view } = show(agents);
      const layout = backRoomLayout(backRoomSide(agents.map((a) => a.desk)));
      const backCorner = layout.at(0, 0).x;
      const wallEnd = layout.at(layout.nc, 0).x;
      const ladderXs = [
        ...view.container
          .querySelector("[data-back-ladder]")!
          .getAttribute("d")!
          .matchAll(/[ML](-?[\d.]+) /g),
      ].map((m) => Number(m[1]));
      expect(Math.max(...ladderXs)).toBeLessThanOrEqual(wallEnd);
      expect(Math.min(...ladderXs)).toBeGreaterThan((backCorner + wallEnd) / 2);
      const sign = stencil(view.container);
      expect(sign.left).toBeGreaterThanOrEqual(backCorner);
      expect(sign.right).toBeLessThanOrEqual(Math.min(...ladderXs));
      const b = board(view.container);
      expect(b.left).toBeGreaterThanOrEqual(layout.at(0, layout.nr).x);
      expect(b.right).toBeLessThanOrEqual(backCorner);

      const top = Math.min(sign.top, b.top);
      const lamps = [...view.container.querySelectorAll("[data-back-bulb]")];
      expect(lamps.length).toBeGreaterThanOrEqual(4);
      const xs: number[] = [];
      let glowR = 0;
      for (const lamp of lamps) {
        // The first path is the cord; groups are measured by what they hold.
        const cordEl = lamp.querySelector("path")!;
        const rest = [...lamp.querySelectorAll("*")].filter(
          (e) => e !== cordEl && e.tagName.toLowerCase() !== "g",
        );
        const cord = /^M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)$/.exec(
          cordEl.getAttribute("d")!,
        )!;
        const [, x0, y0] = cord.map(Number);
        // The cord runs up past the top of the screen.
        expect(y0).toBeLessThan(-1000);
        const glows = rest.filter((e) =>
          (e.getAttribute("fill") ?? "").startsWith("url("),
        );
        expect(glows.map((g) => g.tagName.toLowerCase())).toEqual(["circle"]);
        glowR = Number(glows[0].getAttribute("r"));
        // The shade, the bulb and the rest of the lamp: all above the line.
        const body = rest.filter((e) => !glows.includes(e));
        expect(body.length).toBeGreaterThan(0);
        expect(Math.max(...body.map(lowest))).toBeLessThan(top);
        xs.push(x0);
      }
      // No two glows overlap, so no lamp or cord hides behind another.
      xs.sort((a, b) => a - b);
      for (let k = 1; k < xs.length; k++)
        expect(xs[k] - xs[k - 1]).toBeGreaterThan(2 * glowR);
      cleanup();
    }
  });
});
