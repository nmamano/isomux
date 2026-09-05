// The rich-text helper of ruling 16 (internal-docs/i18n-loop.md), on plain
// templates and on the real catalogs, rendered to static markup: no DOM, no
// provider. The parser boundaries most likely to fail are exercised on
// purpose - two sibling tags, a placeholder inside a tag, the same tag twice,
// a node value, and a translation that moves a tag around a placeholder.

import { describe, expect, it } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderRich, uiTranslatorFor } from "./i18n.tsx";

const html = (node: ReactNode) =>
  renderToStaticMarkup(createElement("p", null, node));

const code = (chunk: ReactNode) => createElement("code", null, chunk);
const strong = (chunk: ReactNode) => createElement("strong", null, chunk);

describe("renderRich", () => {
  it("leaves a plain template as text", () => {
    expect(html(renderRich("Just words.", {}))).toBe("<p>Just words.</p>");
  });

  it("fills placeholders with strings, numbers and nodes", () => {
    expect(
      html(
        renderRich("{a} and {b} and {c}", {
          a: "one",
          b: 2,
          c: createElement("em", null, "three"),
        }),
      ),
    ).toBe("<p>one and 2 and <em>three</em></p>");
  });

  it("wraps two sibling tags separately, text between them intact", () => {
    expect(
      html(
        renderRich(
          "Run <code>bun install</code>, then <strong>restart</strong>.",
          { code, strong },
        ),
      ),
    ).toBe(
      "<p>Run <code>bun install</code>, then <strong>restart</strong>.</p>",
    );
  });

  it("wraps the same tag more than once", () => {
    expect(
      html(
        renderRich("Dev: <code>a</code>. Service: <code>b</code>.", { code }),
      ),
    ).toBe("<p>Dev: <code>a</code>. Service: <code>b</code>.</p>");
  });

  it("fills a placeholder inside a tag before wrapping it", () => {
    expect(
      html(
        renderRich("Keeping {n} in <code>{dir}</code>.", {
          n: 3,
          dir: "/var/backups",
          code,
        }),
      ),
    ).toBe("<p>Keeping 3 in <code>/var/backups</code>.</p>");
  });

  it("keeps an unknown placeholder as written, like interpolate()", () => {
    expect(html(renderRich("{missing} here", {}))).toBe(
      "<p>{missing} here</p>",
    );
  });

  it("does not nest: an inner tag stays literal text", () => {
    // The catalog test forbids nesting; this pins what the parser does if it
    // ever met one, so a catalog slip fails loudly instead of rendering odd.
    expect(
      html(renderRich("<strong>x <code>y</code></strong>", { strong, code })),
    ).toBe("<p><strong>x &lt;code&gt;y&lt;/code&gt;</strong></p>");
  });
});

describe("uiTranslatorFor", () => {
  it("renders a catalog entry with its tags in the language", () => {
    const en = uiTranslatorFor("en");
    const ca = uiTranslatorFor("ca");
    const parts = { retention: 7, destDir: "/b", code };
    expect(html(en.rich("settings.storage.backupKeeping", parts))).toBe(
      "<p>Keeping 7 in <code>/b</code>.</p>",
    );
    expect(html(ca.rich("settings.storage.backupKeeping", parts))).toBe(
      "<p>Es conserven 7 a <code>/b</code>.</p>",
    );
  });

  it("follows a translation that moves the tag around its placeholder", () => {
    const es = uiTranslatorFor("es");
    expect(
      html(
        es.rich("settings.storage.totalAllState", { total: "1 GB", strong }),
      ),
    ).toBe("<p><strong>1 GB en total</strong>, todo estado de la oficina.</p>");
  });

  it("keeps t() and tn() unchanged and one translator per language", () => {
    const ca = uiTranslatorFor("ca");
    expect(ca.t("common.save")).toBe("Desa");
    expect(ca.tn("settings.update.busy", 1)).toBe(
      "1 agent és a mitja tasca ara mateix.",
    );
    expect(uiTranslatorFor("ca")).toBe(ca);
    expect(uiTranslatorFor("es")).not.toBe(ca);
  });
});
