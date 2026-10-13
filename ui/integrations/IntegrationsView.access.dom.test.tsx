// Who sees and changes what on the Integrations page (Nil and the Lead,
// 2026-10-13): Show for a secret's own member and for owners on office
// secrets only; members read the office's items as names; an owner sees a
// member's provider status and variable names, never their values, and never
// the caller's own Claude data under the member's name.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { IntegrationsView } = await import("./IntegrationsView.tsx");
const { IntegrationsFake, EMPTY_CONNECTIONS, secret, server } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

const USERS = new Map(
  [
    ["ricky", { id: "u1", name: "Ricky", role: "owner" }],
    ["stephen", { id: "u2", name: "Stephen", role: "member" }],
  ].map(([key, user]) => [
    key,
    {
      createdAt: 0,
      avatarColor: "#888",
      avatarVariant: 0,
      ...(user as object),
    },
  ]),
);

function stateFor(username: string, userId: string, role: string) {
  return {
    ...initialState,
    hasReceivedInitialState: true,
    sessionContext: { username, userId, role },
    users: USERS,
  } as unknown as typeof initialState;
}

const OWNER = stateFor("Ricky", "u1", "owner");
const MEMBER = stateFor("Stephen", "u2", "member");

let fake: InstanceType<typeof IntegrationsFake>;
function serve(viewer: { username: string; owner: boolean }) {
  fake = new IntegrationsFake(viewer, ["Ricky", "Stephen"]).install();
  fake
    .scope("office")
    .secrets.push(
      secret("FLY_API_TOKEN", { value: "office-value", note: "deploys" }),
    );
  fake.scope("office").servers.push(server("linear", { note: "issues" }));
  fake.scope("office").values = { TZ: "UTC" };
  fake.scope("office").notes = { TZ: "office time" };
  fake
    .scope("Ricky")
    .secrets.push(secret("RICKY_KEY", { value: "ricky-value" }));
  fake
    .scope("Stephen")
    .secrets.push(secret("STEPHEN_KEY", { value: "stephen-value" }));
  fake.scope("Stephen").values = { STEPHEN_VAR: "stephen-var-value" };
  fake.scope("Stephen").notes = { STEPHEN_VAR: "for builds" };
}

async function open(state: typeof initialState) {
  const view = render(
    createElement(
      StateCtx.Provider,
      { value: state },
      createElement(IntegrationsView, { onClose: () => {} }),
    ),
  );
  await act(async () => {});
  return view;
}

async function tab(view: ReturnType<typeof render>, id: string) {
  await act(async () => {
    fireEvent.click(
      view.container.querySelector(`[data-integrations-tab="${id}"]`)!,
    );
  });
}

function card(view: ReturnType<typeof render>, which: "office" | "personal") {
  return view.container.querySelector<HTMLElement>(
    `[data-integrations-card="${which}"]`,
  )!;
}

async function pick(view: ReturnType<typeof render>, member: string) {
  await act(async () => {
    fireEvent.change(
      view.container.querySelector("[data-integrations-picker]")!,
      { target: { value: member } },
    );
  });
}

