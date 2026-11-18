// An agent's settings as a full page (task 59538509; Nil, 2026-11-14: "full
// page would be the most standard"), drilled in under Settings since task
// 1f79f2e3 (Nil, 2026-11-17: "Drill-in: a room, member or agent lists its
// parts in the sidebar"): the header reads Settings with the agent beside it,
// the agent's sections (General, Access, Instructions and memory, Model and
// behavior; one rule for every type, Nil 2026-11-17, task 03ffafc1) are
// part rows under a back row to the Settings list, the selected one on the
// right. A part with an unsaved edit shows a dot. It works with no account. It is one form: an edit
// stays when the member moves to another section, and the one Save writes
// every section. Save keeps the page open, as the Settings panes do. A save
// the server refuses for a field opens that field's section. On a phone the
// list shows first and a back row returns to it. Spawn keeps the dialog
// (ui/components/EditAgentDialog.spawn-*.dom.test.tsx). The doors in App are
// in ui/App.agent-settings-page.dom.test.tsx and
// ui/App.agent-settings-page-form.dom.test.tsx.
//
// DOM contract (shared with rooms and members,
// UserSettingsView.drill-in.dom.test.tsx): the page root carries
// data-settings-item="agent:<id>"; a section row is
// button[data-settings-part="<id>"], the shown one aria-current="true", one
// with an unsaved edit data-settings-part-dirty; the back row to the Settings
// list is button[data-settings-back]; Save is [data-settings-save]; the
// header close is [data-page-close]; the phone back row from a section to
// the list is [data-page-back-to-list]; the open part's body is
// [data-settings-part-body="<id>"]. A section's fields keep their classes:
// .agent-identity-section, .agent-appearance-section, .agent-room-field and
// .agent-directory-field (General), .agent-manager-field and
// .agent-access-field (Access), .agent-instructions-section,
// .agent-engine-section.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { UserSettingsView } = await import("./UserSettingsView.tsx");
const { en } = await import("../../shared/i18n/en.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { agentAt, cleanup, pick, route, settle, shim, user, viewer } =
  await import("../test-support/access-slider-fixture.tsx");
const { room } = await import("../test-support/claude-limits-fixture.tsx");

type AgentInfo = import("../../shared/types.ts").AgentInfo;
type Section = import("./EditAgentDialog.tsx").AgentSettingsSection;

// Each part's fields, in the order the part shows them: General is name,
// room, folder, then the look (Nil, 2026-11-17).
const PART_FIELDS: Record<Section, string[]> = {
  general: [
    "agent-identity-section",
    "agent-room-field",
    "agent-directory-field",
    "agent-appearance-section",
  ],
  access: ["agent-manager-field", "agent-access-field"],
  instructions: ["agent-instructions-section"],
  engine: ["agent-engine-section"],
};
const ALL_FIELDS = Object.values(PART_FIELDS).flat();

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
    noAccount?: boolean;
  } = {},
) {
  const agent = opts.agent ?? agentAt("standard");
  return render(
    onLanguage(
      "en",
      <UserSettingsView
        onSwitchUser={() => {}}
        onClose={opts.onClose ?? (() => {})}
        initialTarget={{
          kind: "agent",
          agentId: agent.id,
          ...(opts.initialSection ? { part: opts.initialSection } : {}),
        }}
      />,
      {
        rooms: [room],
        agents: [agent],
        users,
        hasReceivedInitialState: true,
        sessionContext: opts.noAccount ? null : viewer([]),
        isMobile: opts.phone === true,
      },
    ),
  );
}
type View = ReturnType<typeof renderPage>;

const page = (view: View) =>
  view.container.querySelector('[data-settings-item^="agent:"]');
const row = (view: View, section: Section) =>
  view.container.querySelector<HTMLButtonElement>(
    `button[data-settings-part="${section}"]`,
  );
/** The section rows, in order. */
const rows = (view: View) =>
  [...view.container.querySelectorAll("button[data-settings-part]")].map((el) =>
    el.getAttribute("data-settings-part"),
  );
/** The rows marked as the one shown. */
const currentRows = (view: View) =>
  [
    ...view.container.querySelectorAll(
      'button[data-settings-part][aria-current="true"]',
    ),
  ].map((el) => el.getAttribute("data-settings-part"));
/** The rows that show the unsaved-edits dot. */
const dirtyRows = (view: View) =>
  [
    ...view.container.querySelectorAll(
      "button[data-settings-part][data-settings-part-dirty]",
    ),
  ].map((el) => el.getAttribute("data-settings-part"));
