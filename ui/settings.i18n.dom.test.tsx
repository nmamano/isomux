// S2 of the office i18n loop (internal-docs/i18n-loop.md): the settings page
// shell and the office-side panes render in the language the signed-in user is
// on - Catalan, then Spanish, then the English a user who never chose gets.
//
// The oracles are literal strings on purpose (ruling 14): an expected value
// read back through the translator would pass for any translation, including
// a wrong one. Every sidebar click is proven to have selected its row
// (aria-current) before the pane's anchor is checked, so a duplicate text
// elsewhere on the page cannot pass for it.
//
// One mount of UserSettingsView (not App - the page is the unit here and a
// second mount costs about as much as the first), moved through the panes by
// clicks and across languages by rerender; ui/test-support/dom.ts holds the
// file to 5 s.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

const BUCKET = {
  totalIn: 0,
  totalOut: 0,
  cacheRead: 0,
  cacheCreation: 0,
  costUSD: 0,
};

// Each pane fetches on mount and reads fields off the answer; a shim answering
// {} would throw inside the Usage and Storage panes and leave the Office pane
// read-only. Anything unlisted rejects, which every caller catches (the access
// lists, the backup probe) or which leaves a field read-only.
setApiShim(async (_method, path) => {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path === "/api/office/settings")
    return { name: "", prompt: "", version: "1" };
  if (path.startsWith("/api/rooms/") && path.endsWith("/settings"))
    return { prompt: "", version: "1" };
  if (path === "/api/usage")
    return {
      agents: [],
      rooms: [],
      cronjobs: [],
      total: { session: BUCKET, lifetime: BUCKET },
      scoped: false,
    };
  if (path === "/api/storage/usage")
    return { stateRootBytes: 0, categories: [], measuredAt: Date.now() };
  throw new Error(`no shim for ${path}`);
});
afterAll(() => setApiShim(null));

// The browser confirms of the panes' unsaved-change guards, captured so the
// test can assert the actual message that would have been shown.
const confirms: string[] = [];
const realConfirm = globalThis.confirm;
globalThis.confirm = (message?: string) => {
  confirms.push(message ?? "");
  return true;
};
afterAll(() => {
  globalThis.confirm = realConfirm;
});

const ROOM = {
  id: "r1",
  name: "Sala Nord",
  prompt: null,
  canCloseWhenEmpty: true,
};

const page = (language: "ca" | "es" | null) =>
  onLanguage(
    language,
    createElement(UserSettingsView, {
      onSwitchUser: () => {},
      onClose: () => {},
    }),
    { rooms: [ROOM], hasReceivedInitialState: true },
  );

const SETTINGS = { ca: "Configuració", es: "Ajustes", en: "Settings" } as const;
const STORAGE = {
  ca: "Emmagatzematge",
  es: "Almacenamiento",
  en: "Storage",
} as const;
const STORAGE_TITLE = {
  ca: "Emmagatzematge de l'oficina",
  es: "Almacenamiento de la oficina",
  en: "Office Storage",
} as const;

/**
 * Let every pending pane fetch resolve and React flush it. Called after each
 * pane that loads on mount, and once at the end: a promise that settles after
 * the file does schedules React work against an unregistered happy-dom, which
 * bun reports as an unhandled "window is not defined" and a failed run.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The sidebar button carrying `label` (group headers are divs, not buttons). */
function row(view: View, label: string): HTMLElement {
  const button = view
    .getAllByText(label)
    .map((el) => el.closest("button"))
    .find((el): el is HTMLButtonElement => el !== null);
  if (!button) throw new Error(`no sidebar row reads ${label}`);
  return button;
}

/** Click the row and prove the page moved to it. */
function open(view: View, label: string): void {
  fireEvent.click(row(view, label));
  expect(row(view, label).getAttribute("aria-current"), label).toBe("true");
}

const heading = (view: View, text: string, tag: string) =>
  view.getAllByText(text).some((el) => el.tagName === tag);

describe("the anchors", () => {
  it("differ between the three languages, so a match proves the language", () => {
    for (const anchor of [SETTINGS, STORAGE, STORAGE_TITLE])
      expect(new Set(Object.values(anchor)).size).toBe(3);
  });
});

