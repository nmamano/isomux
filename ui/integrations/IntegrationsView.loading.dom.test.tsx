// While the page reads its data, the lines that the answers bring hold their
// space, so a card does not grow when they arrive (task 0eab60fd): the
// sign-in buttons, a member's included. OpenCode's rows are in
// IntegrationsView.opencode.dom.test.tsx.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { blockShape } from "../test-support/held-shape.ts";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { act, render } = await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { DispatchCtx, reducer } = await import("../store.tsx");
const { MEMBER, OWNER, card, open, page, pick } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
});

const held = (root: Element) => root.querySelectorAll("[data-reserved]");

it("holds the sign-in buttons until the reads answer", async () => {
  const releases = [
    fake.hold("/api/me/provider-accounts"),
    fake.hold("/api/me/connections"),
    fake.hold("/api/office/settings"),
  ];
  const view = await open();
  // Codex and Claude, on the office card and on yours, say they are checking.
  expect(
    view.container.querySelectorAll('[data-provider-account-state="checking"]'),
  ).toHaveLength(4);
  const yours = card(view, "personal");
  // Codex and Claude sign-ins.
  const signIns = [...held(yours)].filter(
    (node) => !node.closest('[data-provider-block="opencode"]'),
  );
  expect(signIns).toHaveLength(2);
  for (const node of held(yours)) {
    expect(node.getAttribute("aria-hidden")).toBe("true");
    expect(node.hasAttribute("inert")).toBe(true);
  }
  // Held sign-in rows offer nothing to start.
  expect(
    view.container.querySelector("[data-start-provider-login]"),
  ).toBeNull();

  await act(async () => {
    for (const release of releases) release();
  });
  expect(held(view.container)).toHaveLength(0);
});

it("holds a member's sign-in buttons and OpenCode row until their reads answer", async () => {
  fake.memberAccounts.set("stephen", [
    {
      provider: "claude",
      scope: "personal",
      accountStatus: "not_connected",
      loginStatus: "idle",
      canBrowserLogin: true,
    },
  ]);
  const view = await open();
  const releases = [
    fake.hold("/api/users/Stephen/provider-accounts"),
    fake.hold("/api/users/Stephen/env/names"),
  ];
  await pick(view, "Stephen");
  const theirs = () => card(view, "personal");
  const checking = () =>
    theirs().querySelectorAll('[data-provider-account-state="checking"]')
      .length;
  expect(checking()).toBe(2);
  expect(theirs().querySelectorAll("[data-start-provider-login]").length).toBe(
    0,
  );
  // OpenCode's row holds its key state.
  const openCode = () =>
    theirs().querySelector('[data-member-provider="opencode"]')!;
  expect(held(openCode()).length).toBeGreaterThan(0);

  await act(async () => {
    for (const release of releases) release();
  });
  expect(checking()).toBe(0);
  expect(theirs().querySelectorAll("[data-start-provider-login]").length).toBe(
    1,
  );
  expect(held(theirs()).length).toBe(0);
});

