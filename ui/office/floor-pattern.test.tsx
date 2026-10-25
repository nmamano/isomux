// The floor patterns, read from the drawn floor. Nil, 2026-10-25: "the thick
// side of the floor always needs to look consistent with the pattern to make
// it feel 3d". So each slab segment along the two front edges must sit under
// exactly one front tile - found by geometry, not by index - and take that
// tile's tone. Tones are read from the fills the floor paints, so a marker
// that says one tone over a fill of the other does not pass.

import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Floor } from "./Floor.tsx";
import { FLOOR_N } from "./grid.ts";
import { ROOM_DECOR_OPTIONS } from "../../shared/room-decor.ts";

type Tone = "light" | "dark";
type Point = [number, number];
const EPS = 1e-3;

function attrs(tag: string): Map<string, string> {
  return new Map(
    [...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
}

function points(d: string): Point[] {
  const nums = [...d.matchAll(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)].map(Number);
  const out: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

function toneOf(fill: string, prefix: string): Tone {
  if (fill.includes(`${prefix}light`)) return "light";
  if (fill.includes(`${prefix}dark`)) return "dark";
  throw new Error(`fill ${fill} is neither tone`);
}

function drawFloor(pattern: string) {
  const markup = renderToStaticMarkup(
    <Floor pattern={pattern as never} desk8Cable={false} />,
  );
  const tags = [...markup.matchAll(/<path\b[^>]*>/g)].map((m) => attrs(m[0]));
  const tiles = tags
    .filter((a) => a.has("data-floor-tile"))
    .map((a) => {
      const [r, c] = a.get("data-floor-tile")!.split("-").map(Number);
      return {
        r,
        c,
        tone: toneOf(a.get("fill")!, "--floor-"),
        corners: points(a.get("d")!),
      };
    });
  const slabs = tags
    .filter((a) => a.has("data-floor-slab"))
    .map((a) => ({
      id: a.get("data-floor-slab")!,
      tone: toneOf(a.get("fill")!, "--floor-edge-"),
      corners: points(a.get("d")!),
    }));
  return { tiles, slabs };
}

/** A slab segment's top edge: at each of its two x positions, the higher
 *  point (the slab hangs straight down from the floor's edge). */
function topEdge(corners: Point[]): [Point, Point] {
  const byX = new Map<number, number>();
  for (const [x, y] of corners) {
    const key = Math.round(x / EPS) * EPS;
    byX.set(key, Math.min(byX.get(key) ?? Infinity, y));
  }
  expect(byX.size).toBe(2);
  const [a, b] = [...byX.entries()].sort((p, q) => p[0] - q[0]);
  return [a, b];
}

function onSegment([a, b]: [Point, Point], p: Point): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return (
    Math.abs(cross) / len < EPS &&
    p[0] >= Math.min(a[0], b[0]) - EPS &&
    p[0] <= Math.max(a[0], b[0]) + EPS
  );
}

const PATTERNS = ROOM_DECOR_OPTIONS.floor;

it("every slab segment sits under one front tile and takes its tone, in every pattern", () => {
  for (const pattern of PATTERNS) {
    const { tiles, slabs } = drawFloor(pattern);
    const cells = Math.sqrt(tiles.length);
    expect({ pattern, square: Number.isInteger(cells) && cells > 0 }).toEqual({
      pattern,
      square: true,
    });
    // One segment per front tile on each side.
    expect({ pattern, slabs: slabs.length }).toEqual({
      pattern,
      slabs: 2 * cells,
    });
    const met = new Set<string>();
    for (const slab of slabs) {
      const edge = topEdge(slab.corners);
      const under = tiles.filter((tile) => {
        const n = tile.corners.length;
        return tile.corners.some(
          (p, i) =>
            onSegment(edge, p) && onSegment(edge, tile.corners[(i + 1) % n]),
        );
      });
      expect({ pattern, slab: slab.id, under: under.length }).toEqual({
        pattern,
        slab: slab.id,
        under: 1,
      });
      const tile = under[0];
      met.add(`${slab.id.split("-")[0]}:${tile.r}-${tile.c}`);
      expect({ pattern, slab: slab.id, tone: slab.tone }).toEqual({
        pattern,
        slab: slab.id,
        tone: tile.tone,
      });
    }
    // No front tile is left without its slab, and none has two.
    expect({ pattern, met: met.size }).toEqual({ pattern, met: 2 * cells });
  }
});

it("the checker is the floor every room drew before patterns, plain is one tone, and each pattern is its own", () => {
  const drawn = new Map<string, string>();
  for (const pattern of PATTERNS) {
    const { tiles } = drawFloor(pattern);
    const key = [...tiles]
      .sort((a, b) => a.r - b.r || a.c - b.c)
      .map((t) => `${t.r}-${t.c}:${t.tone}`)
      .join(",");
    expect({ pattern, sameAs: drawn.get(key) ?? null }).toEqual({
      pattern,
      sameAs: null,
    });
    drawn.set(key, pattern);
  }

  const checker = drawFloor("checker").tiles;
  expect(checker).toHaveLength(FLOOR_N * FLOOR_N);
  for (const tile of checker) {
    expect({ tile: [tile.r, tile.c], tone: tile.tone }).toEqual({
      tile: [tile.r, tile.c],
      tone: (tile.r + tile.c) % 2 === 0 ? "light" : "dark",
    });
  }
  // A room with no floor choice draws the checker.
  expect(drawFloor(undefined as never)).toEqual(drawFloor("checker"));

  const plain = drawFloor("plain").tiles;
  expect(plain.length).toBeGreaterThan(0);
  expect(new Set(plain.map((t) => t.tone)).size).toBe(1);
});
