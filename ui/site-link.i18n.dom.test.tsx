// S10 of the office i18n loop (internal-docs/i18n-loop.md): the neon isomux
// sign on the office wall sends a boss to the public site in the language they
// read the office in.
//
// The sign is drawn twice, once for each theme mode (`.neon-sign-on` for dark,
// `.neon-sign-off` for light), and each copy carries its own click target. Both
// are exercised here: the two handlers are separate code, so a fix applied to
// one of them is not evidence about the other. The selectors name the sign's
// own class, not the first `data-no-pan` element in the scene, which belongs to
// whatever the wall happens to draw first.
//
// The expected URLs are literal (ruling 14): read back through landingUrl they
// would agree with any mapping, including a wrong one.

import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { Walls } = await import("./office/Floor.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");

type Language = "en" | "es" | "ca";

const originalOpen = window.open;
afterEach(() => {
  window.open = originalOpen;
});

/** Click one of the two signs on a wall rendered for `language`. */
function openedBy(language: Language, sign: "on" | "off"): string[] {
  const opened: string[] = [];
  window.open = (url?: string | URL) => {
    opened.push(String(url));
    return null;
  };

  const view = render(onLanguage(language, <Walls />));
  const target = view.container.querySelector(
    `.neon-sign-${sign} rect[data-no-pan]`,
  );
  expect(target).not.toBeNull();
  act(() => {
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  view.unmount();
  return opened;
}

describe("the office's link to the public site", () => {
  it("opens the English landing for a boss on English", () => {
    expect(openedBy("en", "on")).toEqual(["https://isomux.com"]);
    expect(openedBy("en", "off")).toEqual(["https://isomux.com"]);
  });

  it("opens the Spanish landing for a boss on Spanish", () => {
    expect(openedBy("es", "on")).toEqual(["https://isomux.com/es"]);
    expect(openedBy("es", "off")).toEqual(["https://isomux.com/es"]);
  });

  it("opens the Catalan landing for a boss on Catalan", () => {
    expect(openedBy("ca", "on")).toEqual(["https://isomux.com/ca"]);
    expect(openedBy("ca", "off")).toEqual(["https://isomux.com/ca"]);
  });
});
