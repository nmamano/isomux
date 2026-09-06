// S6 of the office i18n loop (internal-docs/i18n-loop.md): the office scene and
// its labels, the task board, the apps page, the schedules page, the agent list
// and the numbers all render in the language the signed-in user is on.
//
// The oracles are literal strings (ruling 14): an expectation read back through
// the translator would pass for any translation. The first describe proves each
// anchor differs in all three languages, so a match is evidence of the language
// and not of a word that never moved.
//
// Every view here mounts DIRECTLY rather than through App: each takes its data
// from the store, which ui/test-support/language-fixture.tsx seeds, so driving
// App into each page would cost four more office renders for no extra evidence.
// Every seeded list carries its `loaded` flag, or the view's own seed hook
// fetches and the shim's answer overwrites the seeded rows (the S3 trap).

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { OfficeView } = await import("./office/OfficeView.tsx");
const { TaskView } = await import("./components/TaskView.tsx");
const { AppsView } = await import("./components/AppsView.tsx");
const { CronjobsView } = await import("./components/CronjobsView.tsx");
const { AgentListView } = await import("./components/AgentListView.tsx");
const { ContextBattery } = await import("./log-view/ContextBattery.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;
type Language = "ca" | "es" | null;
type AgentInfo = import("../shared/types.ts").AgentInfo;
type Cronjob = import("../shared/types.ts").Cronjob;

// The pages fetch on mount. An empty answer keeps every list empty, which is
// the state whose words this file reads; the seeded `loaded` flags are what
// stop the answer from mattering.
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

const ROOM = { id: "r1", name: "Sala Nord", prompt: null, canCloseWhenEmpty: true };

// One agent, parked on a permission prompt, at desk 0 of the shown room: that
// is what puts the nameplate badge on the floor.
const AGENT = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: ROOM.id,
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  queue: [],
  pendingPrompt: "permission",
  contextUsage: null,
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

const SCENE_STATE = {
  agents: [AGENT],
  rooms: [ROOM],
  currentRoomId: ROOM.id,
  hasReceivedInitialState: true,
  connected: true,
};

const noop = () => {};

const officeView = (language: Language) =>
  onLanguage(
    language,
    createElement(OfficeView, {
      onSpawn: noop,
      onContextMenu: noop,
      onOpenSettings: noop,
      onEditOfficePrompt: noop,
      onOpenThemePicker: noop,
      onOpenTasks: noop,
      onOpenCronjobs: noop,
      onOpenApps: noop,
      onOpenUpdate: noop,
    }),
    SCENE_STATE,
  );

const agentList = (language: Language) =>
  onLanguage(
    language,
    createElement(AgentListView, {
      onFocus: noop,
      onSpawn: noop,
      onContextMenu: noop,
      onOpenSettings: noop,
      onOpenThemePicker: noop,
      onOpenTasks: noop,
      onOpenCronjobs: noop,
      onOpenApps: noop,
      onOpenUpdate: noop,
      onToggleView: noop,
    }),
    // No agents, so the view shows its own empty state rather than rows.
    { rooms: [ROOM], currentRoomId: ROOM.id, hasReceivedInitialState: true },
  );

const taskView = (language: Language) =>
  onLanguage(language, createElement(TaskView, { onClose: noop }), {
    rooms: [ROOM],
    currentRoomId: ROOM.id,
    hasReceivedInitialState: true,
    tasksLoaded: true,
  });

const appsView = (language: Language) =>
  onLanguage(language, createElement(AppsView, { onClose: noop }), {
    hasReceivedInitialState: true,
    appsLoaded: true,
  });

const cronjobsView = (language: Language, cronjobs: Cronjob[] = []) =>
  onLanguage(language, createElement(CronjobsView, { onClose: noop }), {
    hasReceivedInitialState: true,
    cronjobs,
    cronjobsLoaded: true,
    cronjobRunsLoaded: true,
  });

// One enabled weekly job whose next run is 20 s away: 20 s rounds to zero
// minutes, which is the branch with no Intl reading, and Monday is the
// weekday whose name differs in all three languages.
const CRONJOB = {
  id: "c1",
  name: "Nightly",
  schedule: { type: "weekly", weekday: 1, hour: 17, minute: 30 },
  prompt: "go",
  cwd: "~",
  agentType: "claude",
  modelFamily: "opus",
  effort: "medium",
  permissionMode: "bypassPermissions",
  enabled: true,
  createdBy: "Tester",
  userId: "u1",
  username: "Tester",
  createdAt: 0,
  lastFireAt: null,
  nextFireAt: Date.now() + 20_000,
} as unknown as Cronjob;

// 12345 of 200000 tokens: five digits, so the grouping mark shows.
const battery = (language: Language) =>
  onLanguage(
    language,
    createElement(ContextBattery, {
      usage: {
        model: "opus",
        totalTokens: 12345,
        maxTokens: 200000,
        percentage: 6.2,
        sampledAtMs: 1,
      },
    }),
    { hasReceivedInitialState: true },
  );

// One anchor per surface, each a string only that surface shows.
const ANCHOR = {
  // The room tab bar's add-room control.
  newRoom: {
    ca: "Crea una sala nova",
    es: "Crear una sala nueva",
    en: "Create new room",
  },
  // The scene's zoom control.
  zoomIn: { ca: "Apropa", es: "Acercar", en: "Zoom in" },
  // The nameplate badge on an agent parked for an answer, which is the word
  // ui/pending-prompt.ts now supplies as a key.
  badge: { ca: "permís", es: "permiso", en: "permission" },
  // The agent list, which is the mobile face of the same room.
  noAgents: {
    ca: "Encara no hi ha agents",
    es: "Aún no hay agentes",
    en: "No agents yet",
  },
  // The task board's empty table.
  noTasks: { ca: "No hi ha tasques", es: "No hay tareas", en: "No tasks" },
  // Its quick-add field, which proves the board's chrome and not just a cell.
  quickAdd: {
    ca: "Afegeix una tasca ràpida…",
    es: "Añadir una tarea rápida…",
    en: "Quick add a task…",
  },
  // The apps page.
  noApps: {
    ca: "Encara no hi ha apps.",
    es: "Aún no hay apps.",
    en: "No apps yet.",
  },
  // The schedules page, which opens on its runs tab. Its schedules tab holds
  // the other empty state; this is the one the page shows on mount.
  noRuns: {
    ca: "Encara no hi ha execucions.",
    es: "Aún no hay ejecuciones.",
    en: "No runs yet.",
  },
  // The schedules tab's own control, which is how the test reaches the table.
  schedulesTab: { ca: "programacions", es: "programaciones", en: "schedules" },
  // A weekly schedule read through shared/i18n/schedule.ts: the sentence is a
  // catalog key and the weekday comes from Intl, not from a hand-written table.
  weeklySchedule: {
    ca: "Cada setmana, dl. a les 17:30",
    es: "Cada semana, lun a las 17:30",
    en: "Weekly Mon at 17:30",
  },
  // The next-run cell under a minute out. Intl has no reading for it, so the
  // caller passes the code fragment "<1m" INTO a catalog sentence - which is
  // what keeps the angle bracket out of the catalog (ruling 19).
  nextRunSoon: {
    ca: "d’aquí a <1m",
    es: "en <1m",
    en: "in <1m",
  },
  // The context battery's reading, by the button's title. It carries the
  // formatted token counts, so it is also where the number reaches the DOM.
  batteryDetail: {
    ca: "Context: 12.345 / 200.000 tokens utilitzats (en queda un 94%).",
    es: "Contexto: 12.345 / 200.000 tokens usados (queda un 94%).",
    en: "Context: 12,345 / 200,000 tokens used (94% left).",
  },
} as const;

// The grouping mark of each language, which es and ca share - so this is
// evidence about formatNumber, not about which language rendered.
const GROUPED = { ca: "12.345", es: "12.345", en: "12,345" } as const;

const shows = (view: View, text: string) =>
  expect(view.queryAllByText(text).length, text).toBeGreaterThan(0);
const titled = (view: View, text: string) =>
  expect(
    view.container.querySelectorAll(`[title="${text}"]`).length,
    text,
  ).toBeGreaterThan(0);

describe("the anchors", () => {
  it("differ between the three languages, so a match proves the language", () => {
    for (const [name, anchor] of Object.entries(ANCHOR))
      expect(new Set(Object.values(anchor)).size, name).toBe(3);
  });
});

describe("the office scene", () => {
  it("reads Catalan on ca, then Spanish, then the English of a user who never chose", () => {
    const view = render(officeView("ca"));
    titled(view, ANCHOR.newRoom.ca);
    titled(view, ANCHOR.zoomIn.ca);
    shows(view, ANCHOR.badge.ca);
    expect(view.queryByText(ANCHOR.badge.en)).toBeNull();

    view.rerender(officeView("es"));
    titled(view, ANCHOR.newRoom.es);
    titled(view, ANCHOR.zoomIn.es);
    shows(view, ANCHOR.badge.es);
    expect(view.queryByText(ANCHOR.badge.ca)).toBeNull();

    view.rerender(officeView(null));
    titled(view, ANCHOR.newRoom.en);
    titled(view, ANCHOR.zoomIn.en);
    shows(view, ANCHOR.badge.en);
    view.unmount();
  });
});

describe("the pages", () => {
  it("read the language on the task board, the apps page and the schedules page", () => {
    const tasks = render(taskView("ca"));
    shows(tasks, ANCHOR.noTasks.ca);
    expect(
      tasks.queryByPlaceholderText(ANCHOR.quickAdd.ca),
      "quick add",
    ).not.toBeNull();
    tasks.rerender(taskView("es"));
    shows(tasks, ANCHOR.noTasks.es);
    expect(tasks.queryByPlaceholderText(ANCHOR.quickAdd.es)).not.toBeNull();
    tasks.rerender(taskView(null));
    shows(tasks, ANCHOR.noTasks.en);
    expect(tasks.queryByPlaceholderText(ANCHOR.quickAdd.en)).not.toBeNull();
    tasks.unmount();

    const apps = render(appsView("ca"));
    shows(apps, ANCHOR.noApps.ca);
    apps.rerender(appsView("es"));
    shows(apps, ANCHOR.noApps.es);
    apps.rerender(appsView(null));
    shows(apps, ANCHOR.noApps.en);
    apps.unmount();

    const schedules = render(cronjobsView("ca"));
    shows(schedules, ANCHOR.noRuns.ca);
    schedules.rerender(cronjobsView("es"));
    shows(schedules, ANCHOR.noRuns.es);
    schedules.rerender(cronjobsView(null));
    shows(schedules, ANCHOR.noRuns.en);
    schedules.unmount();
  });
});

describe("the agent list", () => {
  it("reads the language on its own empty state", () => {
    const view = render(agentList("ca"));
    shows(view, ANCHOR.noAgents.ca);
    view.rerender(agentList("es"));
    shows(view, ANCHOR.noAgents.es);
    view.rerender(agentList(null));
    shows(view, ANCHOR.noAgents.en);
    view.unmount();
  });
});

describe("a number", () => {
  it("carries the reader's grouping mark all the way into the DOM", () => {
    for (const language of ["ca", "es", null] as const) {
      const code = language ?? "en";
      const view = render(battery(language));
      titled(view, ANCHOR.batteryDetail[code]);
      expect(view.container.innerHTML, code).toContain(GROUPED[code]);
      view.unmount();
    }
  });
});

// The schedules TAB, which the page does not open on. Its two cells are the
// repairs the PM ruled into S6 on Reviewer 2's escalation (2026-09-06): the
// schedule sentence, which used to come from a hand-written weekday table, and
// the next-run reading under a minute, whose "<1m" now reaches a catalog
// sentence as a value instead of living inside one.
describe("a schedules row", () => {
  const openSchedulesTab = (view: View, tabLabel: string) => {
    const tab = [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent === tabLabel,
    );
    expect(tab, tabLabel).toBeDefined();
    act(() => tab!.click());
  };

  it("reads its schedule and its next run in the reader's language", () => {
    for (const language of ["ca", "es", null] as const) {
      const code = language ?? "en";
      const view = render(cronjobsView(language, [CRONJOB]));
      openSchedulesTab(view, ANCHOR.schedulesTab[code]);
      shows(view, ANCHOR.weeklySchedule[code]);
      shows(view, ANCHOR.nextRunSoon[code]);
      view.unmount();
    }
  });
});