const settingsBack = (view: View) =>
  view.container.querySelector<HTMLButtonElement>("button[data-settings-back]");
/** The sections whose fields are in the page, in sidebar order. */
const shownSections = (view: View) =>
  (Object.keys(PART_FIELDS) as Section[]).filter((section) =>
    PART_FIELDS[section].some(
      (cls) => view.container.querySelector(`.${cls}`) !== null,
    ),
  );
/** The fields in the page, in document order. */
const fieldsShown = (view: View) =>
  [
    ...view.container.querySelectorAll(
      ALL_FIELDS.map((cls) => `.${cls}`).join(", "),
    ),
  ].map((el) => ALL_FIELDS.find((cls) => el.classList.contains(cls)));
/** The headings in the open part's body. */
const bodyHeadings = (view: View) =>
  view.container.querySelectorAll(
    "[data-settings-part-body] h4, [data-settings-part-body] h5",
  ).length;
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
  await click(view.container.querySelector("[data-settings-save]"));
  await settle();
  await settle();
}

describe("the agent settings page on a desktop", () => {
  it("is Settings with the agent beside the title; lists the four sections in order under the back row, opens on Engine, and a row shows only its section's fields, in order, under the section's one heading", async () => {
    shim();
    const view = renderPage();
    try {
      await settle();
      expect({
        page: page(view)?.getAttribute("data-settings-item") ?? null,
        rows: rows(view),
        current: currentRows(view),
        shown: shownSections(view),
        back: backRow(view) !== null,
        settingsBack: settingsBack(view) !== null,
        title: view.container.querySelector("h1")?.textContent ?? null,
        subtitleNamesAgent:
          view.container
            .querySelector("h1")
            ?.nextElementSibling?.textContent?.includes("Saved name") ?? false,
      }).toEqual({
        page: "agent:a1",
        rows: ["general", "access", "instructions", "engine"],
        current: ["engine"],
        shown: ["engine"],
        back: false,
        settingsBack: true,
        title: en["common.settings"],
        subtitleNamesAgent: true,
      });
      const seen: Record<string, unknown> = {};
      for (const section of [
        "access",
        "engine",
        "instructions",
        "general",
      ] as const) {
        await click(row(view, section));
        seen[section] = {
          current: currentRows(view),
          fields: fieldsShown(view),
          headings: bodyHeadings(view),
        };
      }
      // One heading per part, its title: in General the look is a field
      // like the name and the folder, not a heading over the fields after
      // it.
      expect(seen).toEqual({
        access: {
          current: ["access"],
          fields: PART_FIELDS.access,
          headings: 1,
        },
        engine: {
          current: ["engine"],
          fields: PART_FIELDS.engine,
          headings: 1,
        },
        instructions: {
          current: ["instructions"],
          fields: PART_FIELDS.instructions,
          headings: 1,
        },
        general: {
          current: ["general"],
          fields: PART_FIELDS.general,
          headings: 1,
        },
      });
    } finally {
      cleanup(view);
    }
  });

  it("opens on the section it is asked for", async () => {
    shim();
    const view = renderPage({ initialSection: "general" });
    try {
      await settle();
      expect({
        current: currentRows(view),
        shown: shownSections(view),
      }).toEqual({ current: ["general"], shown: ["general"] });
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
      await open(view, "general");
      await typeName(view, "Renamed");
      await open(view, "engine");
      await open(view, "access");
      await open(view, "general");
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
      await open(view, "general");
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
      await open(view, "general");
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
  it("a section with an unsaved edit shows a dot, and only it; Save clears it", async () => {
    shim();
    const view = renderPage();
    try {
      await settle();
      expect(dirtyRows(view)).toEqual([]);
      await open(view, "general");
      await typeName(view, "Renamed");
      await open(view, "access");
      expect(dirtyRows(view)).toEqual(["general"]);
      // Typed back to the saved name: nothing to save, no dot.
      await open(view, "general");
      await typeName(view, "Saved name");
      expect(dirtyRows(view)).toEqual([]);
      await typeName(view, "Renamed");
      await save(view);
      expect(dirtyRows(view)).toEqual([]);
    } finally {
      cleanup(view);
    }
  });

  it("the back row leads to the Settings list, which holds no agent, and the page stays open", async () => {
    shim();
    let closed = 0;
    const view = renderPage({ onClose: () => closed++ });
    try {
      await settle();
      await click(settingsBack(view));
      expect({
        closed,
        page: page(view) !== null,
        rows: rows(view).length,
        settings:
          view.container.querySelector("[data-sidebar-group-toggle]") !== null,
      }).toEqual({ closed: 0, page: false, rows: 0, settings: true });
    } finally {
      cleanup(view);
    }
  });

  it("works with no account: the sections list and Engine shows", async () => {
    shim();
    const view = renderPage({ noAccount: true });
    try {
      await settle();
      expect({
        page: page(view)?.getAttribute("data-settings-item") ?? null,
        rows: rows(view),
        shown: shownSections(view),
      }).toEqual({
        page: "agent:a1",
        rows: ["general", "access", "instructions", "engine"],
        shown: ["engine"],
      });
    } finally {
      cleanup(view);
    }
  });
});

describe("a save the server refuses for a field", () => {
  it("a taken name, saved from another section: the page opens General and marks the name, and stays open", async () => {
    shim({ refuse: { route: "PATCH :id", code: "name_taken" } });
    let closed = 0;
    const view = renderPage({ onClose: () => closed++ });
    try {
      await settle();
      await open(view, "general");
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
        current: ["general"],
        shown: ["general"],
        invalid: "true",
      });
    } finally {
      cleanup(view);
    }
  });

  it("a refused folder, saved from another section: the page opens General, where the folder is, and marks the working directory", async () => {
    shim({ refuse: { route: "PUT :id/access", code: "folder_not_allowed" } });
    let closed = 0;
    const view = renderPage({
      initialSection: "access",
      onClose: () => closed++,
    });
    try {
      await settle();
      // The enabling condition: the access level is on Access, the folder
      // is not.
      expect(cwdInput(view)).toBeNull();
      await pick(view.container, "web");
      await open(view, "engine");
      expect(cwdInput(view)).toBeNull();
      await save(view);
      expect({
        closed,
        current: currentRows(view),
        shown: shownSections(view),
        invalid: cwdInput(view)?.getAttribute("aria-invalid") ?? null,
      }).toEqual({
        closed: 0,
        current: ["general"],
        shown: ["general"],
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
        rows: ["general", "access", "instructions", "engine"],
        current: [],
        shown: [],
        back: false,
      });
      await click(row(view, "general"));
      expect({
        rows: rows(view).length,
        shown: shownSections(view),
        back: backRow(view) !== null,
      }).toEqual({ rows: 0, shown: ["general"], back: true });
      await typeName(view, "Renamed");
      await click(backRow(view));
      expect({
        rows: rows(view).length,
        shown: shownSections(view),
        back: backRow(view) !== null,
      }).toEqual({ rows: 4, shown: [], back: false });
      await click(row(view, "general"));
      expect(nameInput(view)?.value).toBe("Renamed");
      // The third level up: the sections list's back row to Settings, which
      // asks first about the edit.
      await click(backRow(view));
      await click(settingsBack(view));
      expect({
        prompt: discardPrompt(view) !== null,
        page: page(view) !== null,
      }).toEqual({
        prompt: true,
        page: true,
      });
    } finally {
      cleanup(view);
    }
  });

  it("an unsaved edit and the list showing: Close shows the discard prompt and Escape takes it down; Escape then leaves for the Settings list through the prompt, and Discard lands there", async () => {
    shim();
    let closed = 0;
    const view = renderPage({ phone: true, onClose: () => closed++ });
    try {
      await settle();
      await click(row(view, "general"));
      await typeName(view, "Renamed");
      await click(backRow(view));
      expect(rows(view).length).toBe(4);
      await click(view.container.querySelector("[data-page-close]"));
      expect({ closed, prompt: discardPrompt(view) !== null }).toEqual({
        closed: 0,
        prompt: true,
      });
      const escape = () =>
        act(async () => {
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          );
        });
      // Escape takes the prompt down.
      await escape();
      expect(discardPrompt(view)).toBeNull();
      // On the list, Escape does what the back row there does (task
      // 1f79f2e3): it leaves for the Settings list, asking first.
      await escape();
      const text = discardPrompt(view);
      expect({
        closed,
        prompt: text !== null,
        page: page(view) !== null,
      }).toEqual({
        closed: 0,
        prompt: true,
        page: true,
      });
      await click(text!.parentElement!.querySelector("button"));
      expect({
        closed,
        page: page(view) !== null,
        rows: rows(view).length,
      }).toEqual({
        closed: 0,
        page: false,
        rows: 0,
      });
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
