// The page stack (task 3484f6c9): a door opens its page on top, and closing
// the page that shows uncovers the page it was opened over, whatever the
// order. Every input is frozen: App keeps the stack in React state, so an
// action that changed the array in place would not render.

import { describe, expect, it } from "bun:test";
import {
  pageStackAfter,
  pageUnder,
  topPage,
  type PageStack,
  type PageStackAction,
} from "./page-stack.ts";
import { OFFICE_PAGES, type Page } from "../shared/office-links.ts";

const stack = (...pages: Page[]): PageStack => Object.freeze(pages);
const after = (pages: PageStack, action: PageStackAction) =>
  pageStackAfter(pages, action);

describe("pageStackAfter", () => {
  it("open puts the page on top, and moves a page that is already open", () => {
    expect(after(stack(), { type: "open", page: "skills" })).toEqual([
      "skills",
    ]);
    // Over a page the old fixed order ranked higher (the bug of task 3484f6c9).
    expect(after(stack("skills"), { type: "open", page: "asks" })).toEqual([
      "skills",
      "asks",
    ]);
    expect(
      after(stack("asks", "skills", "tasks"), { type: "open", page: "asks" }),
    ).toEqual(["skills", "tasks", "asks"]);
    expect(
      after(stack("asks", "skills"), { type: "open", page: "skills" }),
    ).toEqual(["asks", "skills"]);
  });

  it("close removes the page wherever it is, and changes nothing when it is not open", () => {
    expect(
      after(stack("apps", "tasks"), { type: "close", page: "tasks" }),
    ).toEqual(["apps"]);
    expect(
      after(stack("apps", "asks", "tasks"), { type: "close", page: "asks" }),
    ).toEqual(["apps", "tasks"]);
    expect(
      after(stack("apps", "tasks"), { type: "close", page: "skills" }),
    ).toEqual(["apps", "tasks"]);
    expect(after(stack(), { type: "close", page: "skills" })).toEqual([]);
  });

  it("toggle closes the page that shows, and else opens it on top", () => {
    expect(
      after(stack("asks", "tasks"), { type: "toggle", page: "tasks" }),
    ).toEqual(["asks"]);
    // Open under another page: it comes up, it does not close out of sight.
    expect(
      after(stack("tasks", "asks"), { type: "toggle", page: "tasks" }),
    ).toEqual(["asks", "tasks"]);
    expect(after(stack("asks"), { type: "toggle", page: "tasks" })).toEqual([
      "asks",
      "tasks",
    ]);
    expect(after(stack(), { type: "toggle", page: "tasks" })).toEqual([
      "tasks",
    ]);
  });

  it("only leaves just the page, or no page", () => {
    const every = stack(...OFFICE_PAGES);
    expect(after(every, { type: "only", page: "apps" })).toEqual(["apps"]);
    expect(after(every, { type: "only", page: null })).toEqual([]);
    expect(after(stack(), { type: "only", page: "asks" })).toEqual(["asks"]);
  });

  // Every action, three deep from the office: a page is in the stack at most
  // once, so one close always uncovers a different page.
  it("never holds a page twice", () => {
    const actions: PageStackAction[] = [
      { type: "only", page: null },
      ...OFFICE_PAGES.flatMap((page): PageStackAction[] => [
        { type: "open", page },
        { type: "toggle", page },
        { type: "close", page },
        { type: "only", page },
      ]),
    ];
    let frontier: PageStack[] = [stack()];
    let deepest = 0;
    for (let depth = 0; depth < 3; depth++) {
      const next: PageStack[] = [];
      for (const s of frontier)
        for (const action of actions) {
          const out = after(Object.freeze([...s]), action);
          expect(new Set(out).size).toBe(out.length);
          deepest = Math.max(deepest, out.length);
          next.push(out);
        }
      frontier = next;
    }
    expect(deepest).toBe(3);
  });
});

describe("topPage and pageUnder", () => {
  it("name the page that shows and the one a close uncovers", () => {
    expect(topPage(stack())).toBeNull();
    expect(pageUnder(stack())).toBeNull();
    expect(topPage(stack("skills"))).toBe("skills");
    expect(pageUnder(stack("skills"))).toBeNull();
    expect(topPage(stack("tasks", "skills", "asks"))).toBe("asks");
    expect(pageUnder(stack("tasks", "skills", "asks"))).toBe("skills");
  });
});
