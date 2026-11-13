// The office's zoom and pan hook in the DOM: what each input does to the
// view.
//
// The view after its scene remounts (task f0af4677): the back room
// screen takes the place of the front's container, and when it closes, the
// front comes back on new container and scene elements while OfficeView, and
// so the viewport hook, stays mounted. The view must come back where it was.
// On the old code the new scene was measured before it carried the saved
// transform, so each round trip moved the front down by its rest offset.
import { expect, it } from "bun:test";
import { useEffect } from "react";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { useViewport } = await import("./useViewport.ts");
type Viewport = ReturnType<typeof useViewport>;

// A container too short for the scene, so the rest view moves the scene down
// (as at 1440x900, where the front rests at translate(0px, 89px)).
const CW = 1000;
const CH = 560;
// The content's layout box in the container at the identity transform.
const BOX = { left: 25, top: 0, width: 950, height: 700 };

function transformOf(el: Element): { x: number; y: number; s: number } {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(
    (el as HTMLElement).style.transform,
  );
  return m
    ? { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) }
    : { x: 0, y: 0, s: 1 };
}

/** Stands in for the browser's layout, and returns the undo. */
function fakeLayout() {
  const OriginalObserver = globalThis.ResizeObserver;
  const originalRect = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getBoundingClientRect",
  )!;
  // happy-dom's own getters live on HTMLElement.prototype: the undo puts
  // them back, or every later file in the process reads undefined.
  const originalSizes = (["clientWidth", "clientHeight"] as const).map(
    (key) =>
      [
        key,
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)!,
      ] as const,
  );
  // As in a browser, a new observation reports the element's size once.
  globalThis.ResizeObserver = class {
    constructor(private cb: () => void) {}
    observe() {
      this.cb();
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.hasAttribute("data-test-container"))
      return new DOMRect(0, 0, CW, CH);
    if (this.hasAttribute("data-test-content")) {
      // The content paints where the scene's live transform puts it.
      const t = transformOf(this.parentElement!);
      return new DOMRect(
        t.x + BOX.left * t.s,
        t.y + BOX.top * t.s,
        BOX.width * t.s,
        BOX.height * t.s,
      );
    }
    return new DOMRect(0, 0, 0, 0);
  };
  for (const key of ["clientWidth", "clientHeight"] as const)
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get() {
        if (!this.hasAttribute("data-test-container")) return 0;
        return key === "clientWidth" ? CW : CH;
      },
    });
  return () => {
    globalThis.ResizeObserver = OriginalObserver;
    Object.defineProperty(
      Element.prototype,
      "getBoundingClientRect",
      originalRect,
    );
    for (const [key, descriptor] of originalSizes)
      Object.defineProperty(HTMLElement.prototype, key, descriptor);
  };
}

function Office({
  front,
  apiRef,
}: {
  front: boolean;
  apiRef?: { current: Viewport | null };
}) {
  const viewport = useViewport("test", true);
  useEffect(() => {
    if (apiRef) apiRef.current = viewport;
  });
  if (!front) return <div data-test-back />;
  return (
    // eslint-disable-next-line react-hooks/refs -- stable callback refs
    <div data-test-container ref={viewport.setContainer}>
      {/* eslint-disable-next-line react-hooks/refs -- stable callback refs */}
      <div data-test-scene ref={viewport.setScene}>
        {/* eslint-disable-next-line react-hooks/refs -- stable callback refs */}
        <div data-test-content ref={viewport.setContent} />
      </div>
    </div>
  );
}

it("brings the front back at the same view after the back screen closes", () => {
  const undo = fakeLayout();
  try {
    check();
  } finally {
    undo();
  }
});

function check() {
  const view = render(<Office front />);
  const scene = () => view.container.querySelector("[data-test-scene]")!;
  const before = transformOf(scene());
  // The rest view moved the scene; otherwise the test proves nothing.
  expect(before.y).not.toBe(0);
  for (let trip = 0; trip < 3; trip++) {
    act(() => view.rerender(<Office front={false} />));
    act(() => view.rerender(<Office front />));
    const after = transformOf(scene());
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    expect(after.s).toBeCloseTo(before.s, 6);
  }
  view.unmount();
}

// ---- Wheel, pinch and Safari gestures (task 7dfe3044) ----------------------
// On a Mac trackpad a two-finger scroll is a plain wheel stream with an
// inertia tail; it used to zoom the room up to 2.5x (Nil, 2026-11-10: the
// room came back from a chat zoomed onto its window). Only a pinch zooms: a
// ctrlKey or metaKey wheel (Chrome and Firefox pinch, Ctrl/Cmd+mouse wheel)
// or Safari's gesture events. A browser zoom carried over from another page
// is the browser's to undo.

