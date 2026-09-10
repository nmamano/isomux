import { describe, expect, it } from "bun:test";
import { pageForPath, pathForPage, pageForFlags, pageShortcut, type Page, type PageFlags, type PageShortcutInput } from "./routes.ts";

const PAGES: Page[] = ["tasks", "cronjobs", "apps", "settings"];

describe("pageForPath", () => {
  it("names each page from its canonical path", () => {
    for (const page of PAGES) expect(pageForPath(`/${page}`)).toBe(page);
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

describe("pathForPage", () => {
  it("formats each page and the office", () => {
    expect(pathForPage(null)).toBe("/");
    for (const page of PAGES) expect(pathForPage(page)).toBe(`/${page}`);
  });

  it("round-trips every path it produces", () => {
    for (const page of [...PAGES, null])
      expect(pageForPath(pathForPage(page))).toBe(page);
  });

  it("never produces the accepted-only /users alias", () => {
    for (const page of PAGES) expect(pathForPage(page)).not.toBe("/users");
  });
});


const office: PageFlags = {
  usersOpen: false, tasksOpen: false, cronjobsOpen: false, appsOpen: false,
};

// Apply the returned setters as React does, including functional updates.
function pressPageKey(state: PageFlags, key: string): PageFlags {
  const update = pageShortcut({ key }, state);
  expect(update !== null && update !== "home").toBe(true);
  if (update === null || update === "home") throw new Error("Expected page setters");
  return {
    ...state,
    ...update,
    tasksOpen: typeof update.tasksOpen === "function"
      ? update.tasksOpen(state.tasksOpen) : update.tasksOpen ?? state.tasksOpen,
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
    expect(typeof (update && update !== "home" && update.tasksOpen)).toBe("function");
    if (!update || update === "home" || typeof update.tasksOpen !== "function")
      throw new Error("Expected a functional task update");
    expect(update.tasksOpen(update.tasksOpen(false))).toBe(false);
  });

  it("only closes Apps when Apps is the visible page", () => {
    expect(pageShortcut({ key: "a" }, { ...office, appsOpen: true })).toBe("home");
    for (const covered of [{ tasksOpen: true }, { cronjobsOpen: true }]) {
      const shown = pressPageKey({ ...office, appsOpen: true, ...covered }, "a");
      expect(shown).toEqual({ ...office, appsOpen: true });
      expect(pageForFlags(shown)).toBe("apps");
    }
  });

  it("keeps shortcuts out of inputs, modified keys, and Settings", () => {
    for (const key of ["t", "a", "s"]) {
      for (const guard of ["isInput", "metaKey", "ctrlKey", "altKey"] as const) {
        const input: PageShortcutInput = { key, [guard]: true };
        expect(pageShortcut(input, office)).toBeNull();
      }
      expect(pageShortcut({ key }, { ...office, usersOpen: true })).toBeNull();
    }
    expect(pageShortcut({ key: "x" }, office)).toBeNull();
    expect(pageForFlags({ usersOpen: true, tasksOpen: true, cronjobsOpen: true, appsOpen: true })).toBe("settings");
  });
});
