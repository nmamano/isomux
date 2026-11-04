// The Asks page's filter row (ui/components/AsksView.tsx): the open checkbox
// lists - Escape, the All box, and the priority list's Only button.
// This file is separate from the other AsksView.filter*.dom.test.tsx files
// and from AsksView.dom.test.tsx only because each DOM file has a wall-time
// budget.
import { beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  allFilterBox,
  allFilterState,
  checkedFilterValues,
  onlyFilterButton,
  openCheckboxFilter,
} = await import("../test-support/checkbox-filters.ts");
const { mountSorted, pageOrder, BY_AGENT, ALL_PRIORITIES, setRooms, isOpen } =
  await import("../test-support/asks-view.ts");

describe("the filter row", () => {
  beforeEach(() => localStorage.clear());

  it("closes an open list on Escape, focus back on its button, and the Inbox stays", async () => {
    const { view } = mountSorted();
    const c = view.container;
    const reached: string[] = [];
    // App closes the page on a window bubble keydown (App.tsx handleKey).
    const appEscape = (e: KeyboardEvent) => reached.push(e.key);
    window.addEventListener("keydown", appEscape);
    try {
      // With no list open, Escape reaches App: the probe can see it.
      await act(async () =>
        fireEvent.keyDown(document.body, { key: "Escape" }),
      );
      expect(reached).toEqual(["Escape"]);
      reached.length = 0;
      // A list open, focus on one of its boxes.
      await openCheckboxFilter(c, "room");
      expect(isOpen(view, "room")).toBe("true");
      const box = c.querySelector<HTMLInputElement>(
        '[data-checkbox-filter="room"] input[value="r1"]',
      )!;
      act(() => box.focus());
      await act(async () => fireEvent.keyDown(box, { key: "Escape" }));
      expect(isOpen(view, "room")).toBe("false");
      expect(reached).toEqual([]);
      // A scalar: a failed toBe on two DOM nodes serialises both.
      const active = () => {
        const el = document.activeElement as HTMLElement | null;
        return `${el?.closest<HTMLElement>("[data-checkbox-filter]")?.dataset.checkboxFilter}/${el?.tagName}`;
      };
      expect(active()).toBe("room/BUTTON");
      // Focus on the page, as after a click in Safari: the list still closes
      // first, and focus goes to its button.
      await openCheckboxFilter(c, "priority");
      expect(isOpen(view, "priority")).toBe("true");
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(active()).toBe("undefined/BODY");
      await act(async () =>
        fireEvent.keyDown(document.body, { key: "Escape" }),
      );
      expect(isOpen(view, "priority")).toBe("false");
      expect(reached).toEqual([]);
      expect(active()).toBe("priority/BUTTON");
      // Other keys with a list open still reach the page.
      await openCheckboxFilter(c, "priority");
      await act(async () => fireEvent.keyDown(document.body, { key: "a" }));
      expect(reached).toEqual(["a"]);
      // One list at a time.
      await openCheckboxFilter(c, "room");
      expect(isOpen(view, "room")).toBe("true");
      expect(isOpen(view, "priority")).toBe("false");
    } finally {
      window.removeEventListener("keydown", appEscape);
    }
  });

  it("has an All box that is checked, mixed or clear, and checks every room unless all are checked", async () => {
    const { view } = mountSorted();
    const c = view.container;
    const clickAll = async () => {
      const box = await allFilterBox(c, "room");
      await act(async () => fireEvent.click(box));
      expect(isOpen(view, "room")).toBe("true");
    };
    expect(await allFilterState(c, "room")).toBe("all");
    // All checked: a click clears every room.
    await clickAll();
    expect(await checkedFilterValues(c, "room")).toEqual([]);
    expect(await allFilterState(c, "room")).toBe("none");
    expect(pageOrder(view)).toEqual([]);
    // None checked: a click checks every room.
    await clickAll();
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r1"]);
    expect(await allFilterState(c, "room")).toBe("all");
    expect(pageOrder(view)).toEqual(BY_AGENT);
    // Some checked: mixed, and a click checks every room.
    await setRooms(view, ["r1"]);
    expect(await allFilterState(c, "room")).toBe("some");
    await clickAll();
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r1"]);
    expect(await allFilterState(c, "room")).toBe("all");
    // A room toggled back on in the list makes All checked again.
    await setRooms(view, ["r2"]);
    await setRooms(view, ["r2", "r1"]);
    expect(await allFilterState(c, "room")).toBe("all");
  });

  it("has Only and All on the priority list too", async () => {
    const { view } = mountSorted();
    const c = view.container;
    await act(async () =>
      fireEvent.click(await onlyFilterButton(c, "priority", "P1")),
    );
    expect(await checkedFilterValues(c, "priority")).toEqual(["P1"]);
    expect(pageOrder(view)).toEqual(["a3:a3p1", "a4:a4p1"]);
    expect(await allFilterState(c, "priority")).toBe("some");
    await act(async () => fireEvent.click(await allFilterBox(c, "priority")));
    expect(await checkedFilterValues(c, "priority")).toEqual(ALL_PRIORITIES);
    expect(pageOrder(view)).toEqual(BY_AGENT);
  });
});
