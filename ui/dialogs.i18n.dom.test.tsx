// The agent and secondary-dialog renders live in sibling files so each file
// stays below half of the DOM per-file budget under load.
// S4 of the office i18n loop (internal-docs/i18n-loop.md): the dialogs - the
// agent dialog (spawn), the schedule dialog, the schedules-settings dialog and
// the expand chrome the first two open their long fields with - render in the
// language the signed-in user is on.
//
// The oracles are literal strings (ruling 14): an expectation read back through
// the translator would pass for any translation. The first describe proves each
// anchor differs in all three languages, so a match is evidence of the language
// and not of a word that never moved.
//
// These dialogs mount directly rather than through App: each is a
// self-contained overlay.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { CronjobDialog } = await import("./components/CronjobDialog.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;
type Language = "ca" | "es" | null;

// The spawn dialog validates its cwd on mount; nothing else here fetches on a
// Claude engine (the backend model list is Codex/OpenCode only). An unlisted
// path rejects, and the caller swallows it, so a pane that lost its own copy
// fails its anchor rather than passing quietly.
setApiShim(async (_method, path) => {
  if (path === "/api/validate/cwd") return { ok: true };
  throw new Error(`no shim for ${path}`);
});
afterAll(() => setApiShim(null));

const ROOM = {
  id: "r1",
  name: "Sala Nord",
  prompt: null,
  canCloseWhenEmpty: true,
};

const scheduleDialog = (language: Language) =>
  onLanguage(language, createElement(CronjobDialog, { onClose: () => {} }), {
    rooms: [ROOM],
    hasReceivedInitialState: true,
  });

// One anchor per section, each a string only that section shows.
const ANCHOR = {
  // The schedule dialog's interval option.
  everyNMinutes: {
    ca: "Cada N minuts",
    es: "Cada N minutos",
    en: "Every N minutes",
  },
  // A static weekday, which no Intl list supplies.
  monday: { ca: "Dilluns", es: "Lunes", en: "Monday" },
  // The schedule dialog's unattended-permission hint.
  unattendedHint: {
    ca: "Les programacions s'executen sense supervisió - els modes que demanen aprovació humana no estan disponibles.",
    es: "Las programaciones se ejecutan sin supervisión - los modos que piden aprobación humana no están disponibles.",
    en: "Schedules run unattended - modes that require human approval are not available.",
  },
} as const;

const shows = (view: View, text: string) =>
  expect(view.queryAllByText(text).length, text).toBeGreaterThan(0);

/** The weekday select only renders once the schedule type is weekly. */
function chooseWeekly(view: View): void {
  const select = view.container.querySelector("select") as HTMLSelectElement;
  act(() => {
    select.value = "weekly";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("the anchors", () => {
  it("differ between the three languages, so a match proves the language", () => {
    for (const [name, anchor] of Object.entries(ANCHOR))
      expect(new Set(Object.values(anchor)).size, name).toBe(3);
  });
});

describe("the schedule dialogs", () => {
  it("reads the language, including the weekday list", () => {
    const view = render(scheduleDialog("ca"));
    shows(view, ANCHOR.everyNMinutes.ca);
    shows(view, ANCHOR.unattendedHint.ca);
    chooseWeekly(view);
    shows(view, ANCHOR.monday.ca);

    view.rerender(scheduleDialog("es"));
    shows(view, ANCHOR.everyNMinutes.es);
    shows(view, ANCHOR.unattendedHint.es);
    chooseWeekly(view);
    shows(view, ANCHOR.monday.es);
    expect(view.queryByText(ANCHOR.everyNMinutes.ca)).toBeNull();

    view.rerender(scheduleDialog(null));
    shows(view, ANCHOR.everyNMinutes.en);
    shows(view, ANCHOR.unattendedHint.en);
    chooseWeekly(view);
    shows(view, ANCHOR.monday.en);
  });
});