/** Mounts the front once; each case starts from the rest view. */
function mountRoom() {
  const api: { current: Viewport | null } = { current: null };
  const view = render(<Office front apiRef={api} />);
  const container = view.container.querySelector("[data-test-container]")!;
  const scene = () => view.container.querySelector("[data-test-scene]")!;
  act(() => api.current!.resetView(false));
  const rest = transformOf(scene());
  return { view, api, container, scene, rest };
}

// The wheel events' clock (Event.timeStamp). The room tells a trackpad stream
// by the time between events, page-wide and across mounts, so each event
// says how long after the one before it came (`after`, in ms); the default
// is long enough that an event stands alone. The harness clears the page's
// wheel history at the start of each file.
let clock = 1e6;

// happy-dom's WheelEvent is a UIEvent: it drops the pointer position and the
// modifier keys from its init, and has no wheelDeltaY.
function wheel(
  target: EventTarget,
  init: {
    deltaX?: number;
    deltaY?: number;
    deltaMode?: number;
    /** Blink and WebKit's wheelDeltaY; left out, the event has none (Firefox). */
    wheelDeltaY?: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    /** Ms since the event before it. */
    after?: number;
    /** Getters that replace the deltas, for an event that reads like Firefox's. */
    deltas?: PropertyDescriptorMap;
  },
  at = { x: 400, y: 250 },
) {
  const e = new WheelEvent("wheel", {
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? 0,
    deltaMode: init.deltaMode ?? 0,
    bubbles: true,
    cancelable: true,
  });
  clock += init.after ?? 1000;
  Object.defineProperties(e, {
    clientX: { value: at.x },
    clientY: { value: at.y },
    ctrlKey: { value: init.ctrlKey ?? false },
    metaKey: { value: init.metaKey ?? false },
    timeStamp: { value: clock },
    ...(init.wheelDeltaY === undefined
      ? {}
      : { wheelDeltaY: { value: init.wheelDeltaY } }),
    ...init.deltas,
  });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

/** Safari's GestureEvent (not in happy-dom): a scale since gesturestart. */
function gesture(
  target: Element,
  type: "gesturestart" | "gesturechange" | "gestureend",
  scale: number,
  at = { x: 400, y: 250 },
) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    scale: { value: scale },
    rotation: { value: 0 },
    clientX: { value: at.x },
    clientY: { value: at.y },
  });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

function touch(target: Element, type: "touchstart" | "touchend", n: number) {
  const touches = Array.from({ length: n }, (_, i) => ({
    clientX: 300 + 100 * i,
    clientY: 250,
    target,
  }));
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    touches: { value: touches },
    changedTouches: { value: touches },
  });
  act(() => {
    target.dispatchEvent(e);
  });
}

/** The scene point under a container point: it stays put when a zoom is anchored there. */
function scenePointAt(
  t: { x: number; y: number; s: number },
  at: { x: number; y: number },
) {
  return { x: (at.x - t.x) / t.s, y: (at.y - t.y) / t.s };
}

/** Sets window.visualViewport.scale (a browser pinch-zoom of the page) and returns the undo. */
function pageZoom(scale: number) {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      scale,
      width: CW / scale,
      height: CH / scale,
      offsetLeft: 0,
      offsetTop: 0,
    },
  });
  return () => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete (window as { visualViewport?: unknown }).visualViewport;
  };
}

function withLayout(run: () => void) {
  return () => {
    const undo = fakeLayout();
    try {
      run();
    } finally {
      undo();
    }
  };
}

it(
  "a trackpad scroll over the room at rest leaves the view alone and the page still",
  withLayout(() => {
    const { view, container, scene, rest } = mountRoom();
    // Up and down, with sideways drift, as an inertia tail delivers it to
    // Chrome on a Mac: a frame apart, wheelDeltaY = -3 * deltaY.
    for (const sign of [-1, 1]) {
      for (let i = 0; i < 40; i++) {
        const deltaX = i % 2 ? 0 : sign * 3;
        const e = wheel(container, {
          deltaX,
          deltaY: sign * 20,
          wheelDeltaY: sign * -60,
          after: 16,
        });
        // The page neither scrolls nor swipes back in history.
        expect(e.defaultPrevented).toBe(true);
      }
      expect(transformOf(scene())).toEqual(rest);
    }
    // One tick of a Mac trackpad (40 px, wheelDelta 120) on its own, and a
    // pixel wheel with no wheelDelta at all (Firefox on a Mac).
    for (const one of [
      { deltaY: -40, wheelDeltaY: 120 },
      { deltaY: -40.2, wheelDeltaY: 120 },
      { deltaY: -100 },
    ]) {
      wheel(container, one);
      expect({ one, t: transformOf(scene()) }).toEqual({ one, t: rest });
    }
    view.unmount();
  }),
);

