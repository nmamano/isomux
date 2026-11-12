// One view for a room and its back room (task 28695913): a zoom or pan set on
// one floor is the view on the other, so going down or up does not jump. In
// the embed (the site demo) neither floor zooms, and the back room draws its
// building in the front's frame.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, act, room } = fixture;
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { artBounds } = await import("./useViewport.ts");
const EN = translatorFor("en");
fixture.setupRoomDoorTests({ decorations: false });

type View = ReturnType<typeof mount>;

/** The floor that shows: its scene content, inside the zoom/pan layer. */
function floorScene(view: View, back: boolean): HTMLElement {
  const all =
    view.container.querySelectorAll<HTMLElement>("[data-floor-scene]");
  expect(all).toHaveLength(1);
  const el = all[0]!;
  // The floor under test is the one drawn.
  expect(el.closest("[data-back-room]") !== null).toBe(back);
  return el;
}

/** The zoom/pan transform the viewport writes on the scene layer. */
function viewOf(view: View, back: boolean) {
  const layer = floorScene(view, back).parentElement!;
  const m =
    /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(
      layer.style.transform,
    );
  // The viewport writes a finite transform on every scene it attaches to.
  expect(m).not.toBeNull();
  const v = { x: Number(m![1]), y: Number(m![2]), s: Number(m![3]) };
  expect([v.x, v.y, v.s].every(Number.isFinite)).toBe(true);
  return v;
}

function expectSameView(
  a: { x: number; y: number; s: number },
  b: { x: number; y: number; s: number },
) {
  expect(b.x).toBeCloseTo(a.x, 3);
  expect(b.y).toBeCloseTo(a.y, 3);
  expect(b.s).toBeCloseTo(a.s, 6);
}

/** The static frame the floor draws its building in: position and scale. */
function frameOf(view: View, back: boolean) {
  const el = floorScene(view, back);
  const scale = /scale\(([\d.e-]+)\)/.exec(el.style.transform);
  return {
    left: el.style.left,
    top: el.style.top,
    scale: scale ? Number(scale[1]) : 1,
  };
}

function zoomIn(view: View, back: boolean) {
  // A pinch (a ctrlKey wheel) bubbles from the scene to the viewport's
  // container. A plain wheel does not zoom.
  const wheel = new WheelEvent("wheel", {
    deltaY: -200,
    bubbles: true,
    cancelable: true,
  });
  // happy-dom's WheelEvent drops the pointer position and the modifier keys
  // from its init.
  Object.defineProperties(wheel, {
    clientX: { value: 300 },
    clientY: { value: 200 },
    ctrlKey: { value: true },
  });
  floorScene(view, back).dispatchEvent(wheel);
}

async function goTo(view: View, embed: boolean, back: boolean) {
  fixture.setBackRoomOpen(back);
  await act(async () => view.setEmbed(embed));
}

it("keeps one zoom and pan between a room and its back room", async () => {
  const view = mount([room("first")]);
  const start = viewOf(view, false);
  await act(async () => zoomIn(view, false));
  const front = viewOf(view, false);
  // The zoom took, or the rest proves nothing.
  expect(front.s).toBeGreaterThan(start.s * 1.05);
  const frame = frameOf(view, false);

  await goTo(view, false, true);
  expectSameView(front, viewOf(view, true));
  expect(frameOf(view, true)).toEqual(frame);

  await act(async () => zoomIn(view, true));
  const back = viewOf(view, true);
  expect(back.s).toBeGreaterThan(front.s * 1.05);

  await goTo(view, false, false);
  expectSameView(back, viewOf(view, false));
  view.unmount();
});

// One mount walks the frames: a mount per case went over the DOM file's time
// cap. The embed cases also prove the back room keeps still under the wheel
// that zooms it outside the embed (the case above), and has no zoom buttons:
// they would move the one view the embed's front shows too.
it("draws the back room in the front's frame", async () => {
  const view = mount([room("first")], true);
  for (const { embed, mobile } of [
    { embed: true, mobile: false },
    { embed: true, mobile: true },
    { embed: false, mobile: true },
  ]) {
    await goTo(view, embed, false);
    await act(async () => {
      fixture.dispatch({ type: "set_mobile", isMobile: mobile });
    });
    expect(fixture.snapshot.isMobile).toBe(mobile);
    const front = frameOf(view, false);
    await goTo(view, embed, true);
    expect({ embed, mobile, ...frameOf(view, true) }).toEqual({
      embed,
      mobile,
      ...front,
    });
    const zoomButtons = view.container.querySelectorAll(
      `[data-back-room] button[aria-label="${EN.t("office.zoom.in")}"]`,
    );
    expect({ embed, zoomButtons: zoomButtons.length }).toEqual({
      embed,
      zoomButtons: embed ? 0 : 1,
    });
    if (embed) {
      const before = viewOf(view, true);
      await act(async () => zoomIn(view, true));
      expectSameView(before, viewOf(view, true));
    }
  }
  view.unmount();
});

