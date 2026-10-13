// The member picker (Nil, 2026-10-13: "it seems easy to forget that you're
// looking at someone else's and mess it up"): it starts on You, another
// member's card says whose it is, an answer for the member left behind never
// shows under the next one, and every form names the member.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { IntegrationsView } = await import("./IntegrationsView.tsx");
const { IntegrationsFake, secret, server } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

const USERS = new Map(
  [
    ["ricky", { id: "u1", name: "Ricky", role: "owner" }],
    ["stephen", { id: "u2", name: "Stephen", role: "member" }],
    ["lena", { id: "u3", name: "Lena", role: "member" }],
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

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
    "Lena",
  ]).install();
});

async function open(
  state = OWNER,
  props: Record<string, unknown> = {},
): Promise<ReturnType<typeof render>> {
  const view = render(
    createElement(
      StateCtx.Provider,
      { value: state },
      createElement(IntegrationsView, { onClose: () => {}, ...props }),
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

function personal(view: ReturnType<typeof render>) {
  return view.container.querySelector<HTMLElement>(
    '[data-integrations-card="personal"]',
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

describe("the member picker", () => {
  it("starts on You, and another member's card names them, turns orange and offers the way back", async () => {
    const view = await open();
    const card = personal(view);
    const picker = card.querySelector<HTMLSelectElement>(
      "[data-integrations-picker]",
    )!;
    expect(picker.value).toBe("");
    expect(card.getAttribute("data-integrations-member")).toBeNull();
    expect(card.querySelector("[data-back-to-yours]")).toBeNull();
    // Every other member, never the owner twice.
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      t("common.you"),
      "Lena",
      "Stephen",
    ]);

    await pick(view, "Stephen");
    const other = personal(view);
    expect(other.getAttribute("data-integrations-member")).toBe("Stephen");
    expect(other.querySelector("[data-card-title]")!.textContent).toContain(
      t("integrations.memberTitle", { member: "Stephen" }),
    );
    expect(other.getAttribute("style")).toContain("var(--orange-border)");
    expect(other.textContent).toContain(
      t("integrations.personalWhoMember", { member: "Stephen" }),
    );

    await act(async () => {
      fireEvent.click(other.querySelector("[data-back-to-yours]")!);
    });
    expect(personal(view).getAttribute("data-integrations-member")).toBeNull();
    expect(
      personal(view).querySelector<HTMLSelectElement>(
        "[data-integrations-picker]",
      )!.value,
    ).toBe("");
  });

  it("keeps the member across tabs, and a new page starts on You", async () => {
    const view = await open();
    await pick(view, "Stephen");
    await tab(view, "secrets");
    expect(personal(view).getAttribute("data-integrations-member")).toBe(
      "Stephen",
    );
    view.unmount();
    const again = await open();
    expect(personal(again).getAttribute("data-integrations-member")).toBeNull();
  });

  it("opens once on the member the profile link names, and tells App it took the request", async () => {
    let handled = 0;
    const view = await open(OWNER, {
      request: { member: "Lena" },
      onRequestHandled: () => handled++,
    });
    expect(personal(view).getAttribute("data-integrations-member")).toBe(
      "Lena",
    );
    expect(handled).toBe(1);
  });

  it("ignores a member request for a member viewer, and for the owner's own name", async () => {
    const member = await open(stateFor("Stephen", "u2", "member"), {
      request: { member: "Lena" },
    });
    expect(
      personal(member).getAttribute("data-integrations-member"),
    ).toBeNull();
    expect(
      member.container.querySelector("[data-integrations-picker]"),
    ).toBeNull();
    member.unmount();
    const self = await open(OWNER, { request: { member: "Ricky" } });
    expect(personal(self).getAttribute("data-integrations-member")).toBeNull();
  });

  it("never shows an answer for the member left behind under the next one", async () => {
    fake.scope("Stephen").secrets.push(secret("STEPHEN_ONLY"));
    fake.scope("Lena").secrets.push(secret("LENA_ONLY"));
    const view = await open();
    await tab(view, "secrets");
    const release = fake.hold("/api/users/Stephen/secrets");
    await pick(view, "Stephen");
    expect(fake.requests("GET", "/api/users/Stephen/secrets")).toHaveLength(1);
    await pick(view, "Lena");
    await act(async () => {
      release();
    });
    const card = personal(view);
    expect(card.getAttribute("data-integrations-member")).toBe("Lena");
    expect(card.querySelector('[data-secret-name="LENA_ONLY"]')).not.toBeNull();
    expect(card.querySelector('[data-secret-name="STEPHEN_ONLY"]')).toBeNull();
    expect(view.container.textContent).not.toContain("STEPHEN_ONLY");
  });

  it("drops a revealed value and an open form when the picker moves", async () => {
    fake.scope("Ricky").secrets.push(secret("MINE", { value: "my-own-value" }));
    fake.scope("Stephen").secrets.push(secret("MINE"));
    const view = await open();
    await tab(view, "secrets");
    const card = personal(view);
    await act(async () => {
      fireEvent.click(card.querySelector("[data-secret-show]")!);
    });
    expect(card.textContent).toContain("my-own-value");
    await act(async () => {
      fireEvent.click(card.querySelector("[data-integrations-add]")!);
    });
    expect(card.querySelector("[data-secret-add]")).not.toBeNull();

    await pick(view, "Stephen");
    expect(view.container.textContent).not.toContain("my-own-value");
    expect(personal(view).querySelector("[data-secret-add]")).toBeNull();
    // Back on You, the value is masked again until Show.
    await pick(view, "");
    expect(view.container.textContent).not.toContain("my-own-value");
  });
});

// One test per form kind: each heading names the member when the card is
// another member's (Nil, 2026-10-13: "Remove Stephen's GH_TOKEN?").
describe("every form on another member's card names them", () => {
  async function onStephen(tabId: string) {
    fake.scope("Stephen").secrets.push(secret("GH_TOKEN"));
    fake.scope("Stephen").servers.push(server("linear"));
    fake.scope("Stephen").values = { TZ: "UTC" };
    const view = await open();
    await tab(view, tabId);
    await pick(view, "Stephen");
    return personal(view);
  }

  async function heading(card: HTMLElement, button: string) {
    await act(async () => {
      fireEvent.click(card.querySelector(button)!);
    });
    return card.querySelector("[data-panel-heading]")!.textContent;
  }

  const cases: [string, string, string, string][] = [
    [
      "secrets",
      "[data-integrations-add]",
      "integrations.secrets.addHeading.member",
      "",
    ],
    [
      "secrets",
      "[data-secret-replace]",
      "integrations.secrets.replaceHeading.member",
      "GH_TOKEN",
    ],
    [
      "secrets",
      "[data-secret-edit]",
      "integrations.dialog.edit.member",
      "GH_TOKEN",
    ],
    [
      "secrets",
      "[data-secret-remove]",
      "integrations.dialog.remove.member",
      "GH_TOKEN",
    ],
    [
      "mcp",
      "[data-integrations-add]",
      "integrations.mcp.addHeading.member",
      "",
    ],
    ["mcp", "[data-mcp-edit]", "integrations.dialog.edit.member", "linear"],
    ["mcp", "[data-mcp-remove]", "integrations.dialog.remove.member", "linear"],
    [
      "variables",
      "[data-integrations-add]",
      "integrations.variables.addHeading.member",
      "",
    ],
    [
      "variables",
      "[data-env-edit]",
      "integrations.variables.replaceHeading.member",
      "TZ",
    ],
    [
      "variables",
      "[data-env-remove]",
      "integrations.dialog.remove.member",
      "TZ",
    ],
  ];

  for (const [tabId, button, key, name] of cases)
    it(`${tabId}: ${key}`, async () => {
      const card = await onStephen(tabId);
      const text = await heading(card, button);
      const expected = (
        t as unknown as (k: string, p: Record<string, string>) => string
      )(key, { member: "Stephen", name });
      expect(text).toBe(expected);
      expect(text).toContain("Stephen");
    });

  it("secrets: a new stand-in names the member", async () => {
    const card = await onStephen("secrets");
    await act(async () => {
      fireEvent.click(card.querySelector("[data-secret-edit]")!);
    });
    await act(async () => {
      fireEvent.click(card.querySelector("[data-secret-reissue]")!);
    });
    expect(card.querySelector("[data-panel-heading]")!.textContent).toBe(
      t("integrations.secrets.reissueHeading.member", {
        member: "Stephen",
        name: "GH_TOKEN",
      }),
    );
  });

  it("names no member on your own card or the office card", async () => {
    fake.scope("Ricky").secrets.push(secret("GH_TOKEN"));
    fake.scope("office").secrets.push(secret("FLY_API_TOKEN"));
    const view = await open();
    await tab(view, "secrets");
    const mine = personal(view);
    await act(async () => {
      fireEvent.click(mine.querySelector("[data-secret-remove]")!);
    });
    expect(mine.querySelector("[data-panel-heading]")!.textContent).toBe(
      t("integrations.dialog.remove.self", { name: "GH_TOKEN" }),
    );
    const office = view.container.querySelector<HTMLElement>(
      '[data-integrations-card="office"]',
    )!;
    await act(async () => {
      fireEvent.click(within(office).getByText(t("integrations.remove")));
    });
    expect(office.querySelector("[data-panel-heading]")!.textContent).toBe(
      t("integrations.dialog.remove.office", { name: "FLY_API_TOKEN" }),
    );
  });
});
