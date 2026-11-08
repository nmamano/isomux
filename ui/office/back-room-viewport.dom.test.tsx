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
  // The wheel bubbles from the scene to the viewport's container.
  const wheel = new WheelEvent("wheel", {
    deltaY: -200,
    bubbles: true,
    cancelable: true,
  });
  // happy-dom's WheelEvent drops the pointer position from its init.
  Object.defineProperties(wheel, {
    clientX: { value: 300 },
    clientY: { value: 200 },
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