// A container narrower than the room (the office beside the desktop sidebar
// at a 1100 px window), and tall enough that height never sets the fit.
const NARROW = { w: 840, h: 1400 };
const FIT_MARGIN = 12;

/** Stands in for the browser's layout of the floor that shows, and returns the undo. */
function fakeFloorLayout() {
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
  // The viewport's container: the floor scene sits in its zoom/pan layer.
  const isContainer = (el: Element) =>
    [...el.children].some((layer) =>
      [...layer.children].some((c) => c.hasAttribute("data-floor-scene")),
    );
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (isContainer(this)) return new DOMRect(0, 0, NARROW.w, NARROW.h);
    if (this.hasAttribute("data-floor-scene")) {
      // The scene box in its static frame (centred at left 50% and its top),
      // then where the zoom/pan layer's live transform puts it.
      const el = this as HTMLElement;
      const fs = Number(/scale\(([\d.e-]+)\)/.exec(el.style.transform)![1]);
      const topFrac = parseFloat(el.style.top) / 100;
      const w = 950 * fs;
      const h = 700 * fs;
      const t =
        /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(
          el.parentElement!.style.transform,
        );
      const [x, y, s] = t ? [1, 2, 3].map((i) => Number(t[i])) : [0, 0, 1];
      return new DOMRect(
        x! + (NARROW.w / 2 - w / 2) * s!,
        y! + (NARROW.h * topFrac - h / 2) * s!,
        w * s!,
        h * s!,
      );
    }
    return (originalRect.value as () => DOMRect).call(this);
  };
  for (const [key, descriptor] of originalSizes)
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get() {
        if (isContainer(this))
          return key === "clientWidth" ? NARROW.w : NARROW.h;
        return (descriptor.get as () => number).call(this);
      },
    });
  return () => {
    Object.defineProperty(
      Element.prototype,
      "getBoundingClientRect",
      originalRect,
    );
    for (const [key, descriptor] of originalSizes)
      Object.defineProperty(HTMLElement.prototype, key, descriptor);
  };
}

/** The painted room (walls and doors included) in container pixels. */
function paintedArt(view: View, back: boolean) {
  const r = floorScene(view, back).getBoundingClientRect();
  return artBounds({
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
  });
}

async function resetView(view: View) {
  const reset = view.container.querySelectorAll<HTMLElement>(
    `button[aria-label="${EN.t("office.zoom.resetAria")}"]`,
  );
  expect(reset).toHaveLength(1);
  await act(async () => reset[0]!.click());
}

// Task a539eaae: at a 1100 px window the sidebar left the room too narrow a
// space, and the rest view cut it at both doors. On a computer the rest view
// fits the room's width too, on both floors. A phone keeps its sideways
// bleed: its frame crops the walls on purpose.
it("fits the room's width on a computer and not on a phone", async () => {
  const undo = fakeFloorLayout();
  try {
    const view = mount([room("first")]);
    expect(fixture.snapshot.isMobile).toBe(false);
    await resetView(view);
    const front = viewOf(view, false);
    const art = paintedArt(view, false);
    // The painted room is wider than the space, so only a width fit shows it
    // whole, and height does not set the fit.
    expect((art.right - art.left) / front.s).toBeGreaterThan(
      NARROW.w - 2 * FIT_MARGIN,
    );
    expect((art.bottom - art.top) / front.s).toBeLessThan(
      NARROW.h - 2 * FIT_MARGIN,
    );
    expect(front.s).toBeLessThan(1);
    // Both wall ends, with their doors, are inside the margin.
    expect(art.left).toBeCloseTo(FIT_MARGIN, 1);
    expect(art.right).toBeCloseTo(NARROW.w - FIT_MARGIN, 1);

    // The back room keeps that view, and its own reset fits the same way.
    await goTo(view, false, true);
    expectSameView(front, viewOf(view, true));
    await resetView(view);
    expectSameView(front, viewOf(view, true));

    for (const back of [false, true]) {
      await goTo(view, false, back);
      await act(async () => {
        fixture.dispatch({ type: "set_mobile", isMobile: true });
      });
      expect(fixture.snapshot.isMobile).toBe(true);
      await resetView(view);
      const phone = viewOf(view, back);
      const phoneArt = paintedArt(view, back);
      // The phone's frame is wider than the space, so a width fit would act.
      expect((phoneArt.right - phoneArt.left) / phone.s).toBeGreaterThan(
        NARROW.w - 2 * FIT_MARGIN,
      );
      expect((phoneArt.bottom - phoneArt.top) / phone.s).toBeLessThan(
        NARROW.h - 2 * FIT_MARGIN,
      );
      expect({ back, s: phone.s }).toEqual({ back, s: 1 });
      await act(async () => {
        fixture.dispatch({ type: "set_mobile", isMobile: false });
      });
    }
    view.unmount();
  } finally {
    undo();
  }
});
