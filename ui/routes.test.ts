import { describe, expect, it } from "bun:test";
import {
  pageForPath,
  pathForPage,
  pageShortcut,
  backRoomShortcut,
  createLoneShiftTracker,
  pagerIdForSearch,
  pageForLocation,
  mcpSignInForSearch,
  integrationsTabForPath,
  askIdForPath,
  presencePageFor,
  type Page,
  type PageShortcutInput,
} from "./routes.ts";
import { pageStackAfter, topPage, type PageStack } from "./page-stack.ts";
import { INTEGRATIONS_TABS, askLinkFor } from "../shared/office-links.ts";
import type { PresencePage } from "../shared/presence-pages.ts";

// Each page and its canonical path. The cronjobs page is "Automations" on
// screen, and its path says so. The asks page is the Inbox.
const PATHS: Record<Page, string> = {
  tasks: "/tasks",
  cronjobs: "/automations",
  apps: "/apps",
  skills: "/skills",
  integrations: "/integrations",
  settings: "/settings",
  asks: "/inbox/asks",
};
const PAGES = Object.keys(PATHS) as Page[];

describe("pageForPath", () => {
  it("names each page from its canonical path", () => {
    for (const page of PAGES) expect(pageForPath(PATHS[page])).toBe(page);
  });

  it("treats the office and its variants as no page", () => {
    expect(pageForPath("/")).toBeNull();
    expect(pageForPath("")).toBeNull();
  });

  // Old names and trailing slashes: accepted, never produced.
  it("accepts trailing slashes and the old paths", () => {
    for (const [path, page] of [
      ["/tasks/", "tasks"],
      ["/settings//", "settings"],
      // The Inbox's Pages tab until pages became asks (task 74e8fc07).
      ["/inbox/pages", "asks"],
      ["/inbox/pages/", "asks"],
      ["/inbox/pages/abcd1234", "asks"],
      ["/users", "settings"],
      ["/users/", "settings"],
      ["/cronjobs", "cronjobs"],
      ["/cronjobs/", "cronjobs"],
      ["/pager", "asks"],
      ["/asks", "asks"],
      ["/asks/", "asks"],
      // A typed /inbox opens the first tab, Asks.
      ["/inbox", "asks"],
      ["/inbox/", "asks"],
    ] as const)
      expect([path, pageForPath(path)]).toEqual([path, page]);
  });

  it("rejects anything else, matching case and segment by segment", () => {
    for (const path of [
      "/garbage",
      "/tasks/extra",
      "/Tasks",
      "/SETTINGS",
      // Ruling 3 names the paths AT THE ROOT: a bare segment is not one, and
      // a doubled slash is a different URL to any browser.
      "tasks",
      "//tasks",
      "/inbox/x",
      "/Inbox/pages",
      "/inbox/Asks",
      "/inbox//asks",
      // Would answer with a function if the table were an object index.
      "/constructor",
      "/__proto__",
      "/toString",
    ])
      expect([path, pageForPath(path)]).toEqual([path, null]);
  });
});

// A pasted /integrations/<tab> URL opens that tab (task df206fe3). The
// address bar never shows one: the boot rewrites it to /integrations.
describe("the Integrations tab paths", () => {
  it("open the Integrations page on the tab they name", () => {
    for (const tab of INTEGRATIONS_TABS) {
      for (const path of [`/integrations/${tab}`, `/integrations/${tab}/`]) {
        expect(pageForPath(path)).toBe("integrations");
        expect(integrationsTabForPath(path)).toBe(tab);
      }
    }
  });

  it("name no tab for the page's own path or any other page", () => {
    expect(integrationsTabForPath("/integrations")).toBeNull();
    expect(integrationsTabForPath("/integrations/")).toBeNull();
    for (const page of PAGES)
      expect(integrationsTabForPath(PATHS[page])).toBeNull();
    expect(integrationsTabForPath("/")).toBeNull();
  });

  it("match segment by segment, like the other routes", () => {
    for (const path of [
      "/integrations/nope",
      "/integrations/mcp/x",
      "/integrations//mcp",
      "/Integrations/mcp",
      "/integrations/MCP",
      "integrations/mcp",
      "/tasks/mcp",
      "/integrations/constructor",
    ]) {
      expect(pageForPath(path)).toBeNull();
      expect(integrationsTabForPath(path)).toBeNull();
    }
  });
});

