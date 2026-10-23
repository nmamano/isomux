import { describe, expect, it } from "bun:test";
import {
  pageForPath,
  pathForPage,
  pageForFlags,
  pageUnder,
  flagForPage,
  pageShortcut,
  backRoomShortcut,
  createLoneShiftTracker,
  pagerIdForSearch,
  pageForLocation,
  mcpSignInForSearch,
  integrationsTabForPath,
  type Page,
  type PageFlags,
  type PageShortcutInput,
} from "./routes.ts";
import { INTEGRATIONS_TABS } from "../shared/office-links.ts";

// Each page and its canonical path. The cronjobs page is "Automations" on
// screen, and its path says so. The pager and asks pages are the Inbox's two
// tabs.
const PATHS: Record<Page, string> = {
  tasks: "/tasks",
  cronjobs: "/automations",
  apps: "/apps",
  skills: "/skills",
  integrations: "/integrations",
  settings: "/settings",
  pager: "/inbox/pages",
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
      ["/inbox/pages/", "pager"],
      ["/users", "settings"],
      ["/users/", "settings"],
      ["/cronjobs", "cronjobs"],
      ["/cronjobs/", "cronjobs"],
      ["/pager", "pager"],
      ["/asks", "asks"],
      ["/asks/", "asks"],
      ["/inbox", "pager"],
      ["/inbox/", "pager"],
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
      "/inbox/pages/x",
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
    expect(pageForLocation("/", "?pager=1a2b3c4d")).toBe("pager");
    expect(pageForLocation("/tasks", "?pager=1a2b3c4d")).toBe("pager");
    expect(pageForLocation("/inbox/asks", "?pager=1a2b3c4d")).toBe("pager");
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
    // The pager link still wins.
    expect(pageForLocation("/settings", "?mcpSignIn=ok&pager=1a2b3c4d")).toBe(
      "pager",
    );
  });
});

describe("pathForPage", () => {
  it("formats each page and the office", () => {
    expect(pathForPage(null)).toBe("/");
    for (const page of PAGES) expect(pathForPage(page)).toBe(PATHS[page]);
  });
});

const office: PageFlags = {
  usersOpen: false,
  tasksOpen: false,
  cronjobsOpen: false,
  appsOpen: false,
  skillsOpen: false,
  integrationsOpen: false,
  pagerOpen: false,
  asksOpen: false,
};

// Apply the returned setters as React does, including functional updates.
function pressPageKey(state: PageFlags, key: string): PageFlags {
  const update = pageShortcut({ key }, state);
  expect(update !== null && update !== "home").toBe(true);
  if (update === null || update === "home")
    throw new Error("Expected page setters");
  return {
    ...state,
    ...update,
    tasksOpen:
      typeof update.tasksOpen === "function"
        ? update.tasksOpen(state.tasksOpen)
        : (update.tasksOpen ?? state.tasksOpen),
  };
}

describe("page shortcuts and rendered-page precedence", () => {
  it("carries t/a/t/a/s through the same paths and page selection as App", () => {
    let state = office;
    for (const [key, path, appsVisible] of [
      ["t", "/tasks", false],
      ["a", "/apps", true],
      ["t", "/tasks", false],
      ["a", "/apps", true],
      ["s", "/settings", false],
    ] as const) {
      state = pressPageKey(state, key);
      const page = pageForFlags(state);
      expect(pathForPage(page)).toBe(path);
      // App uses this same selection to mount AppsView or unmount it.
      expect(page === "apps").toBe(appsVisible);
    }
  });

  it("toggles Tasks without clearing the page flags underneath it", () => {
    const beneath = { ...office, appsOpen: true, cronjobsOpen: true };
    const shown = pressPageKey(beneath, "t");
    expect(shown).toEqual({ ...beneath, tasksOpen: true });
    expect(pageForFlags(shown)).toBe("tasks");
    const hidden = pressPageKey(shown, "t");
    expect(hidden).toEqual(beneath);
    expect(pageForFlags(hidden)).toBe("cronjobs");
  });

  it("preserves two task toggles queued before a render", () => {
    const update = pageShortcut({ key: "t" }, office);
    expect(typeof (update && update !== "home" && update.tasksOpen)).toBe(
      "function",
    );
    if (!update || update === "home" || typeof update.tasksOpen !== "function")
      throw new Error("Expected a functional task update");
    expect(update.tasksOpen(update.tasksOpen(false))).toBe(false);
  });

  // One order decides the page shown when flags overlap; App renders and
  // writes history from it.
  it("shows the pages in one precedence order", () => {
    const ORDER: Page[] = [
      "settings",
      "tasks",
      "cronjobs",
      "apps",
      "skills",
      "integrations",
      "pager",
      "asks",
    ];
    expect([...ORDER].sort()).toEqual([...PAGES].sort());
    ORDER.forEach((page, i) => {
      expect(pageForFlags({ ...office, [flagForPage(page)]: true })).toBe(page);
      for (const lower of ORDER.slice(i + 1))
        expect(
          pageForFlags({
            ...office,
            [flagForPage(page)]: true,
            [flagForPage(lower)]: true,
          }),
        ).toBe(page);
    });
  });

  it("opens Apps on a over any page below Settings, and clears the others", () => {
    const every = {
      ...office,
      tasksOpen: true,
      cronjobsOpen: true,
      skillsOpen: true,
      integrationsOpen: true,
      pagerOpen: true,
      asksOpen: true,
    };
    expect(pressPageKey(every, "a")).toEqual({ ...office, appsOpen: true });
  });

  it("only closes Apps when Apps is the visible page", () => {
    expect(pageShortcut({ key: "a" }, { ...office, appsOpen: true })).toBe(
      "home",
    );
    for (const covered of [{ tasksOpen: true }, { cronjobsOpen: true }]) {
      const shown = pressPageKey(
        { ...office, appsOpen: true, ...covered },
        "a",
      );
      expect(shown).toEqual({ ...office, appsOpen: true });
      expect(pageForFlags(shown)).toBe("apps");
    }
  });

  // "i" sets every page flag in one update, never the lone flip of "t"
  // (task f55581c3).
  it("opens Integrations on i over any page, and clears the others", () => {
    const every = {
      ...office,
      tasksOpen: true,
      cronjobsOpen: true,
      appsOpen: true,
      skillsOpen: true,
      pagerOpen: true,
      asksOpen: true,
    };
    expect(pressPageKey(every, "i")).toEqual({
      ...office,
      integrationsOpen: true,
    });
  });

  it("closes Integrations on i only when it is the page shown", () => {
    const open = pressPageKey(office, "i");
    expect(pageShortcut({ key: "i" }, open)).toBe("home");
    // Integrations, then t: Tasks is on top, so i brings Integrations back.
    const underTasks = pressPageKey(open, "t");
    expect(pageForFlags(underTasks)).toBe("tasks");
    const back = pressPageKey(underTasks, "i");
    expect(back).toEqual({ ...office, integrationsOpen: true });
  });

  it("keeps shortcuts out of inputs, modified keys, and Settings", () => {
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
      expect(pageShortcut({ key }, { ...office, usersOpen: true })).toBeNull();
    }
    expect(pageShortcut({ key: "x" }, office)).toBeNull();
  });
});

