// Preferences labels and save-state coverage split from i18n.dom.test.tsx.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { PreferencesPane } = await import("./components/PreferencesPane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

const OK = async () => ({});
setApiShim(OK);
afterEach(() => setApiShim(OK));
afterAll(() => setApiShim(null));

const SAVE = { ca: "Desa", es: "Guardar", en: "Save" } as const;
const TITLE = {
  ca: "Preferències",
  es: "Preferencias",
  en: "Preferences",
} as const;
const pane = (language: "ca" | "es" | null) =>
  onLanguage(language, createElement(PreferencesPane));

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the preferences pane", () => {
  it("uses distinct anchors in all three tested languages", () => {
    for (const anchor of [SAVE, TITLE])
      expect(new Set(Object.values(anchor)).size).toBe(3);
  });

  it("reads Catalan for a user on ca, Spanish on es, and English for one who never chose", () => {
    const view = render(pane("ca"));
    expect(view.queryByText(TITLE.ca)).not.toBeNull();
    expect(view.queryByText("Idioma")).not.toBeNull();
    expect(
      view.queryByText(/^Et segueixen a tots els dispositius/),
    ).not.toBeNull();
    expect(
      view.queryByText(/^L'idioma en què escriuen els teus agents/),
    ).not.toBeNull();
    expect(view.queryByText(SAVE.ca)).not.toBeNull();
    const select = view.container.querySelector("select")!;
    expect(select.value).toBe("ca");
    expect(
      Array.from(select.querySelectorAll("option"), (o) => o.textContent),
    ).toEqual(["English", "Español", "Català", "简体中文"]);

    view.rerender(pane("es"));
    expect(view.queryByText(TITLE.es)).not.toBeNull();
    expect(view.queryByText(SAVE.es)).not.toBeNull();
    expect(view.queryByText(SAVE.ca)).toBeNull();

    view.rerender(pane(null));
    expect(view.queryByText(TITLE.en)).not.toBeNull();
    expect(view.queryByText(SAVE.en)).not.toBeNull();
  });

  it("reports saving and saved in Catalan", async () => {
    let finishSave: () => void = () => {};
    setApiShim(
      () =>
        new Promise<unknown>((resolve) => {
          finishSave = () => resolve(undefined);
        }),
    );
    const view = render(pane("ca"));
    fireEvent.change(view.container.querySelector("select")!, {
      target: { value: "es" },
    });
    fireEvent.click(view.getByText(SAVE.ca));
    expect(view.queryByText("Desant…")).not.toBeNull();

    await act(async () => finishSave());
    await settle();
    expect(view.queryByText("Desat.")).not.toBeNull();
    expect(view.queryByText(SAVE.ca)).not.toBeNull();
  });

  it("reports a failed save in Catalan", async () => {
    setApiShim(async () => {
      throw new Error("offline");
    });
    const view = render(pane("ca"));
    fireEvent.change(view.container.querySelector("select")!, {
      target: { value: "es" },
    });
    fireEvent.click(view.getByText(SAVE.ca));
    await settle();
    expect(view.queryByText("No s'ha pogut desar")).not.toBeNull();
  });
});
