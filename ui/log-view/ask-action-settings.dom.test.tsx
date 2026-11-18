// An action ask on a member's pack, preferences or room view, or on the
// office or backup settings (task e3d1bc63, part 3). Split from
// ui/log-view/ask-action.dom.test.tsx, which holds the agent-access cards and
// the credential actions; ui/log-view/ask-action-member.dom.test.tsx holds a
// member's rooms and role, and the room-view case with no settings to read.
// The office is in ui/test-support/ask-action-fixture.tsx.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { en } = await import("../../shared/i18n/en.ts");
const { flags, levelCard, member, memberAsk, mount, seeded, viewCard } =
  await import("../test-support/ask-action-fixture.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: string[] = [];
let answer: (path: string) => Promise<unknown> = async () => undefined;
// The answer to a GET (part 3: the office and backup settings a card reads).
let read: (path: string) => unknown = () => undefined;
beforeEach(() => {
  posts = [];
  answer = async () => undefined;
  read = () => undefined;
  setApiShim(async (method, path) => {
    if (method === "POST") {
      posts.push(path);
      return answer(path);
    }
    return read(path);
  });
});
afterAll(() => setApiShim(null));

// Part 3: the settings an agent cannot change. A single-value card (a pack,
// one room of a room list) marks the value now and asked for on the block,
// as above; a card for a set of settings has one row per key, each marked
// with data-ask-action-key and its value now and asked for.
const SETTINGS_ENTRIES: AskEntry[] = [
  // Dana gets a pack with an office ceiling.
  memberAsk("set00001", {
    kind: "member-pack",
    userId: "u3",
    pack: { areas: { tasks: "read" }, agentCeiling: "office" },
  }),
  // Morgan's own language and read-aloud voice.
  memberAsk("set00002", {
    kind: "member-preferences",
    set: { language: "es", voiceOutput: "openai" },
  }),
  // Morgan's room lists: hide Studio, tuck Garden, push Garden, stop
  // notifications for Studio, push Studio.
  memberAsk("set00003", {
    kind: "member-view",
    list: "shown",
    roomId: "r1",
    on: false,
  }),
  memberAsk("set00004", {
    kind: "member-view",
    list: "tucked",
    roomId: "r2",
    on: true,
  }),
  memberAsk("set00005", {
    kind: "member-view",
    list: "push",
    roomId: "r2",
    on: true,
  }),
  memberAsk("set00006", {
    kind: "member-view",
    list: "notif",
    roomId: "r1",
    on: false,
  }),
  memberAsk("set00007", {
    kind: "member-view",
    list: "push",
    roomId: "r1",
    on: true,
  }),
  memberAsk("set00008", {
    kind: "office-settings",
    set: {
      memberUsageShare: 30,
      processIsolation: true,
      recordTerminals: true,
      providerFallback: true,
    },
  }),
  memberAsk("set00009", {
    kind: "backup-settings",
    set: { dir: "/srv/backups", retention: 3 },
  }),
  memberAsk("set00010", {
    kind: "backup-settings",
    set: { intervalHours: 6 },
  }),
  // A room the office state does not have.
  memberAsk("set00011", {
    kind: "member-view",
    list: "notif",
    roomId: "r9",
    on: true,
  }),
];

const OFFICE_SETTINGS = {
  version: "v1",
  name: "Office",
  memberUsageCap: false,
  memberUsageShare: 50,
  recordTerminals: false,
  providerFallback: false,
  processIsolation: false,
  claudeIsomuxLabel: false,
};
const BACKUP_STATUS = {
  lastRunAt: null,
  ok: true,
  error: null,
  retention: 7,
  intervalHours: 24,
  destDir: "/home/morgan/isomux-backups",
  destDirFromEnv: false,
};
function readSettings() {
  read = (path) =>
    path.startsWith("/api/office/settings")
      ? OFFICE_SETTINGS
      : path.startsWith("/api/backup/status")
        ? BACKUP_STATUS
        : undefined;
}

// Morgan notifies and pushes Studio.
const MORGAN_NOTIFIED = {
  ...(member("u1", "Morgan", "owner", []) as object),
  notifRooms: ["r1"],
  pushRooms: ["r1"],
} as never;

async function mountSettings() {
  readSettings();
  const m = await mount(SETTINGS_ENTRIES);
  await act(async () => {
    seeded({ type: "user_admin_updated", user: MORGAN_NOTIFIED } as never);
  });
  return m;
}

// The rows of a settings card, by key: the value now and asked for.
const rows = (b: HTMLElement) =>
  Object.fromEntries(
    [...b.querySelectorAll<HTMLElement>("[data-ask-action-key]")].map((r) => [
      r.dataset.askActionKey,
      {
        current: r.dataset.askActionCurrent,
        requested: r.dataset.askActionRequested,
      },
    ]),
  );

it("a member-pack card names the member and shows the pack now and asked for, live", async () => {
  const { view, card, block, apply } = await mountSettings();
  const b = block("set00001")!;
  expect(b).not.toBe(null);
  expect({
    ...flags(b),
    member: b.textContent!.includes("Dana"),
    apply: apply("set00001") !== null,
    link: card("set00001").querySelector("[data-ask-office-link]") !== null,
  }).toEqual({
    current: "none",
    requested: "office",
    manager: false,
    selfDemote: false,
    gone: false,
    member: true,
    apply: true,
    link: false,
  });
  await act(async () => {
    seeded({
      type: "user_admin_updated",
      user: {
        ...(member("u3", "Dana", "member", []) as object),
        pack: { areas: { tasks: "read" }, agentCeiling: "folder" },
      },
    } as never);
  });
  expect(flags(block("set00001")!).current).toBe("folder");
  view.unmount();
});

it("a member-preferences card has one row per key, with the value now (the default when the record has none) and the value asked for", async () => {
  const { view, block, apply } = await mountSettings();
  expect(rows(block("set00002")!)).toEqual({
    language: { current: "en", requested: "es" },
    voiceOutput: { current: "browser", requested: "openai" },
  });
  expect(apply("set00002")).not.toBe(null);
  view.unmount();
});

it("a member-view card shows the room's view level now and the level after the step, and marks a change that stops the room's notifications or turns them on", async () => {
  const { view, block, apply } = await mountSettings();
  const views = ["set00003", "set00004", "set00005", "set00006", "set00007"];
  expect(
    views.map((id) => {
      const b = block(id)!;
      return {
        id,
        ...viewCard(b),
        alertsStop: b.hasAttribute("data-ask-action-alerts-stop"),
        notifOn: b.hasAttribute("data-ask-action-notif-on"),
      };
    }),
  ).toEqual([
    // Hiding Studio stops its notifications and pushes.
    {
      id: "set00003",
      ...levelCard("push", "hidden"),
      alertsStop: true,
      notifOn: false,
    },
    // Garden has none to stop.
    {
      id: "set00004",
      ...levelCard("shown", "tucked"),
      alertsStop: false,
      notifOn: false,
    },
    // A push for Garden turns its notifications on too.
    {
      id: "set00005",
      ...levelCard("shown", "push"),
      alertsStop: false,
      notifOn: true,
    },
    // Studio's notifications off stop its pushes: the server drops the push
    // with the sound, so Studio is Shown after, not Push.
    {
      id: "set00006",
      ...levelCard("push", "shown"),
      alertsStop: true,
      notifOn: false,
    },
    // Studio pushes already: the step is done, nothing else moves.
    {
      id: "set00007",
      ...levelCard("push", "push"),
      alertsStop: false,
      notifOn: false,
    },
  ]);
  // The meaning line explains the level asked for, not the one now, and the
  // name of the list the step changes is not a third value on the card.
  const hide = block("set00003")!.textContent!;
  expect([
    hide.includes(en["settings.room.viewLevelInfo.hidden"]),
    hide.includes(en["settings.room.viewLevelInfo.push"]),
  ]).toEqual([true, false]);
  const soundOff = block("set00006")!.textContent!;
  expect([
    soundOff.includes(en["settings.room.viewLevelInfo.shown"]),
    soundOff.includes(en["settings.room.viewLevel.notify"]),
  ]).toEqual([true, false]);
  expect(block("set00003")!.textContent).toContain("Studio");
  expect(block("set00005")!.textContent).toContain("Garden");
  // A room the office state does not have: gone, no Apply.
  expect(block("set00011")!.hasAttribute("data-ask-action-gone")).toBe(true);
  expect(apply("set00011")).toBe(null);
  // The levels and marks read the member's lists live.
  await act(async () => {
    seeded({
      type: "user_admin_updated",
      user: member("u1", "Morgan", "owner", []),
    } as never);
  });
  expect(block("set00003")!.hasAttribute("data-ask-action-alerts-stop")).toBe(
    false,
  );
  expect(viewCard(block("set00006")!)).toEqual(levelCard("shown", "shown"));
  view.unmount();
});

it("an office-settings card has one row per key with the office's value now, and a hint under each switch that changes what agents can do", async () => {
  const { view, block, apply } = await mountSettings();
  await waitFor(() =>
    expect(rows(block("set00008")!).memberUsageShare?.current).toBe("50"),
  );
  expect(rows(block("set00008")!)).toEqual({
    memberUsageShare: { current: "50", requested: "30" },
    processIsolation: { current: "false", requested: "true" },
    recordTerminals: { current: "false", requested: "true" },
    providerFallback: { current: "false", requested: "true" },
  });
  const hinted = [
    ...block("set00008")!.querySelectorAll<HTMLElement>(
      "[data-ask-action-key]",
    ),
  ]
    .filter((r) => r.querySelector("[data-ask-action-hint]") !== null)
    .map((r) => r.dataset.askActionKey)
    .sort();
  expect(hinted).toEqual([
    "processIsolation",
    "providerFallback",
    "recordTerminals",
  ]);
  expect(apply("set00008")).not.toBe(null);
  view.unmount();
});

it("a backup-settings card has one row per key with the value now, and says what a backup holds when the folder moves", async () => {
  const { view, block, apply } = await mountSettings();
  await waitFor(() =>
    expect(rows(block("set00009")!).retention?.current).toBe("7"),
  );
  expect(rows(block("set00009")!)).toEqual({
    dir: { current: "/home/morgan/isomux-backups", requested: "/srv/backups" },
    retention: { current: "7", requested: "3" },
  });
  // The full folder shows, not a short form.
  expect(block("set00009")!.textContent).toContain("/srv/backups");
  expect(
    ["set00009", "set00010"].map((id) =>
      block(id)!.hasAttribute("data-ask-action-backup-holds"),
    ),
  ).toEqual([true, false]);
  expect(rows(block("set00010")!)).toEqual({
    intervalHours: { current: "24", requested: "6" },
  });
  expect(apply("set00009")).not.toBe(null);
  view.unmount();
});

it("Apply on each settings card posts that ask's run once", async () => {
  const { view, apply } = await mountSettings();
  for (const id of [
    "set00001",
    "set00002",
    "set00003",
    "set00008",
    "set00009",
  ]) {
    await act(async () => {
      fireEvent.click(apply(id)!);
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toEqual([
    "/api/asks/set00001/action",
    "/api/asks/set00002/action",
    "/api/asks/set00003/action",
    "/api/asks/set00008/action",
    "/api/asks/set00009/action",
  ]);
  view.unmount();
});

it("an office-settings card reads the settings again when any office setting changes, not only the name", async () => {
  const { view, block } = await mountSettings();
  await waitFor(() =>
    expect(rows(block("set00008")!).memberUsageShare?.current).toBe("50"),
  );
  // Another owner sets the share by hand: the event carries the name and
  // instructions only, both as the state has them.
  const { office } = (await import("../store.tsx")).initialState;
  expect([office.name, office.prompt]).toEqual([null, null]);
  const changed = { ...OFFICE_SETTINGS, version: "v2", memberUsageShare: 70 };
  read = (path) =>
    path.startsWith("/api/office/settings") ? changed : undefined;
  await act(async () => {
    seeded({ type: "office_settings_updated", prompt: null, name: null });
  });
  await waitFor(() =>
    expect(rows(block("set00008")!).memberUsageShare?.current).toBe("70"),
  );
  view.unmount();
});
