// The room turn on a wall-door click (task fee198a0): which choice runs, for
// how long, and that every way a turn ends leaves only the live scene.
// requestAnimationFrame is a manual queue, so frames run at chosen times.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { beginRoomTurn, finishRoomTurn, cancelRoomTurn, setRoomTurn } =
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
  setRoomTurn("off");
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
  it.each([
    ["turn-350", 350],
    ["turn-600", 600],
    ["cube-350", 350],
    ["cube-600", 600],
  ] as const)(
    "%s runs for its time and then leaves only the live scene",
    (choice, ms) => {
      setRoomTurn(choice);
      beginRoomTurn(content, "right", "next");
      finishRoomTurn("next");
      flush(); // the frame after the commit inserts both snapshots
      expect(clones()).toHaveLength(2);
      for (const clone of clones()) {
        expect(clone.getAttribute("aria-hidden")).toBe("true");
        expect(clone.hasAttribute("inert")).toBe(true);
      }
      expect(content.style.opacity).toBe("0");
      // The cube flips the flat picture in 3D; the turn moves the pieces.
      expect(
        clones().some((el) => el.style.transform.includes("rotateY")),
      ).toBe(choice.startsWith("cube"));
      flush(ms - 50);
      expect(clones()).toHaveLength(2);
      flush(ms + 50);
      expect(clones()).toHaveLength(0);
      expect(content.style.opacity).toBe("");
    },
  );

  it("keeps the choice made at the click when the setting changes mid-turn", () => {
    setRoomTurn("turn-600");
    beginRoomTurn(content, "left", "next");
    setRoomTurn("off");
    finishRoomTurn("next");
    flush();
    expect(clones()).toHaveLength(2);
    flush(400);
    expect(clones()).toHaveLength(2);
    flush(650);
    expect(clones()).toHaveLength(0);
  });

  it("does nothing when the setting is off or the system asks for reduced motion", () => {
    for (const setup of [
      () => setRoomTurn("off"),
      () => {
        setRoomTurn("turn-350");
        reduce = true;
      },
    ]) {
      setup();
      beginRoomTurn(content, "right", "next");
      finishRoomTurn("next");
      flush();
      expect(clones()).toHaveLength(0);
      expect(content.style.opacity).toBe("");
    }
  });

  it("drops a turn whose room never opened, so a later switch does not turn", () => {
    setRoomTurn("turn-350");
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
    setRoomTurn("turn-350");
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
    setRoomTurn("turn-350");
    beginRoomTurn(content, "right", "next");
    cancelRoomTurn();
    finishRoomTurn("next");
    flush();
    expect(clones()).toHaveLength(0);
  });
});
