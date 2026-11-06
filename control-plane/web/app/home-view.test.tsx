import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { webTranslatorFor } from "../lib/i18n/rich";
import { HomeView, SignedOut } from "./home-view";

/**
 * THE FIRST PAINT, which is the whole product of the static shell.
 *
 * `app/page.tsx` is prerendered, so the bytes a CDN holds - and the bytes a
 * signed-out visitor reads, and the bytes a crawler with no JavaScript reads -
 * are whatever `HomeView` renders before its probe has answered.
 * `renderToStaticMarkup` runs no effects, so it renders exactly that moment:
 * the English signed-out landing and nothing else, so no signed-in fragment
 * leaks into the shell.
 */
test("the first paint is the English signed-out landing", () => {
  const shell = renderToStaticMarkup(
    <SignedOut i18n={webTranslatorFor("en")} />,
  );
  expect(shell).toContain('href="/signin"');
  expect(renderToStaticMarkup(<HomeView />)).toBe(shell);
});
