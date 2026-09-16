// S3 of the office i18n loop (internal-docs/i18n-loop.md): the access and
// connections panes - Invites, Sessions, External access, both Connections
// halves, API tokens, the provider sign-in card, the managed-variables editor,
// the shared tables and empty states in access-shared.tsx, and an owner's view
// of a member's individual connections - render in the language the signed-in
// user is on.
//
// Every sidebar click is proven by aria-current before its pane is read.
//
// One mount of UserSettingsView, walked through the panes by clicks and across
// languages by rerender; ui/test-support/dom.ts holds the file to 5 s.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFrom,
  translationsFor,
} from "./test-support/i18n.ts";
import { timeUntil } from "../shared/i18n/time.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

// Every path a pane in this file reads on mount. Anything unlisted rejects,
// which each caller catches; a pane that then rendered an error string instead
// of its own copy would fail its anchor rather than pass quietly.
setApiShim(async (_method, path) => {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path === "/api/office/access")
    return {
      externalAccess: false,
      publicOrigin: null,
      envOriginSet: false,
      envOrigin: null,
      boundLoopback: true,
    };
  if (path.startsWith("/api/me/provider-accounts")) return { accounts: [] };
  if (path === "/api/me/api-tokens") return { apiTokens: [] };
  if (path.endsWith("/env/names"))
    return {
      names: [],
      providers: [
        { provider: "claude", status: "unknown" },
        { provider: "codex", status: "not_connected" },
      ],
    };
  if (path === "/api/office/env" || path.endsWith("/env"))
    return { mode: "managed", values: {} };
  throw new Error(`no shim for ${path}`);
});
afterAll(() => setApiShim(null));

const ROOM = {
  id: "r1",
  name: "Sala Nord",
  prompt: null,
  canCloseWhenEmpty: true,
};

// A member for the owner to open from the roster: the individual-connections
// section only mounts on someone else's profile.
const MEMBER = {
  ...selfUserRecord(null),
  id: "u2",
  name: "Bru",
  role: "member" as const,
};

// An invite that expires in twelve hours, so the Expires cell exercises the
// Intl relative formatter rather than the "expired" word - the one case with
// no Intl form.
const NOW = Date.now();
const INVITE = {
  tokenPrefix: "ab12cd34",
  username: "Bru",
  role: "member" as const,
  createdBy: "u1",
  createdAt: NOW,
  expiresAt: NOW + 12 * 3_600_000,
};

const page = (language: "ca" | "es" | null) =>
  onLanguage(
    language,
    createElement(UserSettingsView, {
      onSwitchUser: () => {},
      onClose: () => {},
    }),
    {
      rooms: [ROOM],
      hasReceivedInitialState: true,
      users: new Map([
        ["tester", selfUserRecord(language)],
        ["bru", MEMBER],
      ]),
      invitesList: [INVITE],
      invitesLoaded: true,
      // Loaded and empty on purpose: it is the access-shared empty state, and
      // a loaded flag keeps useAccessListsSeed from refetching over the seed.
      activeSessions: [],
      activeSessionsLoaded: true,
    },
  );

// Sidebar rows, per language.
const SIDEBAR = {
  invites: translationsFor("settings.sidebar.invites"),
  sessions: translationsFor("settings.sidebar.sessions"),
  access: translationsFor("settings.sidebar.access"),
  officeConnections: translationsFor("settings.sidebar.connectionsOffice"),
  personalConnections: translationsFor("settings.sidebar.connectionsPersonal"),
  apiTokens: translationsFor("settings.sidebar.apiTokens"),
} as const;

// One anchor per pane, each a string only that pane shows.
const ANCHOR = {
  // InvitesPane's own subheading.
  outstanding: translationsFor("settings.invites.outstanding"),
  // A column header of access-shared's InvitesTable.
  columnFor: translationsFor("settings.invites.columnFor"),
  // The same table's Expires cell, formatted by shared/i18n/time.ts.
  expiresIn: translationsFrom(({ language }) => {
    const result = timeUntil(language, INVITE.expiresAt, NOW);
    if (result.kind !== "formatted")
      throw new Error("expected formatted invite expiry");
    return result.text;
  }),
  // access-shared's empty state, under the Sessions pane.
  emptyList: translationsFor("settings.access.none"),
  externalAccess: translationsFor("settings.externalAccess.title"),
  enableExternal: translationsFor("settings.externalAccess.enable"),
  envTitle: translationsFor("settings.connections.envTitle"),
  // ProviderSignInCard.
  status: translationsFor("settings.signIn.status"),
  // ManagedEnvEditor.
  addVariable: translationsFor("settings.env.add"),
  personalVars: translationsFor("settings.connections.personalVars"),
  howToUse: translationsFor("settings.apiTokens.howToUse"),
  noTokens: translationsFor("settings.apiTokens.empty"),
  // MemberVariableNames, on the member's profile.
  memberConnections: translationsFor("settings.memberConnections.title"),
  memberUnknown: translationsFrom(
    ({ t }) => `Claude: ${t("settings.memberConnections.unknown")}`,
  ),
} as const;

