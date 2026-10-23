// The room turn on a wall-door click (task fee198a0): it runs for a fixed
// time (task 8f71e886), and every way a turn ends leaves only the live scene.
// requestAnimationFrame is a manual queue, so frames run at chosen times.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { beginRoomTurn, finishRoomTurn, cancelRoomTurn } =
  await import("./room-turn.ts");

const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;
const realMatchMedia = globalThis.matchMedia;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let reduce = false;
globalThis.requestAnimationFrame = (cb) => {
  frames.set(nextFrame, cb);
  return nextFrame++;
};
globalThis.cancelAnimationFrame = (id) => void frames.delete(id);
globalThis.matchMedia = ((query: string) => ({
  matches: reduce && query.includes("reduce"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof matchMedia;
afterAll(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
  globalThis.matchMedia = realMatchMedia;
});

/** Runs the frames queued so far, as if `ms` passed since now. */
function flush(ms = 0) {
  const due = [...frames.values()];
  frames = new Map();
  const now = performance.now() + ms;
  for (const cb of due) cb(now);
}

let parent: HTMLElement;
let content: HTMLElement;
beforeEach(() => {
  cancelRoomTurn();
  frames = new Map();
  reduce = false;
  localStorage.clear();
  document.body.innerHTML = "";
  parent = document.createElement("div");
  content = document.createElement("div");
  content.innerHTML = '<svg><g id="floor"></g></svg>';
  parent.append(content);
  document.body.append(parent);
});

const clones = () =>
  [...parent.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el !== content,
  );

describe("a wall-door turn", () => {
  // The Room switch animation setting is gone (task 8f71e886): a value an
  // older build stored under its key changes nothing.
  it.each([[null], ["off"], ["turn-350"]] as const)(
    "with %p stored, runs for 600 ms and then leaves only the live scene",
    (stored) => {
      if (stored !== null) localStorage.setItem("isomux-room-turn", stored);
      beginRoomTurn(content, "right", "next");
      finishRoomTurn("next");
      flush(); // the frame after the commit inserts both snapshots
      expect(clones()).toHaveLength(2);
      for (const clone of clones()) {
        expect(clone.getAttribute("aria-hidden")).toBe("true");
        expect(clone.hasAttribute("inert")).toBe(true);
      }
      expect(content.style.opacity).toBe("0");
      flush(550);
      expect(clones()).toHaveLength(2);
      flush(650);
      expect(clones()).toHaveLength(0);
      expect(content.style.opacity).toBe("");
    },
  );

  it("moves a desk on every frame, with none of its own transition easing it", () => {
    content.innerHTML =
      '<div data-turn-anchor="300,400" style="position:absolute;z-index:30;transition:transform 0.25s"></div>';
    beginRoomTurn(content, "right", "next");
    finishRoomTurn("next");
    flush();
    const desks = clones().map((c) => c.firstElementChild as HTMLElement);
    expect(desks).toHaveLength(2);
    for (const desk of desks) expect(desk.style.transition).toBe("none");
    const before = desks.map((d) => d.style.translate);
    flush(300);
    expect(desks.map((d) => d.style.translate)).not.toEqual(before);
  });

  it("does nothing when the system asks for reduced motion", () => {
    reduce = true;
    beginRoomTurn(content, "right", "next");
    finishRoomTurn("next");
    flush();
    expect(clones()).toHaveLength(0);
    expect(content.style.opacity).toBe("");
  });

  it("drops a turn whose room never opened, so a later switch does not turn", () => {
    for (const other of ["elsewhere", null]) {
      beginRoomTurn(content, "right", "next");
      finishRoomTurn(other); // another room, or the lobby, committed instead
      flush();
      expect(clones()).toHaveLength(0);
      finishRoomTurn("next"); // e.g. a tab click to that room later
      flush();
      expect(clones()).toHaveLength(0);
    }
  });

  it("a second click and an unmount each end a running turn cleanly", () => {
    beginRoomTurn(content, "right", "next");
    finishRoomTurn("next");
    flush();
    expect(clones()).toHaveLength(2);
    beginRoomTurn(content, "left", "back");
    expect(clones()).toHaveLength(0);
    expect(content.style.opacity).toBe("");
    finishRoomTurn("back");
    flush();
    expect(clones()).toHaveLength(2);
    cancelRoomTurn();
    expect(clones()).toHaveLength(0);
    expect(content.style.opacity).toBe("");
    flush(1000);
    expect(clones()).toHaveLength(0);
  });

  it("an unmount between the click and the commit cancels the pending turn", () => {
    beginRoomTurn(content, "right", "next");
    cancelRoomTurn();
    finishRoomTurn("next");
    flush();
    expect(clones()).toHaveLength(0);
  });
});
