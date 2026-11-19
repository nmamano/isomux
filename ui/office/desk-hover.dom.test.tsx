// A hovered desk lifts its drawing, but the box that takes the mouse stays
// where it is (task de1358b6). When the hit box rose with the drawing, a mouse
// that rested in its bottom band left the box, the desk dropped back under the
// mouse, hover came back, and the agent flickered.

import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { DeskUnit } = await import("./DeskUnit.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

afterEach(cleanup);

const noop = () => {};

const agent = {
  id: "d2",
  name: "d2",
  desk: 2,
  roomId: "a",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  effort: "medium",
  topic: null,
  topicState: null,
  customInstructions: null,
  customInstructionsVersion: "0",
  permissionMode: "default",
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as never;

// Every inline style that can move or resize an element's box.
const BOX_PROPS = [
  "position",
  "inset",
  "top",
  "left",
  "right",
  "bottom",
  "margin",
  "width",
  "height",
  "transform",
  "translate",
  "scale",
  "rotate",
] as const;

function box(el: HTMLElement): string {
  const style = el.style as unknown as Record<string, string | undefined>;
  return BOX_PROPS.map((p) => `${p}=${style[p] ?? ""}`).join("; ");
}

// The vertical offset an element's inline transform gives it, in px.
function liftOf(el: HTMLElement): number {
  const t = el.style.transform;
  const y =
    /translateY\((-?[\d.]+)px\)/.exec(t)?.[1] ??
    /translate\([^,]+,\s*(-?[\d.]+)px\)/.exec(t)?.[1];
  return y === undefined ? 0 : Number(y);
}

// True when el, or an element between el and the hit box, takes no pointer.
function takesNoPointer(el: HTMLElement, hit: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n && n !== hit; n = n.parentElement)
    if (n.style.pointerEvents === "none") return true;
  return false;
}

it("lifts the drawing on hover while the hit box stays in place", () => {
  const { container } = render(
    onLanguage(
      "en",
      <DeskUnit agent={agent} onClick={noop} onContextMenu={noop} />,
    ),
  );
  // The draggable element is the desk's hit box: it owns the mouse handlers.
  const hit = container.querySelector<HTMLElement>("[draggable]")!;
  const drawn = Array.from(hit.querySelectorAll<HTMLElement>("*"));
  const boxBefore = box(hit);
  const liftsBefore = drawn.map(liftOf);

  fireEvent.mouseEnter(hit);

  // The hit box did not move or change size.
  expect(box(hit)).toBe(boxBefore);
  expect(liftOf(hit)).toBe(0);
  // Something inside it rose: hover took effect.
  const lifted = drawn.filter((el, i) => liftOf(el) < liftsBefore[i]!);
  expect(lifted.length).toBeGreaterThan(0);
  // What rose is not a hit target, so the hit area is the same box hovered
  // or not.
  expect(lifted.every((el) => takesNoPointer(el, hit))).toBe(true);

  fireEvent.mouseLeave(hit);

  expect(drawn.map(liftOf)).toEqual(liftsBefore);
});
