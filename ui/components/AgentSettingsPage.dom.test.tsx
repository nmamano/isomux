// An agent's settings as a full page (task 59538509; Nil, 2026-11-14: "full
// page would be the most standard"). The page has the layout of Settings: the
// agent's sections in a list on the left (Profile, Engine, Instructions and
// memory, Access), the selected section on the right. It is one form: an edit
// stays when the member moves to another section, and the one Save writes
// every section. Save keeps the page open, as the Settings panes do. A save
// the server refuses for a field opens that field's section. On a phone the
// list shows first and a back row returns to it. Spawn keeps the dialog
// (ui/components/EditAgentDialog.spawn-*.dom.test.tsx). The doors in App are
// in ui/App.agent-settings-page.dom.test.tsx.
//
// DOM contract: the page root carries data-agent-settings-page (the agent
// id); a section row is button[data-agent-settings-section="<id>"], the
// shown one aria-current="true"; Save is [data-agent-settings-save]; the
// header close is [data-page-close]; the phone back row is
// [data-page-back-to-list]. A section's fields keep their classes:
// .agent-identity-section and .agent-appearance-section (Profile),
// .agent-engine-section, .agent-instructions-section, .agent-access-section.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { en } = await import("../../shared/i18n/en.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { agentAt, cleanup, pick, route, settle, shim, user, viewer } =
  await import("../test-support/access-slider-fixture.tsx");
const { room } = await import("../test-support/claude-limits-fixture.tsx");

type AgentInfo = import("../../shared/types.ts").AgentInfo;
type Section = import("./EditAgentDialog.tsx").AgentSettingsSection;

const SECTION_CLASSES: Record<Section, string[]> = {
  profile: ["agent-identity-section", "agent-appearance-section"],
  engine: ["agent-engine-section"],
  instructions: ["agent-instructions-section"],
  access: ["agent-access-section"],
};

const users = new Map(
  [user("owner", "Owner", "owner"), user("member", "Member", "member")].map(
    (u) => [u.name.toLowerCase(), u],
  ),
);

function renderPage(
  opts: {
    agent?: AgentInfo;
    initialSection?: Section;
    phone?: boolean;
    onClose?: () => void;
  } = {},
) {
  const agent = opts.agent ?? agentAt("standard");
  return render(
    onLanguage(
      "en",
      <EditAgentDialog
        agent={agent}
        onClose={opts.onClose ?? (() => {})}
        initialSection={opts.initialSection}
      />,
      {
        rooms: [room],
        agents: [agent],
        users,
        hasReceivedInitialState: true,
        sessionContext: viewer([]),
        isMobile: opts.phone === true,
      },
    ),
  );
}
type View = ReturnType<typeof renderPage>;

const page = (view: View) =>
  view.container.querySelector("[data-agent-settings-page]");
const row = (view: View, section: Section) =>
  view.container.querySelector<HTMLButtonElement>(
    `button[data-agent-settings-section="${section}"]`,
  );
/** The section rows, in order. */
const rows = (view: View) =>
  [
    ...view.container.querySelectorAll("button[data-agent-settings-section]"),
  ].map((el) => el.getAttribute("data-agent-settings-section"));
/** The rows marked as the one shown. */
const currentRows = (view: View) =>
  [
    ...view.container.querySelectorAll(
      'button[data-agent-settings-section][aria-current="true"]',
    ),
  ].map((el) => el.getAttribute("data-agent-settings-section"));
/** The sections whose fields are in the page, in sidebar order. */
const shownSections = (view: View) =>
  (Object.keys(SECTION_CLASSES) as Section[]).filter((section) =>
    SECTION_CLASSES[section].some(
      (cls) => view.container.querySelector(`.${cls}`) !== null,
    ),
  );
const backRow = (view: View) =>
  view.container.querySelector<HTMLButtonElement>("[data-page-back-to-list]");
const nameInput = (view: View) =>
  view.container.querySelector<HTMLInputElement>(
    ".agent-identity-section input",
  );
