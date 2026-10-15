// The office's view after its scene remounts (task f0af4677): the back room
// screen takes the place of the front's container, and when it closes, the
// front comes back on new container and scene elements while OfficeView, and
// so the viewport hook, stays mounted. The view must come back where it was.
// On the old code the new scene was measured before it carried the saved
// transform, so each round trip moved the front down by its rest offset.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { useViewport } = await import("./useViewport.ts");

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
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  };
}

function Office({ front }: { front: boolean }) {
  const viewport = useViewport("test", true);
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
