// The floating name tag above a desk opens the agent's chat, the same as the
// desk (task 5f049b70). The tag was hoisted out of the desk container to draw
// above ghost avatars and lost its clicks: a tap on it fell through to the
// floor.

import { afterEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { DeskUnit } = await import("./DeskUnit.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

afterEach(cleanup);

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
  topic: "a topic",
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

function mount() {
  const onClick = jest.fn();
  const onContextMenu = jest.fn();
  const { container } = render(
    onLanguage(
      "en",
      <DeskUnit
        agent={agent}
        onClick={onClick}
        onContextMenu={onContextMenu}
      />,
    ),
  );
  const tag = container.querySelector<HTMLElement>("[data-desk-tag]")!;
  const desk = container.querySelector<HTMLElement>("[draggable]")!;
  // The tag is the floating chip, not a part of the desk's hit box.
  expect(tag).not.toBeNull();
  expect(desk.contains(tag)).toBe(false);
  // The element a finger lands on: the chip, inside the tag wrapper.
  const chip = tag.firstElementChild as HTMLElement;
  return { tag, chip, desk, onClick, onContextMenu };
}

const at = { clientX: 300, clientY: 300 };
const touch = (target: Element) => ({ identifier: 0, ...at, target });

function touchStart(target: Element): boolean {
  const t = touch(target);
  return fireEvent.touchStart(target, {
    touches: [t],
    targetTouches: [t],
    changedTouches: [t],
  });
}

function touchEnd(target: Element): boolean {
  return fireEvent.touchEnd(target, {
    touches: [],
    targetTouches: [],
    changedTouches: [touch(target)],
  });
}

// A phone sends the compatibility mouse events and click after a tap unless
// touchstart or touchend was prevented.
function compatClick(target: Element, startOk: boolean, endOk: boolean) {
  if (startOk && endOk) {
    fireEvent.mouseDown(target, at);
    fireEvent.mouseUp(target, at);
    fireEvent.click(target, at);
  }
}

it("a mouse click on the name tag opens the chat", () => {
  const { chip, onClick, onContextMenu } = mount();
  fireEvent.click(chip, at);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(onContextMenu).toHaveBeenCalledTimes(0);
});

it("a tap on the name tag opens the chat once", () => {
  const { chip, onClick, onContextMenu } = mount();
  const startOk = touchStart(chip);
  const endOk = touchEnd(chip);
  compatClick(chip, startOk, endOk);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(onContextMenu).toHaveBeenCalledTimes(0);
});

it("a long press on the name tag opens the menu, not the chat", async () => {
  jest.useFakeTimers();
  try {
    const { chip, onClick, onContextMenu } = mount();
    const startOk = touchStart(chip);
    await act(async () => jest.advanceTimersByTime(600));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    const endOk = touchEnd(chip);
    compatClick(chip, startOk, endOk);
    expect(onClick).toHaveBeenCalledTimes(0);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it("a right-click on the name tag opens the menu", () => {
  const { chip, onClick, onContextMenu } = mount();
  const notPrevented = fireEvent.contextMenu(chip, at);
  expect(onContextMenu).toHaveBeenCalledTimes(1);
  // The browser's own menu does not open over ours.
  expect(notPrevented).toBe(false);
  expect(onClick).toHaveBeenCalledTimes(0);
});

it("hovering the name tag lifts the desk as hovering the desk does", () => {
  const { tag, desk } = mount();
  const lift = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLElement>("*")).filter((n) =>
      /translateY\(-[\d.]+px\)/.test(n.style.transform),
    ).length;
  expect(lift(desk)).toBe(0);
  fireEvent.mouseEnter(tag);
  expect(lift(desk)).toBeGreaterThan(0);
  fireEvent.mouseLeave(tag);
  expect(lift(desk)).toBe(0);
});

it("the name tag takes the pointer and does not start a floor pan", () => {
  const { tag, chip } = mount();
  // A real browser skips an element with pointer-events: none (happy-dom
  // does not), so the chip and every element up to the tag wrapper take it.
  for (let n: HTMLElement | null = chip; n; n = n.parentElement) {
    expect(n.style.pointerEvents).not.toBe("none");
    if (n === tag) break;
  }
  expect(tag.hasAttribute("data-no-pan")).toBe(true);
});
