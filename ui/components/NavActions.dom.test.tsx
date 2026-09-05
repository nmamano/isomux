// Proving test for the render harness (ui/test-support/dom.ts): a real React
// component, mounted in happy-dom, clicked, and asserted on.
//
// NavActions is the right subject because it is pure props - no store, no
// socket, no fetch - and still exercises everything the harness has to support:
// state, refs, effects, getBoundingClientRect, and a createPortal subtree that
// renders outside the container. A markup-only test (renderToStaticMarkup, as
// in ui/office/Character.test.tsx) reaches none of that.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { fireEvent, render } = await import("@testing-library/react");
const { NavActions } = await import("./NavActions.tsx");

function actions(onTasks: () => void) {
  return [
    { id: "tasks", icon: null, label: "Tasks", onClick: onTasks },
    { id: "apps", icon: null, label: "Apps", onClick: () => {} },
  ];
}

describe("NavActions", () => {
  it("runs a desktop action's onClick", () => {
    let clicked = 0;
    const view = render(
      <NavActions actions={actions(() => clicked++)} viewport="desktop" />,
    );

    fireEvent.click(view.getByText("Tasks"));

    expect(clicked).toBe(1);
  });

  it("opens the mobile overflow menu into a portal and runs the action", () => {
    let clicked = 0;
    const view = render(
      <NavActions actions={actions(() => clicked++)} viewport="mobile" />,
    );

    // Collapsed: the labels live behind the overflow trigger.
    expect(view.queryByText("Tasks")).toBeNull();

    fireEvent.click(view.getByRole("button"));

    // The menu is a Portal child of document.body, not of the render
    // container, so finding it at all proves createPortal works here.
    const item = view.getByText("Tasks");
    expect(document.body.contains(item)).toBe(true);
    expect(view.container.contains(item)).toBe(false);

    fireEvent.click(item);

    expect(clicked).toBe(1);
    // Choosing an action closes the menu.
    expect(view.queryByText("Apps")).toBeNull();
  });
});
