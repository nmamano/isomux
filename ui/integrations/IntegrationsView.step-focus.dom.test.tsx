// A step ask's link (task c71cb60f) opens an Integrations tab with the step
// as its focus: the tab shows the setting the step is done in, for the
// member the step is for, and marks it (data-step-focus, one element). The
// GitHub tab's case is in IntegrationsView.github.dom.test.tsx, the link
// from the ask card in ui/App.inbox-ask-links.dom.test.tsx.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake, server } =
  await import("../test-support/integrations-fake.ts");
const { OWNER, card, open, page, pick, selectedTab } =
  await import("../test-support/integrations-page-fixture.ts");
type StepAskRequest = import("../../shared/types.ts").StepAskRequest;
afterAll(() => setApiShim(null));

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  // Ricky (u1) owns the office; Stephen (u2) is a member.
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
});

type View = Awaited<ReturnType<typeof open>>;

const TAB: Record<StepAskRequest["kind"], string> = {
  "provider-sign-in": "providers",
  "mcp-sign-in": "mcp",
  "browser-pairing": "browser",
  "github-link": "github",
};

async function openOn(focus: StepAskRequest): Promise<View> {
  const view = await open(OWNER, { request: { tab: TAB[focus.kind], focus } });
  await act(async () => {});
  return view;
}

// The one marked element, after checking there is exactly one and that it
// names the step's kind.
function marked(view: View, kind: string): HTMLElement {
  const all = [
    ...view.container.querySelectorAll<HTMLElement>("[data-step-focus]"),
  ];
  expect(all.map((el) => el.getAttribute("data-step-focus"))).toEqual([kind]);
  return all[0];
}

// Whether the mark is the element `selector` finds, or holds it.
const marks = (mark: HTMLElement, selector: string) =>
  mark.matches(selector) || mark.querySelector(selector) !== null;

it("a provider sign-in marks that provider's card in the step's scope", async () => {
  const office = await openOn({
    kind: "provider-sign-in",
    provider: "codex",
    scope: "office",
  });
  expect(selectedTab(office)).toBe("providers");
  const officeMark = marked(office, "provider-sign-in");
  expect(card(office, "office").contains(officeMark)).toBe(true);
  expect(marks(officeMark, '[data-sign-in-scope="office"]')).toBe(true);
  expect(officeMark.textContent).toContain("Codex");
  expect(officeMark.textContent).not.toContain("Claude");
  office.unmount();

  const personal = await openOn({
    kind: "provider-sign-in",
    provider: "claude",
    scope: "personal",
  });
  const personalMark = marked(personal, "provider-sign-in");
  expect(card(personal, "personal").contains(personalMark)).toBe(true);
  expect(personalMark.textContent).toContain("Claude");
  expect(personalMark.textContent).not.toContain("Codex");
});

it("a personal provider sign-in switches the personal card back to the viewer's own", async () => {
  const view = await open(OWNER, { request: { tab: "providers" } });
  await pick(view, "Stephen");
  expect(card(view, "personal").getAttribute("data-integrations-member")).toBe(
    "Stephen",
  );
  await act(async () => {
    view.rerender(
      page(OWNER, {
        request: {
          tab: "providers",
          focus: {
            kind: "provider-sign-in",
            provider: "claude",
            scope: "personal",
          },
        },
      }),
    );
  });
  await act(async () => {});
  // The viewer's own card names no member.
  expect(
    card(view, "personal").getAttribute("data-integrations-member"),
  ).toBeNull();
  expect(
    card(view, "personal").contains(marked(view, "provider-sign-in")),
  ).toBe(true);
});

it("an MCP sign-in marks that server's row, in the scope and for the member it names", async () => {
  const oauth = { clientId: null, signedIn: false };
  fake.scope("ricky").servers = [
    server("docs", { oauth }),
    server("mail", { oauth }),
  ];
  fake.scope("stephen").servers = [server("mail", { oauth })];
  fake.scope("office").servers = [server("wiki", { oauth })];

  const own = await openOn({
    kind: "mcp-sign-in",
    name: "mail",
    scope: "personal",
    ownerUserId: "u1",
  });
  expect(selectedTab(own)).toBe("mcp");
  const ownMark = marked(own, "mcp-sign-in");
  expect(card(own, "personal").contains(ownMark)).toBe(true);
  expect(marks(ownMark, '[data-mcp-server-name="mail"]')).toBe(true);
  expect(marks(ownMark, '[data-mcp-server-name="docs"]')).toBe(false);
  own.unmount();

  // A member's server, for an owner named on the step: the personal card
  // shows that member.
  const members = await openOn({
    kind: "mcp-sign-in",
    name: "mail",
    scope: "personal",
    ownerUserId: "u2",
  });
  expect(
    card(members, "personal").getAttribute("data-integrations-member"),
  ).toBe("Stephen");
  expect(
    marks(marked(members, "mcp-sign-in"), '[data-mcp-server-name="mail"]'),
  ).toBe(true);
  members.unmount();

  const office = await openOn({
    kind: "mcp-sign-in",
    name: "wiki",
    scope: "office",
  });
  const officeMark = marked(office, "mcp-sign-in");
  expect(card(office, "office").contains(officeMark)).toBe(true);
  expect(marks(officeMark, '[data-mcp-server-name="wiki"]')).toBe(true);
});

it("a browser pairing marks the Chrome pairing pane", async () => {
  const view = await openOn({ kind: "browser-pairing" });
  expect(selectedTab(view)).toBe("browser");
  const mark = marked(view, "browser-pairing");
  const pane = view.container.querySelector('[data-testid="browser-settings"]');
  expect(pane).not.toBeNull();
  expect(mark === pane || mark.contains(pane) || pane!.contains(mark)).toBe(
    true,
  );
});

it("a tab opened with no step marks nothing", async () => {
  const view = await open(OWNER, { request: { tab: "mcp" } });
  await act(async () => {});
  expect(view.container.querySelector("[data-step-focus]")).toBeNull();
});
