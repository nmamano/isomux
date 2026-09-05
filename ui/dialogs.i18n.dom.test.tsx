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
// The three dialogs mount directly rather than through App: each one is a
// self-contained overlay, and the file has 5 s (ruling 10) for all three.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./components/EditAgentDialog.tsx");
const { CronjobDialog } = await import("./components/CronjobDialog.tsx");
const { CronjobsPromptDialog } = await import(
  "./components/CronjobsPromptDialog.tsx"
);
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

const agentDialog = (language: Language) =>
  onLanguage(
    language,
    createElement(EditAgentDialog, {
      onClose: () => {},
      deskIndex: 2,
      roomId: ROOM.id,
      defaultCwd: "~",
      spawnAgentType: "claude" as const,
    }),
    { rooms: [ROOM], hasReceivedInitialState: true },
  );

const scheduleDialog = (language: Language) =>
  onLanguage(
    language,
    createElement(CronjobDialog, { onClose: () => {} }),
    { rooms: [ROOM], hasReceivedInitialState: true },
  );

const schedulePromptDialog = (language: Language) =>
  onLanguage(
    language,
    createElement(CronjobsPromptDialog, { onClose: () => {} }),
    { rooms: [ROOM], hasReceivedInitialState: true },
  );

// One anchor per section, each a string only that section shows.
const ANCHOR = {
  // The agent dialog's own heading.
  spawnTitle: {
    ca: "Crear un agent nou",
    es: "Crear un agente nuevo",
    en: "Spawn New Agent",
  },
  // The template section's blank card.
  blank: { ca: "En blanc", es: "En blanco", en: "Blank" },
  // A template card's title, which lives in the catalog keyed by template id.
  codeReviewer: {
    ca: "Revisor de codi",
    es: "Revisor de código",
    en: "Code Reviewer",
  },
  // The permission field's label, on a Claude agent.
  permissionMode: {
    ca: "Mode de permisos",
    es: "Modo de permisos",
    en: "Permission Mode",
  },
  // One Claude permission option.
  permissionDefault: {
    ca: "Per defecte (preguntar per a tot)",
    es: "Por defecto (preguntar para todo)",
    en: "Default (ask for everything)",
  },
  // The dangerous Claude option, pinned in all three languages: this mode
  // auto-approves everything, so a translation that reads as "no permissions"
  // would say the opposite of what it does.
  permissionBypass: {
    ca: "Ometre els permisos (s'aprova tot automàticament)",
    es: "Omitir permisos (se aprueba todo automáticamente)",
    en: "Bypass (auto-approve all)",
  },
  // An effort option, which the dialog reads from the catalog by level id
  // while EFFORT_LEVELS keeps the id.
  effortXhigh: { ca: "Molt alt", es: "Muy alto", en: "Extra high" },
  // ExpandableTextarea's expand button, reached through the custom-instructions
  // field: the title it interpolates is the field's own translated label.
  expandInstructions: {
    ca: "Amplia Instruccions personalitzades",
    es: "Ampliar Instrucciones personalizadas",
    en: "Expand Custom Instructions",
  },
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
  // The schedules-settings dialog's own heading.
  schedulePromptTitle: {
    ca: "Configuració de les programacions",
    es: "Ajustes de las programaciones",
    en: "Schedules Settings",
  },
} as const;

/**
 * Let the cwd validation resolve and React flush it. A promise that settles
 * after the file does schedules React work against an unregistered happy-dom,
 * which bun reports as an unhandled "window is not defined" and a failed run.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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

describe("the agent dialog", () => {
  it("reads Catalan on ca, then Spanish, then the English of a user who never chose", async () => {
    const view = render(agentDialog("ca"));
    shows(view, ANCHOR.spawnTitle.ca);
    shows(view, ANCHOR.blank.ca);
    shows(view, ANCHOR.codeReviewer.ca);
    shows(view, ANCHOR.permissionMode.ca);
    shows(view, ANCHOR.permissionDefault.ca);
    shows(view, ANCHOR.permissionBypass.ca);
    shows(view, ANCHOR.effortXhigh.ca);
    expect(
      view.queryByLabelText(ANCHOR.expandInstructions.ca),
    ).not.toBeNull();
    expect(view.queryByText(ANCHOR.spawnTitle.en)).toBeNull();

    view.rerender(agentDialog("es"));
    shows(view, ANCHOR.spawnTitle.es);
    shows(view, ANCHOR.codeReviewer.es);
    shows(view, ANCHOR.permissionDefault.es);
    shows(view, ANCHOR.permissionBypass.es);
    shows(view, ANCHOR.effortXhigh.es);
    expect(view.queryByLabelText(ANCHOR.expandInstructions.es)).not.toBeNull();
    expect(view.queryByText(ANCHOR.blank.ca)).toBeNull();

    view.rerender(agentDialog(null));
    shows(view, ANCHOR.spawnTitle.en);
    shows(view, ANCHOR.blank.en);
    shows(view, ANCHOR.codeReviewer.en);
    shows(view, ANCHOR.permissionDefault.en);
    shows(view, ANCHOR.permissionBypass.en);
    shows(view, ANCHOR.effortXhigh.en);
    await settle();
  });
});

describe("the schedule dialogs", () => {
  it("read the language too, including the weekday list and the prompt dialog", () => {
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

    const prompt = render(schedulePromptDialog("ca"));
    shows(prompt, ANCHOR.schedulePromptTitle.ca);
    prompt.rerender(schedulePromptDialog("es"));
    shows(prompt, ANCHOR.schedulePromptTitle.es);
    prompt.rerender(schedulePromptDialog(null));
    shows(prompt, ANCHOR.schedulePromptTitle.en);
  });
});
