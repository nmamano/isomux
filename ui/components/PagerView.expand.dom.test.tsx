// Which pages the pager view shows expanded: every page by default, each
// collapsible on its own, and the deep link that opens and scrolls to one.
// The rest of the view is in PagerView.dom.test.tsx.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { h, mount, page, row, rowIds, setupPagerViewTests, shim, toggle } =
  await import("../test-support/pager-view-fixture.tsx");
setupPagerViewTests();

type View = Awaited<ReturnType<typeof mount>>["view"];

// Each row: open (aria-expanded) and whether its details are in the DOM.
function openness(view: View) {
  return rowIds(view).map((id) => {
    const t = toggle(view, id!);
    const details = t.getAttribute("aria-controls")!;
    return [
      id,
      t.getAttribute("aria-expanded"),
      row(view, id!).querySelector(`[id="${details}"]`) !== null,
    ];
  });
}

describe("expanded pages", () => {
  it("shows every page expanded, and a page that arrives later too", async () => {
    const { view } = await mount([
      page("p1", { body: "one", lastRaisedAt: 3_000 }),
      page("p2", { body: "two", lastRaisedAt: 2_000 }),
    ]);
    expect(openness(view)).toEqual([
      ["p1", "true", true],
      ["p2", "true", true],
    ]);
    await act(async () =>
      h.dispatch({
        type: "pager_upserted",
        entry: page("p3", { body: "three", lastRaisedAt: 1_000 }),
      }),
    );
    expect(openness(view)).toEqual([
      ["p1", "true", true],
      ["p2", "true", true],
      ["p3", "true", true],
    ]);
  });

  it("collapses one page and leaves the others open, and opens it again", async () => {
    const { view } = await mount([
      page("p1", { lastRaisedAt: 3_000 }),
      page("p2", { lastRaisedAt: 2_000 }),
      page("p3", { lastRaisedAt: 1_000 }),
    ]);
    fireEvent.click(toggle(view, "p2"));
    expect(openness(view)).toEqual([
      ["p1", "true", true],
      ["p2", "false", false],
      ["p3", "true", true],
    ]);
    fireEvent.click(toggle(view, "p3"));
    fireEvent.click(toggle(view, "p2"));
    expect(openness(view)).toEqual([
      ["p1", "true", true],
      ["p2", "true", true],
      ["p3", "false", false],
    ]);
  });
});

describe("the deep link", () => {
  // Each scrollIntoView call: the page row it ran on and its block option.
  let scrolled: [string | undefined, unknown][] = [];
  let original: PropertyDescriptor;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    )!;
    expect(typeof original.value).toBe("function");
    scrolled = [];
    Element.prototype.scrollIntoView = function (
      this: HTMLElement,
      arg?: boolean | ScrollIntoViewOptions,
    ) {
      scrolled.push([
        this.dataset.pagerId,
        typeof arg === "object" ? arg.block : arg,
      ]);
    };
  });
  afterEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", original);
  });

  const three = () => [
    page("p1", { lastRaisedAt: 3_000 }),
    page("p2", { lastRaisedAt: 2_000 }),
    page("p3", { lastRaisedAt: 1_000 }),
  ];

  it("opens a page the member collapsed and leaves another collapsed page as it is", async () => {
    const { view } = await mount(three());
    fireEvent.click(toggle(view, "p1"));
    fireEvent.click(toggle(view, "p2"));
    await act(async () => h.requestSelect({ id: "p2" }));
    expect(openness(view)).toEqual([
      ["p1", "false", false],
      ["p2", "true", true],
      ["p3", "true", true],
    ]);
    expect(scrolled).toEqual([["p2", "start"]]);
  });

  it("scrolls to the top a page that is already open, again on a repeat link", async () => {
    const { view } = await mount(three());
    // Enabling condition: the target is open before the link.
    expect(toggle(view, "p3").getAttribute("aria-expanded")).toBe("true");
    await act(async () => h.requestSelect({ id: "p3" }));
    expect(scrolled).toEqual([["p3", "start"]]);
    await act(async () => h.requestSelect({ id: "p3" }));
    expect(scrolled).toEqual([
      ["p3", "start"],
      ["p3", "start"],
    ]);
  });

  it("scrolls to a page read by id, outside the loaded pages", async () => {
    shim.byId = [page("old1", { state: "resolved", lastRaisedAt: 500 })];
    const { view } = await mount(three());
    await act(async () => h.requestSelect({ id: "old1" }));
    // Enabling condition: the page came from the read by id.
    expect(shim.calls).toContain("GET /api/pager/old1");
    expect(toggle(view, "old1").getAttribute("aria-expanded")).toBe("true");
    expect(scrolled).toEqual([["old1", "start"]]);
  });
});