describe("Show", () => {
  beforeEach(() => serve({ username: "Ricky", owner: true }));

  it("reveals your own value, and Hide drops it", async () => {
    const view = await open(OWNER);
    await tab(view, "secrets");
    const mine = card(view, "personal");
    const show = mine.querySelector<HTMLButtonElement>("[data-secret-show]")!;
    expect(mine.textContent).not.toContain("ricky-value");
    await act(async () => {
      fireEvent.click(show);
    });
    expect(
      fake.requests("GET", "/api/users/Ricky/secrets/RICKY_KEY/value"),
    ).toHaveLength(1);
    expect(mine.textContent).toContain("ricky-value");
    expect(show.textContent).toBe(t("integrations.hide"));
    await act(async () => {
      fireEvent.click(show);
    });
    expect(mine.textContent).not.toContain("ricky-value");
  });

  it("reveals an office value to an owner", async () => {
    const view = await open(OWNER);
    await tab(view, "secrets");
    const office = card(view, "office");
    await act(async () => {
      fireEvent.click(office.querySelector("[data-secret-show]")!);
    });
    expect(office.textContent).toContain("office-value");
  });

  it("gives an owner no Show on a member's secret, and never asks for its value", async () => {
    const view = await open(OWNER);
    await tab(view, "secrets");
    await pick(view, "Stephen");
    const theirs = card(view, "personal");
    expect(
      theirs.querySelector('[data-secret-name="STEPHEN_KEY"]'),
    ).not.toBeNull();
    expect(theirs.querySelector("[data-secret-show]")).toBeNull();
    // Replace and Remove stay: an owner manages the secret without reading it.
    expect(theirs.querySelector("[data-secret-replace]")).not.toBeNull();
    expect(theirs.querySelector("[data-secret-remove]")).not.toBeNull();
    expect(fake.requests("GET", /\/value$/)).toHaveLength(0);
  });

  it("says a failed read in fixed words, never with the answer", async () => {
    const view = await open(OWNER);
    await tab(view, "secrets");
    fake.scope("Ricky").secrets.length = 0;
    const mine = card(view, "personal");
    await act(async () => {
      fireEvent.click(mine.querySelector("[data-secret-show]")!);
    });
    expect(mine.textContent).toContain(t("integrations.secrets.showFailed"));
    expect(mine.textContent).not.toContain("Not found");
  });
});