const cwdInput = (view: View) =>
  view.container.querySelector<HTMLInputElement>(
    ".agent-directory-field input",
  );
/** The discard prompt's text, or null. */
const discardPrompt = (view: View) =>
  [...view.container.querySelectorAll("span")].find(
    (span) => span.textContent === en["common.discardPrompt"],
  ) ?? null;

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
}
async function open(view: View, section: Section) {
  await click(row(view, section));
  expect(currentRows(view)).toEqual([section]);
}
async function typeName(view: View, value: string) {
  const input = nameInput(view);
  expect(input).not.toBeNull();
  await act(async () => {
    fireEvent.change(input!, { target: { value } });
  });
}
async function save(view: View) {
  await click(view.container.querySelector("[data-agent-settings-save]"));
  await settle();
  await settle();
}

describe("the agent settings page on a desktop", () => {
  it("lists the four sections in order, opens on Profile, and a row shows only its section", async () => {
    shim();
    const view = renderPage();
    try {
      await settle();
      expect({
        page: page(view)?.getAttribute("data-agent-settings-page") ?? null,
        rows: rows(view),
        current: currentRows(view),
        shown: shownSections(view),
        back: backRow(view) !== null,
      }).toEqual({
        page: "a1",
        rows: ["profile", "engine", "instructions", "access"],
        current: ["profile"],
        shown: ["profile"],
        back: false,
      });
      const seen: Record<string, unknown> = {};
      for (const section of [
        "access",
        "engine",
        "instructions",
        "profile",
      ] as const) {
        await click(row(view, section));
        seen[section] = {
          current: currentRows(view),
          shown: shownSections(view),
        };
      }
      expect(seen).toEqual({
        access: { current: ["access"], shown: ["access"] },
        engine: { current: ["engine"], shown: ["engine"] },
        instructions: { current: ["instructions"], shown: ["instructions"] },
        profile: { current: ["profile"], shown: ["profile"] },
      });
    } finally {
      cleanup(view);
    }
  });

  it("opens on the section it is asked for", async () => {
    shim();
    const view = renderPage({ initialSection: "engine" });
    try {
      await settle();
      expect({
        current: currentRows(view),
        shown: shownSections(view),
      }).toEqual({ current: ["engine"], shown: ["engine"] });
    } finally {
      cleanup(view);
    }
  });

  it("keeps an edit across section switches; Save writes it and the page stays open and clean, so Close leaves without a prompt", async () => {
    const calls = shim();
    let closed = 0;
    const view = renderPage({ onClose: () => closed++ });
    try {
      await settle();
      await typeName(view, "Renamed");
      await open(view, "engine");
      await open(view, "access");
      await open(view, "profile");
      expect(nameInput(view)?.value).toBe("Renamed");
      // Saved from another section than the edit's.
      await open(view, "instructions");
      await save(view);
      const patches = calls.filter((c) => route(c) === "PATCH :id");
      expect({
        closed,
        page: page(view) !== null,
        names: patches.map((c) => (c.body as { name?: string }).name),
      }).toEqual({ closed: 0, page: true, names: ["Renamed"] });
      await open(view, "profile");
      expect(nameInput(view)?.value).toBe("Renamed");
      await click(view.container.querySelector("[data-page-close]"));
      expect({ closed, prompt: discardPrompt(view) !== null }).toEqual({
        closed: 1,
        prompt: false,
      });
    } finally {
      cleanup(view);
    }
  });

  it("an unsaved edit: Close asks first, and leaves only on Discard", async () => {
    shim();
    let closed = 0;
    const view = renderPage({ onClose: () => closed++ });
    try {
      await settle();
      await typeName(view, "Renamed");
      await open(view, "engine");
      await click(view.container.querySelector("[data-page-close]"));
      const text = discardPrompt(view);
      expect({ closed, prompt: text !== null }).toEqual({
        closed: 0,
        prompt: true,
      });
      // The prompt's first button discards.
      await click(text!.parentElement!.querySelector("button"));
      expect(closed).toBe(1);
    } finally {
      cleanup(view);
    }
  });
});

