// Raw HTML in chat Markdown (task 85881065).
//
// Agent replies, project skill files and system prompts all render through
// Markdown into innerHTML, and outside text can reach each of them. Pins: no
// source markup leaves an event handler, an active element or a script URL
// in the DOM, and the HTML agents are told to use (server/agent-reference/
// visuals.md) keeps rendering. The audit reads the DOM after the browser
// parse, so entity-encoded attribute values are judged as the browser sees
// them.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { Markdown } = await import("./Markdown.tsx");

function mount(content: string): HTMLElement {
  const view = render(<Markdown content={content} />);
  const root = view.container.querySelector<HTMLElement>(".md-content");
  if (!root) throw new Error("Markdown did not mount");
  return root;
}

// Elements that run script, load a document, submit, or change how the
// page parses or resolves URLs.
const ACTIVE_TAGS = new Set([
  "script",
  "iframe",
  "frame",
  "object",
  "embed",
  "form",
  "input",
  "textarea",
  "select",
  "base",
  "meta",
  "link",
  "style",
  "template",
  "noscript",
  "math",
  "foreignobject",
  "animate",
  "set",
]);
const URL_ATTRS = new Set([
  "href",
  "xlink:href",
  "src",
  "srcset",
  "action",
  "formaction",
  "data",
  "poster",
]);
const SAFE_SCHEMES = new Set([
  "http",
  "https",
  "mailto",
  // ui/safari-link.ts rewrites office app links on the iPhone Home Screen.
  "x-safari-http",
  "x-safari-https",
]);

// The scheme a browser reads from a URL attribute: it strips ASCII tab and
// newline anywhere and leading or trailing C0 controls and spaces.
function schemeOf(value: string): string | null {
  // eslint-disable-next-line no-control-regex
  const compact = value.replace(/[\u0000- ]/g, "").toLowerCase();
  const match = /^([a-z][a-z0-9+.-]*):/.exec(compact);
  return match ? match[1] : null;
}

// Every problem a rendered tree carries, as readable lines.
function unsafeMarkup(root: HTMLElement): string[] {
  const problems: string[] = [];
  for (const el of root.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (ACTIVE_TAGS.has(tag)) problems.push(`<${tag}> element`);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) problems.push(`${tag}[${name}]`);
      if (URL_ATTRS.has(name)) {
        const scheme = schemeOf(attr.value);
        if (scheme !== null && !SAFE_SCHEMES.has(scheme))
          problems.push(`${tag}[${name}=${JSON.stringify(attr.value)}]`);
      }
    }
  }
  return problems;
}