describe("the pager link", () => {
  it("reads the page id from the query on any path", () => {
    expect(pagerIdForSearch("?pager=1a2b3c4d")).toBe("1a2b3c4d");
    // An old page link opens the Inbox (its ask is pinned once the office
    // names it, task 74e8fc07).
    expect(pageForLocation("/", "?pager=1a2b3c4d")).toBe("asks");
    expect(pageForLocation("/tasks", "?pager=1a2b3c4d")).toBe("asks");
    expect(pageForLocation("/inbox/asks", "?pager=1a2b3c4d")).toBe("asks");
  });

  it("falls back to the path without a usable id", () => {
    for (const search of ["", "?pager=", "?pager=%20", "?other=1"]) {
      expect(pagerIdForSearch(search)).toBeNull();
      expect(pageForLocation("/tasks", search)).toBe("tasks");
      expect(pageForLocation("/", search)).toBeNull();
    }
    expect(pagerIdForSearch(`?pager=${"a".repeat(65)}`)).toBeNull();
  });
});

// One ask's address, /inbox/asks/<askId> (task 84aadfab): it opens the Asks
// tab with that ask pinned. The id is lowercase hex, 8 to 64 characters, the
// same check as an ask's link (shared/office-links.ts).
describe("the ask address", () => {
  const id8 = "a6b624d3";
  const id64 = "0123456789abcdef".repeat(4);

  it("opens the Asks tab on the ask it names", () => {
    for (const [path, id] of [
      [`/inbox/asks/${id8}`, id8],
      [`/inbox/asks/${id8}/`, id8],
      [`/inbox/asks/${id64}`, id64],
    ] as const) {
      expect([path, pageForPath(path)]).toEqual([path, "asks"]);
      expect([path, askIdForPath(path)]).toEqual([path, id]);
      expect([path, pageForLocation(path, "")]).toEqual([path, "asks"]);
    }
  });

  it("names no ask on the list's own paths or another page", () => {
    for (const path of ["/inbox/asks", "/inbox/asks/", "/inbox", "/asks", "/"])
      expect([path, askIdForPath(path)]).toEqual([path, null]);
    for (const page of PAGES)
      expect([page, askIdForPath(PATHS[page])]).toEqual([page, null]);
  });

  it("refuses an id that is not lowercase hex of 8 to 64, or more segments", () => {
    for (const path of [
      "/inbox/asks/a6b624d",
      `/inbox/asks/${id64}0`,
      "/inbox/asks/A6B624D3",
      "/inbox/asks/a6b624dg",
      "/inbox/asks/a6b624d3/x",
      "/inbox/asks//a6b624d3",
      "/inbox/Asks/a6b624d3",
      "/asks/a6b624d3",
      "inbox/asks/a6b624d3",
      "/inbox/asks/constructor",
    ]) {
      expect([path, askIdForPath(path)]).toEqual([path, null]);
      expect([path, pageForPath(path)]).toEqual([path, null]);
    }
  });

  // One check for both (C2): a link the server accepts is an address the
  // boot opens, and the other way round.
  it("accepts exactly the ids an ask's link accepts", () => {
    for (const segment of [
      id8,
      id64,
      `${id64}0`,
      "a6b624d",
      "A6B624D3",
      "a6b624dg",
      "a6b624d3/x",
      "",
      "1234567890",
    ]) {
      const link = askLinkFor(`/inbox/asks/${segment}`);
      expect([segment, askIdForPath(`/inbox/asks/${segment}`)]).toEqual([
        segment,
        link && "page" in link ? (link.askId ?? null) : null,
      ]);
    }
  });
});

describe("the MCP sign-in return", () => {
  it("reads the result code from the query", () => {
    expect(mcpSignInForSearch("?mcpSignIn=ok")).toBe("ok");
    expect(mcpSignInForSearch("?mcpSignIn=denied&x=1")).toBe("denied");
    for (const search of ["", "?mcpSignIn=", "?mcpSignIn=%20", "?other=ok"])
      expect(mcpSignInForSearch(search)).toBeNull();
    expect(mcpSignInForSearch(`?mcpSignIn=${"a".repeat(65)}`)).toBeNull();
  });

  it("opens the Integrations page at its own path and at the old /settings one", () => {
    expect(pageForLocation("/integrations", "?mcpSignIn=ok")).toBe(
      "integrations",
    );
    expect(pageForLocation("/settings", "?mcpSignIn=ok")).toBe("integrations");
    // Settings without a sign-in result stays Settings.
    expect(pageForLocation("/settings", "")).toBe("settings");
    // The page link still wins.
    expect(pageForLocation("/settings", "?mcpSignIn=ok&pager=1a2b3c4d")).toBe(
      "asks",
    );
  });
});

describe("pathForPage", () => {
  it("formats each page and the office", () => {
    expect(pathForPage(null)).toBe("/");
    for (const page of PAGES) expect(pathForPage(page)).toBe(PATHS[page]);
  });
});

// What a page key does to the page stack (task 3484f6c9). Each case applies
// the key's action through pageStackAfter, as App does, and reads the stack.
const office: PageStack = Object.freeze([]);
const stackOf = (...pages: Page[]): PageStack => Object.freeze(pages);

