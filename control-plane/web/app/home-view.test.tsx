import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { webTranslatorFor } from "../lib/i18n/rich";
import { Dashboard, HomeView, SignedOut } from "./home-view";

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
  expect(shell).toContain('<a href="/signin">');
  expect(renderToStaticMarkup(<HomeView />)).toBe(shell);
});

test("a deleted office is listed as ended, apart from ready and not ready", () => {
  const card = {
    instanceId: "i-1",
    officeName: "acme",
    hostname: "acme.isomux.app",
    ready: false,
    ended: false,
  };
  const chip = (office: typeof card) =>
    /<span data-state="([^"]+)">([^<]*)<\/span>/
      .exec(
        renderToStaticMarkup(
          <Dashboard
            i18n={webTranslatorFor("en")}
            email={null}
            offices={[office]}
          />,
        ),
      )
      ?.slice(1);
  const ended = chip({ ...card, ended: true });
  const ready = chip({ ...card, ready: true });
  const notReady = chip(card);
  expect(ended?.[0]).toBe("ended");
  expect(ended?.[1]).toBeTruthy();
  expect(ended?.[1]).not.toBe(ready?.[1]);
  expect(ended?.[1]).not.toBe(notReady?.[1]);
});
