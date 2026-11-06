// The floor move through the trap door and up the ladder (task c996e4a9):
// it runs for a fixed time, only on a commit to the click's own target, and
// every way it ends leaves only the live view, unmoved.
// requestAnimationFrame is a manual queue, so frames run at chosen times.
import { beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile, stubGlobal } from "../test-support/dom.ts";

setUpDomTestFile();
const { beginFloorMove, finishFloorMove, cancelFloorMove, FLOOR_MOVE_MS } =
  await import("./floor-move.ts");
const { beginRoomTurn, finishRoomTurn, cancelRoomTurn } =
  await import("./room-turn.ts");

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let reduce = false;
stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  frames.set(nextFrame, cb);
  return nextFrame++;
});
stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
stubGlobal("matchMedia", (query: string) => ({
  matches: reduce && query.includes("reduce"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
}));

/** Runs the frames queued so far, as if `ms` passed since now. */
function flush(ms = 0) {
  const due = [...frames.values()];
  frames = new Map();
  const now = performance.now() + ms;
  for (const cb of due) cb(now);
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
  expect(floor.style.overflow).toBe("");
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

  it("moves the camera down through the hatch and up the ladder", () => {
    // Down: the old view leaves upward, the new one rises from below.
    start("down");
    flush(FLOOR_MOVE_MS / 2);
    expect(dy(oldCopy("front"))).toBeLessThan(-H / 4);
    expect(dy(back)).toBeGreaterThan(H / 4);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(back);

    // Up: the mirror.
    start("up");
    flush(FLOOR_MOVE_MS / 2);
    expect(dy(oldCopy("back"))).toBeGreaterThan(H / 4);
    expect(dy(front)).toBeLessThan(-H / 4);
    flush(FLOOR_MOVE_MS + 50);
    expectAtRest(front);
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

  it("drops a click whose switch committed nothing, so a later switch does not move", () => {
    beginFloorMove(floor, "down", "r1");
    flush(); // the frame after the click: no layout effect claimed it
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