function pressPageKey(stack: PageStack, key: string): PageStack {
  const action = pageShortcut({ key }, stack);
  if (action === null || action === "home")
    throw new Error(`Expected a stack action for ${key}, got ${action}`);
  return pageStackAfter(stack, action);
}

describe("pageShortcut", () => {
  it("t opens Tasks on top of any page, and closes it when it shows", () => {
    expect(pressPageKey(office, "t")).toEqual(["tasks"]);
    expect(pressPageKey(stackOf("apps", "asks"), "t")).toEqual([
      "apps",
      "asks",
      "tasks",
    ]);
    expect(pressPageKey(stackOf("apps", "tasks"), "t")).toEqual(["apps"]);
    // Tasks open under the Inbox comes up; it does not close out of sight.
    expect(pressPageKey(stackOf("tasks", "asks"), "t")).toEqual([
      "asks",
      "tasks",
    ]);
  });

  // Two keydowns can come before React renders: both read the same stack,
  // and App applies both actions in turn to the latest one.
  it("composes two t presses read from one stack", () => {
    for (const stack of [office, stackOf("tasks"), stackOf("apps", "tasks")]) {
      const first = pageShortcut({ key: "t" }, stack);
      const second = pageShortcut({ key: "t" }, stack);
      if (
        first === null ||
        first === "home" ||
        second === null ||
        second === "home"
      )
        throw new Error("Expected stack actions for t");
      expect(pageStackAfter(pageStackAfter(stack, first), second)).toEqual([
        ...stack,
      ]);
    }
  });

  it("a and i open their page alone, and close it only when it shows", () => {
    // Every page but Settings, Tasks on top.
    const every = stackOf(
      "asks",
      "apps",
      "cronjobs",
      "skills",
      "integrations",
      "tasks",
    );
    for (const [key, page] of [
      ["a", "apps"],
      ["i", "asks"],
    ] as const) {
      expect(pressPageKey(office, key)).toEqual([page]);
      expect(pressPageKey(every, key)).toEqual([page]);
      expect(pageShortcut({ key }, stackOf(page))).toBe("home");
      expect(pageShortcut({ key }, stackOf("tasks", page))).toBe("home");
      // Covered by Tasks: the key brings the page back, alone.
      expect(pressPageKey(stackOf(page, "tasks"), key)).toEqual([page]);
    }
  });

  it("s opens Settings on top of the page that shows", () => {
    expect(pressPageKey(office, "s")).toEqual(["settings"]);
    expect(pressPageKey(stackOf("asks", "tasks"), "s")).toEqual([
      "asks",
      "tasks",
      "settings",
    ]);
  });

  it("keeps shortcuts out of inputs, modified keys, and a Settings page that shows", () => {
    for (const key of ["t", "a", "i", "s"]) {
      for (const guard of [
        "isInput",
        "metaKey",
        "ctrlKey",
        "altKey",
      ] as const) {
        const input: PageShortcutInput = { key, [guard]: true };
        expect(pageShortcut(input, office)).toBeNull();
      }
      // Settings guards its own unsaved edits, and only while it shows.
      expect(pageShortcut({ key }, stackOf("settings"))).toBeNull();
      expect(pageShortcut({ key }, stackOf("tasks", "settings"))).toBeNull();
    }
    expect(pressPageKey(stackOf("settings", "apps"), "t")).toEqual([
      "settings",
      "apps",
      "tasks",
    ]);
    expect(pageShortcut({ key: "x" }, office)).toBeNull();
  });

  // From every stack a member reaches with the keys and Escape, a key that
  // does not close its page shows that page: a key that opened its page
  // under the one shown would leave the member looking at the old page.
  it("every key shows the page it opens, from every reachable stack", () => {
    const KEY_PAGE: Record<string, Page> = {
      t: "tasks",
      a: "apps",
      i: "asks",
      s: "settings",
    };
    const seen = new Set<string>();
    const queue: PageStack[] = [office, ...PAGES.map((page) => stackOf(page))];
    let deepest = 0;
    while (queue.length > 0) {
      const stack = queue.shift()!;
      const id = stack.join(",");
      if (seen.has(id)) continue;
      seen.add(id);
      deepest = Math.max(deepest, stack.length);
      // Escape closes the page that shows.
      if (stack.length > 0) queue.push(Object.freeze(stack.slice(0, -1)));
      for (const [key, page] of Object.entries(KEY_PAGE)) {
        const action = pageShortcut({ key }, stack);
        if (action === null) continue;
        if (action === "home") {
          expect(topPage(stack)).toBe(page);
          continue;
        }
        const next = pageStackAfter(stack, action);
        queue.push(next);
        if (!(key === "t" && topPage(stack) === "tasks"))
          expect(topPage(next)).toBe(page);
      }
    }
    expect(deepest).toBe(3);
  });
});