describe("raw HTML in Markdown", () => {
  // Each row: the source, and text the reader must still see, which proves
  // the render reached the markup instead of failing empty.
  it.each([
    [
      "the audit's handlers, as their own blocks",
      `<img src=x onerror="document.title='pwn'">\n\n<details open ontoggle="fetch('/api/me/api-tokens',{method:'POST'})"><summary>more</summary>body</details>`,
      "more",
    ],
    [
      "handlers inline in a paragraph",
      `see <img src=x onerror=alert(1)> and <span onmouseover=alert(1) style="color:red">red</span> <b onclick=alert(1)>here</b>`,
      "red here",
    ],
    [
      "a handler after a slash, which the browser reads as a separator",
      `<div>\n<img/src="x"/onerror=alert(1)><span/title="t"/onclick=alert(1)>slash</span>\n</div>`,
      "slash",
    ],
    [
      "a quoted value that holds a closing angle bracket",
      `<span title="a>b" onclick="alert(1)">quoted</span> <span title='x"' onfocus=alert(1) tabindex=0>single</span>`,
      "quoted",
    ],
    [
      "elements that run or load content",
      [
        `<iframe src="http://127.0.0.1:9/"></iframe>`,
        `<object data="http://127.0.0.1:9/x.swf"></object>`,
        `<embed src="http://127.0.0.1:9/x.swf">`,
        `<form action="/api/me/api-tokens" method="post"><input name="n" value="v"><button formaction="javascript:alert(1)">go</button></form>`,
        `<base href="http://127.0.0.1:9/">`,
        `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:9/">`,
        `<link rel="stylesheet" href="http://127.0.0.1:9/x.css">`,
        `<style>body{display:none}</style>`,
        `<template><img src=x onerror=alert(1)></template>`,
        `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`,
        `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>`,
        `after`,
      ].join("\n\n"),
      "after",
    ],
    [
      "an svg inside an HTML block",
      `<div>\n<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="5" height="5" onclick="alert(1)"/><a href="javascript:alert(1)"><text>t</text></a><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>\n</div>\n\nafter svg`,
      "after svg",
    ],
    [
      "an svg left open inside an HTML block",
      `<div><svg><rect width="1" height="1" onclick="alert(1)"/><animate attributeName="href" to="javascript:alert(1)"/>\n\nafter open svg`,
      "after open svg",
    ],
    [
      "Markdown links with script and data schemes",
      `[a1](javascript:alert(1)) [a2](JaVaScRiPt:alert(1)) [a3](jav&#x61;script:alert(1)) [a4](javascript&colon;alert(1)) [a5](<java\tscript:alert(1)>) [a6](data:text/html,x) [a7](vbscript:x)`,
      "a1 a2 a3 a4",
    ],
    [
      "raw links with script schemes, plain and entity-encoded",
      `<a href="javascript:alert(1)">r1</a> <a href="jav&#x61;script:alert(1)">r2</a> <a href="javascript&colon;alert(1)">r3</a> <a href=" java&Tab;script:alert(1)">r4</a> <a href="&#106;avascript:alert(1)">r5</a> <a href="data:text/html,x">r6</a>`,
      "r1 r2 r3 r4 r5 r6",
    ],
    [
      "raw images with script and data sources",
      `<img src="javascript:alert(1)" alt="i1"> <img src="jav&#x61;script:alert(1)" alt="i2"> <img src="data:image/svg+xml,x" alt="i3"> imgs`,
      "imgs",
    ],
    [
      "HTML inside link text",
      `[<img src=x onerror=alert(1)> label](https://a.example/)`,
      "label",
    ],
    [
      // An inline <code>, <kbd>, <pre> or <script> tag puts marked in a raw
      // state where it hands over the text after it unescaped.
      "text after an inline code, kbd, pre or script tag",
      [
        `k <kbd><img/src="x"/onerror=alert(1)></kbd> kbd`,
        `c <code><svg/onload=alert(1)></code> code`,
        `p <pre><iframe/src="javascript:alert(1)"></pre> pre`,
        `s <script><img/src="x"/onerror=alert(1)></script> script`,
      ].join("\n\n"),
      "kbd",
    ],
  ])(
    "%s leaves no handler, active element or script URL",
    (_name, source, shown) => {
      const root = mount(source);
      expect(unsafeMarkup(root)).toEqual([]);
      expect(root.textContent).toContain(shown);
    },
  );

  it("shows a script tag in a reply as text", () => {
    const root = mount(
      `<script>alert(1)</script>\n\nInline <script>alert(2)</script> too.`,
    );
    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.textContent).toContain("<script>alert(2)</script>");
  });

  it("keeps a link title as one attribute", () => {
    const root = mount(
      `[t](https://a.example/ "q\\" onmouseover=\\"alert(1)")`,
    );
    const link = root.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://a.example/");
    expect(link?.getAttribute("title")).toBe('q" onmouseover="alert(1)');
    expect(unsafeMarkup(root)).toEqual([]);
  });

  it("does not let raw HTML forge the renderer's placeholders or clobber DOM names", () => {
    const root = mount(
      `<span class="katex-math" data-katex-source="x" data-task-id="ce5e7fe0" id="getElementById" name="body">forged</span> <img name="cookie" id="x" src="https://a.example/i.png" alt="pic"> <div class="mermaid" data-mermaid-source="graph TD; A-->B">m</div>`,
    );
    expect(root.textContent).toContain("forged");
    expect(root.querySelector("img")?.getAttribute("alt")).toBe("pic");
    expect(
      Array.from(
        root.querySelectorAll(
          ".katex-math, .mermaid, [data-task-id], [data-katex-source], [data-mermaid-source], [id], [name]",
        ),
        (el) => el.outerHTML,
      ),
    ).toEqual([]);
  });

  it("shows a placeholder in angle brackets as text and drops HTML comments", () => {
    const root = mount(
      `<!-- a note for the agent -->\n\nRun it with <agent-id> on <port>.`,
    );
    expect(root.textContent).toContain("Run it with <agent-id> on <port>.");
    expect(root.textContent).not.toContain("a note for the agent");
  });

  it("keeps the HTML the visuals page tells agents to use", () => {
    const root = mount(
      [
        `<div style="background: var(--bg-subtle); border: 1px solid var(--border)"><b>Box</b><br><span style="color: var(--text-primary)">line two</span></div>`,
        `<details><summary>Sum</summary>Hidden body</details>`,
        `<table><tr><td align="right" colspan="2">cell</td></tr></table>`,
        `<a href="https://example.com/" target="_self" rel="opener">site</a> <img src="https://example.com/i.png" width="20" height="10" alt="logo"> <kbd>K</kbd>`,
        `<ol start="3"><li>three</li></ol>`,
        `Inline <svg viewBox="0 0 10 10"><rect width="5" height="5" fill="var(--border)"/></svg> svg.`,
        `<div>\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" stroke="var(--border)"/></svg>\n</div>`,
      ].join("\n\n"),
    );
    const box = root.querySelector<HTMLElement>("div[style]");
    expect(box?.getAttribute("style")).toContain("var(--bg-subtle)");
    expect(box?.querySelector("b")?.textContent).toBe("Box");
    expect(box?.querySelector("br")).not.toBeNull();
    expect(box?.querySelector("span[style]")?.getAttribute("style")).toContain(
      "var(--text-primary)",
    );
    expect(root.querySelector("details > summary")?.textContent).toBe("Sum");
    const cell = root.querySelector("td");
    expect([
      cell?.getAttribute("align"),
      cell?.getAttribute("colspan"),
    ]).toEqual(["right", "2"]);
    const link = root.querySelector("a");
    expect([
      link?.getAttribute("href"),
      link?.getAttribute("target"),
      link?.getAttribute("rel"),
    ]).toEqual(["https://example.com/", "_blank", "noopener noreferrer"]);
    const img = root.querySelector("img");
    expect([
      img?.getAttribute("src"),
      img?.getAttribute("width"),
      img?.getAttribute("height"),
      img?.getAttribute("alt"),
    ]).toEqual(["https://example.com/i.png", "20", "10", "logo"]);
    expect(root.querySelector("kbd")?.textContent).toBe("K");
    expect(root.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(root.querySelector("svg rect")?.getAttribute("fill")).toBe(
      "var(--border)",
    );
    expect(root.querySelector("div > svg circle")?.getAttribute("stroke")).toBe(
      "var(--border)",
    );
    expect(unsafeMarkup(root)).toEqual([]);
  });

  it("keeps the renderer's own placeholders and code copy button", () => {
    const root = mount(
      [
        "Math $x^2$ and task ce5e7fe0.",
        "```mermaid\ngraph TD; A-->B\n```",
        "```ts\nconst a = 1;\n```",
      ].join("\n\n"),
    );
    expect(
      root.querySelector(".katex-math")?.getAttribute("data-katex-source"),
    ).toBe("x^2");
    expect(
      root.querySelector("[data-task-id]")?.getAttribute("data-task-id"),
    ).toBe("ce5e7fe0");
    expect(
      root.querySelector(".mermaid")?.getAttribute("data-mermaid-source"),
    ).toBe("graph TD; A-->B");
    expect(
      root.querySelector(".code-block-wrapper .code-copy-btn + pre code")
        ?.textContent,
    ).toContain("const a = 1;");
  });
});