// ---- A mouse wheel zooms at the cursor (task 5e8602df) ---------------------
// Nil, 2026-11-13 (Windows): a plain mouse wheel zooms in and out at the
// cursor again. A trackpad stream still must not: an event that looks like a
// notch zooms only when no other wheel event came in the last 300 ms.

/** A Windows Chrome or Edge notch: 100 px, wheelDeltaY 120. */
const NOTCH_IN = { deltaY: -100, wheelDeltaY: 120 };
const NOTCH_OUT = { deltaY: 100, wheelDeltaY: -120 };
/** A Mac trackpad tick read at 125% browser zoom: Chrome scales deltaY, not wheelDeltaY. */
const ZOOMED_MAC_TICK = { deltaY: -32, wheelDeltaY: 120 };
const MAC_TRACKPAD = { deltaY: -20, wheelDeltaY: 60 };

/** A Firefox notch: in lines, but only to a reader of deltaMode before the deltas. */
function firefoxNotch(lines: number): PropertyDescriptorMap {
  let mode: "line" | "pixel" | null = null;
  const delta = (n: number) => {
    mode ??= "pixel";
    return mode === "line" ? n : n * 16;
  };
  return {
    deltaMode: {
      get() {
        mode ??= "line";
        return mode === "line" ? 1 : 0;
      },
    },
    deltaX: { get: () => delta(0) },
    deltaY: { get: () => delta(lines) },
    deltaZ: { get: () => delta(0) },
  };
}

it(
  "a mouse-wheel notch zooms one step at the cursor, in and out",
  withLayout(() => {
    const { view, api, container, scene, rest } = mountRoom();
    act(() => api.current!.zoomIn());
    const step = transformOf(scene()).s / rest.s;
    const at = { x: 420, y: 260 };
    // A Firefox event's getters keep state, so each notch is made fresh.
    for (const [browser, zoomIn, zoomOut] of [
      ["Chrome", () => NOTCH_IN, () => NOTCH_OUT],
      [
        "Firefox",
        () => ({ deltas: firefoxNotch(-3) }),
        () => ({ deltas: firefoxNotch(3) }),
      ],
    ] as const) {
      // Zoomed in first, so the pan clamp leaves the anchor alone.
      act(() => api.current!.resetView(false));
      act(() => api.current!.zoomIn());
      const start = transformOf(scene());
      const anchor = scenePointAt(start, at);
      const e = wheel(container, zoomIn(), at);
      expect(e.defaultPrevented).toBe(true);
      const zoomed = transformOf(scene());
      expect({ browser, ratio: zoomed.s / start.s }).toEqual({
        browser,
        ratio: expect.closeTo(step, 6),
      });
      const moved = scenePointAt(zoomed, at);
      expect({ browser, x: moved.x, y: moved.y }).toEqual({
        browser,
        x: expect.closeTo(anchor.x, 3),
        y: expect.closeTo(anchor.y, 3),
      });
      // Two notches 50 ms apart (a quick spin) both count.
      wheel(container, zoomOut(), at);
      wheel(container, { ...zoomOut(), after: 50 }, at);
      expect({ browser, ratio: start.s / transformOf(scene()).s }).toEqual({
        browser,
        ratio: expect.closeTo(step, 6),
      });
    }
    act(() => api.current!.resetView(false));
    view.unmount();
  }),
);

it(
  "a notch-like event inside a trackpad stream does not zoom, however long the stream runs",
  withLayout(() => {
    const { view, api, container, scene, rest } = mountRoom();
    // The same lone event zooms: otherwise the rest of the case proves nothing.
    wheel(container, ZOOMED_MAC_TICK);
    expect(transformOf(scene()).s).toBeGreaterThan(rest.s * 1.1);
    act(() => api.current!.resetView(false));
    // 100 ms after a trackpad event.
    wheel(container, MAC_TRACKPAD);
    wheel(container, { ...ZOOMED_MAC_TICK, after: 100 });
    expect(transformOf(scene())).toEqual(rest);
    // A stream of notch-like events, each within 300 ms of the one before,
    // is one gesture: two seconds of them still do not zoom.
    for (let i = 0; i < 20; i++) wheel(container, { ...NOTCH_IN, after: 100 });
    expect(transformOf(scene())).toEqual(rest);
    // After a 400 ms pause, the next notch is a mouse again.
    wheel(container, { ...NOTCH_IN, after: 400 });
    expect(transformOf(scene()).s).toBeGreaterThan(rest.s * 1.1);
    act(() => api.current!.resetView(false));
    view.unmount();
  }),
);