// Task da868bd9: the held sign-in rows have the shape of the rows the answer
// brings, so the card keeps its height. A device holds the rows its last load
// drew; a first visit holds a signed-in office and a viewer not signed in.
// The page runs on a live store here: the cards read their accounts from it.
describe("the held sign-in rows", () => {
  type Wire = import("../../shared/types.ts").ProviderAccountWire;
  type Row = "signOut" | "signIn" | "none";
  type Rows = Record<"office" | "personal", Record<"codex" | "claude", Row>>;

  // The wire that makes the live card draw `row`.
  const wire = (
    provider: "codex" | "claude",
    scope: "office" | "personal",
    row: Row,
  ): Wire => ({
    provider,
    scope,
    accountStatus: row === "signOut" ? "connected" : "not_connected",
    loginStatus: "idle",
    canBrowserLogin: row !== "none",
  });
  const wires = (rows: Rows): Wire[] =>
    (["office", "personal"] as const).flatMap((scope) =>
      (["codex", "claude"] as const).map((provider) =>
        wire(provider, scope, rows[scope][provider]),
      ),
    );

  function Page({ state }: { state: typeof OWNER }) {
    const [live, dispatch] = useReducer(reducer, state);
    return createElement(DispatchCtx.Provider, { value: dispatch }, page(live));
  }
  async function mount(state: typeof OWNER) {
    const view = render(createElement(Page, { state }));
    await act(async () => {});
    return view;
  }

  // The block shape of each sign-in block, with each Reserved wrapper
  // replaced by its children (a wrapper adds no box of its own).
  function shapes(root: Element): Record<string, string> {
    const copy = root.cloneNode(true) as Element;
    for (const wrapper of [
      ...copy.querySelectorAll("[data-reserved]"),
    ].reverse())
      wrapper.replaceWith(...wrapper.childNodes);
    const out: Record<string, string> = {};
    for (const which of ["office", "personal"] as const)
      for (const block of copy.querySelectorAll(
        `[data-integrations-card="${which}"] [data-provider-card]`,
      ))
        out[`${which} ${block.getAttribute("data-provider-card")}`] =
          blockShape(block);
    return out;
  }
  // Held sign-in content that does not paint: an empty box the answer fills.
  const unpainted = (root: Element) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        "[data-provider-card] [data-reserved]",
      ),
    ].filter((node) => node.style.visibility === "hidden").length;

  // Loads the page held, then answers: the shapes and the paint check.
  async function heldThenLoaded(state: typeof OWNER) {
    const release = fake.hold("/api/me/provider-accounts");
    const view = await mount(state);
    const checking = view.container.querySelectorAll(
      '[data-provider-account-state="checking"]',
    ).length;
    const held = shapes(view.container);
    const hidden = unpainted(view.container);
    await act(async () => release());
    const result = {
      checking,
      hidden,
      held,
      loaded: shapes(view.container),
    };
    view.unmount();
    return result;
  }

  // Every row differs from the first-visit guess.
  const UNUSUAL: Rows = {
    office: { codex: "signIn", claude: "none" },
    personal: { codex: "signOut", claude: "none" },
  };

  it("a device holds the rows its last load drew, and they paint", async () => {
    window.localStorage.clear();
    fake.accounts = wires(UNUSUAL);
    // The load that remembers.
    (await mount(OWNER)).unmount();
    const run = await heldThenLoaded(OWNER);
    expect({
      checking: run.checking,
      hidden: run.hidden,
      held: run.held,
    }).toEqual({ checking: 4, hidden: 0, held: run.loaded });
  });

  it("a first visit holds a signed-in office and a viewer not signed in", async () => {
    window.localStorage.clear();
    fake.accounts = wires({
      office: { codex: "signOut", claude: "signOut" },
      personal: { codex: "signIn", claude: "signIn" },
    });
    const run = await heldThenLoaded(OWNER);
    expect({
      checking: run.checking,
      hidden: run.hidden,
      held: run.held,
    }).toEqual({ checking: 4, hidden: 0, held: run.loaded });
  });

  // A device where an owner last saw the office not signed in (Sign in rows
  // held), then a member who cannot sign the office in opens the page: the
  // member's card draws no Sign in row, so it holds none.
  it("a member on a device where an owner last saw Sign in rows holds no office Sign in row", async () => {
    window.localStorage.clear();
    const rows: Rows = {
      office: { codex: "signIn", claude: "signIn" },
      personal: { codex: "signIn", claude: "signIn" },
    };
    fake.accounts = wires(rows);
    // The owner's load that remembers.
    (await mount(OWNER)).unmount();
    fake = new IntegrationsFake({ username: "Stephen", owner: false }, [
      "Ricky",
      "Stephen",
    ]).install();
    fake.accounts = wires(rows);
    const run = await heldThenLoaded(MEMBER);
    expect({
      checking: run.checking,
      hidden: run.hidden,
      held: run.held,
    }).toEqual({ checking: 4, hidden: 0, held: run.loaded });
  });

  // The office card of a viewer who cannot change it draws its sign-in and
  // sign-out controls disabled (task 3d517a07): its held space has the same
  // shape.
  for (const office of ["signOut", "signIn"] as const)
    it(`a member who cannot change the office sign-ins: held office rows match, office ${office === "signOut" ? "signed in" : "not signed in"}`, async () => {
      fake = new IntegrationsFake({ username: "Stephen", owner: false }, [
        "Ricky",
        "Stephen",
      ]).install();
      window.localStorage.clear();
      fake.accounts = wires({
        office: { codex: office, claude: office },
        personal: { codex: "signIn", claude: "signIn" },
      });
      // Not signed in is not the first-visit guess: a load remembers it.
      if (office === "signIn") (await mount(MEMBER)).unmount();
      const run = await heldThenLoaded(MEMBER);
      expect({
        checking: run.checking,
        hidden: run.hidden,
        held: run.held,
      }).toEqual({ checking: 4, hidden: 0, held: run.loaded });
    });
});
