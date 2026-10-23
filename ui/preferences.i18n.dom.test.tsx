// Preferences labels and save-state coverage split from i18n.dom.test.tsx.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFor,
} from "./test-support/i18n.ts";
import { SUPPORTED_LANGUAGES } from "../shared/languages.ts";

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

const SAVE = translationsFor("common.save");
// The pane is named for its one control (task db800fd8).
const TITLE = translationsFor("settings.sidebar.language");
const LANGUAGE = translationsFor("preferences.language");
const INTRO = translationsFor("preferences.intro");
const LANGUAGE_HINT = translationsFor("preferences.languageHint");
const SAVING = translationsFor("common.saving");
const SAVED = translationsFor("preferences.saved");
const SAVE_FAILED = translationsFor("preferences.saveFailed");
const pane = (language: "ca" | "es" | null) =>
  onLanguage(language, createElement(PreferencesPane));

// The pane's heading: the label beside the select can read the same word.
const heading = (view: ReturnType<typeof render>) =>
  view.container.querySelector("h4")?.textContent ?? null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the preferences pane", () => {
  it("resolves each anchor in every shipped language", () => {
    for (const anchor of [SAVE]) {
      expect(Object.keys(anchor).sort()).toEqual(
        [...SHIPPED_LANGUAGE_CODES].sort(),
      );
      expect(new Set(Object.values(anchor)).size).toBe(
        SHIPPED_LANGUAGE_CODES.length,
      );
    }
  });

  it("reads Catalan for a user on ca, Spanish on es, and English for one who never chose", () => {
    const view = render(pane("ca"));
    expect(heading(view)).toBe(TITLE.ca);
    expect(view.queryByText(LANGUAGE.ca)).not.toBeNull();
    expect(view.queryByText(INTRO.ca)).not.toBeNull();
    expect(view.queryByText(LANGUAGE_HINT.ca)).not.toBeNull();
    expect(view.queryByText(SAVE.ca)).not.toBeNull();
    const select = view.container.querySelector("select")!;
    expect(select.value).toBe("ca");
    expect(
      Array.from(select.querySelectorAll("option"), (o) => o.textContent),
    ).toEqual(SUPPORTED_LANGUAGES.map(({ label }) => label));

    view.rerender(pane("es"));
    expect(heading(view)).toBe(TITLE.es);
    expect(view.queryByText(SAVE.es)).not.toBeNull();
    expect(view.queryByText(SAVE.ca)).toBeNull();

    view.rerender(pane(null));
    expect(heading(view)).toBe(TITLE.en);
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
    expect(view.queryByText(SAVING.ca)).not.toBeNull();

    await act(async () => finishSave());
    await settle();
    expect(view.queryByText(SAVED.ca)).not.toBeNull();
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
    expect(view.queryByText(SAVE_FAILED.ca)).not.toBeNull();
  });
});
