// The tracer of the office i18n loop (internal-docs/i18n-loop.md, S1): the
// office nav bar and the preferences pane render in the language the signed-in
// user is on, and follow it when it changes - Catalan, then Spanish, then the
// English a user who never chose gets.
//
// The oracles are literal strings on purpose. An expected value read back
// through translatorFor would repeat the implementation and pass for any
// translation, including a wrong one. A literal fails when the catalog
// changes, which is the point.
//
// One file, as the slice asks: an App mount with two rerenders covers the
// desktop bar, two more rerenders reach the labels only the phone menus carry,
// and the pane renders on its own for its labels and save states.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { PreferencesPane } = await import("./components/PreferencesPane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

// App needs a shim so nothing reaches for a socket; the save flows below swap
// in their own and hand this one back.
const OK = async () => ({});
setApiShim(OK);
afterEach(() => setApiShim(OK));
afterAll(() => setApiShim(null));

const TASKS = { ca: "Tasques", es: "Tareas", en: "Tasks" } as const;
const SAVE = { ca: "Desa", es: "Guardar", en: "Save" } as const;
const TITLE = {
  ca: "Preferències",
  es: "Preferencias",
  en: "Preferences",
} as const;

const app = (language: "ca" | "es" | null, over = {}) =>
  onLanguage(language, createElement(App), over);
const pane = (language: "ca" | "es" | null) =>
  onLanguage(language, createElement(PreferencesPane));

// NavActions' phone trigger is the one button reading "⋯"; the labels live in
// a portal until it is clicked.
function openOverflow(view: View): void {
  fireEvent.click(view.getByText("⋯"));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the anchors", () => {
  it("differ between the three languages, so a match proves the language", () => {
    for (const anchor of [TASKS, SAVE, TITLE])
      expect(new Set(Object.values(anchor)).size).toBe(3);
  });
});

describe("the office nav bar", () => {
  // One App instance for every viewport and language, moved by rerender: a
  // second mount costs about as much as the first, a rerender a fraction, and
  // the file's budget is the constraint (internal-docs/testing-guide.md).
  it("reads Catalan on ca, Spanish on es, English for one who never chose, on desktop and phone", () => {
    const view = render(app("ca"));

    // Every desktop action of OfficeView, label and title, once in Catalan.
    // The title is the label unless the action names its own.
    for (const title of ["Tasques", "Programacions", "Apps", "Configuració"])
      expect(view.queryByTitle(title), title).not.toBeNull();
    expect(view.queryByText("Configuració")).not.toBeNull();
    expect(view.queryByText("Tema")).not.toBeNull();
    expect(view.queryByTitle("Canvia el tema")).not.toBeNull();
    expect(view.queryByTitle(TASKS.en)).toBeNull();

    view.rerender(app("es"));
    expect(view.queryByTitle(TASKS.es)).not.toBeNull();
    expect(view.queryByTitle(TASKS.ca)).toBeNull();

    view.rerender(app(null));
    expect(view.queryByTitle(TASKS.en)).not.toBeNull();
    expect(view.queryByTitle(TASKS.es)).toBeNull();

    // Both builders of the nav actions: OfficeView's phone menu carries "Show
    // agent list", AgentListView's carries "Show floor view".
    view.rerender(app("ca", { isMobile: true, mobileViewMode: "office" }));
    openOverflow(view);
    expect(view.queryByText("Mostra la llista d'agents")).not.toBeNull();
    expect(view.queryByText(TASKS.ca)).not.toBeNull();

    view.rerender(app("ca", { isMobile: true, mobileViewMode: "list" }));
    openOverflow(view);
    expect(view.queryByText("Mostra la vista de planta")).not.toBeNull();
    expect(view.queryByText(TASKS.ca)).not.toBeNull();
  });
});

describe("the preferences pane", () => {
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
    // Catalan is a choice in the picker, under its own name, and is selected.
    const select = view.container.querySelector("select")!;
    expect(select.value).toBe("ca");
    expect(
      Array.from(select.querySelectorAll("option"), (o) => o.textContent),
    ).toEqual(["English", "Español", "Català"]);

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
    // Save is inert while the picker matches the record, so move it first.
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
