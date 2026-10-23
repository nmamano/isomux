// The room turn on a wall-door click (task fee198a0): it runs for a fixed
// time (task 8f71e886), and every way a turn ends leaves only the live scene.
// requestAnimationFrame is a manual queue, so frames run at chosen times.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { beginRoomTurn, finishRoomTurn, cancelRoomTurn } =
  await import("./room-turn.ts");
const { createElement } = await import("react");
const { act, render } = await import("@testing-library/react");
const { LobbyScene } = await import("./lobby/LobbyScene.tsx");

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
    for (const other of ["elsewhere", "lobby", null]) {
      beginRoomTurn(content, "right", "next");
      finishRoomTurn(other); // another room or the lobby committed instead
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

// The lobby turns like a room (task 8f71e886), so each of its layers must
// move as the plane it is drawn on: wall art with its wall, flat floor items
// with the floor, upright props and the receptionist as standing sprites.
describe("a lobby turn", () => {
  const OFFICE = "Turn test office";
  function turnLobby() {
    const view = render(
      createElement(LobbyScene, {
        rooms: [{ id: "r1", name: "r1" }],
        officeName: OFFICE,
        mode: "dark",
        placements: [
          { family: "directory", variant: "board", a: 4, b: 0, wall: "right" },
          { family: "lamp", variant: "arc", a: 5, b: 3 },
        ],
        receptionistAt: { a: 5, b: 5 },
        receptionist: createElement("g", { "data-test-receptionist": "" }),
      }),
      { container: content },
    );
    act(() => {
      beginRoomTurn(content, "left", "r1");
      finishRoomTurn("r1");
    });
    flush();
    flush(300); // mid-turn
    return view;
  }
  // The scene layer (a direct child of a snapshot) that holds `selector`.
  function layersHolding(selector: string) {
    const out: HTMLElement[] = [];
    for (const clone of clones())
      for (const layer of Array.from(clone.children) as HTMLElement[])
        if (layer.matches(selector) || layer.querySelector(selector))
          out.push(layer);
    return out;
  }
  // The wall art draws the office name; nothing else in this scene does.
  const wallArt = () =>
    clones()
      .flatMap((clone) => Array.from(clone.children) as HTMLElement[])
      .filter((layer) => layer.textContent?.includes(OFFICE));

  it("moves the wall art with its wall, split at the back corner", () => {
    const view = turnLobby();
    // Two snapshots, each with one copy per wall plane.
    const layers = wallArt();
    expect(layers).toHaveLength(4);
    for (const layer of layers) {
      expect(layer.style.transform).toStartWith("matrix(");
      expect(layer.style.clipPath).toStartWith("polygon(");
    }
    view.unmount();
  });

  it("moves a lamp's light pool with the floor, in one piece", () => {
    const view = turnLobby();
    const layers = layersHolding('[fill^="url(#lobby-lamp-pool"]');
    expect(layers).toHaveLength(2); // one per snapshot: the floor is not split
    for (const layer of layers) {
      expect(layer.style.transform).toStartWith("matrix(");
      expect(layer.style.clipPath).toBe("");
      // The wall art is not on this layer.
      expect(layer.textContent?.includes(OFFICE)).toBe(false);
    }
    view.unmount();
  });

  it("keeps the receptionist upright: its layer is not mapped as a plane", () => {
    const view = turnLobby();
    const layers = layersHolding("[data-test-receptionist]");
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(layer).toBeInstanceOf(SVGSVGElement);
      expect(layer.style.transform).toBe("");
      expect(layer.style.clipPath).toBe("");
      expect(layer.querySelector('[fill^="url(#lobby-lamp-pool"]')).toBeNull();
    }
    view.unmount();
  });
});