describe("a member's view of the office", () => {
  beforeEach(() => serve({ username: "Stephen", owner: false }));

  for (const [tabId, row, name] of [
    ["secrets", "data-secret-name", "FLY_API_TOKEN"],
    ["mcp", "data-mcp-server-name", "linear"],
    ["variables", "data-env-entry", "TZ"],
  ] as const)
    it(`${tabId}: names and notes, no control and no value`, async () => {
      const view = await open(MEMBER);
      await tab(view, tabId);
      const office = card(view, "office");
      const item = office.querySelector(`[${row}="${name}"]`);
      expect(item).not.toBeNull();
      expect(office.querySelector("[data-connection-note]")).not.toBeNull();
      expect(office.querySelectorAll("button")).toHaveLength(0);
      expect(office.querySelector("[data-integrations-add]")).toBeNull();
      expect(office.textContent).not.toContain("office-value");
      expect(office.textContent).not.toContain("UTC");
      expect(office.textContent).toContain(t("integrations.officeWhoMember"));
    });

  it("asks for no office value and no owner-only route", async () => {
    const view = await open(MEMBER);
    for (const id of ["mcp", "secrets", "variables", "providers"])
      await tab(view, id);
    expect(fake.requests("GET", "/api/office/env")).toHaveLength(0);
    expect(fake.requests("GET", /\/value$/)).toHaveLength(0);
    expect(fake.requests("GET", /^\/api\/users\/Ricky\//)).toHaveLength(0);
    expect(
      view.container.querySelector("[data-integrations-picker]"),
    ).toBeNull();
    expect(view.container.querySelector("[data-member-usage-card]")).toBeNull();
  });

  it("still edits their own items", async () => {
    const view = await open(MEMBER);
    await tab(view, "secrets");
    const mine = card(view, "personal");
    expect(
      mine.querySelector('[data-secret-name="STEPHEN_KEY"]'),
    ).not.toBeNull();
    expect(mine.querySelector("[data-secret-show]")).not.toBeNull();
    expect(mine.querySelector("[data-integrations-add]")).not.toBeNull();
  });
});

describe("an owner on another member's card", () => {
  beforeEach(() => serve({ username: "Ricky", owner: true }));

  it("shows the member's provider status with no sign-in control", async () => {
    fake.officeSettings = { memberUsageCap: false, version: "1" };
    const view = await open(OWNER);
    // The owner's own card has the sign-in cards.
    expect(
      card(view, "personal").querySelector("[data-provider-card]"),
    ).not.toBeNull();
    expect(
      card(view, "office").querySelector("[data-member-usage-card]"),
    ).not.toBeNull();
    await pick(view, "Stephen");
    const theirs = card(view, "personal");
    expect(theirs.querySelector("[data-provider-card]")).toBeNull();
    expect(
      theirs.querySelector('[data-member-provider="claude"]')!.textContent,
    ).toContain(t("settings.signIn.connected"));
    expect(
      theirs.querySelector('[data-member-provider="codex"]')!.textContent,
    ).toContain(t("integrations.providers.noPersonal"));
    expect(theirs.querySelectorAll("button")).toHaveLength(1);
    expect(theirs.querySelector("[data-back-to-yours]")).not.toBeNull();
    expect(fake.requests("GET", "/api/users/Stephen/env/names")).toHaveLength(
      1,
    );
  });

  it("shows none of the caller's Claude lists under the member", async () => {
    fake.connections = {
      ...EMPTY_CONNECTIONS,
      signIns: [
        { scope: "personal", engine: "claude", account: "ricky@example.com" },
      ],
      claudeConnectors: [
        { scope: "personal", seenAt: 1, names: ["Gmail"], statuses: [] },
      ],
      engineMcpServers: [
        {
          engine: "claude",
          name: "local-tool",
          source: "user",
          folder: null,
          status: "connected",
        },
      ],
    };
    const view = await open(OWNER);
    await tab(view, "mcp");
    const mine = card(view, "personal");
    expect(
      mine.querySelector('[data-claude-connectors="personal"]'),
    ).not.toBeNull();
    expect(mine.querySelector("[data-engine-mcp-servers]")).not.toBeNull();
    await pick(view, "Stephen");
    const theirs = card(view, "personal");
    expect(theirs.querySelector("[data-claude-connectors]")).toBeNull();
    expect(theirs.querySelector("[data-engine-mcp-servers]")).toBeNull();
    expect(theirs.textContent).not.toContain("Gmail");
    expect(theirs.textContent).not.toContain("local-tool");
    expect(theirs.textContent).not.toContain("ricky@example.com");
  });

  it("changes a member's variables one at a time and never reads or writes their values", async () => {
    const view = await open(OWNER);
    await tab(view, "variables");
    await pick(view, "Stephen");
    const theirs = card(view, "personal");
    const row = theirs.querySelector('[data-env-entry="STEPHEN_VAR"]')!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("for builds");
    expect(theirs.textContent).not.toContain("stephen-var-value");
    expect(row.querySelector("[data-env-show]")).toBeNull();

    // Replace: the value field starts empty.
    await act(async () => {
      fireEvent.click(row.querySelector("[data-env-edit]")!);
    });
    const value = theirs.querySelector<HTMLInputElement>(
      "[data-env-value-input]",
    )!;
    expect(value.value).toBe("");
    await act(async () => {
      fireEvent.change(value, { target: { value: "new-value" } });
    });
    await act(async () => {
      fireEvent.click(theirs.querySelector("[data-panel-save]")!);
    });

    // Add.
    await act(async () => {
      fireEvent.click(theirs.querySelector("[data-integrations-add]")!);
    });
    await act(async () => {
      fireEvent.change(theirs.querySelector("[data-env-name]")!, {
        target: { value: "REGION" },
      });
      fireEvent.change(theirs.querySelector("[data-env-value-input]")!, {
        target: { value: "eu" },
      });
    });
    await act(async () => {
      fireEvent.click(theirs.querySelector("[data-panel-save]")!);
    });

    // Remove.
    await act(async () => {
      fireEvent.click(
        theirs.querySelector('[data-env-entry="REGION"] [data-env-remove]')!,
      );
    });
    await act(async () => {
      fireEvent.click(theirs.querySelector("[data-panel-save]")!);
    });

    expect(
      fake.requests("PUT", "/api/users/Stephen/env/STEPHEN_VAR"),
    ).toHaveLength(1);
    expect(fake.requests("PUT", "/api/users/Stephen/env/REGION")).toHaveLength(
      1,
    );
    expect(
      fake.requests("DELETE", "/api/users/Stephen/env/REGION"),
    ).toHaveLength(1);
    // The two requests that would read or overwrite every value.
    expect(fake.requests("GET", "/api/users/Stephen/env")).toHaveLength(0);
    expect(fake.requests("PUT", "/api/users/Stephen/env")).toHaveLength(0);
    expect(fake.scope("Stephen").values).toEqual({ STEPHEN_VAR: "new-value" });
  });
});
