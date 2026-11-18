// The member picker (Nil, 2026-10-13: "it seems easy to forget that you're
// looking at someone else's and mess it up"): every form on another member's
// card names the member. Split from
// ui/integrations/IntegrationsView.picker.dom.test.tsx, which holds the
// picker itself, because the 5 s cap is per file.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake, secret, server } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { card, open, pick, tab } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
    "Lena",
  ]).install();
});

const personal = (view: Awaited<ReturnType<typeof open>>) =>
  card(view, "personal");

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
    const office = card(view, "office");
    await act(async () => {
      fireEvent.click(office.querySelector("[data-secret-remove]")!);
    });
    expect(office.querySelector("[data-panel-heading]")!.textContent).toBe(
      t("integrations.dialog.remove.office", { name: "FLY_API_TOKEN" }),
    );
  });
});
