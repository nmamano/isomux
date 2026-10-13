// The Integrations page reads in the language the signed-in user is on: the
// tabs, the intros, the cards, and the provider sign-in card inside it.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFor,
} from "../test-support/i18n.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { IntegrationsView } = await import("./IntegrationsView.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
afterAll(() => setApiShim(null));

new IntegrationsFake({ username: "Tester", owner: true }, ["Tester"]).install();

const ANCHOR = {
  tabProviders: translationsFor("integrations.tabs.providers"),
  tabMcp: translationsFor("integrations.tabs.mcp"),
  ownerIntro: translationsFor("integrations.ownerIntro"),
  office: translationsFor("integrations.office"),
  status: translationsFor("settings.signIn.status"),
  honesty: translationsFor("integrations.secretsHonesty"),
  addSecret: translationsFor("integrations.secrets.add"),
} as const;

const page = (language: "ca" | "es" | null) =>
  onLanguage(language, createElement(IntegrationsView, { onClose: () => {} }), {
    hasReceivedInitialState: true,
  });

const shows = (view: ReturnType<typeof render>, text: string) =>
  expect(
    view.queryAllByText(text, { exact: false }).length,
    text,
  ).toBeGreaterThan(0);

describe("the Integrations page", () => {
  it("resolves each anchor in every shipped language", () => {
    for (const [name, anchor] of Object.entries(ANCHOR)) {
      expect(Object.keys(anchor).sort(), name).toEqual(
        [...SHIPPED_LANGUAGE_CODES].sort(),
      );
      expect(new Set(Object.values(anchor)).size, name).toBe(
        SHIPPED_LANGUAGE_CODES.length,
      );
    }
  });

  it("reads Catalan on ca, then Spanish, then English", async () => {
    const view = render(page("ca"));
    await act(async () => {});
    for (const anchor of [
      ANCHOR.tabProviders,
      ANCHOR.ownerIntro,
      ANCHOR.office,
      ANCHOR.status,
    ])
      shows(view, anchor.ca);
    await act(async () => {
      fireEvent.click(
        view.container.querySelector('[data-integrations-tab="secrets"]')!,
      );
    });
    shows(view, ANCHOR.honesty.ca);
    shows(view, ANCHOR.addSecret.ca);
    expect(view.queryByText(ANCHOR.tabMcp.en)).toBeNull();

    view.rerender(page("es"));
    await act(async () => {});
    shows(view, ANCHOR.honesty.es);
    shows(view, ANCHOR.tabMcp.es);

    view.rerender(page(null));
    await act(async () => {});
    shows(view, ANCHOR.honesty.en);
    shows(view, ANCHOR.addSecret.en);
  });
});
