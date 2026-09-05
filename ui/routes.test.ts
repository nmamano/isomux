import { describe, expect, it } from "bun:test";
import { pageForPath, pathForPage, type Page } from "./routes.ts";

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
