import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeView } from "./home-view";

/**
 * THE FIRST PAINT, which is the whole product of the static shell.
 *
 * `app/page.tsx` is prerendered, so the bytes a CDN holds - and the bytes a
 * signed-out visitor reads, and the bytes a crawler with no JavaScript reads -
 * are whatever `HomeView` renders before its probe has answered.
 * `renderToStaticMarkup` runs no effects, so it renders exactly that moment.
 *
 * The assertion is an EXACT STRING rather than a set of `toContain` checks. The
 * requirement on this slice was that the signed-out first paint keep today's
 * text and links, and the only way a test can hold that line is to fail when any
 * of it moves - including a signed-in fragment leaking into the shell.
 */
test("the first paint is the signed-out landing, unchanged", () => {
  expect(renderToStaticMarkup(<HomeView />)).toBe(
    '<main><h1>Hosted Isomux</h1>' +
      '<p class="lead"><a href="/signin">Sign in</a> to set up an office.</p>' +
      "</main>",
  );
});
