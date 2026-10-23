// The office pages an ask can link to: one per page and one per Integrations
// tab, matched exactly. Pager and API tokens are Integrations tabs since task
// db800fd8, so an ask can link to them.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  INTEGRATIONS_TABS,
  OFFICE_LINK_PATHS,
  OFFICE_PAGES,
  askLinkFor,
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
        "/inbox/pages",
        "/inbox/asks",
        "/integrations/providers",
        "/integrations/mcp",
        "/integrations/secrets",
        "/integrations/variables",
        "/integrations/voice",
        "/integrations/browser",
        "/integrations/pager",
        "/integrations/api-tokens",
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
      "/pager",
      "/asks",
      "/inbox",
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

// An ask's link (task 9aaec0eb): an office page, or an agent by id, whose
// chat the card's button opens.
describe("ask links", () => {
  it("read every office page path as that page", () => {
    for (const path of OFFICE_LINK_PATHS)
      expect(askLinkFor(path)).toEqual(officeLinkFor(path));
  });

  it("read /agents/<id> as that agent", () => {
    for (const id of ["agent-1778610253631-jfh2", "a1", "x"])
      expect(askLinkFor(`/agents/${id}`)).toEqual({ agentId: id });
  });

  it("refuse an agent form with no id or more than one segment", () => {
    for (const path of [
      "/agents",
      "/agents/",
      "/agents/a/b",
      "/agents/a/",
      "/agents//a",
      "//agents/a",
      "agents/a",
      "/Agents/a",
      "/agent/a",
      "/tasks/agents/a",
      "",
      "/",
      "/users",
    ])
      expect(`${path} ${JSON.stringify(askLinkFor(path))}`).toBe(
        `${path} null`,
      );
    for (const value of [undefined, null, 1, {}, ["/agents/a"]])
      expect(askLinkFor(value)).toBeNull();
  });
});

// The asks reference lists the accepted values for agents to read before
// their first call. Every backticked office path in it is one of them, and
// none is missing, so a new page or tab cannot leave the page stale. It also
// shows the agent form.
describe("the asks reference", () => {
  it("lists exactly the office links, and the agent form", () => {
    const page = readFileSync(
      join(import.meta.dir, "../server/agent-reference/asks.md"),
      "utf-8",
    );
    const listed = [
      ...new Set(
        [...page.matchAll(/`(\/[^`\s]*)`/g)]
          .map((m) => m[1])
          .filter((path) => !path.startsWith("/api/")),
      ),
    ];
    const agentForms = listed.filter(
      (path) => askLinkFor(path) !== null && officeLinkFor(path) === null,
    );
    expect(agentForms.length).toBe(1);
    expect(listed.filter((path) => !agentForms.includes(path)).sort()).toEqual(
      [...OFFICE_LINK_PATHS].sort(),
    );
  });
});
