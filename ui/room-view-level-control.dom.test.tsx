// The five-step view level control (task 611c968e): one radio group, the
// steps up to the chosen one filled, keys that move one level at a time.
// Both surfaces mount it, so its keyboard and disabled state are owned here;
// the surfaces' tests own what a pick saves.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { RoomViewLevelControl } =
  await import("./components/RoomViewLevelControl.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { ROOM_VIEW_LEVELS } = await import("../shared/room-view-level.ts");
type Level = (typeof ROOM_VIEW_LEVELS)[number];

// A parent that keeps the level, as both surfaces do, and logs each change.
function mount(
  start: Level,
  {
    size = "pane",
    disabled = false,
  }: { size?: "pane" | "row"; disabled?: boolean } = {},
) {
  const changes: Level[] = [];
  function Parent() {
    const [level, setLevel] = useState<Level>(start);
    return createElement(RoomViewLevelControl, {
      level,
      onChange: (l: Level) => {
        changes.push(l);
        setLevel(l);
      },
      roomName: "Ward",
      size,
      disabled,
    });
  }
  const view = render(onLanguage(null, createElement(Parent)));
  const group = () => view.getByRole("radiogroup");
  const steps = () => [
    ...group().querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ];
  const step = (l: Level) =>
    group().querySelector<HTMLButtonElement>(
      `[role="radio"][data-view-level="${l}"]`,
    )!;
  const checked = () =>
    steps()
      .filter((s) => s.getAttribute("aria-checked") === "true")
      .map((s) => s.dataset.viewLevel);
  const filled = () =>
    steps()
      .filter((s) => s.dataset.filled === "true")
      .map((s) => s.dataset.viewLevel);
  const key = (k: string) =>
    act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: k });
    });
  return { view, group, steps, step, checked, filled, key, changes };
}

describe("RoomViewLevelControl", () => {
  for (const size of ["pane", "row"] as const) {
    it(`${size}: five steps in order, the chosen one checked, it and the ones below it filled, the group named after the room`, () => {
      const c = mount("notify", { size });
      expect(c.steps().map((s) => s.dataset.viewLevel)).toEqual([
        ...ROOM_VIEW_LEVELS,
      ]);
      expect(c.group().dataset.viewLevel).toBe("notify");
      expect(c.checked()).toEqual(["notify"]);
      expect(c.filled()).toEqual(["hidden", "tucked", "shown", "notify"]);
      expect(c.group().getAttribute("aria-label")).toContain("Ward");
      // One tab stop: the checked step.
      expect(c.steps().map((s) => s.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
      c.view.unmount();
    });
  }

  it("a click picks that level", async () => {
    const c = mount("shown");
    await act(async () => {
      fireEvent.click(c.step("tucked"));
    });
    expect(c.changes).toEqual(["tucked"]);
    expect(c.checked()).toEqual(["tucked"]);
    expect(c.filled()).toEqual(["hidden", "tucked"]);
    c.view.unmount();
  });

  it("arrows move one level and stop at the ends; Home and End jump; focus follows the checked step", async () => {
    const c = mount("shown");
    c.step("shown").focus();
    await c.key("ArrowRight");
    await c.key("ArrowUp");
    expect(c.checked()).toEqual(["push"]);
    // Already at the top: no change is reported.
    await c.key("ArrowRight");
    expect(c.changes).toEqual(["notify", "push"]);
    expect((document.activeElement as HTMLElement).dataset.viewLevel).toBe(
      "push",
    );
    await c.key("ArrowLeft");
    await c.key("ArrowDown");
    expect(c.checked()).toEqual(["shown"]);
    await c.key("Home");
    expect(c.checked()).toEqual(["hidden"]);
    await c.key("ArrowLeft");
    await c.key("End");
    expect(c.changes).toEqual([
      "notify",
      "push",
      "notify",
      "shown",
      "hidden",
      "push",
    ]);
    expect((document.activeElement as HTMLElement).dataset.viewLevel).toBe(
      "push",
    );
    c.view.unmount();
  });

  it("disabled: every step disabled, a click and a key change nothing", async () => {
    const c = mount("shown", { disabled: true });
    expect(c.steps().every((s) => s.disabled)).toBe(true);
    await act(async () => {
      fireEvent.click(c.step("push"));
    });
    fireEvent.keyDown(c.step("shown"), { key: "ArrowRight" });
    expect(c.changes).toEqual([]);
    expect(c.checked()).toEqual(["shown"]);
    c.view.unmount();
  });
});
