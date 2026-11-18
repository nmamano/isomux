// S2 of the office i18n loop (internal-docs/i18n-loop.md): the settings page
// shell and the office-side panes render in the language the signed-in user is
// on - Catalan, then Spanish, then the English a user who never chose gets.
//
// Every sidebar click is proven to have selected its row
// (aria-current) before the pane's anchor is checked, so a duplicate text
// elsewhere on the page cannot pass for it.
//
// One mount of UserSettingsView (not App - the page is the unit here and a
// second mount costs about as much as the first), moved through the panes by
// clicks and across languages by rerender; ui/test-support/dom.ts holds the
// file to 5 s.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFor,
} from "./test-support/i18n.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
const { en } = await import("../shared/i18n/en.ts");
const EN_ROOM_INTRO = en["settings.room.intro"];
const paragraphs = (view: View) =>
  Array.from(view.container.querySelectorAll("p")).map(
    (p) => p.textContent ?? "",
  );

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
    return {
      name: "",
      prompt: "",
      version: "1",
    };
  if (path.startsWith("/api/rooms/") && path.endsWith("/settings"))
    return { prompt: "", version: "1" };
  if (path === "/api/office/instructions")
    return { instructions: "", version: "1" };
  if (path.startsWith("/api/rooms/") && path.endsWith("/instructions"))
    return { instructions: "", version: "1" };
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

