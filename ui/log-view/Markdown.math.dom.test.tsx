import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, waitFor } = await import("@testing-library/react");
const { Markdown } = await import("./Markdown.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

function skipStylesheetFetch() {
  const settings = (
    window as unknown as {
      happyDOM: {
        settings: {
          disableCSSFileLoading: boolean;
          handleDisabledFileLoadingAsSuccess: boolean;
        };
      };
    }
  ).happyDOM.settings;
  settings.disableCSSFileLoading = true;
  settings.handleDisabledFileLoadingAsSuccess = true;
}

it("lazy-loads styled, accessible KaTeX for inline and display math", async () => {
  skipStylesheetFetch();
  const view = render(
    onLanguage(
      "en",
      <Markdown
        content={String.raw`Inline \(x^2\).

$$\int_0^1 x\,dx$$`}
      />,
    ),
  );

  await waitFor(() => {
    expect(view.container.querySelectorAll(".katex").length).toBe(2);
  });
  expect(view.container.querySelectorAll("math").length).toBe(2);
  expect(
    view.container.querySelector(".katex-html")?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(view.container.querySelector(".katex-html [style]") !== null).toBe(
    true,
  );
  const loadedStylesheet = document.head.querySelector<HTMLLinkElement>(
    "link[data-katex-stylesheet]",
  );
  expect(loadedStylesheet !== null).toBe(true);
});

// The shell declares where its bundle and the copied katex folder are served
// from; the page URL says nothing about it (an app widget page or a mirror
// serves the office shell under another path).
it.each([
  {
    shell: "root /mirror/isomux/",
    root: "/mirror/isomux/",
    page: "/demo",
    expected: "/mirror/isomux/",
  },
  { shell: "root /", root: "/", page: "/demo/app", expected: "/" },
  { shell: "an empty root", root: "", page: "/apps/notes/", expected: "/" },
  { shell: "no root", root: null, page: "/demo", expected: "/" },
])(
  "a shell that declares $shell loads the KaTeX stylesheet from $expected on page $page",
  async ({ root, page, expected }) => {
    skipStylesheetFetch();
    window.history.replaceState(null, "", page);
    document.head
      .querySelectorAll(
        'link[data-katex-stylesheet], meta[name="isomux-asset-root"]',
      )
      .forEach((node) => node.remove());
    if (root !== null) {
      const meta = document.createElement("meta");
      meta.name = "isomux-asset-root";
      meta.content = root;
      document.head.appendChild(meta);
    }
    expect(location.pathname).toBe(page);

    const view = render(
      onLanguage("en", <Markdown content={String.raw`\(x\)`} />),
    );

    await waitFor(() => {
      expect(view.container.querySelectorAll(".katex").length).toBe(1);
    });
    const links = document.head.querySelectorAll<HTMLLinkElement>(
      "link[data-katex-stylesheet]",
    );
    expect(links.length).toBe(1);
    expect(new URL(links[0].href, location.href).pathname).toBe(
      `${expected}katex/katex.min.css`,
    );
    view.unmount();
  },
);
