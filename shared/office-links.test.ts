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
  outsideLinkFor,
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

  // Task 74e8fc07, slice 4: the Pages tab is gone. Its old path stays a
  // link, to the Asks view, so an ask that holds it keeps its button and an
  // agent that still sends it is not refused.
  it("keep /inbox/pages as a link to the Asks view, and no page is the pager", () => {
    expect(OFFICE_PAGES as readonly string[]).not.toContain("pager");
    expect(OFFICE_LINK_PATHS).toContain("/inbox/pages");
    expect(officeLinkFor("/inbox/pages")).toEqual({ page: "asks" });
    expect(pathForPage("asks")).toBe("/inbox/asks");
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
// shows the agent form, and leaves out the old paths kept as aliases.
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
    // An old path the office still accepts (an alias: its link's own path
    // differs, as /inbox/pages opens /inbox/asks, task 74e8fc07) is not
    // taught.
    const canonical = (path: string) => {
      const link = officeLinkFor(path)!;
      return link.page === "integrations" && link.tab
        ? `${pathForPage("integrations")}/${link.tab}`
        : pathForPage(link.page);
    };
    const taught = OFFICE_LINK_PATHS.filter((path) => canonical(path) === path);
    expect(OFFICE_LINK_PATHS.filter((p) => !taught.includes(p))).toEqual([
      "/inbox/pages",
    ]);
    expect(
      listed
        .filter(
          (path) => !agentForms.includes(path) && !askForms.includes(path),
        )
        .sort(),
    ).toEqual([...taught].sort());
  });
});

// An outside page as an ask's link (task 0355f4b7): an https URL, drawn as a
// button that names its site and opens a new tab. The button's address is
// the parse that named the site, so the label names where a click goes.
describe("an outside link", () => {
  it("reads an https URL as its canonical address and the site it names", () => {
    const cases: [string, string, string][] = [
      [
        "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Isomux",
        "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Isomux",
        "github.com",
      ],
      // The parse is the address: case, default port and the root slash.
      ["https://GitHub.COM/a", "https://github.com/a", "github.com"],
      ["https://example.com:443/x", "https://example.com/x", "example.com"],
      ["https://example.com", "https://example.com/", "example.com"],
      // One leading www. goes; nothing else of the host does.
      ["https://www.github.com/x", "https://www.github.com/x", "github.com"],
      [
        "https://www.www.example.com/",
        "https://www.www.example.com/",
        "www.example.com",
      ],
      [
        "https://wwwx.example.com/",
        "https://wwwx.example.com/",
        "wwwx.example.com",
      ],
      [
        "https://docs.www.example.com/",
        "https://docs.www.example.com/",
        "docs.www.example.com",
      ],
      // A port that is not the default stays in the site.
      [
        "https://localhost:8443/x",
        "https://localhost:8443/x",
        "localhost:8443",
      ],
      // A host in another script stays in its ASCII form: a lookalike shows.
      [
        "https://bücher.example/",
        "https://xn--bcher-kva.example/",
        "xn--bcher-kva.example",
      ],
      ["https://аpple.com/", "https://xn--pple-43d.com/", "xn--pple-43d.com"],
    ];
    for (const [value, url, site] of cases)
      expect({ value, link: outsideLinkFor(value) }).toEqual({
        value,
        link: { url, site },
      });
  });

  it("takes up to 2048 characters", () => {
    const prefix = "https://example.com/";
    const longest = prefix + "a".repeat(2048 - prefix.length);
    expect(outsideLinkFor(longest)).toEqual({
      url: longest,
      site: "example.com",
    });
    expect(outsideLinkFor(`${longest}a`)).toBeNull();
  });

  it("refuses anything that is not plainly an https URL", () => {
    for (const value of [
      "",
      "https://",
      "http://github.com",
      "HTTPS://github.com",
      "Https://github.com",
      // The parser repairs these into https://github.com/: refused, so what
      // is stored is what the button opens.
      "https:github.com",
      "https:/github.com",
      "https:\\\\github.com",
      " https://github.com",
      "https://github.com ",
      "https://git hub.com",
      "https://github.com/a b",
      "https://github.com/\n",
      "https://github.com/\t",
      "https://github.com/\r",
      "https://github.com/\u0000",
      "https://github.com/\u007f",
      "https://github.com/\u00a0",
      "https://github.com/\u2028",
      "\nhttps://github.com",
      // Who signs in is not the agent's to fill in.
      "https://user:pass@github.com/",
      "https://user@github.com/",
      "https://:pass@github.com/",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "ftp://example.com/",
      "wss://example.com/",
      "/integrations/secrets",
      "//github.com",
      "github.com",
    ])
      expect(
        `${JSON.stringify(value)} ${JSON.stringify(outsideLinkFor(value))}`,
      ).toBe(`${JSON.stringify(value)} null`);
    for (const value of [
      undefined,
      null,
      1,
      {},
      ["https://github.com"],
      new URL("https://github.com"),
    ])
      expect(outsideLinkFor(value)).toBeNull();
  });

  // The address bar reads an office route through askLinkFor (ui/routes.ts):
  // an outside URL never becomes one.
  it("is never an office link", () => {
    for (const value of [
      "https://github.com/",
      "https://office.example.com/tasks",
    ])
      expect(askLinkFor(value)).toBeNull();
  });
});