describe("pageUnder", () => {
  it("is null with no page or one page open", () => {
    expect(pageUnder(office)).toBeNull();
    for (const page of PAGES)
      expect(pageUnder({ ...office, [flagForPage(page)]: true })).toBeNull();
  });

  it("names the page that shows when the top one closes", () => {
    // t then s from a chat (task d6c09d1c): Settings closes to Tasks.
    let state = pressPageKey(office, "t");
    state = pressPageKey(state, "s");
    expect(pageForFlags(state)).toBe("settings");
    expect(pageUnder(state)).toBe("tasks");
    // a then t: Tasks sits over Apps.
    state = pressPageKey(pressPageKey(office, "a"), "t");
    expect(pageForFlags(state)).toBe("tasks");
    expect(pageUnder(state)).toBe("apps");
    // Tasks over the Asks tab (the bar button, then t).
    state = pressPageKey({ ...office, asksOpen: true }, "t");
    expect(pageForFlags(state)).toBe("tasks");
    expect(pageUnder(state)).toBe("asks");
  });

  // The invariant pageUnder rests on: every shortcut, from every flags state a
  // member can reach, shows the page it opened on top. A key that opened its
  // page under the one shown would make Escape close the wrong layer.
  it("every shortcut shows the page it opens, from every reachable state", () => {
    const KEY_PAGE: Record<string, Page> = {
      t: "tasks",
      a: "apps",
      i: "integrations",
      s: "settings",
    };
    const apply = (state: PageFlags, key: string): PageFlags | null => {
      const update = pageShortcut({ key }, state);
      if (update === null) return null;
      const top = pageForFlags(state);
      // "home" closes the page on top (App's closePage).
      if (update === "home")
        return top === null ? state : { ...state, [flagForPage(top)]: false };
      return {
        ...state,
        ...update,
        tasksOpen:
          typeof update.tasksOpen === "function"
            ? update.tasksOpen(state.tasksOpen)
            : (update.tasksOpen ?? state.tasksOpen),
      };
    };
    // Start from the office and from each page alone (the bar buttons, a
    // link, a saved spot); close the top layer as Escape does.
    const seen = new Map<string, PageFlags>();
    const queue: PageFlags[] = [
      office,
      ...PAGES.map((page) => ({ ...office, [flagForPage(page)]: true })),
    ];
    while (queue.length > 0) {
      const state = queue.shift()!;
      const id = JSON.stringify(state);
      if (seen.has(id)) continue;
      seen.set(id, state);
      const top = pageForFlags(state);
      if (top !== null) queue.push({ ...state, [flagForPage(top)]: false });
      for (const key of Object.keys(KEY_PAGE)) {
        const next = apply(state, key);
        if (next === null) continue;
        queue.push(next);
        const opened =
          pageShortcut({ key }, state) !== "home" &&
          !(key === "t" && state.tasksOpen);
        if (opened) expect(pageForFlags(next)).toBe(KEY_PAGE[key]);
      }
    }
    // Stacks two and three deep were reached, so the walk covered layering.
    const depths = [...seen.values()].map((state) => {
      let depth = 0;
      for (let s = state; pageForFlags(s) !== null; depth++)
        s = { ...s, [flagForPage(pageForFlags(s)!)]: false };
      return depth;
    });
    expect(Math.max(...depths)).toBe(3);
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
