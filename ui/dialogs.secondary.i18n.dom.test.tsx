// Schedule-settings and new-room translations split from
// dialogs.i18n.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFor,
} from "./test-support/i18n.ts";

setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { CronjobsPromptDialog } =
  await import("./components/CronjobsPromptDialog.tsx");
const { NewRoomDialog } = await import("./office/NewRoomDialog.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;
type Language = "ca" | "es" | null;
const shows = (view: View, text: string) =>
  expect(view.queryAllByText(text).length, text).toBeGreaterThan(0);
const PROMPT_TITLE = translationsFor("dialogs.schedulePrompt.title");
const NEW_ROOM_TITLE = translationsFor("office.newRoom.title");
const promptDialog = (language: Language) =>
  onLanguage(
    language,
    createElement(CronjobsPromptDialog, { onClose: () => {} }),
  );

describe("the secondary dialogs", () => {
  it("resolves each title in every shipped language", () => {
    for (const anchor of [PROMPT_TITLE, NEW_ROOM_TITLE]) {
      expect(Object.keys(anchor).sort()).toEqual(
        [...SHIPPED_LANGUAGE_CODES].sort(),
      );
      expect(new Set(Object.values(anchor)).size).toBe(
        SHIPPED_LANGUAGE_CODES.length,
      );
    }
  });

  it("reads the schedule prompt in all three languages", () => {
    const view = render(promptDialog("ca"));
    shows(view, PROMPT_TITLE.ca);
    view.rerender(promptDialog("es"));
    shows(view, PROMPT_TITLE.es);
    view.rerender(promptDialog(null));
    shows(view, PROMPT_TITLE.en);
  });

  it("reads the new-room title in all three languages", () => {
    for (const [language, title] of [
      ["ca", NEW_ROOM_TITLE.ca],
      ["es", NEW_ROOM_TITLE.es],
      [null, NEW_ROOM_TITLE.en],
    ] as const) {
      const view = render(
        onLanguage(
          language,
          createElement(NewRoomDialog, { onClose: () => {} }),
        ),
      );
      shows(view, title);
      view.unmount();
    }
  });
});
