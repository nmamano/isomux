// Tests for the inline-SVG chat rendering path: the sanitizer itself and
// the marked extension that captures <svg>…</svg> spans before marked's
// `breaks: true` can inject <br> into them (a <br> inside an <svg> makes
// the browser force-close the svg, dropping every shape after it).

import { describe, it, expect } from "bun:test";
import { sanitizeSvg } from "./svg-sanitize.ts";
import { renderMarkdown } from "./Markdown.tsx";
import { translatorFor } from "../../shared/i18n/translate.ts";

// The catalog's English, so the copy button's title reads as it always has.
const EN = translatorFor("en");

describe("sanitizeSvg", () => {
  it("keeps shape, structure, and text elements with presentation attrs", () => {
    const out = sanitizeSvg(
      `<svg width="200" height="100" viewBox="0 0 200 100">` +
        `<defs><marker id="m" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0 0L6 3L0 6z" fill="#333"/></marker></defs>` +
        `<g transform="translate(5,5)">` +
        `<rect x="10" y="10" width="80" height="40" fill="#333" rx="4"/>` +
        `<circle cx="50" cy="50" r="10" stroke="red" stroke-width="2"/>` +
        `<line x1="0" y1="0" x2="10" y2="10" marker-end="url(#m)"/>` +
        `<polyline points="0,0 10,10" stroke-dasharray="2 2"/>` +
        `<text x="20" y="35" fill="white" text-anchor="middle">hello</text>` +
        `</g></svg>`,
    );
    for (const frag of [
      `<svg width="200" height="100" viewBox="0 0 200 100">`,
      `<marker id="m" markerWidth="6"`,
      `<path d="M0 0L6 3L0 6z" fill="#333"/>`,
      `<g transform="translate(5,5)">`,
      `<rect x="10" y="10" width="80" height="40" fill="#333" rx="4"/>`,
      `<circle cx="50" cy="50" r="10" stroke="red" stroke-width="2"/>`,
      `marker-end="url(#m)"`,
      `<polyline points="0,0 10,10" stroke-dasharray="2 2"/>`,
      `<text x="20" y="35" fill="white" text-anchor="middle">hello</text>`,
      `</g></svg>`,
    ]) {
      expect(out).toContain(frag);
    }
  });

  it("drops <script> including its payload", () => {
    const out = sanitizeSvg(
      `<svg><script>alert(1)</script><rect width="5" height="5"/></svg>`,
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toContain(`<rect width="5" height="5"/>`);
  });

  it("drops <foreignObject> and everything nested inside it", () => {
    const out = sanitizeSvg(
      `<svg><foreignObject><body><img src="x"><rect width="5"/></body></foreignObject><circle r="3"/></svg>`,
    );
    expect(out).not.toContain("foreignObject");
    expect(out).not.toContain("img");
    // the rect inside the foreignObject subtree is dropped too
    expect(out).not.toContain("rect");
    expect(out).toContain(`<circle r="3"/>`);
  });

  it("drops SMIL animation elements", () => {
    const out = sanitizeSvg(
      `<svg><rect width="5"/><animate attributeName="href" values="javascript:alert(1)"/></svg>`,
    );
    expect(out).not.toContain("animate");
    expect(out).not.toContain("javascript");
  });

  it("strips on* event handler attributes", () => {
    const out = sanitizeSvg(
      `<svg onload="alert(1)"><rect width="5" onclick="alert(2)" fill="red"/></svg>`,
    );
    expect(out).not.toContain("onload");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert");
    expect(out).toContain(`<rect width="5" fill="red"/>`);
  });

  it("drops the style attribute entirely", () => {
    const out = sanitizeSvg(
      `<svg><rect style="filter:url(https://evil.example/f.svg#f)" width="5"/></svg>`,
    );
    expect(out).not.toContain("style");
    expect(out).not.toContain("evil.example");
    expect(out).toContain(`<rect width="5"/>`);
  });

  it("blocks external url() in paint and reference attributes", () => {
    const out = sanitizeSvg(
      `<svg>` +
        `<rect fill="url(https://evil.example/x.svg#g)" width="5"/>` +
        `<rect clip-path="url(https://evil.example/x.svg#c)" width="6"/>` +
        `<rect mask="url('https://evil.example/x.svg#m')" width="7"/>` +
        `<line marker-end="url(//evil.example/x.svg#a)" x1="0"/>` +
        `</svg>`,
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("url(");
    expect(out).toContain(`<rect width="5"/>`);
    expect(out).toContain(`<line x1="0"/>`);
  });

  it("keeps same-document url() and plain paint values", () => {
    const out = sanitizeSvg(
      `<svg>` +
        `<rect fill="url(#g)" width="5"/>` +
        `<rect fill="#333" stroke="rgb(255, 0, 0)" width="6"/>` +
        `<rect fill="none" stroke="currentColor" width="7"/>` +
        `<line marker-end="url(#m)" x1="0"/>` +
        `</svg>`,
    );
    expect(out).toContain(`fill="url(#g)"`);
    expect(out).toContain(`fill="#333" stroke="rgb(255, 0, 0)"`);
    expect(out).toContain(`fill="none" stroke="currentColor"`);
    expect(out).toContain(`marker-end="url(#m)"`);
  });

  it("drops paint values containing CSS escape sequences", () => {
    // "\\75 rl(" is a CSS-escaped "url(" - any backslash disqualifies.
    const out = sanitizeSvg(
      `<svg><rect fill="\\75 rl(https://evil.example)" width="5"/></svg>`,
    );
    expect(out).not.toContain("fill");
    expect(out).not.toContain("evil.example");
    expect(out).toContain(`<rect width="5"/>`);
  });

  it("strips unknown attributes", () => {
    const out = sanitizeSvg(
      `<svg><rect width="5" data-foo="1" bogus="x"/></svg>`,
    );
    expect(out).toContain(`data-foo="1"`);
    expect(out).not.toContain("bogus");
  });

  it("allows fragment hrefs, blocks everything else", () => {
    const out = sanitizeSvg(
      `<svg>` +
        `<use href="#icon"/>` +
        `<use xlink:href="#icon2"/>` +
        `<use href="javascript:alert(1)"/>` +
        `<use href="java\tscript:alert(1)"/>` +
        `<use href="https://evil.example/x.svg#f"/>` +
        `<use href="data:text/html,x"/>` +
        `</svg>`,
    );
    expect(out).toContain(`href="#icon"`);
    expect(out).toContain(`xlink:href="#icon2"`);
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("script:");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("data:");
  });

  it("preserves camelCase SVG names regardless of input casing", () => {
    const out = sanitizeSvg(
      `<svg><lineargradient id="g"><stop offset="0" stop-color="red"/></lineargradient>` +
        `<rect fill="url(#g)" clip-path="url(#c)"/><clippath id="c"><rect width="1"/></clippath></svg>`,
    );
    expect(out).toContain("<linearGradient");
    expect(out).toContain("</linearGradient>");
    expect(out).toContain("<clipPath");
  });

  it("escapes text nodes so text cannot smuggle markup", () => {
    const out = sanitizeSvg(`<svg><text>a < b & c > d</text></svg>`);
    expect(out).toContain("a &lt; b &amp; c &gt; d");
  });

  it("escapes attribute values", () => {
    const out = sanitizeSvg(
      `<svg><text font-family='He said "hi"'>x</text></svg>`,
    );
    expect(out).toContain(`font-family="He said &quot;hi&quot;"`);
  });

  it("drops comments, CDATA, and processing instructions", () => {
    const out = sanitizeSvg(
      `<svg><!-- secret --><![CDATA[cdata-stuff]]><?php evil ?><rect width="1"/></svg>`,
    );
    expect(out).not.toContain("secret");
    expect(out).not.toContain("cdata-stuff");
    expect(out).not.toContain("php");
    expect(out).toContain(`<rect width="1"/>`);
  });

  it("closes unclosed elements so output is balanced", () => {
    const out = sanitizeSvg(`<svg><g><rect width="1">`);
    expect(out).toBe(`<svg><g><rect width="1"></rect></g></svg>`);
  });

  it("ignores stray close tags", () => {
    const out = sanitizeSvg(`<svg></div><rect width="1"/></svg>`);
    expect(out).toBe(`<svg><rect width="1"/></svg>`);
  });
});

describe("renderMarkdown svg capture", () => {
  // The core repro from the bug report: text directly above the <svg>
  // with no blank line. Without the extension, marked paragraph-izes the
  // svg and `breaks: true` inserts <br> between its lines, which makes
  // the browser force-close the svg and drop the shapes.
  it("keeps a multi-line svg intact when text precedes it without a blank line", () => {
    const html = renderMarkdown(EN, 
      `Here is a diagram:\n<svg width="200" height="100">\n  <rect x="10" y="10" width="80" height="40" fill="#333"/>\n  <text x="20" y="35">hello</text>\n</svg>`,
    );
    expect(html).toContain(
      `<rect x="10" y="10" width="80" height="40" fill="#333"/>`,
    );
    const svgSpan = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
    expect(svgSpan).not.toContain("<br");
    expect(svgSpan).not.toContain("<p>");
  });

  it("keeps an svg with a blank line inside it intact", () => {
    const html = renderMarkdown(EN, 
      `<svg width="10">\n  <rect width="5"/>\n\n  <text>hi</text>\n</svg>`,
    );
    const svgSpan = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
    expect(svgSpan).toContain("<rect");
    expect(svgSpan).toContain("<text>");
    expect(svgSpan).not.toContain("<br");
    expect(svgSpan).not.toContain("<p>");
  });

  it("captures an svg inside a list item via the inline extension", () => {
    const html = renderMarkdown(EN, 
      `- item with <svg width="5"><rect width="1"/></svg> inline`,
    );
    expect(html).toContain(
      `<li>item with <svg width="5"><rect width="1"/></svg> inline</li>`,
    );
  });

  it("sanitizes captured svgs", () => {
    const html = renderMarkdown(EN, 
      `<svg onload="alert(1)">\n<script>alert(2)</script>\n<rect width="5"/>\n</svg>`,
    );
    expect(html).not.toContain("onload");
    expect(html).not.toContain("alert");
    expect(html).toContain(`<rect width="5"/>`);
  });

  it("captures a one-line svg mid-sentence via the inline extension", () => {
    const html = renderMarkdown(EN, 
      `Look <svg width="5"><rect width="1"/><text>hi</text></svg> here`,
    );
    expect(html).toContain(
      `Look <svg width="5"><rect width="1"/><text>hi</text></svg> here`,
    );
  });

  it("does not mangle prose that mentions svg tags in inline code", () => {
    const html = renderMarkdown(EN, "Use `<svg>` and `</svg>` tags");
    expect(html).toContain("<code>&lt;svg&gt;</code>");
    expect(html).toContain("<code>&lt;/svg&gt;</code>");
  });

  it("does not mangle a code span containing a full svg element", () => {
    const html = renderMarkdown(EN, "here: `an <svg></svg> example` end");
    expect(html).toContain("<code>an &lt;svg&gt;&lt;/svg&gt; example</code>");
  });

  it("leaves svg inside fenced code blocks as escaped code", () => {
    const html = renderMarkdown(EN, '```html\n<svg><rect width="5"/></svg>\n```');
    expect(html).not.toContain("<svg>");
    expect(html).toContain("&lt;");
  });

  it("leaves 4-space-indented svg as an indented code block", () => {
    const html = renderMarkdown(EN, `    <svg><rect width="1"/></svg>`);
    // Rendered as escaped code (hljs may wrap the escaped tag in spans),
    // never passed through as a live element.
    expect(html).toContain("<pre><code>");
    expect(html).not.toContain(`<rect width="1"/>`);
  });

  it("does not mangle double-backtick code spans containing svg", () => {
    const html = renderMarkdown(EN, "Use ``<svg><rect/></svg>`` here");
    expect(html).toContain("<code>&lt;svg&gt;&lt;rect/&gt;&lt;/svg&gt;</code>");
  });

  it("captures an svg inside a blockquote", () => {
    const html = renderMarkdown(EN, 
      `> quoted\n> <svg width="5"><rect width="1"/></svg>`,
    );
    expect(html).toContain("<blockquote>");
    expect(html).toContain(`<svg width="5"><rect width="1"/></svg>`);
  });
});
