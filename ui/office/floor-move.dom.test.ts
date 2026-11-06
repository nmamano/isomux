// The floor move through the trap door and up the ladder (task c996e4a9):
// it runs for a fixed time, only on a commit to the click's own target, and
// every way it ends leaves only the live view, unmoved. The two rooms move as
// one building, the back room under the front floor (task 28aa0955).
// requestAnimationFrame and setTimeout are manual queues, so frames and
// timers run at chosen times.
import { beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile, stubGlobal } from "../test-support/dom.ts";

setUpDomTestFile();
const { beginFloorMove, finishFloorMove, cancelFloorMove, FLOOR_MOVE_MS } =
  await import("./floor-move.ts");
const { beginRoomTurn, finishRoomTurn, cancelRoomTurn } =
  await import("./room-turn.ts");
const { SLAB_H, WALL_H } = await import("./back-room/geometry.ts");

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let reduce = false;
stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  frames.set(nextFrame, cb);
  return nextFrame++;
});
stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
let timers = new Map<number, { at: number; cb: () => void }>();
let nextTimer = 1;
let clock = 0;
stubGlobal("setTimeout", (cb: () => void, ms = 0) => {
  timers.set(nextTimer, { at: clock + ms, cb });
  return nextTimer++;
});
stubGlobal("clearTimeout", (id: number) => void timers.delete(id));
stubGlobal("matchMedia", (query: string) => ({
  matches: reduce && query.includes("reduce"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
}));

/** Runs the frames queued so far, as if `ms` passed since a move's first
 * frame. */
function flush(ms = 0) {
  const due = [...frames.values()];
  frames = new Map();
  for (const cb of due) cb(1000 + ms);
}

/** Lets `ms` pass for the timers. */
function advance(ms: number) {
  clock += ms;
  for (const [id, t] of [...timers])
    if (t.at <= clock) {
      timers.delete(id);
      t.cb();
    }
}

// happy-dom lays nothing out: give the floor and its views a real size.
const H = 400;
function sized(el: HTMLElement) {
  for (const prop of ["clientHeight", "offsetHeight", "scrollHeight"])
    Object.defineProperty(el, prop, { configurable: true, get: () => H });
  for (const prop of ["clientWidth", "offsetWidth", "scrollWidth"])
    Object.defineProperty(el, prop, { configurable: true, get: () => 800 });
  el.getBoundingClientRect = () => new DOMRect(0, 0, 800, H);
  return el;
}

function view(name: string) {
  const el = sized(document.createElement("div"));
  el.setAttribute("data-floor-view", "");
  el.setAttribute("data-name", name);
  el.innerHTML = `<svg><defs><linearGradient id="g-${name}"></linearGradient></defs></svg>`;
  return el;
}

let floor: HTMLElement;
let front: HTMLElement;
let back: HTMLElement;
// A later sibling of the view, as the members chat panel is: the move paints
// below it.
let chat: HTMLElement;
beforeEach(() => {
  cancelFloorMove();
  cancelRoomTurn();
  frames = new Map();
  timers = new Map();
  reduce = false;
  document.body.innerHTML = "";
  floor = sized(document.createElement("div"));
  front = view("front");
  back = view("back");
  chat = document.createElement("div");
  chat.setAttribute("data-name", "chat");
  floor.append(front, chat);
  document.body.append(floor);
});

/** What React does at the commit: the other view replaces the live one. */
function commit(to: HTMLElement) {
  const live = floor.querySelector(":scope > [data-floor-view]")!;
  if (live !== to) live.replaceWith(to);
}

/** Everything the move added to the floor. */
const added = () =>
  [...floor.children].filter(
    (el) => !el.hasAttribute("data-floor-view") && el !== chat,
  ) as HTMLElement[];

/** How far down the element is moved, in px, by its own style and its
 * ancestors' up to the floor. */
function dy(el: HTMLElement): number {
  let sum = 0;
  for (
    let at: HTMLElement | null = el;
    at && at !== floor;
    at = at.parentElement
  )
    sum += ownDy(at);
  return sum;
}

/** How far the element is moved, [x, y] in px, by the translate of its own
 * style and its ancestors' up to the floor. */
function shift(el: HTMLElement): [number, number] {
  let x = 0,
    y = 0;
  for (
    let at: HTMLElement | null = el;
    at && at !== floor;
    at = at.parentElement
  ) {
    const [tx = "0", ty = "0"] = at.style.translate.trim().split(/\s+/);
    x += parseFloat(tx) || 0;
    y += parseFloat(ty) || 0;
  }
  return [x, y];
}

/** The vertical offset in px a style moves the element by: the translate
 * property, or a translate in the transform. */
function ownDy(el: HTMLElement): number {
  const t = el.style.translate.trim();
  if (t) {
    const parts = t.split(/\s+/);
    return parts.length > 1 ? parseFloat(parts[1]) : 0;
  }
  const tf = el.style.transform;
  let m = /translateY\(\s*(-?[\d.]+)px/.exec(tf);
  if (m) return parseFloat(m[1]);
  m = /translate(?:3d)?\(\s*-?[\d.]+px\s*,\s*(-?[\d.]+)px/.exec(tf);
  if (m) return parseFloat(m[1]);
  m = /matrix\(([^)]*)\)/.exec(tf);
  if (m) return parseFloat(m[1].split(",")[5]);
  return 0;
}

/** The moving copy of the old view: the one element that carries its name
 * inside what the move added. */
function oldCopy(name: string): HTMLElement {
  const hits = added().flatMap((el) => [
    ...(el.getAttribute("data-name") === name ? [el] : []),
    ...el.querySelectorAll<HTMLElement>(`[data-name="${name}"]`),
  ]);
  expect(hits).toHaveLength(1);
  return hits[0];
}

/** The live view carries no style the move left behind. */
function expectAtRest(live: HTMLElement) {
  expect(added()).toHaveLength(0);
  expect(live.style.translate).toBe("");
  expect(live.style.transform).toBe("");
  expect(live.style.clipPath).toBe("");
  expect(live.style.opacity).toBe("");
  for (const el of live.querySelectorAll<HTMLElement>("[data-floor-chrome]"))
    expect(el.style.opacity).toBe("");
  expect(floor.style.overflow).toBe("");
}

/** An element's opacity as a number: 1 when its style sets none. */
const opacity = (el: HTMLElement) =>
  el.style.opacity === "" ? 1 : parseFloat(el.style.opacity);

/** Gives a view its 950x700 scene box at (left, top) on screen, drawn at
 * scale s, and returns the box's back corner on screen: scene point
 * (475, 140), where the building's two walls meet its floor. */
function scene(
  el: HTMLElement,
  left: number,
  top: number,
  s: number,
): [number, number] {
  const box = document.createElement("div");
  box.setAttribute("data-floor-scene", "");
  box.getBoundingClientRect = () => new DOMRect(left, top, 950 * s, 700 * s);
  el.append(box);
  return [left + 475 * s, top + 140 * s];
}

/** Gives a view a control that stays on the screen while the building
 * moves. */
function chrome(el: HTMLElement): HTMLElement {
  const c = document.createElement("div");
  c.setAttribute("data-floor-chrome", "");
  c.setAttribute("data-name", `chrome-${el.getAttribute("data-name")}`);
  el.append(c);
  return c;
}

/** Clicks, commits the target and runs the first frame: the move is on. */
function start(dir: "down" | "up") {
  const [from, to] = dir === "down" ? [front, back] : [back, front];
  if (dir === "up") commit(back);
  beginFloorMove(floor, dir, "r1");
  commit(to);
  finishFloorMove("r1", dir === "down");
  flush();
  expect(added()).toHaveLength(1);
  return { from, to };
}

describe("a floor move", () => {
  it("shows a still copy of the old view under the later siblings, for the move's time only", () => {
    start("down");
    // The copy sits right after the live view and before the chat panel.
    expect(
      [...floor.children].map((el) => el.getAttribute("data-name")),
    ).toEqual(["back", null, "chat"]);
    const host = added()[0];
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.style.pointerEvents).toBe("none");
    oldCopy("front");
    flush(FLOOR_MOVE_MS - 50);
    expect(added()).toHaveLength(1);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(back);
  });

  it("moves the two rooms as one building, the back room's wall tops under the front floor's slab", () => {
    // A different place and zoom on each floor: the joint is still exact.
    const sf = 1,
      sb = 0.8;
    const frontCorner = scene(front, 10, 20, sf);
    const backCorner = scene(back, 40, -30, sb);
    const joint = SLAB_H * sf + WALL_H * sb;
    // Where the back room's corner is on screen, less where the building
    // says it must be: under the front room's corner, `joint` lower.
    const gap = (frontEl: HTMLElement, backEl: HTMLElement) => {
      const [fx, fy] = shift(frontEl);
      const [bx, by] = shift(backEl);
      return [
        backCorner[0] + bx - (frontCorner[0] + fx),
        backCorner[1] + by - (frontCorner[1] + fy) - joint,
      ];
    };

    // Down: the old front room starts where it was, the back room hangs
    // under it, and both move together.
    start("down");
    expect(shift(oldCopy("front"))).toEqual([0, 0]);
    for (const ms of [0, FLOOR_MOVE_MS / 2]) {
      flush(ms);
      const [gx, gy] = gap(oldCopy("front"), back);
      expect(gx).toBeCloseTo(0, 6);
      expect(gy).toBeCloseTo(0, 6);
    }
    expect(shift(oldCopy("front"))[1]).toBeLessThan(0);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(back);

    // Up: the old back room starts where it was, under the front room.
    start("up");
    expect(shift(oldCopy("back"))).toEqual([0, 0]);
    for (const ms of [0, FLOOR_MOVE_MS / 2]) {
      flush(ms);
      const [gx, gy] = gap(front, oldCopy("back"));
      expect(gx).toBeCloseTo(0, 6);
      expect(gy).toBeCloseTo(0, 6);
    }
    expect(shift(oldCopy("back"))[1]).toBeGreaterThan(0);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(front);
  });

  it("without scene boxes, the new view comes from a whole view height away", () => {
    // Down: the new view starts a view height below and rises.
    start("down");
    expect(dy(back)).toBeCloseTo(H, 6);
    flush(FLOOR_MOVE_MS / 2);
    expect(dy(oldCopy("front"))).toBeLessThan(-H / 4);
    expect(dy(back)).toBeGreaterThan(H / 4);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(back);

    // Up: the mirror.
    start("up");
    expect(dy(front)).toBeCloseTo(-H, 6);
    flush(FLOOR_MOVE_MS / 2);
    expect(dy(oldCopy("back"))).toBeGreaterThan(H / 4);
    expect(dy(front)).toBeLessThan(-H / 4);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(front);
  });

  it("paints the front room over the back room, and fades the room the camera leaves or nears through the floor", () => {
    const names = () =>
      [...floor.children].map((el) => el.getAttribute("data-name"));
    const end = 0.98 * FLOOR_MOVE_MS;

    // Down: the front copy is over the back room. The back room is not
    // seen at the click and is all there at the end; the front room is the
    // reverse.
    start("down");
    expect(names()).toEqual(["back", null, "chat"]);
    expect(opacity(oldCopy("front"))).toBe(1);
    expect(opacity(back)).toBe(0);
    flush(end);
    expect(opacity(oldCopy("front"))).toBe(0);
    expect(opacity(back)).toBe(1);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(back);

    // Up: the live front room is over the back copy. It is not seen at the
    // click and is all there at the end; the back room fades away before its
    // copy goes.
    start("up");
    expect(names()).toEqual([null, "front", "chat"]);
    expect(opacity(front)).toBe(0);
    expect(opacity(oldCopy("back"))).toBe(1);
    flush(end);
    expect(opacity(front)).toBe(1);
    expect(opacity(oldCopy("back"))).toBeLessThan(0.1);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(front);
  });

  it("fades the old view's controls out and the new view's in, so no control rides across the screen", () => {
    chrome(front);
    const live = chrome(back);
    const copied = () =>
      added()[0].querySelector<HTMLElement>('[data-name="chrome-front"]')!;
    start("down");
    expect(opacity(copied())).toBe(1);
    expect(opacity(live)).toBe(0);
    flush(FLOOR_MOVE_MS / 2);
    expect(opacity(copied())).toBe(0);
    expect(opacity(live)).toBe(0);
    flush(0.98 * FLOOR_MOVE_MS);
    expect(opacity(live)).toBeGreaterThan(0.8);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(back);

    // A cancel in the middle gives the live controls back too.
    commit(front);
    start("down");
    flush(FLOOR_MOVE_MS / 2);
    expect(opacity(live)).toBe(0);
    cancelFloorMove();
    expectAtRest(back);
  });

  it("does nothing when the system asks for reduced motion", () => {
    reduce = true;
    beginFloorMove(floor, "down", "r1");
    commit(back);
    finishFloorMove("r1", true);
    flush();
    expectAtRest(back);
    flush(FLOOR_MOVE_MS / 2);
    expectAtRest(back);
  });

  it("starts no move on a commit to anything but the click's target, now or later", () => {
    const others: [string | null, boolean, "down" | "up"][] = [
      ["r2", true, "down"], // another room's back room
      ["r1", false, "down"], // the front stayed
      [null, false, "down"], // the lobby
      ["r1", true, "up"], // a ladder click, but the back room is still shown
    ];
    for (const [roomId, backShown, dir] of others) {
      beginFloorMove(floor, dir, "r1");
      finishFloorMove(roomId, backShown);
      flush();
      expect(added()).toHaveLength(0);
      finishFloorMove("r1", dir === "down"); // e.g. the "b" key later
      flush();
      expect(added()).toHaveLength(0);
    }
  });

  it("ends a running move when another room, side or the lobby commits", () => {
    for (const [roomId, backShown] of [
      ["r2", true], // a tab to another room keeps the back room open
      ["r1", false], // the Back button
      [null, false], // the lobby
    ] as const) {
      commit(front);
      start("down");
      flush(FLOOR_MOVE_MS / 2);
      finishFloorMove(roomId, backShown);
      expectAtRest(back);
      flush(FLOOR_MOVE_MS);
      expectAtRest(back);
    }
  });

  it("waits for a switch that commits frames after the click, but drops a click that committed nothing", () => {
    // Up the ladder can go back in the browser history: the switch commits
    // on the popstate event, after the next frame.
    commit(back);
    beginFloorMove(floor, "up", "r1");
    flush();
    advance(100);
    commit(front);
    finishFloorMove("r1", false);
    flush();
    expect(added()).toHaveLength(1);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(front);

    // A click whose switch never came: a later switch does not move.
    beginFloorMove(floor, "down", "r1");
    flush();
    advance(1000);
    commit(back);
    finishFloorMove("r1", true); // e.g. the "b" key later
    flush();
    expectAtRest(back);
  });

  it("a second click and an unmount each end a running move cleanly", () => {
    start("down");
    flush(FLOOR_MOVE_MS / 2);
    beginFloorMove(floor, "up", "r1");
    expectAtRest(back);
    commit(front);
    finishFloorMove("r1", false);
    flush();
    expect(added()).toHaveLength(1);
    flush(FLOOR_MOVE_MS / 2);
    cancelFloorMove();
    expectAtRest(front);
    flush(FLOOR_MOVE_MS);
    expectAtRest(front);
  });

  it("an unmount between the click and the commit cancels the pending move", () => {
    beginFloorMove(floor, "down", "r1");
    cancelFloorMove();
    commit(back);
    finishFloorMove("r1", true);
    flush();
    expectAtRest(back);
  });

  it("a hatch click during a door turn ends the turn first, so the copy is the room at rest", () => {
    const content = document.createElement("div");
    content.setAttribute("data-name", "content");
    front.append(content);
    beginRoomTurn(content, "right", "r1");
    finishRoomTurn("r1");
    flush();
    expect(front.children.length).toBeGreaterThan(2); // the turn's two copies
    beginFloorMove(floor, "down", "r1");
    expect(front.children).toHaveLength(2); // svg + content
    expect(content.style.opacity).toBe("");
    commit(back);
    finishFloorMove("r1", true);
    flush();
    const copy = oldCopy("front");
    expect(copy.children).toHaveLength(2);
    expect(
      copy.querySelector<HTMLElement>('[data-name="content"]')!.style.opacity,
    ).toBe("");
  });
});
