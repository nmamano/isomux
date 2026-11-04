// A member's permission pack on the Integrations page (task a1d3fa5f): a tab
// whose area the pack lacks is hidden, never shown with every action failing,
// and the page reads nothing from an area the pack lacks. The server refuses
// those routes either way (task 134b8f77).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { INTEGRATIONS_TABS } = await import("../../shared/office-links.ts");
const { notifyConnectionsChanged, notifyManagedEnvSaved } =
  await import("../connections-events.ts");
const { MEMBER, OWNER, USERS, open, page, selectedTab, stateFor } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

type Areas = Record<string, "read" | "write">;
type View = Awaited<ReturnType<typeof open>>;

// Every area at write, except the ones named.
function allBut(...missing: string[]): Areas {
  const areas: Areas = {};
  for (const area of [
    "office",
    "rooms",
    "agents",
    "agentManagement",
    "logs",
    "files",
    "tasks",
    "asks",
    "membersChat",
    "memory",
    "skills",
    "schedules",
    "apps",
    "webhooks",
    "pager",
    "environment",
    "voice",
  ])
    if (!missing.includes(area)) areas[area] = "write";
  return areas;
}

// Stephen's own full record, as the self channel sends it; with a pack when
// areas are given.
function stephen(areas?: Areas) {
  return {
    id: "u2",
    name: "Stephen",
    role: "member",
    createdAt: 0,
    avatarColor: "#888",
    avatarVariant: 0,
    allowedRooms: [],
    notifRooms: [],
    hidden: [],
    order: [],
    memberPrompt: "",
    language: "en",
    ...(areas ? { pack: { areas, agentCeiling: "office" } } : {}),
  };
}

function memberWith(areas?: Areas) {
  const users = new Map(USERS);
  users.set("stephen", stephen(areas));
  return stateFor("Stephen", "u2", "member", users);
}

function tabsShown(view: View): string[] {
  return [...view.container.querySelectorAll("[data-integrations-tab]")].map(
    (row) => row.getAttribute("data-integrations-tab")!,
  );
}

// The routes on the environment area that the page or its tabs read.
const ENVIRONMENT =
  /^\/api\/(me\/provider-accounts|me\/integration-changes|whatsapp|(users\/[^/]+|office)\/(secrets|mcp|env|providers))/;

function environmentCalls(): string[] {
  return fake.calls
    .map((call) => call.path)
    .filter((path) => ENVIRONMENT.test(path));
}

const ENVIRONMENT_TABS = [
  "providers",
  "mcp",
  "secrets",
  "variables",
  "messaging",
];

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Stephen", owner: false }, [
    "Ricky",
    "Stephen",
  ]).install();
});

describe("a pack without environment", () => {
  it("hides the environment tabs, opens on a tab it has, and reads nothing from environment", async () => {
    const view = await open(memberWith(allBut("environment")));
    expect(tabsShown(view)).toEqual(
      INTEGRATIONS_TABS.filter(
        (id) => id !== "github" && !ENVIRONMENT_TABS.includes(id),
      ),
    );
    expect(selectedTab(view)).toBe(tabsShown(view)[0]!);
    expect(view.container.querySelector("[data-secrets-path]")).toBeNull();
    expect(environmentCalls()).toEqual([]);
  });

  // A remembered tab, a door that names a tab and an MCP sign-in that came
  // back all name a tab the pack lacks; each opens on one it has.
  it.each([
    ["remembered", {}],
    ["requested", { request: { tab: "secrets" } }],
    ["signed-in MCP", { request: { signIn: "ok" } }],
  ] as const)(
    "a %s environment tab opens on a tab the pack has",
    async (_, props) => {
      window.localStorage.setItem("isomux-integrations-tab", "secrets");
      const view = await open(memberWith(allBut("environment")), props);
      expect(tabsShown(view)).not.toContain("secrets");
      expect(tabsShown(view)).not.toContain("mcp");
      expect(selectedTab(view)).toBe(tabsShown(view)[0]!);
      expect(view.container.querySelector("[data-secrets-path]")).toBeNull();
      expect(environmentCalls()).toEqual([]);
    },
  );

  // The member's record arrives after the page opened on a tab the pack
  // lacks, or an owner takes the area away while the page is open.
  it("leaves an open environment tab when the pack arrives, and keeps the remembered tab", async () => {
    const view = await open(MEMBER, { request: { tab: "secrets" } });
    expect(selectedTab(view)).toBe("secrets");
    expect(view.container.querySelector("[data-secrets-path]")).not.toBeNull();

    await act(async () => {
      view.rerender(page(memberWith(allBut("environment"))));
    });
    expect(tabsShown(view)).not.toContain("secrets");
    expect(selectedTab(view)).toBe(tabsShown(view)[0]!);
    expect(view.container.querySelector("[data-secrets-path]")).toBeNull();
    expect(window.localStorage.getItem("isomux-integrations-tab")).toBe(
      "secrets",
    );

    // A saved variable or a changed connection reads nothing more.
    const before = environmentCalls().length;
    expect(before).toBeGreaterThan(0);
    await act(async () => {
      notifyManagedEnvSaved();
      notifyConnectionsChanged();
    });
    expect(environmentCalls()).toHaveLength(before);
  });
});

describe("a pack without one area", () => {
  it.each([
    ["voice", "voice"],
    ["pager", "pager"],
    ["agents", "browser"],
  ])("without %s hides the %s tab only", async (area, hidden) => {
    const view = await open(memberWith(allBut(area)));
    expect(tabsShown(view)).toEqual(
      INTEGRATIONS_TABS.filter((id) => id !== "github" && id !== hidden),
    );
  });

  it("an empty pack keeps API tokens", async () => {
    const view = await open(memberWith({}));
    expect(tabsShown(view)).toEqual(["api-tokens"]);
    expect(selectedTab(view)).toBe("api-tokens");
    expect(environmentCalls()).toEqual([]);
  });

  it("environment at read shows the environment tabs and reads them", async () => {
    const view = await open(memberWith({ environment: "read" }));
    expect(tabsShown(view)).toEqual(
      INTEGRATIONS_TABS.filter(
        (id) => id === "api-tokens" || ENVIRONMENT_TABS.includes(id),
      ),
    );
    expect(
      fake.requests("GET", "/api/me/provider-accounts").length,
    ).toBeGreaterThan(0);
  });
});

describe("no pack", () => {
  it("a member without a pack sees every tab but GitHub", async () => {
    const view = await open(memberWith());
    expect(tabsShown(view)).toEqual(
      INTEGRATIONS_TABS.filter((id) => id !== "github"),
    );
  });

  it("an owner sees every tab", async () => {
    const view = await open(OWNER);
    expect(tabsShown(view)).toEqual([...INTEGRATIONS_TABS]);
  });
});
