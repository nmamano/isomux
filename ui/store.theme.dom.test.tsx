// The office theme for a member who never picked one, and for one who did.
// A pick is the `isomux-theme` localStorage key; with no key the theme follows
// the OS: a light preference gets "light", anything else the dark default.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { cleanup, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ThemeProvider } = await import("./store.tsx");
const { DEFAULT_THEME_ID, THEMES, emitThemesCss, getThemeById } =
  await import("./themes.ts");

const PICK_KEY = "isomux-theme";

function stubOsPreference(light: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: light && query === "(prefers-color-scheme: light)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function mountedTheme(): string | null {
  render(createElement(ThemeProvider, null, null));
  return document.documentElement.getAttribute("data-theme");
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => cleanup());

describe("the office theme default", () => {
  it("is Dracula, a dark theme", () => {
    expect(DEFAULT_THEME_ID).toBe("dracula");
    expect(getThemeById(DEFAULT_THEME_ID).mode).toBe("dark");
  });

  it("applies to a member with no pick on a dark OS, and is not stored", () => {
    stubOsPreference(false);
    expect(mountedTheme()).toBe(DEFAULT_THEME_ID);
    expect(window.localStorage.getItem(PICK_KEY)).toBeNull();
  });

  it("leaves an OS light preference on the light theme", () => {
    stubOsPreference(true);
    expect(mountedTheme()).toBe("light");
  });

  it("keeps every stored pick, including the old dark default", () => {
    stubOsPreference(false);
    for (const theme of THEMES) {
      cleanup();
      window.localStorage.setItem(PICK_KEY, theme.id);
      expect({ pick: theme.id, shown: mountedTheme() }).toEqual({
        pick: theme.id,
        shown: theme.id,
      });
      expect(window.localStorage.getItem(PICK_KEY)).toBe(theme.id);
    }
  });
});

describe("emitThemesCss", () => {
  // :root and [data-theme=...] tie on specificity, so the :root block must come
  // before every other theme or it overrides a member's pick.
  it("emits the default first as :root, and no other block on :root", () => {
    const css = emitThemesCss();
    const selectors = [...css.matchAll(/^ {2}(\S[^{\n]*)\{$/gm)].map((m) =>
      m[1].trim(),
    );
    expect(selectors[0]).toBe(`:root, [data-theme="${DEFAULT_THEME_ID}"]`);
    expect(selectors.filter((s) => s.includes(":root"))).toHaveLength(1);
    expect(selectors).toHaveLength(THEMES.length);
  });
});