const SETTINGS = translationsFor("common.settings");
const STORAGE = translationsFor("settings.sidebar.storage");
const STORAGE_TITLE = translationsFor("settings.storage.title");
const CA = {
  office: translationsFor("settings.sidebar.office").ca,
  access: translationsFor("settings.sidebar.access").ca,
  invites: translationsFor("settings.sidebar.invites").ca,
  sessions: translationsFor("settings.sidebar.sessions").ca,
  usage: translationsFor("settings.sidebar.usage").ca,
  updates: translationsFor("settings.sidebar.updates").ca,
  you: translationsFor("common.you").ca,
  self: translationsFor("settings.you").ca,
  general: translationsFor("settings.part.general").ca,
  language: translationsFor("settings.sidebar.languageAndChat").ca,
  housekeeping: translationsFor("settings.sidebar.housekeeping").ca,
  signInLinks: translationsFor("settings.sidebar.signInLinks").ca,
  device: translationsFor("common.device").ca,
  deviceLabel: translationsFor("settings.sidebar.deviceLabel").ca,
  theme: translationsFor("common.theme").ca,
  rooms: translationsFor("common.rooms").ca,
  members: translationsFor("settings.sidebar.members").ca,
  signOut: translationsFor("common.signOut").ca,
  discardPrompt: translationsFor("common.discardPrompt").ca,
  discard: translationsFor("common.discard").ca,
  officeTitle: translationsFor("settings.office.title").ca,
  usageTitle: translationsFor("settings.usage.title").ca,
  upToDate: translationsFor("settings.update.upToDate").ca,
  devicePlaceholder: translationsFor("settings.device.placeholder").ca,
  themeIntro: translationsFor("settings.theme.intro").ca,
  devicesTitle: translationsFor("settings.devices.title").ca,
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

/**
 * Click the row from a dirty pane: the in-app discard prompt holds the
 * navigation, in the page language, until Discard is pressed.
 */
function discardInto(view: View, label: string): void {
  fireEvent.click(row(view, label));
  expect(view.queryByText(CA.discardPrompt), label).not.toBeNull();
  expect(row(view, label).getAttribute("aria-current"), label).toBeNull();
  fireEvent.click(view.getByText(CA.discard));
  expect(row(view, label).getAttribute("aria-current"), label).toBe("true");
}

const heading = (view: View, text: string, tag: string) =>
  view.getAllByText(text).some((el) => el.tagName === tag);

describe("the anchors", () => {
  it("resolves each anchor in every shipped language", () => {
    for (const anchor of [SETTINGS, STORAGE, STORAGE_TITLE]) {
      expect(Object.keys(anchor).sort()).toEqual(
        [...SHIPPED_LANGUAGE_CODES].sort(),
      );
      expect(new Set(Object.values(anchor)).size).toBe(
        SHIPPED_LANGUAGE_CODES.length,
      );
    }
  });
});

describe("the settings page", () => {
  it("reads Catalan on ca, shell and every office-side pane, then Spanish, then English", async () => {
    const view = render(page("ca"));

    // The shell: header and every sidebar label of an owner.
    expect(view.queryByRole("heading", { name: SETTINGS.ca })).not.toBeNull();
    for (const label of [
      CA.office,
      CA.access,
      CA.invites,
      CA.sessions,
      CA.usage,
      STORAGE.ca,
      CA.updates,
      CA.you,
      CA.general,
      CA.language,
      CA.housekeeping,
      CA.signInLinks,
      CA.device,
      CA.deviceLabel,
      CA.theme,
      CA.rooms,
      CA.members,
    ])
      expect(view.queryAllByText(label).length, label).toBeGreaterThan(0);
    expect(view.queryByText(CA.signOut)).not.toBeNull();
    expect(view.queryByText(STORAGE.en)).toBeNull();

    // Desktop opens on the signed-in user's editor, on the General row, and
    // its open part is titled General like a room's and an agent's. The
    // Members group stays collapsed, so no "(you)" shows: the editor has no
    // heading of its own since task 1f79f2e3.
    expect(
      view.container.querySelector('[data-settings-part-body="general"] h4')
        ?.textContent,
    ).toBe(CA.general);
    expect(row(view, CA.general).getAttribute("aria-current")).toBe("true");

    // Its inline discard prompt, in Catalan, holds the navigation until
    // Discard is pressed.
    fireEvent.change(view.getByDisplayValue("Tester"), {
      target: { value: "Tester 2" },
    });
    fireEvent.click(row(view, CA.office));
    expect(view.queryByText(CA.discardPrompt)).not.toBeNull();
    expect(row(view, CA.office).getAttribute("aria-current")).toBeNull();
    fireEvent.click(view.getByText(CA.discard));
    expect(row(view, CA.office).getAttribute("aria-current")).toBe("true");
    expect(heading(view, CA.officeTitle, "H3")).toBe(true);

    // The office pane's discard prompt, once its settings have hydrated and
    // the name has been edited.
    await settle();
    fireEvent.change(
      view.getByPlaceholderText(
        translationsFor("settings.office.namePlaceholder").ca,
      ),
      {
        target: { value: "Oficina Nord" },
      },
    );
    discardInto(view, CA.usage);
    expect(heading(view, CA.usageTitle, "H3")).toBe(true);

    open(view, STORAGE.ca);
    await settle();
    expect(heading(view, STORAGE_TITLE.ca, "H3")).toBe(true);

    open(view, CA.updates);
    expect(view.queryByText(CA.upToDate)).not.toBeNull();

    // The device label pane, then its discard prompt on the way to Theme.
    open(view, CA.deviceLabel);
    expect(heading(view, CA.deviceLabel, "H4")).toBe(true);
    fireEvent.change(view.getByPlaceholderText(CA.devicePlaceholder), {
      target: { value: "Mòbil" },
    });
    discardInto(view, CA.theme);
    expect(heading(view, CA.theme, "H4")).toBe(true);
    expect(view.queryByText(CA.themeIntro)).not.toBeNull();

    open(view, CA.signInLinks);
    expect(heading(view, CA.devicesTitle, "H4")).toBe(true);

    // The room pane's intro is read in the language, never pinned as copy
    // (Nil, 2026-09-14): the English sentence is absent on ca and on es, and
    // the pane's paragraphs change between the two, so the pane re-read it.
    // Rooms starts collapsed: its header opens it.
    fireEvent.click(
      view.container.querySelector('[data-sidebar-group-toggle="rooms"]')!,
    );
    // The room drills the list column into its parts (task 1f79f2e3).
    fireEvent.click(row(view, ROOM.name));
    expect(
      view.container
        .querySelector("[data-settings-item]")
        ?.getAttribute("data-settings-item"),
    ).toBe(`room:${ROOM.id}`);
    expect(view.queryByText(EN_ROOM_INTRO)).toBeNull();
    const caParagraphs = paragraphs(view);

    // Spanish: the shell and the open pane follow, and a fresh pane reads it.
    view.rerender(page("es"));
    expect(view.queryByRole("heading", { name: SETTINGS.es })).not.toBeNull();
    expect(view.queryByRole("heading", { name: SETTINGS.ca })).toBeNull();
    expect(view.queryByText(EN_ROOM_INTRO)).toBeNull();
    expect(paragraphs(view)).not.toEqual(caParagraphs);
    // Back to the Settings list, in Spanish, for the next pane.
    fireEvent.click(
      view.container.querySelector("button[data-settings-back]")!,
    );
    expect(
      view.queryByText(translationsFor("settings.sidebar.usage").es),
    ).not.toBeNull();
    open(view, STORAGE.es);
    await settle();
    expect(heading(view, STORAGE_TITLE.es, "H3")).toBe(true);

    // English for one who never chose.
    view.rerender(page(null));
    expect(view.queryByRole("heading", { name: SETTINGS.en })).not.toBeNull();
    expect(view.queryByRole("heading", { name: SETTINGS.es })).toBeNull();
    expect(heading(view, STORAGE_TITLE.en, "H3")).toBe(true);
    await settle();
  });
});