// A wide raw block scrolls sideways in its own wrapper instead of being cut
// at the edge of the message (task 4c2eb16a). Markdown's own blocks keep
// their layout: a scroller is a formatting context, so only blocks that
// start below the bubble corner may be one.
describe("raw HTML blocks scroll sideways", () => {
  const WRAPPER = "raw-html-wrapper";

  // Each top-level block as one label: "wrapped <tag>" for a scroll wrapper
  // around one element, else the tag and its first class.
  function topLevel(root: HTMLElement): string[] {
    return Array.from(root.children, (el) => {
      if (el.classList.contains(WRAPPER))
        return `wrapped ${Array.from(el.children, (c) => c.tagName.toLowerCase()).join(" ")}`;
      const cls = el.classList[0];
      return cls
        ? `${el.tagName.toLowerCase()}.${cls}`
        : el.tagName.toLowerCase();
    });
  }

  it("wraps each top-level raw block and no Markdown block", () => {
    // The display math lazy-loads KaTeX, whose stylesheet has no server here.
    const { settings } = (
      window as unknown as {
        happyDOM: {
          settings: {
            disableCSSFileLoading: boolean;
            handleDisabledFileLoadingAsSuccess: boolean;
          };
        };
      }
    ).happyDOM;
    settings.disableCSSFileLoading = true;
    settings.handleDisabledFileLoadingAsSuccess = true;
    const root = mount(
      [
        `<div style="width: 700px">wide div</div>`,
        `<svg width="900" height="10" viewBox="0 0 900 10"><rect width="900" height="10"/></svg>`,
        `<svg class="chart" width="900" height="10" viewBox="0 0 900 10"><rect width="900" height="10"/></svg>`,
        `<p style="width: 700px">styled paragraph</p>`,
        `<table style="width: 700px"><tr><td>styled table</td></tr></table>`,
        `<table><tr><td>plain raw table</td></tr></table>`,
        `<pre><code>raw code</code></pre>`,
        `Markdown paragraph.`,
        `# Heading`,
        `- item`,
        `1. one`,
        `> quote`,
        `---`,
        "```ts\nconst a = 1;\n```",
        "| a |\n|---|\n| b |",
        "```mermaid\ngraph TD; A-->B\n```",
        "$$x^2$$",
      ].join("\n\n"),
    );
    expect(topLevel(root)).toEqual([
      "wrapped div",
      "wrapped svg",
      "wrapped svg",
      "wrapped p",
      "wrapped table",
      "wrapped table",
      "wrapped pre",
      "p",
      "h1",
      "ul",
      "ol",
      "blockquote",
      "hr",
      "div.code-block-wrapper",
      "div.table-wrapper",
      "div.mermaid-wrapper",
      "span.katex-math",
    ]);
  });

  // marked splits this pattern into separate html tokens around the
  // Markdown inside, so only the browser's parse sees one div. A wrapper
  // close emitted for a raw tag without its open ends the styled div early.
  it("keeps a styled div that holds Markdown and raw blocks in one piece", () => {
    const root = mount(
      [
        `<div style="border: 1px solid red">`,
        `<table style="width: 700px"><tr><td>cell</td></tr></table>`,
        `<pre style="width: 700px">pre text</pre>`,
        `after`,
        `</div>`,
        `outside`,
      ].join("\n\n"),
    );
    expect(topLevel(root)).toEqual(["wrapped div", "p"]);
    const box = root.querySelector<HTMLElement>(`.${WRAPPER} > div[style]`);
    expect(
      Array.from(box?.children ?? [], (el) => el.tagName.toLowerCase()),
    ).toEqual(["table", "pre", "p"]);
    expect(box?.lastElementChild?.textContent).toBe("after");
  });

  it("gives every fenced code block a copy button and raw code none", () => {
    const root = mount(
      [
        "```ts\nconst a = 1;\n```",
        "```\nno language\n```",
        "```\nliteral </code></pre> close\n```",
        "- item\n\n  ```\n  in a list\n  ```",
        "> ```\n> in a quote\n> ```",
        `<pre><code>raw code</code></pre>`,
      ].join("\n\n"),
    );
    expect(
      Array.from(
        root.querySelectorAll(".code-block-wrapper"),
        (wrapper) =>
          `${wrapper.querySelectorAll(".code-copy-btn").length} ${wrapper.querySelector(".code-copy-btn + pre code")?.textContent?.trim()}`,
      ),
    ).toEqual([
      "1 const a = 1;",
      "1 no language",
      "1 literal </code></pre> close",
      "1 in a list",
      "1 in a quote",
    ]);
    expect(root.textContent).toContain("raw code");
  });
});
