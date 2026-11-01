// The office pages an ask can link to: one per page and one per Integrations
// tab, matched exactly. Pager and API tokens are Integrations tabs since task
// db800fd8, so an ask can link to them.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  AGENT_LINK_PREFIX,
  ASK_LINK_PREFIX,
  INTEGRATIONS_TABS,
  OFFICE_LINK_PATHS,
  OFFICE_PAGES,
  askLinkFor,
  officeLinkFor,
  pathForPage,
} from "./office-links.ts";

describe("office links", () => {
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

// One ask as a link (task 84aadfab): /inbox/asks/<askId> opens the Asks tab
// with that ask pinned. Whether the ask exists is not checked, as for an
// agent.
describe("the one-ask link", () => {
  it("reads /inbox/asks/<id> as the Asks page on that ask", () => {
    for (const id of ["a6b624d3", "1234567890abcdef", "f".repeat(64)])
      expect(askLinkFor(`${ASK_LINK_PREFIX}${id}`)).toEqual({
        page: "asks",
        askId: id,
      });
    // The list itself stays the plain page link.
    expect(askLinkFor("/inbox/asks")).toEqual({ page: "asks" });
  });

  it("refuses an id that is not lowercase hex of 8 to 64, exactly", () => {
    for (const path of [
      "/inbox/asks/",
      "/inbox/asks/a6b624d",
      `/inbox/asks/${"f".repeat(65)}`,
      "/inbox/asks/A6B624D3",
      "/inbox/asks/a6b624dg",
      "/inbox/asks/a6b624d3/",
      "/inbox/asks/a6b624d3/x",
      "/inbox/asks//a6b624d3",
      "/inbox/asks/a6b624d3?x=1",
      "/inbox/Asks/a6b624d3",
      "/asks/a6b624d3",
      "/inbox/pages/a6b624d3",
    ])
      expect(`${path} ${JSON.stringify(askLinkFor(path))}`).toBe(
        `${path} null`,
      );
  });
});

// The asks reference lists the accepted values for agents to read before
// their first call. Every backticked office path in it is one of them, and
// none is missing, so a new page or tab cannot leave the page stale. It also
// shows the agent form.
describe("the asks reference", () => {
  it("lists exactly the office links, the agent form and the ask form", () => {
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
    const agentForms = listed.filter((path) =>
      path.startsWith(AGENT_LINK_PREFIX),
    );
    const askForms = listed.filter((path) => path.startsWith(ASK_LINK_PREFIX));
    expect(agentForms.length).toBe(1);
    expect(askLinkFor(agentForms[0])).not.toBeNull();
    // The one-ask form, with a placeholder for the id (task 84aadfab).
    expect(askForms.length).toBe(1);
    expect(
      listed
        .filter(
          (path) => !agentForms.includes(path) && !askForms.includes(path),
        )
        .sort(),
    ).toEqual([...OFFICE_LINK_PATHS].sort());
  });
});