it(
  "a trackpad stream that began over the chat does not zoom the room it reaches",
  withLayout(() => {
    // The P0 of task 7dfe3044: a two-finger scroll in an agent's chat, and
    // the member goes back to the room while its inertia tail still runs.
    const chat = document.body.appendChild(document.createElement("div"));
    try {
      const first = mountRoom();
      first.view.unmount();
      for (let i = 0; i < 20; i++) wheel(chat, { ...MAC_TRACKPAD, after: 16 });
      const { view, api, container, scene, rest } = mountRoom();
      const e = wheel(container, { ...ZOOMED_MAC_TICK, after: 16 });
      expect(e.defaultPrevented).toBe(true);
      expect(transformOf(scene())).toEqual(rest);
      // The same event once the stream is over zooms.
      wheel(container, { ...ZOOMED_MAC_TICK, after: 400 });
      expect(transformOf(scene()).s).toBeGreaterThan(rest.s * 1.1);
      act(() => api.current!.resetView(false));
      view.unmount();
    } finally {
      chat.remove();
    }
  }),
);

it(
  "a pinch zooms at the pointer, as fast out as in",
  withLayout(() => {
    const { view, api, container, scene } = mountRoom();
    for (const modifier of ["ctrlKey", "metaKey"] as const) {
      // Zoomed in first, so the pan clamp leaves the anchor alone.
      act(() => api.current!.resetView(false));
      act(() => api.current!.zoomIn());
      act(() => api.current!.zoomIn());
      const start = transformOf(scene());
      const at = { x: 420, y: 260 };
      const anchor = scenePointAt(start, at);
      // A pinch arrives as many small wheel events. The rate follows
      // Chrome's pinch wheels (deltaY = -100 * ln(finger scale)), so ten
      // events of -5 px are a finger scale of e^0.5.
      for (let i = 0; i < 10; i++) {
        const e = wheel(container, { deltaY: -5, [modifier]: true }, at);
        expect(e.defaultPrevented).toBe(true);
      }
      const zoomed = transformOf(scene());
      expect({ modifier, ratio: zoomed.s / start.s }).toEqual({
        modifier,
        ratio: expect.closeTo(Math.exp(0.5), 6),
      });
      const moved = scenePointAt(zoomed, at);
      expect(moved.x).toBeCloseTo(anchor.x, 3);
      expect(moved.y).toBeCloseTo(anchor.y, 3);
      // The same pinch back out lands where it started.
      for (let i = 0; i < 10; i++) {
        wheel(container, { deltaY: 5, [modifier]: true }, at);
      }
      expect(transformOf(scene()).s).toBeCloseTo(start.s, 6);
    }
    act(() => api.current!.resetView(false));
    view.unmount();
  }),
);

it(
  "one Ctrl+mouse-wheel notch is one zoom button step",
  withLayout(() => {
    const { view, api, container, scene, rest } = mountRoom();
    act(() => api.current!.zoomIn());
    const step = transformOf(scene()).s / rest.s;
    expect(step).toBeGreaterThan(1.1);
    // Pixel mode (Chrome, Safari) and line mode (Firefox), in and out.
    for (const notch of [
      { deltaY: 100, deltaMode: 0 },
      { deltaY: 3, deltaMode: 1 },
    ]) {
      act(() => api.current!.resetView(false));
      act(() => api.current!.zoomIn());
      const start = transformOf(scene()).s;
      wheel(container, { ...notch, deltaY: -notch.deltaY, ctrlKey: true });
      expect({ notch, ratio: transformOf(scene()).s / start }).toEqual({
        notch,
        ratio: expect.closeTo(step, 6),
      });
      wheel(container, { ...notch, ctrlKey: true });
      wheel(container, { ...notch, ctrlKey: true });
      expect({ notch, ratio: start / transformOf(scene()).s }).toEqual({
        notch,
        ratio: expect.closeTo(step, 6),
      });
    }
    act(() => api.current!.resetView(false));
    view.unmount();
  }),
);

