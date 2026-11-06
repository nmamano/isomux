// The "are you sure?" step of a destructive action with no Undo (task
// c6589760, AGENTS.md "UI rules"): the first activation arms the control, a
// second one runs the action once; a blur, Escape or another control's
// activation ends it. The armed control takes the focus, so the blur that
// ends it comes in every browser, and its mousedown keeps that focus, so a
// browser that clears the focus on a click on a button (Safari) does not
// end it before the second click lands.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, act, createEvent } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { useConfirmStep } = await import("./useConfirmStep.ts");

// Two rows of a list and a control outside it. Each run of a row's action
// is counted by its key; Escape that leaves the control reaches the wrapper.
function rig() {
  const runs: string[] = [];
  const escapesOut: string[] = [];
  function Rows() {
    const step = useConfirmStep();
    return createElement(
      "div",
      {
        "data-testid": "wrap",
        onKeyDown: (e: { key: string }) => escapesOut.push(e.key),
      },
      ...["t1", "t2"].map((key) =>
        createElement(
          "button",
          {
            key,
            "data-row": key,
            ...step.bind(key),
            onClick: () => step.confirm(key, () => runs.push(key)),
          },
          step.armed === key ? "Confirm?" : "Revoke",
        ),
      ),
      createElement("input", { "data-other": "" }),
    );
  }
  const view = render(createElement(Rows));
  const row = (key: string) =>
    view.container.querySelector<HTMLButtonElement>(`[data-row="${key}"]`)!;
  const armed = () =>
    [
      ...view.container.querySelectorAll<HTMLElement>("[data-confirm-armed]"),
    ].map((el) => el.dataset.row);
  return { view, runs, escapesOut, row, armed };
}

it("the first click arms the control and runs nothing; the second runs the action once and disarms", () => {
  const t = rig();
  expect(t.armed()).toEqual([]);
  fireEvent.click(t.row("t1"));
  expect(t.runs).toEqual([]);
  expect(t.armed()).toEqual(["t1"]);
  expect(t.row("t1").textContent).toBe("Confirm?");
  fireEvent.click(t.row("t1"));
  expect(t.runs).toEqual(["t1"]);
  expect(t.armed()).toEqual([]);
  // A third click arms again; it does not run a second time.
  fireEvent.click(t.row("t1"));
  expect(t.runs).toEqual(["t1"]);
  expect(t.armed()).toEqual(["t1"]);
  t.view.unmount();
});

it("takes the focus when armed, so its blur ends it", () => {
  const t = rig();
  fireEvent.click(t.row("t1"));
  expect(document.activeElement).toBe(t.row("t1") as Element);
  // The focus moves elsewhere: disarmed, and the next click only arms.
  act(() =>
    t.view.container.querySelector<HTMLElement>("[data-other]")!.focus(),
  );
  expect(t.armed()).toEqual([]);
  fireEvent.click(t.row("t1"));
  expect(t.runs).toEqual([]);
  t.view.unmount();
});

it("keeps the focus on a mousedown on the armed control, and not on one that is not armed", () => {
  const t = rig();
  const down = (el: HTMLElement) => {
    const ev = createEvent.mouseDown(el);
    fireEvent(el, ev);
    return ev.defaultPrevented;
  };
  expect(down(t.row("t1"))).toBe(false);
  fireEvent.click(t.row("t1"));
  expect(down(t.row("t1"))).toBe(true);
  // The other row is not armed: its mousedown does what a browser does.
  expect(down(t.row("t2"))).toBe(false);
  t.view.unmount();
});

it("Escape on the armed control disarms it and goes no further; on a control that is not armed it passes", () => {
  const t = rig();
  fireEvent.click(t.row("t1"));
  fireEvent.keyDown(t.row("t1"), { key: "Escape" });
  expect(t.armed()).toEqual([]);
  expect(t.escapesOut).toEqual([]);
  fireEvent.click(t.row("t1"));
  expect(t.runs).toEqual([]);
  // Not armed: Escape is the container's (a dialog closes as before).
  fireEvent.keyDown(t.row("t2"), { key: "Escape" });
  expect(t.escapesOut).toEqual(["Escape"]);
  t.view.unmount();
});

it("a click on another row arms that row instead, and runs neither", () => {
  const t = rig();
  fireEvent.click(t.row("t1"));
  fireEvent.click(t.row("t2"));
  expect(t.runs).toEqual([]);
  expect(t.armed()).toEqual(["t2"]);
  fireEvent.click(t.row("t2"));
  expect(t.runs).toEqual(["t2"]);
  t.view.unmount();
});
