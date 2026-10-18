// The ask card's "open" label in every language: each page and tab reads
// with its own label, and Chinese takes no space around a Chinese label.

import { describe, it, expect } from "bun:test";
import { SUPPORTED_LANGUAGES } from "../shared/languages.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import { OFFICE_LINK_PATHS, officeLinkFor } from "../shared/office-links.ts";
import { officeLinkLabel } from "./office-link.tsx";

describe("the open label", () => {
  for (const { code } of SUPPORTED_LANGUAGES)
    it(`names each page and tab in ${code}`, () => {
      const { t } = translatorFor(code);
      for (const path of OFFICE_LINK_PATHS) {
        const link = officeLinkFor(path)!;
        const label = t(officeLinkLabel(link));
        const text = t("asks.openLink", { page: label });
        expect(text).toContain(label);
        expect(text).not.toBe(label);
        // The words around the label, for a script without spaces.
        if (code === "zh")
          expect(`${path} ${/\s/.test(text.replace(label, ""))}`).toBe(
            `${path} false`,
          );
      }
    });

  it("labels a tab with the tab, not the page", () => {
    const { t } = translatorFor("zh");
    const browser = t(
      officeLinkLabel({ page: "integrations", tab: "browser" }),
    );
    // A Chinese label, so the no-space case is the one exercised.
    expect(/[一-鿿]/.test(browser)).toBe(true);
    expect(browser).not.toBe(t(officeLinkLabel({ page: "integrations" })));
  });
});