describe("backRoomShortcut", () => {
  const office = { hasBackRoom: true, backRoomOpen: false, covered: false };

  it("goes between the front and the back room", () => {
    expect(backRoomShortcut({ key: "b" }, office)).toBe("open");
    expect(
      backRoomShortcut({ key: "b" }, { ...office, backRoomOpen: true }),
    ).toBe("close");
  });

  // Nil, 2026-10-20: in a back room, a lone Shift or Shift+Tab goes to the
  // front. Neither opens the back room: from the front, Shift+Tab still
  // switches rooms.
  const loneShift: PageShortcutInput = { key: "Shift", loneShift: true };
  const shiftTab: PageShortcutInput = { key: "Tab", shiftKey: true };
  const open = { ...office, backRoomOpen: true };

  it("a lone Shift or Shift+Tab in a back room goes to the front", () => {
    expect(backRoomShortcut(loneShift, open)).toBe("close");
    expect(backRoomShortcut(shiftTab, open)).toBe("close");
    expect(backRoomShortcut(loneShift, office)).toBeNull();
    expect(backRoomShortcut(shiftTab, office)).toBeNull();
  });

  it("a Shift that is not lone, or plain Tab, does nothing", () => {
    // A Shift keydown reaches the rule with key "Shift" too: only the keyup
    // path's loneShift flag makes it a lone press.
    expect(backRoomShortcut({ key: "Shift" }, open)).toBeNull();
    expect(backRoomShortcut({ key: "Shift", shiftKey: true }, open)).toBeNull();
    expect(backRoomShortcut({ key: "Tab" }, open)).toBeNull();
  });

  it("does nothing without a back room, while typing, with a modifier, or under a log or page", () => {
    expect(backRoomShortcut({ key: "c" }, office)).toBeNull();
    for (const input of [{ key: "b" }, loneShift, shiftTab]) {
      const state = input.key === "b" ? office : open;
      expect(
        backRoomShortcut(input, { ...state, hasBackRoom: false }),
      ).toBeNull();
      expect(backRoomShortcut({ ...input, isInput: true }, state)).toBeNull();
      for (const mod of ["metaKey", "ctrlKey", "altKey"] as const)
        expect(backRoomShortcut({ ...input, [mod]: true }, state)).toBeNull();
      expect(backRoomShortcut(input, { ...state, covered: true })).toBeNull();
    }
  });
});

describe("createLoneShiftTracker", () => {
  it("keeps a held Shift lone across its repeat keydowns", () => {
    const t = createLoneShiftTracker();
    t.keydown("Shift");
    t.keydown("Shift", true);
    t.keydown("Shift", true);
    expect(t.keyup("Shift")).toBe(true);
  });

  // A blur loses the release of a Shift held as the window lost focus.
  it("after a reset, a new Shift press counts, and the repeats of a held one do not", () => {
    const fresh = createLoneShiftTracker();
    fresh.keydown("Shift");
    fresh.reset();
    fresh.keydown("Shift");
    expect(fresh.keyup("Shift")).toBe(true);

    const held = createLoneShiftTracker();
    held.keydown("Shift");
    held.reset();
    held.keydown("Shift", true);
    held.keydown("Shift", true);
    expect(held.keyup("Shift")).toBe(false);
  });

  it("counts one press once, and a spoiled press does not spoil the next", () => {
    const t = createLoneShiftTracker();
    expect(t.keyup("Shift")).toBe(false);
    t.keydown("Shift");
    expect(t.keyup("Shift")).toBe(true);
    expect(t.keyup("Shift")).toBe(false);
    // A spoiled press does not spoil the next one.
    t.keydown("Shift");
    t.keydown("A");
    expect(t.keyup("Shift")).toBe(false);
    t.keydown("Shift");
    expect(t.keyup("Shift")).toBe(true);
  });
});

describe("presencePageFor", () => {
  // The wall item a ghost stands by while each page is open (tasks 35bdee4d,
  // b781545f): the corkboard, the Apps screen, the clock, the vent and the
  // Inbox tray, for the asks page. A Record over
  // Page, so a new page fails the type check here until someone picks its
  // ghost spot.
  const WALL: Record<Page, PresencePage | null> = {
    tasks: "tasks",
    cronjobs: "cronjobs",
    apps: "apps",
    skills: null,
    integrations: null,
    settings: "settings",
    asks: "inbox",
  };

  it("maps each page to its wall item, and no page to none", () => {
    const got = Object.fromEntries(
      (Object.keys(WALL) as Page[]).map((page) => [
        page,
        presencePageFor(page),
      ]),
    );
    expect(got).toEqual(WALL);
    expect(presencePageFor(null)).toBeNull();
  });
});
