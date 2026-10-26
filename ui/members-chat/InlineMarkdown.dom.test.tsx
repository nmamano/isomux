import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { InlineMarkdown } = await import("./InlineMarkdown.tsx");
const { asDevice, IPHONE_HOME_SCREEN } =
  await import("../test-support/ios-home-screen.ts");

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
// What the two tests above leave out: mail links, and newlines kept as text
// (no <br> or <p>) with a link after one.
for (const [content, html] of [
  [
    "[mail](mailto:hello@example.com)",
    link("mailto:hello@example.com", "mail"),
  ],
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

// iOS keeps a same-origin link inside the Home Screen window, which has no
// Back button: there an app's short link opens Safari. An office page stays in
// the office, and a link to another site keeps the plain href (iOS opens it in
// a Safari sheet).
it("opens an app link in Safari from the iPhone Home Screen office, and nothing else", () => {
  const office = window.location.origin;
  const undo = asDevice(IPHONE_HOME_SCREEN);
  try {
    const view = render(
      createElement(InlineMarkdown, {
        content: `[loop](${office}/loop) ${office}/board ${office}/settings https://example.com/`,
      }),
    );
    expect(
      view.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual([
      "x-safari-" + office + "/loop",
      "x-safari-" + office + "/board",
      office + "/settings",
      "https://example.com/",
    ]);
    view.unmount();
  } finally {
    undo();
  }
});

// The opt-in grammar of the ask surfaces: code spans render as code, a safe
// link can render as its text. Defaults are untouched; the pinned test above
// still holds them.
it("with code, a codespan renders as code without its markers", () => {
  const view = render(
    createElement(InlineMarkdown, {
      content: "run `bun test` now",
      code: true,
    }),
  );
  const code = view.container.querySelector("code");
  expect(code).not.toBe(null);
  expect(code!.textContent).toBe("bun test");
  expect(view.container.textContent).toBe("run bun test now");
  // ui/styles.ts .md-content code is the source; the size is relative here,
  // because a fixed 12px does not follow an 11px line.
  expect(code!.style.fontFamily).toBe("var(--font-mono)");
  expect(code!.style.fontSize).toBe("0.92em");
});

it("with code, markup inside a codespan stays text", () => {
  const view = render(
    createElement(InlineMarkdown, { content: "`<img src=x>`", code: true }),
  );
  expect(view.container.querySelector("code")?.textContent).toBe("<img src=x>");
  expect(view.container.querySelector("img")).toBe(null);
});

it("with code, a codespan inside strong renders there too", () => {
  const view = render(
    createElement(InlineMarkdown, { content: "**go `fast` now**", code: true }),
  );
  const strong = view.container.querySelector("strong");
  expect(strong).not.toBe(null);
  expect(strong!.querySelector("code")?.textContent).toBe("fast");
  expect(strong!.textContent).toBe("go fast now");
});

it("passes whiteSpace through", () => {
  const view = render(
    createElement(InlineMarkdown, { content: "now", whiteSpace: "nowrap" }),
  );
  const root = view.container.firstElementChild as HTMLElement;
  expect(root.style.whiteSpace).toBe("nowrap");
  expect(view.container.textContent).toBe("now");
  expect(view.container.querySelector("strong,code,a")).toBe(null);
});

it("with links=false, a safe link draws as text and an unsafe one stays raw", () => {
  const view = render(
    createElement(InlineMarkdown, {
      content:
        "see [docs](https://example.com) and [bad](javascript:alert%281%29)",
      links: false,
    }),
  );
  expect(view.container.querySelector("a")).toBe(null);
  const text = view.container.textContent ?? "";
  expect(text).toContain("see docs and");
  expect(text).toContain("[bad](javascript:alert%281%29)");
});
