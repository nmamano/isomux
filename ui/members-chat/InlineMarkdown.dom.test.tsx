import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { InlineMarkdown } = await import("./InlineMarkdown.tsx");

it("renders only bold, italics and safe web links", () => {
  const view = render(
    createElement(InlineMarkdown, {
      content:
        "**bold *and italic*** _italic_ https://example.com [site](https://example.org)",
    }),
  );
  expect(view.container.querySelector("strong")?.textContent).toBe(
    "bold and italic",
  );
  expect(view.container.querySelectorAll("em").length).toBe(2);
  const links = view.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "https://example.com",
    "https://example.org",
  ]);
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
});

it("keeps unsupported syntax and hostile markup as text", () => {
  const content =
    "# heading\n```js\nalert(1)\n```\n`code` ~~strike~~ ![image](https://example.com/x.png) <img src=x onerror=alert(1)> [bad](javascript:alert%281%29) [data](data:text/html,hello)";
  const view = render(createElement(InlineMarkdown, { content }));
  expect(
    view.container.querySelector("h1,pre,code,del,img,a,script") === null,
  ).toBe(true);
  expect(view.container.textContent).toBe(content);
});

const link = (href: string, text: string) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
for (const [content, html] of [
  ["**bold** and *italic*", "<strong>bold</strong> and <em>italic</em>"],
  ["# heading", "# heading"],
  ["<b>x</b>", "&lt;b&gt;x&lt;/b&gt;"],
  ["`x`", "`x`"],
  ["[x](javascript:alert(1))", "[x](javascript:alert(1))"],
  ["[x](data:text/html,hello)", "[x](data:text/html,hello)"],
  [
    "[mail](mailto:hello@example.com)",
    link("mailto:hello@example.com", "mail"),
  ],
  ["first\nsecond", "first\nsecond"],
  [
    "first\nhttps://example.com",
    "first\n" + link("https://example.com", "https://example.com"),
  ],
  ["first\n\nsecond", "first\n\nsecond"],
] as const) {
  it(`inline grammar: ${JSON.stringify(content)}`, () => {
    const view = render(createElement(InlineMarkdown, { content }));
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.innerHTML).toBe(html);
    expect(root.style.whiteSpace).toBe("pre-wrap");
  });
}

it("keeps a quote in a destination inside the href attribute", () => {
  const view = render(
    createElement(InlineMarkdown, {
      content: '[x](https://example.com/"onmouseover="alert)',
    }),
  );
  const anchor = view.getByRole("link");
  expect(anchor.getAttribute("href")).toBe(
    'https://example.com/"onmouseover="alert',
  );
  expect(anchor.hasAttribute("onmouseover")).toBe(false);
});
