import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { ChatWidthHandle } = await import("./ChatWidthHandle.tsx");
it("translates the separator name", () => {
  for (const [language, name] of [
    ["en", "Resize chat"],
    ["es", "Cambiar el ancho del chat"],
    ["ca", "Canvia l’amplada del xat"],
  ] as const) {
    const view = render(
      onLanguage(
        language,
        createElement(ChatWidthHandle, {
          width: 520,
          viewportWidth: 1440,
          onChange: () => {},
          onCommit: () => {},
        }),
      ),
    );
    expect(
      view.getByRole("separator", { name }).getAttribute("aria-orientation"),
    ).toBe("vertical");
    view.unmount();
  }
});