/**
 * Let every pending pane fetch resolve and React flush it. A promise that
 * settles after the file does schedules React work against an unregistered
 * happy-dom, which bun reports as an unhandled "window is not defined" and a
 * failed run, so this is called after every pane that loads on mount and once
 * at the end.
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

const shows = (view: View, text: string) =>
  expect(view.queryAllByText(text).length, text).toBeGreaterThan(0);

describe("the anchors", () => {
  it("resolves each catalog anchor in every shipped language", () => {
    for (const [name, anchor] of Object.entries(ANCHOR)) {
      expect(Object.keys(anchor).sort(), name).toEqual(
        [...SHIPPED_LANGUAGE_CODES].sort(),
      );
      expect(new Set(Object.values(anchor)).size, name).toBe(
        SHIPPED_LANGUAGE_CODES.length,
      );
    }
  });
});

describe("the access and connections panes", () => {
  it("read Catalan on ca, then Spanish, then the English of a user who never chose", async () => {
    const view = render(page("ca"));

    // Invites, and the shared invites table under it.
    open(view, SIDEBAR.invites.ca);
    shows(view, ANCHOR.outstanding.ca);
    shows(view, ANCHOR.columnFor.ca);
    shows(view, ANCHOR.expiresIn.ca);

    // Sessions: seeded empty, so this is access-shared's empty state.
    open(view, SIDEBAR.sessions.ca);
    shows(view, ANCHOR.emptyList.ca);
    expect(view.queryByText(ANCHOR.emptyList.en)).toBeNull();

    open(view, SIDEBAR.access.ca);
    await settle();
    shows(view, ANCHOR.externalAccess.ca);
    shows(view, ANCHOR.enableExternal.ca);

    // The office half: the sign-in card and the managed-variable editor are
    // inside it, so all three read together.
    open(view, SIDEBAR.officeConnections.ca);
    await settle();
    shows(view, ANCHOR.envTitle.ca);
    shows(view, ANCHOR.status.ca);
    shows(view, ANCHOR.addVariable.ca);

    open(view, SIDEBAR.personalConnections.ca);
    await settle();
    shows(view, ANCHOR.personalVars.ca);

    open(view, SIDEBAR.apiTokens.ca);
    await settle();
    shows(view, ANCHOR.howToUse.ca);
    shows(view, ANCHOR.noTokens.ca);

    // The member's profile, for the owner-only individual-connections section.
    // Its heading repeats the sidebar row's words in Catalan, so it is read by
    // role rather than by text.
    const memberRow = view
      .getAllByRole("button")
      .find((el) => (el.textContent ?? "").startsWith(MEMBER.name));
    expect(memberRow).toBeDefined();
    fireEvent.click(memberRow!);
    await settle();
    expect(
      view.queryByRole("heading", {
        name: ANCHOR.memberConnections.ca,
        level: 5,
      }),
    ).not.toBeNull();

    shows(view, ANCHOR.memberUnknown.ca);

    // Spanish: the open pane follows, and every fresh pane reads it too.
    view.rerender(page("es"));
    expect(
      view.queryByRole("heading", {
        name: ANCHOR.memberConnections.es,
        level: 5,
      }),
    ).not.toBeNull();

    shows(view, ANCHOR.memberUnknown.es);
    view.rerender(page(null));
    shows(view, ANCHOR.memberUnknown.en);
    view.rerender(page("es"));

    open(view, SIDEBAR.invites.es);
    shows(view, ANCHOR.outstanding.es);
    shows(view, ANCHOR.columnFor.es);
    shows(view, ANCHOR.expiresIn.es);
    expect(view.queryByText(ANCHOR.outstanding.ca)).toBeNull();

    open(view, SIDEBAR.officeConnections.es);
    await settle();
    shows(view, ANCHOR.envTitle.es);
    shows(view, ANCHOR.status.es);
    shows(view, ANCHOR.addVariable.es);

    // English for one who never chose a language.
    view.rerender(page(null));
    shows(view, ANCHOR.envTitle.en);
    shows(view, ANCHOR.status.en);
    shows(view, ANCHOR.addVariable.en);
    expect(view.queryByText(ANCHOR.envTitle.es)).toBeNull();

    open(view, SIDEBAR.sessions.en);
    shows(view, ANCHOR.emptyList.en);
    await settle();
  });
});
