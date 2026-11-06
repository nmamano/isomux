// The tabs with more options to add end with a way to ask for one: a line
// and a button that opens a new issue on the Isomux GitHub repo (Nil,
// 2026-11-05; task b6306e0e).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { OWNER, open, selectedTab, tab } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");
const NEW_ISSUE = "https://github.com/nmamano/isomux/issues/new";

beforeEach(() => {
  new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
});

// Each tab with the request line: a card that stands for its content, and
// the line's hint.
const CASES = [
  [
    "providers",
    '[data-integrations-card="office"]',
    "integrations.requestSupport.providers",
  ],
  [
    "voice",
    '[data-integrations-card="personal"]',
    "integrations.requestSupport.voice",
  ],
  [
    "pager",
    '[data-integrations-card="personal"]',
    "integrations.requestSupport.pager",
  ],
  [
    "messaging",
    '[data-integrations-card="discord"]',
    "integrations.requestSupport.messaging",
  ],
] as const;

describe("a request for another option", () => {
  for (const [id, content, hint] of CASES) {
    it(`ends the ${id} tab, with a filled button that opens a new Isomux issue in a new tab`, async () => {
      const view = await open(OWNER, { request: { tab: id } });
      expect(selectedTab(view)).toBe(id);
      const line = view.container.querySelector(
        `[data-request-support="${id}"]`,
      );
      expect(line).not.toBeNull();
      // Last in the tab body, after the tab's own content.
      const body = line!.parentElement!;
      expect(body.querySelector(content)).not.toBeNull();
      expect(body.lastElementChild!.getAttribute("data-request-support")).toBe(
        id,
      );
      expect(line!.textContent).toContain(t(hint));

      const link = line!.querySelector<HTMLAnchorElement>(
        "a[data-request-support-link]",
      )!;
      expect(link.textContent).toBe(t("integrations.requestSupport.button"));
      expect(link.getAttribute("href")).toBe(NEW_ISSUE);
      expect(link.getAttribute("target")).toBe("_blank");
      // The issues page gets no handle on the office tab.
      const rel = (link.getAttribute("rel") ?? "").split(/\s+/);
      expect(rel.includes("noopener") || rel.includes("noreferrer")).toBe(true);
      // A button, not link text (AGENTS.md, UI rules): it has a padding and
      // does not clear its background. happy-dom drops the color-mix() fill
      // of a secondary button, so the fill itself is checked in a browser.
      expect(["", "0px"]).not.toContain(link.style.padding);
      expect(link.style.background).not.toMatch(/^(none|transparent)\b/);
    });
  }

  it("is on no other tab", async () => {
    const view = await open();
    const others = [
      ...view.container.querySelectorAll("[data-integrations-tab]"),
    ]
      .map((row) => row.getAttribute("data-integrations-tab")!)
      .filter((id) => !CASES.some(([shown]) => shown === id));
    // The owner sees every other tab.
    expect(others.sort()).toEqual([
      "api-tokens",
      "browser",
      "github",
      "mcp",
      "secrets",
      "variables",
    ]);
    for (const id of others) {
      await tab(view, id);
      expect(selectedTab(view)).toBe(id);
      expect(view.container.querySelector("[data-request-support]")).toBeNull();
    }
  });
});
