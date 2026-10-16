import { describe, expect, it } from "bun:test";
import {
  pageForPath,
  pathForPage,
  pageForFlags,
  pageUnder,
  flagForPage,
  pageShortcut,
  backRoomShortcut,
  pagerIdForSearch,
  pageForLocation,
  mcpSignInForSearch,
  type Page,
  type PageFlags,
  type PageShortcutInput,
} from "./routes.ts";

// Each page and its canonical path. The cronjobs page is "Automations" on
// screen, and its path says so.
const PATHS: Record<Page, string> = {
  tasks: "/tasks",
  cronjobs: "/automations",
  apps: "/apps",
  skills: "/skills",
  integrations: "/integrations",
  settings: "/settings",
  pager: "/pager",
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

  it("tolerates trailing slashes", () => {
    expect(pageForPath("/tasks/")).toBe("tasks");
    expect(pageForPath("/settings//")).toBe("settings");
  });

  it("accepts /users as the settings page's old name", () => {
    expect(pageForPath("/users")).toBe("settings");
    expect(pageForPath("/users/")).toBe("settings");
  });

  it("accepts /cronjobs as the automations page's old path", () => {
    expect(pageForPath("/cronjobs")).toBe("cronjobs");
    expect(pageForPath("/cronjobs/")).toBe("cronjobs");
  });

  it("is case-sensitive", () => {
    expect(pageForPath("/Tasks")).toBeNull();
    expect(pageForPath("/SETTINGS")).toBeNull();
  });

  it("requires exactly one leading slash", () => {
    // Ruling 3 names four paths AT THE ROOT. A bare segment is not one of them,
    // and neither is a doubled slash, which is a different URL to any browser.
    expect(pageForPath("tasks")).toBeNull();
    expect(pageForPath("//tasks")).toBeNull();
    expect(pageForPath("/tasks")).toBe("tasks");
  });

  it("rejects anything else, including inherited object properties", () => {
    expect(pageForPath("/garbage")).toBeNull();
    expect(pageForPath("/tasks/extra")).toBeNull();
    // Would answer with a function if the table were an object index.
    expect(pageForPath("/constructor")).toBeNull();
    expect(pageForPath("/__proto__")).toBeNull();
    expect(pageForPath("/toString")).toBeNull();
  });
});

describe("the pager link", () => {
  it("reads the page id from the query on any path", () => {
    expect(pagerIdForSearch("?pager=1a2b3c4d")).toBe("1a2b3c4d");
    expect(pageForLocation("/", "?pager=1a2b3c4d")).toBe("pager");
    expect(pageForLocation("/tasks", "?pager=1a2b3c4d")).toBe("pager");
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

  it("round-trips every path it produces", () => {
    for (const page of [...PAGES, null])
      expect(pageForPath(pathForPage(page))).toBe(page);
  });

  it("never produces the accepted-only /users and /cronjobs aliases", () => {
    for (const page of PAGES) {
      expect(pathForPage(page)).not.toBe("/users");
      expect(pathForPage(page)).not.toBe("/cronjobs");
    }
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

  it("leaves the pager for Apps on a", () => {
    const shown = pressPageKey({ ...office, pagerOpen: true }, "a");
    expect(pageForFlags(shown)).toBe("apps");
    expect(shown.pagerOpen).toBe(false);
  });

  it("leaves the Skills page for Apps on a", () => {
    const shown = pressPageKey({ ...office, skillsOpen: true }, "a");
    expect(pageForFlags(shown)).toBe("apps");
    expect(shown.skillsOpen).toBe(false);
  });

  it("leaves the Integrations page for Apps on a", () => {
    const shown = pressPageKey({ ...office, integrationsOpen: true }, "a");
    expect(pageForFlags(shown)).toBe("apps");
    expect(shown.integrationsOpen).toBe(false);
  });

  it("shows Integrations over the pager and under Skills", () => {
    expect(
      pageForFlags({ ...office, integrationsOpen: true, pagerOpen: true }),
    ).toBe("integrations");
    expect(
      pageForFlags({ ...office, integrationsOpen: true, skillsOpen: true }),
    ).toBe("skills");
  });

  it("shows Skills over the pager and under Apps", () => {
    expect(pageForFlags({ ...office, skillsOpen: true, pagerOpen: true })).toBe(
      "skills",
    );
    expect(pageForFlags({ ...office, skillsOpen: true, appsOpen: true })).toBe(
      "apps",
    );
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
    };
    expect(pressPageKey(every, "i")).toEqual({
      ...office,
      integrationsOpen: true,
    });
    // Tasks over Apps: Integrations comes up and Apps closes.
    const shown = pressPageKey(
      { ...office, tasksOpen: true, appsOpen: true },
      "i",
    );
    expect(shown).toEqual({ ...office, integrationsOpen: true });
    expect(pageForFlags(shown)).toBe("integrations");
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
    expect(
      pageForFlags({
        usersOpen: true,
        tasksOpen: true,
        cronjobsOpen: true,
        appsOpen: true,
        skillsOpen: true,
        integrationsOpen: true,
        pagerOpen: true,
      }),
    ).toBe("settings");
  });
});

describe("pageUnder", () => {
  it("names each page by the flag that shows it", () => {
    for (const page of PAGES)
      expect(pageForFlags({ ...office, [flagForPage(page)]: true })).toBe(page);
  });

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

  it("drops only the page on top", () => {
    const all = {
      usersOpen: true,
      tasksOpen: true,
      cronjobsOpen: true,
      appsOpen: true,
      skillsOpen: true,
      integrationsOpen: true,
      pagerOpen: true,
    };
    expect(pageUnder(all)).toBe("tasks");
    expect(pageUnder({ ...all, usersOpen: false })).toBe("cronjobs");
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

  it("does nothing without a back room, while typing, with a modifier, or under a log or page", () => {
    expect(
      backRoomShortcut({ key: "b" }, { ...office, hasBackRoom: false }),
    ).toBeNull();
    expect(backRoomShortcut({ key: "b", isInput: true }, office)).toBeNull();
    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const)
      expect(backRoomShortcut({ key: "b", [mod]: true }, office)).toBeNull();
    expect(
      backRoomShortcut({ key: "b" }, { ...office, covered: true }),
    ).toBeNull();
    expect(backRoomShortcut({ key: "c" }, office)).toBeNull();
  });
});
