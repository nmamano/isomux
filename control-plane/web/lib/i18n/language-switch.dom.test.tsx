// The storefront's language menu.
//
// It names the document's own language, offers only the others, and a choice
// is saved in the cookie before the page reloads. Before its first reading of
// the document the name is hidden, so a page in another language never shows
// the default's name while it hydrates.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:3999/signin" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { LanguageSwitch } = await import("./language-switch");
const { LANGUAGE_COOKIE, SUPPORTED_LANGUAGES } = await import("./languages");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const codes = SUPPORTED_LANGUAGES.map((option) => option.code);
const labelOf = (code: string) =>
  SUPPORTED_LANGUAGES.find((option) => option.code === code)!.label;
const offered = (root: HTMLElement) =>
  [...root.querySelectorAll(".language-menu button")].map((button) =>
    button.getAttribute("lang"),
  );

test("the server render hides the name it cannot know yet", () => {
  const html = renderToString(createElement(LanguageSwitch));
  const box = document.createElement("div");
  box.innerHTML = html;
  const current = box.querySelector<HTMLElement>(
    '[data-testid="language-current"]',
  )!;
  expect(current.style.visibility).toBe("hidden");
});

test("the menu names the document's language, offers the others, and saves a choice", async () => {
  const other = codes.find((code) => code !== "en")!;
  document.documentElement.lang = other;
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  try {
    await act(async () => {
      root.render(createElement(LanguageSwitch));
    });
    const current = () =>
      box.querySelector<HTMLElement>('[data-testid="language-current"]')!;
    expect(current().style.visibility).toBe("");
    expect(current().textContent).toBe(labelOf(other));
    expect(box.querySelector("summary")!.getAttribute("lang")).toBe(other);
    expect(offered(box).sort()).toEqual(
      codes.filter((code) => code !== other).sort(),
    );

    // DocumentLanguage rewrites the attribute; the menu follows it.
    await act(async () => {
      document.documentElement.lang = "en";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(current().textContent).toBe(labelOf("en"));
    expect(offered(box).sort()).toEqual(
      codes.filter((code) => code !== "en").sort(),
    );

    await act(async () => {
      box
        .querySelector<HTMLButtonElement>(`[data-testid="language-${other}"]`)!
        .click();
    });
    expect(document.cookie).toContain(`${LANGUAGE_COOKIE}=${other}`);
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    reload.mockRestore();
    await act(async () => {
      root.unmount();
    });
    box.remove();
  }
});