it(
  "a trackpad scroll pans the room once it is zoomed in",
  withLayout(() => {
    const { view, api, container, scene } = mountRoom();
    act(() => api.current!.zoomIn());
    act(() => api.current!.zoomIn());
    expect(api.current!.isZoomedIn()).toBe(true);
    const before = transformOf(scene());
    // Content follows the fingers: scrolling down and right moves it up and left.
    const e = wheel(container, { deltaX: 30, deltaY: 40 });
    expect(e.defaultPrevented).toBe(true);
    const after = transformOf(scene());
    expect(after.s).toBe(before.s);
    expect(after.x).toBeCloseTo(before.x - 30, 3);
    expect(after.y).toBeCloseTo(before.y - 40, 3);
    // A Firefox line-mode touchpad scroll (a fraction of a line) pans in
    // pixels too.
    wheel(container, { deltaY: -1.5, deltaMode: 1 });
    const lines = transformOf(scene());
    expect(lines.s).toBe(before.s);
    expect(lines.y).toBeCloseTo(after.y + 24, 3);
    act(() => api.current!.resetView(false));
    view.unmount();
  }),
);

it(
  "a pinch while the browser has zoomed the page undoes the browser zoom, not the room's",
  withLayout(() => {
    const { view, api, container, scene, rest } = mountRoom();
    const undo = pageZoom(2);
    try {
      const w = wheel(container, { deltaY: 10, ctrlKey: true });
      expect(w.defaultPrevented).toBe(false);
      const g0 = gesture(container, "gesturestart", 1);
      const g1 = gesture(container, "gesturechange", 0.5);
      gesture(container, "gestureend", 0.5);
      expect([g0.defaultPrevented, g1.defaultPrevented]).toEqual([
        false,
        false,
      ]);
      expect(transformOf(scene())).toEqual(rest);
    } finally {
      undo();
    }
    // Back at page scale 1, the same pinch is the room's.
    const undoRest = pageZoom(1);
    try {
      const w = wheel(container, { deltaY: -10, ctrlKey: true });
      expect(w.defaultPrevented).toBe(true);
      expect(transformOf(scene()).s).toBeGreaterThan(rest.s * 1.05);
    } finally {
      undoRest();
    }
    act(() => api.current!.resetView(false));
    view.unmount();
  }),
);

it(
  "a Safari pinch zooms the room at the fingers, once",
  withLayout(() => {
    const { view, api, container, scene } = mountRoom();
    // Zoomed in first, so the pan clamp leaves the anchor alone.
    act(() => api.current!.zoomIn());
    act(() => api.current!.zoomIn());
    const rest = transformOf(scene());
    const at = { x: 380, y: 240 };
    const anchor = scenePointAt(rest, at);
    const start = gesture(container, "gesturestart", 1, at);
    expect(start.defaultPrevented).toBe(true);
    // Safari may also send its pinch as ctrlKey wheels: those must not zoom
    // on top of the gesture.
    wheel(container, { deltaY: -10, ctrlKey: true }, at);
    expect(transformOf(scene())).toEqual(rest);
    const change = gesture(container, "gesturechange", 1.5, at);
    expect(change.defaultPrevented).toBe(true);
    const zoomed = transformOf(scene());
    expect(zoomed.s / rest.s).toBeCloseTo(1.5, 6);
    const moved = scenePointAt(zoomed, at);
    expect(moved.x).toBeCloseTo(anchor.x, 3);
    expect(moved.y).toBeCloseTo(anchor.y, 3);
    // The gesture's scale counts from its start, not from the last change.
    gesture(container, "gesturechange", 1.2, at);
    expect(transformOf(scene()).s / rest.s).toBeCloseTo(1.2, 6);
    gesture(container, "gestureend", 1.2, at);
    // After the gesture, a ctrlKey wheel zooms again.
    const before = transformOf(scene()).s;
    wheel(container, { deltaY: -10, ctrlKey: true }, at);
    expect(transformOf(scene()).s).toBeGreaterThan(before * 1.05);
    act(() => api.current!.resetView(false));
    view.unmount();
  }),
);

it(
  "iOS gesture events during a two-finger touch do not zoom on top of the touch pinch",
  withLayout(() => {
    const { view, api, container, scene, rest } = mountRoom();
    // iOS sends gesture events alongside the touches of a pinch, which the
    // touch handlers already zoom by.
    touch(container, "touchstart", 2);
    const g = gesture(container, "gesturestart", 1);
    gesture(container, "gesturechange", 2);
    // Still kept from the page: iOS would zoom the page otherwise.
    expect(g.defaultPrevented).toBe(true);
    expect(transformOf(scene())).toEqual(rest);
    gesture(container, "gestureend", 2);
    touch(container, "touchend", 0);
    // With no touch down, the same gesture zooms (a Mac trackpad pinch).
    gesture(container, "gesturestart", 1);
    gesture(container, "gesturechange", 2);
    gesture(container, "gestureend", 2);
    expect(transformOf(scene()).s / rest.s).toBeCloseTo(2, 6);
    act(() => api.current!.resetView(false));
    view.unmount();
  }),
);
