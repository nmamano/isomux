// A member's permission pack on the Integrations page (task a1d3fa5f): a tab
// whose area the pack lacks is hidden, never shown with every action failing,
// and the page reads nothing from an area the pack lacks. A tab whose area
// the pack gives at read shows what it reads without the controls that change
// it (task 119d0b47). The server refuses those routes either way (task
// 134b8f77).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const fakeBuilders = await import("../test-support/integrations-fake.ts");
const { IntegrationsFake } = fakeBuilders;
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

// A pack that gives a tab's area at read only (task 119d0b47): the tab shows
// what it reads, and no control whose route needs the area at write. Each
// case opens the same seeded tab at write first, so a control's absence at
// read is the level's, not a missing fixture's.
describe("a pack that gives an area at read only", () => {
  const { secret, server } = fakeBuilders;

  function at(area: string, level: "read" | "write") {
    return memberWith(
      level === "write" ? allBut() : { ...allBut(), [area]: "read" },
    );
  }

  function present(view: View, selectors: readonly string[]): string[] {
    return selectors.filter(
      (selector) => view.container.querySelector(selector) !== null,
    );
  }

  // Opens `id` at both levels, with `over` on the store state; `check` runs
  // on each view.
  async function bothLevels(
    area: string,
    id: string,
    check: (view: View, level: "read" | "write") => void,
    over: Record<string, unknown> = {},
  ) {
    for (const level of ["write", "read"] as const) {
      const state = { ...at(area, level), ...over } as typeof MEMBER;
      const view = await open(state, { request: { tab: id } });
      await act(async () => {});
      expect(selectedTab(view)).toBe(id);
      check(view, level);
      view.unmount();
    }
  }

  it.each([
    [
      "secrets",
      () => {
        // A GitHub token has a Test.
        fake
          .scope("Stephen")
          .secrets.push(secret("GH_TOKEN", { hosts: ["api.github.com"] }));
      },
      [
        "[data-integrations-add]",
        "[data-secret-replace]",
        "[data-secret-remove]",
        "[data-connection-test]",
      ],
      ["[data-secret-show]"],
    ],
    [
      "mcp",
      () => {
        fake
          .scope("Stephen")
          .servers.push(
            server("linear"),
            server("notion", { oauth: { clientId: null, signedIn: false } }),
          );
      },
      [
        "[data-integrations-add]",
        "[data-mcp-edit]",
        "[data-mcp-remove]",
        "[data-mcp-sign-in]",
        "[data-connection-test]",
      ],
      ['[data-mcp-server-name="linear"]', '[data-mcp-server-name="notion"]'],
    ],
    [
      "variables",
      () => {
        fake.scope("Stephen").values = { GREETING: "hello" };
      },
      ["[data-integrations-add]", "[data-env-edit]", "[data-env-remove]"],
      ["[data-env-show]"],
    ],
    [
      "providers",
      // The page reads the accounts from the store.
      () => ({
        providerAccounts: [
          {
            provider: "claude",
            scope: "personal",
            accountStatus: "connected",
            loginStatus: "idle",
            canBrowserLogin: true,
          },
          {
            provider: "codex",
            scope: "personal",
            accountStatus: "not_connected",
            loginStatus: "idle",
            canBrowserLogin: true,
          },
        ],
      }),
      [
        "[data-providers-refresh]",
        "[data-provider-sign-out]",
        "[data-sign-in-test]",
        "[data-start-provider-login]",
      ],
      ['[data-sign-in-scope="personal"]', "[data-provider-account-state]"],
    ],
  ] as const)(
    "the %s tab at environment read has no write control",
    async (id, seed, writes, reads) => {
      const over: Record<string, unknown> = seed() ?? {};
      await bothLevels(
        "environment",
        id,
        (view, level) => {
          expect(present(view, reads)).toEqual([...reads]);
          expect(present(view, writes)).toEqual(
            level === "write" ? [...writes] : [],
          );
        },
        over,
      );
    },
  );

  // An MCP server's status reads the secrets of its scope (environment
  // read), so a read-only pack sees the same status as a write one.
  it("an MCP server's status at environment read is the one at write", async () => {
    const scope = fake.scope("Stephen");
    scope.secrets.push(
      secret("LINEAR_TOKEN", { hosts: ["linear.example.com"] }),
    );
    scope.servers.push(server("linear", { secret: "LINEAR_TOKEN" }));
    // The row without its buttons: the name, the detail and the status.
    const rowText: string[] = [];
    await bothLevels("environment", "mcp", (view) => {
      const row = view.container
        .querySelector('[data-mcp-server-name="linear"]')!
        .cloneNode(true) as HTMLElement;
      for (const button of row.querySelectorAll("button")) button.remove();
      rowText.push(row.textContent!);
    });
    expect(rowText[1]).toBe(rowText[0]!);
  });

  // Each WhatsApp state has its own write controls; Cancel unlinks a link
  // the server says is under way, wherever it started.
  it.each([
    [
      { state: "unlinked" },
      ["[data-whatsapp-link]", "[data-whatsapp-code-form]"],
    ],
    [
      { state: "dead", reason: "replaced" },
      [
        "[data-whatsapp-link]",
        "[data-whatsapp-unlink]",
        "[data-whatsapp-code-form]",
      ],
    ],
    [
      { state: "linking", method: "code", pairingCode: "ABCD1234" },
      ["[data-whatsapp-cancel]"],
    ],
    [
      { state: "linked", phone: "447700900123", linkedAt: 1, connected: true },
      [
        "[data-whatsapp-unlink]",
        '[data-whatsapp-row-delete="r1"]',
        "[data-integrations-add]",
      ],
    ],
  ] as const)(
    "the Messaging tab at environment read, WhatsApp $state, has no write control",
    async (status, writes) => {
      const route = {
        id: "r1",
        chat: "447700900124@s.whatsapp.net",
        group: false,
        name: "Ana",
        agentId: "a1",
        createdAt: 1,
      };
      setApiShim(async (method, path, body) => {
        if (method === "GET" && path === "/api/whatsapp") return status;
        if (method === "GET" && path === "/api/whatsapp/routes") return [route];
        return fake.handle(method, path, body);
      });
      const reads = [`[data-whatsapp-state="${status.state}"]`];
      if (status.state === "linked") reads.push('[data-whatsapp-row="r1"]');
      // The section shows the store's status, which the socket keeps.
      await bothLevels(
        "environment",
        "messaging",
        (view, level) => {
          expect(present(view, reads)).toEqual(reads);
          expect(present(view, writes)).toEqual(
            level === "write" ? [...writes] : [],
          );
        },
        { whatsappStatus: status },
      );
    },
  );

  it("the Pager tab at pager read shows the saved settings in disabled fields and has no write control", async () => {
    fake.pagers.set("stephen", {
      webhookUrlMasked: "https://discord.com/api/webhooks/…1234",
      discordUserId: "4242",
      repeatMinutes: 5,
    });
    const writes = [
      '[data-testid="pager-save"]',
      '[data-testid="pager-test"]',
      '[data-testid="pager-webhook-remove"]',
    ];
    const fields = [
      '[data-testid="pager-webhook"]',
      '[data-testid="pager-user-id"]',
      '[data-testid="pager-repeat"]',
    ];
    await bothLevels("pager", "pager", (view, level) => {
      expect(
        present(view, ['[data-testid="pager-webhook-current"]', ...fields]),
      ).toEqual(['[data-testid="pager-webhook-current"]', ...fields]);
      expect(
        view.container.querySelector<HTMLInputElement>(
          '[data-testid="pager-user-id"]',
        )!.value,
      ).toBe("4242");
      expect(
        fields.filter(
          (selector) =>
            view.container.querySelector<HTMLInputElement>(selector)!.disabled,
        ),
      ).toEqual(level === "write" ? [] : fields);
      expect(present(view, writes)).toEqual(level === "write" ? writes : []);
    });
  });

  it("the Browser tab at agents read lists the browsers and the update download, with no pairing, setup, unpair or reload", async () => {
    // Two out-of-date browsers: one has the new files (Reload), one needs
    // the download.
    const browser = (id: string, reloadable: boolean) => ({
      id,
      name: `Chrome ${id}`,
      pairedAt: 1,
      online: true,
      outdated: true,
      reloadable,
      agentTabs: null,
    });
    setApiShim(async (method, path, body) => {
      if (method === "GET" && path === "/api/me/browser")
        return {
          paired: true,
          online: true,
          member: { id: "u2", name: "Stephen" },
          version: "9.9.9",
          browsers: [browser("b1", true), browser("b2", false)],
        };
      return fake.handle(method, path, body);
    });
    const writes = [
      '[data-testid="browser-pair"]',
      '[data-testid="browser-name"]',
      '[data-testid="browser-office"]',
      '[data-testid="browser-revoke"]',
      '[data-testid="browser-reload"]',
      // The setup steps, which end in pairing.
      '[data-testid="browser-extensions-copy"]',
    ];
    const notice: number[] = [];
    await bothLevels("agents", "browser", (view, level) => {
      expect(
        view.container.querySelectorAll('[data-testid="browser-row"]'),
      ).toHaveLength(2);
      const update = view.container.querySelector(
        '[data-testid="browser-update"]',
      )!;
      expect(
        update.querySelector('a[href="/api/me/browser/extension.zip"]'),
      ).not.toBeNull();
      notice.push(update.children.length);
      expect(present(view, writes)).toEqual(level === "write" ? writes : []);
    });
    // The update notice at read loses the Reload row and the line under it.
    expect(notice[1]).toBe(notice[0]! - 2);
  });
});
