// The office pages an ask can link to: one per page and one per Integrations
// tab, matched exactly.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  INTEGRATIONS_TABS,
  OFFICE_LINK_PATHS,
  OFFICE_PAGES,
  officeLinkFor,
  pathForPage,
} from "./office-links.ts";

describe("office links", () => {
  it("are the canonical path of every page and one path per Integrations tab", () => {
    expect([...OFFICE_LINK_PATHS].sort()).toEqual(
      [
        "/tasks",
        "/automations",
        "/apps",
        "/skills",
        "/integrations",
        "/settings",
        "/pager",
        "/asks",
        "/integrations/providers",
        "/integrations/mcp",
        "/integrations/secrets",
        "/integrations/variables",
        "/integrations/browser",
      ].sort(),
    );
  });

  it("name the page, and the tab for an Integrations tab", () => {
    for (const page of OFFICE_PAGES)
      expect(officeLinkFor(pathForPage(page))).toEqual({ page });
    for (const tab of INTEGRATIONS_TABS)
      expect(officeLinkFor(`/integrations/${tab}`)).toEqual({
        page: "integrations",
        tab,
      });
  });

  it("refuse anything else, exactly", () => {
    for (const path of [
      "",
      "/",
      "tasks",
      "//tasks",
      "/tasks/",
      "/Tasks",
      "/integrations/",
      "/integrations/mcp/",
      "/integrations?tab=mcp",
      "/integrations/mcpx",
      "/integrations/constructor",
      "/users",
      "/cronjobs",
      "constructor",
      "toString",
      "__proto__",
      "https://linear.app",
      "/tasks#x",
    ])
      expect(`${path} ${JSON.stringify(officeLinkFor(path))}`).toBe(
        `${path} null`,
      );
    for (const value of [undefined, null, 1, {}, ["/tasks"]])
      expect(officeLinkFor(value)).toBeNull();
  });
});

// The asks reference lists the accepted values for agents to read before
// their first call. Every backticked office path in it is one of them, and
// none is missing, so a new page or tab cannot leave the page stale.
describe("the asks reference", () => {
  it("lists exactly the office links", () => {
    const page = readFileSync(
      join(import.meta.dir, "../server/agent-reference/asks.md"),
      "utf-8",
    );
    const listed = [...page.matchAll(/`(\/[^`\s]*)`/g)]
      .map((m) => m[1])
      .filter((path) => !path.startsWith("/api/"));
    expect([...new Set(listed)].sort()).toEqual([...OFFICE_LINK_PATHS].sort());
  });
});