describe("a save the server refuses for a field", () => {
  it("a taken name, saved from another section: the page opens Profile and marks the name, and stays open", async () => {
    shim({ refuse: { route: "PATCH :id", code: "name_taken" } });
    let closed = 0;
    const view = renderPage({ onClose: () => closed++ });
    try {
      await settle();
      await typeName(view, "Taken");
      await open(view, "access");
      await save(view);
      expect({
        closed,
        current: currentRows(view),
        shown: shownSections(view),
        invalid: nameInput(view)?.getAttribute("aria-invalid") ?? null,
      }).toEqual({
        closed: 0,
        current: ["profile"],
        shown: ["profile"],
        invalid: "true",
      });
    } finally {
      cleanup(view);
    }
  });

  it("a refused folder, saved from another section: the page opens Access and marks the working directory", async () => {
    shim({ refuse: { route: "PUT :id/access", code: "folder_not_allowed" } });
    let closed = 0;
    const view = renderPage({
      initialSection: "access",
      onClose: () => closed++,
    });
    try {
      await settle();
      await pick(view.container, "web");
      await open(view, "profile");
      expect(cwdInput(view)).toBeNull();
      await save(view);
      expect({
        closed,
        current: currentRows(view),
        shown: shownSections(view),
        invalid: cwdInput(view)?.getAttribute("aria-invalid") ?? null,
      }).toEqual({
        closed: 0,
        current: ["access"],
        shown: ["access"],
        invalid: "true",
      });
    } finally {
      cleanup(view);
    }
  });
});

describe("the agent settings page on a phone", () => {
  it("shows the list first; a row opens its section with a back row, and the back row returns to the list with the edit kept", async () => {
    shim();
    const view = renderPage({ phone: true });
    try {
      await settle();
      expect({
        page: page(view) !== null,
        rows: rows(view),
        current: currentRows(view),
        shown: shownSections(view),
        back: backRow(view) !== null,
      }).toEqual({
        page: true,
        rows: ["profile", "engine", "instructions", "access"],
        current: [],
        shown: [],
        back: false,
      });
      await click(row(view, "profile"));
      expect({
        rows: rows(view).length,
        shown: shownSections(view),
        back: backRow(view) !== null,
      }).toEqual({ rows: 0, shown: ["profile"], back: true });
      await typeName(view, "Renamed");
      await click(backRow(view));
      expect({
        rows: rows(view).length,
        shown: shownSections(view),
        back: backRow(view) !== null,
      }).toEqual({ rows: 4, shown: [], back: false });
      await click(row(view, "profile"));
      expect(nameInput(view)?.value).toBe("Renamed");
    } finally {
      cleanup(view);
    }
  });

  it("an unsaved edit and the list showing: Close and Escape show the discard prompt, and Discard leaves", async () => {
    shim();
    let closed = 0;
    const view = renderPage({ phone: true, onClose: () => closed++ });
    try {
      await settle();
      await click(row(view, "profile"));
      await typeName(view, "Renamed");
      await click(backRow(view));
      expect(rows(view).length).toBe(4);
      await click(view.container.querySelector("[data-page-close]"));
      expect({ closed, prompt: discardPrompt(view) !== null }).toEqual({
        closed: 0,
        prompt: true,
      });
      // Escape takes the prompt down; a second one asks again.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(discardPrompt(view)).toBeNull();
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      const text = discardPrompt(view);
      expect({ closed, prompt: text !== null }).toEqual({
        closed: 0,
        prompt: true,
      });
      await click(text!.parentElement!.querySelector("button"));
      expect(closed).toBe(1);
    } finally {
      cleanup(view);
    }
  });

  it("a door that names a section opens that section, with the back row", async () => {
    shim();
    const view = renderPage({ phone: true, initialSection: "engine" });
    try {
      await settle();
      expect({
        rows: rows(view).length,
        shown: shownSections(view),
        back: backRow(view) !== null,
      }).toEqual({ rows: 0, shown: ["engine"], back: true });
    } finally {
      cleanup(view);
    }
  });
});
