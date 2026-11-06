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

const { fireEvent, render, within } = await import("@testing-library/react");
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

  // The chat log follows its bottom by assigning scrollTop, and each
  // assignment fires a scroll event that a capture listener on window sees. A
  // scroll of an element beside the trigger leaves the menu where it was, so
  // it must stay open; a scroll that moves the trigger detaches the
  // fixed-position menu from it, so that one closes it (task 094d3163).
  it("keeps the mobile menu open through a scroll that does not move its trigger", () => {
    const view = render(
      <div>
        <div data-testid="log" />
        <div data-testid="header">
          <NavActions actions={actions(() => {})} viewport="mobile" />
        </div>
      </div>,
    );
    const trigger = view.getByRole("button");
    const open = () => {
      fireEvent.click(trigger);
      expect(view.queryByText("Tasks")).not.toBeNull();
    };

    open();
    fireEvent.scroll(view.getByTestId("log"));
    expect(view.queryByText("Tasks")).not.toBeNull();

    // A scroll of an element that holds the trigger closes it.
    fireEvent.scroll(view.getByTestId("header"));
    expect(view.queryByText("Tasks")).toBeNull();

    // So does a scroll of the page itself.
    open();
    fireEvent.scroll(document);
    expect(view.queryByText("Tasks")).toBeNull();
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

  // Task 760818d5: a phone shows no title tooltip, so the overflow row shows
  // `count` (what waits, already seen) as a neutral pill, beside the red
  // badge (what is new). Desktop keeps its title and ignores `count`; the
  // trigger's dot is for the badge only.
  it("shows the count as a neutral pill beside the badge on a mobile row only", () => {
    const row = (count: number, badge: number) => ({
      id: "inbox",
      icon: null,
      label: "Inbox",
      onClick: () => {},
      count,
      badge,
    });
    const pills = (label: string) => {
      const el = within(document.body).getByText(label).closest("button")!;
      const neutral = el.querySelectorAll<HTMLElement>(".nav-action-count");
      const red = el.querySelectorAll<HTMLElement>(".nav-action-badge");
      expect([neutral.length <= 1, red.length <= 1]).toEqual([true, true]);
      return { neutral: neutral[0] ?? null, red: red[0] ?? null };
    };
    const cases: {
      count: number;
      badge: number;
      neutral: string | null;
      red: string | null;
      dot: boolean;
    }[] = [
      { count: 7, badge: 0, neutral: "7", red: null, dot: false },
      { count: 7, badge: 2, neutral: "7", red: "2", dot: true },
      { count: 0, badge: 0, neutral: null, red: null, dot: false },
    ];
    for (const c of cases) {
      const mobile = render(
        <NavActions actions={[row(c.count, c.badge)]} viewport="mobile" />,
      );
      const dot =
        mobile.container.querySelector(".nav-action-badge-dot") !== null;
      fireEvent.click(mobile.getByRole("button"));
      const { neutral, red } = pills("Inbox");
      const got: (typeof cases)[number] = {
        ...c,
        neutral: neutral?.textContent ?? null,
        red: red?.textContent ?? null,
        dot,
      };
      expect(got).toEqual(c);
      if (neutral) {
        // Neutral: not the badge's red fill.
        expect(neutral.classList.contains("nav-action-badge")).toBe(false);
        expect(neutral.style.background).not.toContain("--red");
      }
      if (neutral && red) {
        // The open count first, then the new count.
        expect(
          neutral.compareDocumentPosition(red) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      mobile.unmount();
    }

    const desktop = render(
      <NavActions actions={[row(7, 2)]} viewport="desktop" />,
    );
    const button = desktop.getByText("Inbox").closest("button")!;
    expect(button.querySelector(".nav-action-badge")?.textContent).toBe("2");
    expect(button.querySelector(".nav-action-count")).toBeNull();
  });
});

// An action with a menu (the chat bar's Copy: Messages only, Everything, Last
// exchange) runs nothing when pressed: it offers its choices, and a choice
// runs once and closes them. The overflow menu on a phone offers the same
// choices as rows under the action.
describe("NavActions with a menu", () => {
  // `radio` adds two radio rows after the plain ones (the Copy format, task
  // 28bd5993).
  function withMenu(opts: { disabled?: boolean; radio?: boolean } = {}) {
    const ran: string[] = [];
    const row = (id: string, checked?: boolean) => ({
      id,
      label: `Item ${id}`,
      onClick: () => ran.push(id),
      ...(checked === undefined ? {} : { checked }),
    });
    const acts = [
      { id: "tasks", icon: null, label: "Tasks", onClick: () => {} },
      {
        id: "copy",
        icon: null,
        label: "Copy",
        disabled: opts.disabled,
        menu: [
          ...["messages", "everything", "lastExchange"].map((id) => row(id)),
          ...(opts.radio ? [row("markdown", true), row("plain", false)] : []),
        ],
      },
    ];
    return { ran, acts };
  }

  // What a real press sends, so a close-on-press-outside listener that also
  // catches the trigger or the menu shows here.
  function press(el: Element) {
    fireEvent.pointerDown(el);
    fireEvent.mouseDown(el);
    fireEvent.pointerUp(el);
    fireEvent.mouseUp(el);
    fireEvent.click(el);
  }

  const menu = () => document.querySelector('[data-nav-menu="copy"]');
  const items = () =>
    Array.from(document.querySelectorAll("[data-nav-menu-item]"));
  const itemIds = () =>
    items().map((el) => el.getAttribute("data-nav-menu-item"));
  const item = (id: string) =>
    document.querySelector(`[data-nav-menu-item="${id}"]`)!;
  const separators = () =>
    Array.from(menu()?.querySelectorAll('[role="separator"]') ?? []);

  // The radio rows follow the plain ones past one divider, and only they
  // say which one is picked.
  function expectRadioRows() {
    expect(itemIds()).toEqual([
      "messages",
      "everything",
      "lastExchange",
      "markdown",
      "plain",
    ]);
    expect(items().map((el) => el.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitem",
      "menuitemradio",
      "menuitemradio",
    ]);
    expect(items().map((el) => el.getAttribute("aria-checked"))).toEqual([
      null,
      null,
      null,
      "true",
      "false",
    ]);
    const seps = separators();
    expect(seps).toHaveLength(1);
    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(item("lastExchange"), seps[0])).toBe(true);
    expect(follows(seps[0], item("markdown"))).toBe(true);
  }

  describe("desktop", () => {
    function mount(opts?: { disabled?: boolean; radio?: boolean }) {
      const m = withMenu(opts);
      const view = render(
        <div>
          <div data-testid="log" />
          <div data-testid="bar">
            <NavActions actions={m.acts} viewport="desktop" />
          </div>
          <div data-testid="outside" />
        </div>,
      );
      const trigger = view.container.querySelector(
        'button[aria-haspopup="menu"]',
      )!;
      expect(trigger).not.toBeNull();
      return { ...m, view, trigger };
    }

    it("opens the choices without running one, and a choice runs once and closes them", () => {
      const { ran, view, trigger } = mount();
      expect(menu()).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      press(trigger);
      expect(menu()).not.toBeNull();
      expect(menu()!.getAttribute("role")).toBe("menu");
      // In a portal, so the chat bar cannot clip it.
      expect(view.container.contains(menu())).toBe(false);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(itemIds()).toEqual(["messages", "everything", "lastExchange"]);
      expect(
        items().every((el) => el.getAttribute("role") === "menuitem"),
      ).toBe(true);
      expect(separators()).toHaveLength(0);
      expect(ran).toEqual([]);

      press(item("everything"));
      expect(ran).toEqual(["everything"]);
      expect(menu()).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it("closes on a second press of the button, a press outside, and Escape", () => {
      const { ran, view, trigger } = mount();

      press(trigger);
      press(trigger);
      expect(menu()).toBeNull();

      press(trigger);
      press(view.getByTestId("outside"));
      expect(menu()).toBeNull();

      press(trigger);
      expect(menu()).not.toBeNull();
      fireEvent.keyDown(item("messages"), { key: "Escape" });
      expect(menu()).toBeNull();
      // Focus goes back to the button, not to the page.
      expect(document.activeElement === trigger).toBe(true);

      expect(ran).toEqual([]);
    });

    // The chat log follows its bottom with scroll events of its own; only a
    // scroll that moves the button detaches the menu from it.
    it("stays open through a scroll that does not move the button", () => {
      const { view, trigger } = mount();
      press(trigger);
      fireEvent.scroll(view.getByTestId("log"));
      expect(menu()).not.toBeNull();

      fireEvent.scroll(view.getByTestId("bar"));
      expect(menu()).toBeNull();

      press(trigger);
      expect(menu()).not.toBeNull();
      fireEvent(window, new Event("resize"));
      expect(menu()).toBeNull();
    });

    it("a radio row runs and keeps the menu open; a plain row then closes it", () => {
      const { ran, trigger } = mount({ radio: true });
      press(trigger);
      expectRadioRows();

      press(item("plain"));
      expect(ran).toEqual(["plain"]);
      expect(menu()).not.toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");

      press(item("messages"));
      expect(ran).toEqual(["plain", "messages"]);
      expect(menu()).toBeNull();
    });

    it("does not open while disabled", () => {
      const { ran, trigger } = mount({ disabled: true });
      expect(trigger.hasAttribute("disabled")).toBe(true);
      press(trigger);
      expect(menu()).toBeNull();
      expect(ran).toEqual([]);
    });
  });

  describe("mobile", () => {
    function mount(opts?: { disabled?: boolean; radio?: boolean }) {
      const m = withMenu(opts);
      const view = render(<NavActions actions={m.acts} viewport="mobile" />);
      const overflow = view.getByRole("button");
      const openOverflow = () => {
        press(overflow);
        expect(view.queryByText("Tasks")).not.toBeNull();
      };
      const row = () =>
        view.getByText("Copy").closest("button") as HTMLButtonElement;
      return { ...m, view, overflow, openOverflow, row };
    }

    it("opens the choices under the row without closing the overflow, and a choice runs once and closes it", () => {
      const { ran, view, openOverflow, row } = mount();
      openOverflow();
      expect(row().getAttribute("aria-expanded")).toBe("false");
      expect(items().length).toBe(0);

      press(row());
      // The overflow stays open with its other rows.
      expect(view.queryByText("Tasks")).not.toBeNull();
      expect(row().getAttribute("aria-expanded")).toBe("true");
      expect(menu()).not.toBeNull();
      expect(itemIds()).toEqual(["messages", "everything", "lastExchange"]);
      expect(
        items().every((el) => el.getAttribute("role") === "menuitem"),
      ).toBe(true);
      expect(ran).toEqual([]);

      press(item("lastExchange"));
      expect(ran).toEqual(["lastExchange"]);
      expect(view.queryByText("Tasks")).toBeNull();

      // Collapsed again the next time the overflow opens.
      openOverflow();
      expect(row().getAttribute("aria-expanded")).toBe("false");
      expect(items().length).toBe(0);
    });

    it("a radio row runs and keeps the overflow and the choices open; a plain row then closes it", () => {
      const { ran, view, openOverflow, row } = mount({ radio: true });
      openOverflow();
      press(row());
      expectRadioRows();

      press(item("plain"));
      expect(ran).toEqual(["plain"]);
      expect(view.queryByText("Tasks")).not.toBeNull();
      expect(row().getAttribute("aria-expanded")).toBe("true");
      expect(items()).toHaveLength(5);

      press(item("lastExchange"));
      expect(ran).toEqual(["plain", "lastExchange"]);
      expect(view.queryByText("Tasks")).toBeNull();
    });

    it("collapses the choices on a second tap of the row", () => {
      const { ran, view, openOverflow, row } = mount();
      openOverflow();
      press(row());
      expect(items().length).toBe(3);
      press(row());
      expect(items().length).toBe(0);
      expect(row().getAttribute("aria-expanded")).toBe("false");
      expect(view.queryByText("Tasks")).not.toBeNull();
      expect(ran).toEqual([]);
    });

    it("does not expand while disabled", () => {
      const { ran, openOverflow, row } = mount({ disabled: true });
      openOverflow();
      expect(row().hasAttribute("disabled")).toBe(true);
      press(row());
      expect(items().length).toBe(0);
      expect(ran).toEqual([]);
    });
  });
});
