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

// Safari does not hold the member's session (task 79beacd9): in the Home
// Screen window an app's short link and an office page stay in the window,
// and a link to another site keeps the plain href (iOS opens it in a Safari
// sheet).
it("keeps every link as it is in the iPhone Home Screen office", () => {
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
      office + "/loop",
      office + "/board",
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

// Colour markup, on the ask surfaces only (task d6cadcdb): `:name[text]`
// with a fixed set of names, each drawn in a theme variable. The colour comes
// from the name lookup, never from the source.
const colored = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-color]")].map((span) => ({
    name: span.dataset.color,
    color: span.style.color,
    text: span.textContent,
    // Only the two attributes and the one style property come from the code.
    attributes: span.getAttributeNames().sort(),
    styles: span.style.length,
  }));

it("with colors, each name draws its text in its theme variable", () => {
  const vars = {
    green: "var(--green-text)",
    orange: "var(--orange-text)",
    red: "var(--red-text)",
    purple: "var(--purple-text)",
    blue: "var(--accent-text)",
  };
  const content = Object.keys(vars)
    .map((name) => `:${name}[${name} word]`)
    .join(" ");
  const view = render(createElement(InlineMarkdown, { content, colors: true }));
  expect(colored(view.container)).toStrictEqual(
    Object.entries(vars).map(([name, color]) => ({
      name,
      color,
      text: `${name} word`,
      attributes: ["data-color", "style"],
      styles: 1,
    })),
  );
  expect(view.container.textContent).toBe(
    Object.keys(vars)
      .map((name) => `${name} word`)
      .join(" "),
  );
});

// Chinese and Japanese write no space between words, so a CJK character
// before the colon still opens the markup.
it("with colors, the markup opens at the start, after a space, punctuation or a CJK character, and inside bold", () => {
  const view = render(
    createElement(InlineMarkdown, {
      content: ":green[a] then (:red[b]), **:blue[c]** 请确认:orange[决定]",
      colors: true,
    }),
  );
  expect(
    colored(view.container).map(({ name, text }) => [name, text]),
  ).toStrictEqual([
    ["green", "a"],
    ["red", "b"],
    ["blue", "c"],
    ["orange", "决定"],
  ]);
  expect(view.container.querySelector("strong > [data-color]")).not.toBe(null);
  expect(view.container.textContent).toBe("a then (b), c 请确认决定");
});

it("with colors, the text inside keeps bold, code and task chips", () => {
  const task = {
    id: "ce5e7fe0",
    title: "A task",
    priority: "P1",
    status: "open",
    createdBy: "Nil",
    username: "Nil",
    createdAt: 1,
    roomId: "r1",
  } as import("../../shared/types.ts").TaskItem;
  const view = render(
    createElement(InlineMarkdown, {
      content: ":red[**Decide** on ce5e7fe0, run `bun test`] now",
      colors: true,
      code: true,
      tasks: new Map([[task.id, task]]),
      onOpenTask: () => {},
    }),
  );
  const span = view.container.querySelector<HTMLElement>("[data-color]");
  expect(span?.dataset.color).toBe("red");
  if (!span) return;
  expect(span.querySelector("strong")?.textContent).toBe("Decide");
  expect(span.querySelector<HTMLElement>(".task-id-chip")?.dataset.taskId).toBe(
    task.id,
  );
  expect(span.querySelector("code")?.textContent).toBe("bun test");
  expect(span.textContent).toBe("Decide on ce5e7fe0, run bun test");
  expect(view.container.textContent).toBe(
    "Decide on ce5e7fe0, run bun test now",
  );
});

// Each case: what the agent wrote, and why it must stay as typed.
for (const [content, why] of [
  ["Mark :pink[this] now", "a name not in the set"],
  ["Mark :Green[this] now", "names are case-sensitive"],
  ["Mark :constructor[this] now", "a prototype key is not a name"],
  ["note:red[this] now", "a letter before the colon"],
  ["key2:green[0] now", "a digit before the colon"],
  ["Mark :green[] now", "empty text"],
  ["Mark :green[this now", "no closing bracket"],
  ["Mark :green[this\nnow] then", "text across a line break"],
  ["Mark :green;color:red[this] now", "style syntax in the name"],
  ["Mark : green[this] now", "a space after the colon"],
] as const) {
  it(`with colors, keeps ${JSON.stringify(content)} as typed: ${why}`, () => {
    const view = render(
      createElement(InlineMarkdown, { content, colors: true }),
    );
    expect(view.container.querySelector("[data-color]")).toBe(null);
    expect(view.container.textContent).toBe(content);
  });
}

it("with colors, an escaped colon and a code span keep the markup as text", () => {
  const view = render(
    createElement(InlineMarkdown, {
      content: "\\:green[a] and `:red[b]`",
      colors: true,
      code: true,
    }),
  );
  expect(view.container.querySelector("[data-color]")).toBe(null);
  expect(view.container.querySelector("code")?.textContent).toBe(":red[b]");
  expect(view.container.textContent).toBe(":green[a] and :red[b]");
});

it("with colors, source markup reaches the DOM only as text", () => {
  const content =
    ':green[<img src=x onerror=alert(1)> <b style="color:red">b</b>]{style="color:red" onclick="alert(1)"}';
  const view = render(createElement(InlineMarkdown, { content, colors: true }));
  expect(view.container.querySelector("img,b,script")).toBe(null);
  // The attribute block stays text after the span; nothing of it reaches the
  // span.
  expect(colored(view.container)).toStrictEqual([
    {
      name: "green",
      color: "var(--green-text)",
      text: '<img src=x onerror=alert(1)> <b style="color:red">b</b>',
      attributes: ["data-color", "style"],
      styles: 1,
    },
  ]);
  expect(view.container.textContent).toBe(
    '<img src=x onerror=alert(1)> <b style="color:red">b</b>{style="color:red" onclick="alert(1)"}',
  );
});

it("without colors, the markup stays as typed (members chat, secret reasons)", () => {
  const content = ":green[**Quick stamp**] ship it";
  const view = render(createElement(InlineMarkdown, { content, code: true }));
  expect(view.container.querySelector("[data-color]")).toBe(null);
  // The rest of the grammar still runs inside the brackets.
  expect(view.container.querySelector("strong")?.textContent).toBe(
    "Quick stamp",
  );
  expect(view.container.textContent).toBe(":green[Quick stamp] ship it");
});
