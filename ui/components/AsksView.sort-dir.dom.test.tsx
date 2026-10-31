// The Asks page's sort-direction select (ui/components/AsksView.tsx): what it
// holds, and how the page and the stored choice follow it. The direction's
// storage has its own owner ("asks sort direction" in
// ui/device-settings.test.ts) and the sort orders it produces their own
// (ui/components/AsksView.test.ts). This file is separate from
// AsksView.dom.test.tsx only because each DOM file has a wall-time budget,
// and the tab's own file is close to it.
import { describe, it, expect, beforeEach } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { ranked, mount, control, choose, pageOrder, SORT_ROOMS, SORT_AGENTS } =
  await import("../test-support/asks-view.ts");

// The direction select beside the sort (task 452cf482): one shared direction
// that survives a reload and resets to asc on a change of sort.
describe("the sort direction", () => {
  beforeEach(() => localStorage.clear());

  const dir = (view: ReturnType<typeof mount>["view"]) =>
    control(view, "data-asks-sort-dir");
  // The storage key is a protocol value.
  const rawDir = () => localStorage.getItem("isomux-asks-sort-dir");

  it("draws the select after the sort select, follows it, and resets on a change of sort", () => {
    const { view } = mount(
      [
        ranked("x", "a1", 90),
        ranked("y", "a1", 30, "P1"),
        ranked("z", "a2", 60),
      ],
      {
        rooms: SORT_ROOMS,
        agents: SORT_AGENTS.slice(0, 2),
      },
    );
    // The select sits after the sort select; today the second is missing,
    // which is the red reason for this test.
    const kinds = [...view.container.querySelectorAll("select")]
      .map((el) =>
        el.dataset.asksSort !== undefined
          ? "sort"
          : el.dataset.asksSortDir !== undefined
            ? "dir"
            : "other",
      )
      .filter((k) => k !== "other");
    expect(kinds).toEqual(["sort", "dir"]);
    const d = dir(view);
    expect([...d.options].map((o) => o.value)).toEqual(["asc", "desc"]);
    expect(d.value).toBe("asc");
    // A labeled control, whatever the words: an empty label is the defect.
    expect(d.getAttribute("aria-label") ?? "").not.toBe("");
    // The labels follow the sort, whatever the words.
    const labels = () => [...d.options].map((o) => o.textContent);
    const byAge = labels();
    // The sort starts as its own asc side: a1 heads the page and its cards
    // run oldest first (x, then y).
    expect(pageOrder(view)).toEqual(["a1:x,y", "a2:z"]);

    // The direction the member picks shows on the page and is stored,
    // only as desc.
    choose(view, "data-asks-sort-dir", "desc");
    expect(pageOrder(view)).toEqual(["a1:y,x", "a2:z"]);
    expect(rawDir()).toBe("desc");

    // A change of sort resets: a1 re-split into its two runs, oldest first.
    // The labels stay the same pair here by design: "agent" and "age" both
    // key the cards by age.
    choose(view, "data-asks-sort", "age");
    expect(d.value).toBe("asc");
    expect(rawDir()).toBeNull();
    expect(pageOrder(view)).toEqual(["a1:x", "a2:z", "a1:y"]);
    expect(labels().join("|")).toBe(byAge.join("|"));

    // A sort that does not key by age draws its own pair of labels.
    choose(view, "data-asks-sort", "priority");
    expect(labels().join("|")).not.toBe(byAge.join("|"));
  });
});
