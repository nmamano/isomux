import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, waitFor } = await import("@testing-library/react");
const { Markdown } = await import("./Markdown.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

it("lazy-loads styled, accessible KaTeX for inline and display math", async () => {
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
  expect(view.container.querySelector(".katex-html")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  expect(view.container.querySelector(".katex-html [style]") !== null).toBe(
    true,
  );
  const loadedStylesheet = document.head.querySelector<HTMLLinkElement>(
    'link[data-katex-stylesheet]',
  );
  expect(loadedStylesheet !== null).toBe(true);
  expect(loadedStylesheet?.href.endsWith("/katex/katex.min.css")).toBe(true);
});
