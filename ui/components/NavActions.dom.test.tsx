// Proving test for the render harness (ui/test-support/dom.ts): a real React
// component, mounted in happy-dom, clicked, and asserted on.
//
// NavActions is the right subject because it is pure props - no store, no
// socket, no fetch - and still exercises everything the harness has to support:
// state, refs, effects, getBoundingClientRect, and a createPortal subtree that
// renders outside the container. A markup-only test (renderToStaticMarkup, as
// in ui/office/Character.test.tsx) reaches none of that.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

// Registered after the harness's own afterAll, so it runs after it: whatever
// the harness put on globalThis has to be gone by now. GlobalRegistrator
// captures the global property set when it registers, so its unregister cannot
// take a later addition back off - only the harness can, and this is what says
// it did. AudioContext is the one stub today (see ui/test-support/dom.ts).
afterAll(() => {
  expect(
    (globalThis as { AudioContext?: unknown }).AudioContext,
  ).toBeUndefined();
});

const { fireEvent, render } = await import("@testing-library/react");
const { NavActions } = await import("./NavActions.tsx");

function actions(onTasks: () => void) {
  return [
    { id: "tasks", icon: null, label: "Tasks", onClick: onTasks },
    { id: "apps", icon: null, label: "Apps", onClick: () => {} },
  ];
}

describe("NavActions", () => {
  it("renders a disabled action inert on both viewports", () => {
    let clicked = 0;
    const inert = [
      {
        id: "end",
        icon: null,
        label: "End",
        onClick: () => clicked++,
        disabled: true,
      },
    ];
    const desktop = render(<NavActions actions={inert} viewport="desktop" />);
    const button = desktop.getByText("End").closest("button")!;
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(clicked).toBe(0);
    desktop.unmount();

    const mobile = render(<NavActions actions={inert} viewport="mobile" />);
    fireEvent.click(mobile.getByRole("button"));
    const item = mobile.getByText("End").closest("button")!;
    expect(item.hasAttribute("disabled")).toBe(true);
    fireEvent.click(item);
    expect(clicked).toBe(0);
  });

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

  it("shows a badge count on desktop, and a dot plus the count on mobile", () => {
    const badged = [
      { id: "pager", icon: null, label: "Pager", onClick: () => {}, badge: 3 },
      { id: "apps", icon: null, label: "Apps", onClick: () => {}, badge: 0 },
    ];
    const desktop = render(<NavActions actions={badged} viewport="desktop" />);
    const pills = desktop.container.querySelectorAll(".nav-action-badge");
    expect(pills.length).toBe(1);
    expect(pills[0].textContent).toBe("3");
    expect(
      desktop.getByText("Pager").closest("button")!.contains(pills[0]),
    ).toBe(true);
    desktop.unmount();

    const mobile = render(<NavActions actions={badged} viewport="mobile" />);
    expect(
      mobile.container.querySelector(".nav-action-badge-dot"),
    ).not.toBeNull();
    fireEvent.click(mobile.getByRole("button"));
    const row = mobile.getByText("Pager").closest("button")!;
    expect(row.querySelector(".nav-action-badge")?.textContent).toBe("3");
    mobile.unmount();

    const quiet = render(
      <NavActions actions={actions(() => {})} viewport="mobile" />,
    );
    expect(quiet.container.querySelector(".nav-action-badge-dot")).toBeNull();
  });
});