describe("the settings page", () => {
  it("reads Catalan on ca, shell and every office-side pane, then Spanish, then English", async () => {
    const view = render(page("ca"));

    // The shell: header and every sidebar label of an owner.
    expect(view.queryByText(SETTINGS.ca)).not.toBeNull();
    for (const label of [
      "Oficina",
      "Accés",
      "Invitacions",
      "Sessions",
      "Connexions de tota l'oficina",
      "Ús",
      STORAGE.ca,
      "Actualitzacions",
      "Tu",
      "Perfil",
      "Preferències",
      "Connexions individuals",
      "Tokens d'API",
      "Enllaços d'inici de sessió",
      "Dispositiu",
      "Etiqueta del dispositiu",
      "Tema",
      "Sales",
      "Membres",
    ])
      expect(view.queryAllByText(label).length, label).toBeGreaterThan(0);
    expect(view.queryByText("Tanca la sessió")).not.toBeNull();
    expect(view.queryByText(STORAGE.en)).toBeNull();

    // Desktop opens on the signed-in user's editor.
    expect(view.queryByText("Identitat")).not.toBeNull();
    // Once on the roster row, once in the editor heading.
    expect(view.queryAllByText("(tu)").length).toBe(2);

    // Its inline discard prompt, in Catalan, holds the navigation until
    // Discard is pressed.
    fireEvent.change(view.getByDisplayValue("Tester"), {
      target: { value: "Tester 2" },
    });
    fireEvent.click(row(view, "Oficina"));
    expect(
      view.queryByText("Vols descartar els canvis sense desar?"),
    ).not.toBeNull();
    expect(row(view, "Oficina").getAttribute("aria-current")).toBeNull();
    fireEvent.click(view.getByText("Descarta"));
    expect(row(view, "Oficina").getAttribute("aria-current")).toBe("true");
    expect(heading(view, "Configuració de l'oficina", "H3")).toBe(true);

    // The office pane's browser confirm, once its settings have hydrated and
    // the name has been edited.
    await settle();
    fireEvent.change(view.getByPlaceholderText("Oficina del Nil"), {
      target: { value: "Oficina Nord" },
    });
    open(view, "Ús");
    expect(confirms).toEqual([
      "Vols descartar els canvis de l'oficina sense desar?",
    ]);
    expect(heading(view, "Ús de l'oficina", "H3")).toBe(true);

    open(view, STORAGE.ca);
    await settle();
    expect(heading(view, STORAGE_TITLE.ca, "H3")).toBe(true);

    open(view, "Actualitzacions");
    expect(
      view.queryByText("Aquesta oficina està actualitzada."),
    ).not.toBeNull();

    // The device label pane, then its browser confirm on the way to Theme.
    open(view, "Etiqueta del dispositiu");
    expect(heading(view, "Etiqueta del dispositiu", "H4")).toBe(true);
    fireEvent.change(view.getByPlaceholderText("Mòbil, Portàtil, …"), {
      target: { value: "Mòbil" },
    });
    open(view, "Tema");
    expect(confirms[1]).toBe(
      "Vols descartar els canvis de l'etiqueta del dispositiu sense desar?",
    );
    expect(heading(view, "Tema", "H4")).toBe(true);
    expect(view.queryByText(/^Es desa en aquest navegador/)).not.toBeNull();

    open(view, "Enllaços d'inici de sessió");
    expect(heading(view, "Els meus dispositius", "H4")).toBe(true);

    open(view, ROOM.name);
    expect(
      view.queryByText(
        "Fes doble clic en una pestanya de sala per venir directament aquí.",
      ),
    ).not.toBeNull();

    // Spanish: the shell and the open pane follow, and a fresh pane reads it.
    view.rerender(page("es"));
    expect(view.queryByText(SETTINGS.es)).not.toBeNull();
    expect(view.queryByText(SETTINGS.ca)).toBeNull();
    expect(view.queryByText("Uso")).not.toBeNull();
    expect(
      view.queryByText(
        "Haz doble clic en la pestaña de una sala para venir directamente aquí.",
      ),
    ).not.toBeNull();
    open(view, STORAGE.es);
    await settle();
    expect(heading(view, STORAGE_TITLE.es, "H3")).toBe(true);

    // English for one who never chose.
    view.rerender(page(null));
    expect(view.queryByText(SETTINGS.en)).not.toBeNull();
    expect(view.queryByText(SETTINGS.es)).toBeNull();
    expect(heading(view, STORAGE_TITLE.en, "H3")).toBe(true);
    await settle();
  });
});
