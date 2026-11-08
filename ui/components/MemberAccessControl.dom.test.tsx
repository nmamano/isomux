// The member panel's one Access control (task 2c57281c): four levels on one
// line, Read only < Work with agents < Full access < Owner, with the agent
// ceiling and the per-area grid shown under every level, filled with the
// level's values. An edit of the shown values makes Custom (no step lit);
// setting it back by hand relights the preset. Full access lights only with
// no pack and Owner only with the owner role: a pack at every area write and
// agents up to Web is still a pack (no terminal, no Standard agents). An edit
// under Owner is a demote, saved as ONE PATCH with the role and the pack.
//
// Driven through UserSettingsView, the one user of the control. The control's
// markup: the section root carries data-member-access, the level line is a
// radio group with data-member-level, the ceiling one with
// data-member-ceiling, the grid's selects carry data-area, the Custom badge
// carries data-member-access-custom and the demote line
// data-member-access-demote.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { UserSettingsView } = await import("./UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { MEMBER_PACK_PRESETS } = await import("../../shared/pack-fit.ts");
const { API_TOKEN_AREAS } = await import("../../shared/api-token-limits.ts");

import type { MemberPack } from "../../shared/pack-fit.ts";
import type { UserRecord } from "../../shared/types.ts";

const { t } = translatorFor("en");

const READ_ONLY = MEMBER_PACK_PRESETS.readOnly;
const WITH_AGENTS = MEMBER_PACK_PRESETS.workWithAgents;
// What Full access and Owner show: every area at read and write, agents up
// to Web.
const ALL_WRITE: MemberPack = {
  areas: Object.fromEntries(API_TOKEN_AREAS.map((area) => [area, "write"])),
  agentCeiling: "web",
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}
const calls: Call[] = [];
// A refusal the next PATCH answers with, if set.
let patchRefusal: InstanceType<typeof ApiError> | null = null;

beforeEach(() => {
  window.localStorage.clear();
  calls.length = 0;
  patchRefusal = null;
  setApiShim(async (method, path, body) => {
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/removed-members") return { members: [] };
    if (path.endsWith("/instructions") && method === "GET")
      return { instructions: "", version: "1" };
    if (method === "GET") return {};
    calls.push({ method, path, body });
    if (method === "PATCH" && patchRefusal) throw patchRefusal;
    if (method === "POST" && path === "/api/users")
      return { user: { id: "u9" } };
    return {};
  });
});
afterAll(() => setApiShim(null));

const SELF = selfUserRecord("en");

function member(over: Partial<UserRecord> = {}): UserRecord {
  return {
    ...selfUserRecord("en"),
    id: "member-id",
    name: "Marc",
    role: "member",
    ...over,
  };
}

type View = ReturnType<typeof render>;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The settings page on `target`'s editor, viewed by the owner Tester.
async function open(target: UserRecord): Promise<View> {
  const users = new Map([[SELF.name.toLowerCase(), SELF]]);
  users.set(target.name.toLowerCase(), target);
  const view = render(
    onLanguage(
      "en",
      createElement(UserSettingsView, {
        initialUserId: target.id,
        onClose: () => {},
        onSwitchUser: () => {},
      }),
      { users, rooms: [], hasReceivedInitialState: true },
    ),
  );
  await settle();
  return view;
}

function section(view: View): HTMLElement {
  const el = view.container.querySelector<HTMLElement>("[data-member-access]");
  if (!el) throw new Error("no Access section");
  return el;
}

function levelGroup(view: View): HTMLElement {
  const el = section(view)
    .querySelector('[role="radio"][data-member-level]')
    ?.closest<HTMLElement>('[role="radiogroup"]');
  if (!el) throw new Error("no level line");
  return el;
}

function step(view: View, level: string): HTMLElement {
  const el = levelGroup(view).querySelector<HTMLElement>(
    `[role="radio"][data-member-level="${level}"]`,
  );
  if (!el) throw new Error(`no step ${level}`);
  return el;
}

// The lit level, or null when no step is lit (Custom).
function lit(view: View): string | null {
  const checked = levelGroup(view).querySelectorAll(
    '[role="radio"][aria-checked="true"]',
  );
  if (checked.length > 1) throw new Error("more than one step lit");
  return checked[0]?.getAttribute("data-member-level") ?? null;
}

const isCustom = (view: View) =>
  section(view).querySelector("[data-member-access-custom]") !== null;

function areaSelect(view: View, area: string): HTMLSelectElement {
  const el = section(view).querySelector<HTMLSelectElement>(
    `select[data-area="${area}"]`,
  );
  if (!el) throw new Error(`no select for ${area}`);
  return el;
}

function ceilingStep(view: View, stop: string): HTMLElement {
  const el = section(view).querySelector<HTMLElement>(
    `[role="radio"][data-member-ceiling="${stop}"]`,
  );
  if (!el) throw new Error(`no ceiling step ${stop}`);
  return el;
}

// The values the control shows: each area's select and the lit ceiling.
function shown(view: View): {
  areas: Record<string, string>;
  agentCeiling: string | null;
} {
  const areas: Record<string, string> = {};
  for (const area of API_TOKEN_AREAS)
    areas[area] = areaSelect(view, area).value;
  const ceiling = section(view).querySelector(
    '[role="radio"][data-member-ceiling][aria-checked="true"]',
  );
  return {
    areas,
    agentCeiling: ceiling?.getAttribute("data-member-ceiling") ?? null,
  };
}

// A pack as the control shows it: every area, "none" where the pack has none.
function asShown(pack: MemberPack): ReturnType<typeof shown> {
  const areas: Record<string, string> = {};
  for (const area of API_TOKEN_AREAS)
    areas[area] = pack.areas[area as keyof MemberPack["areas"]] ?? "none";
  return { areas, agentCeiling: pack.agentCeiling };
}

function withArea(pack: MemberPack, area: string, level: string): MemberPack {
  const areas = { ...pack.areas } as Record<string, string>;
  if (level === "none") delete areas[area];
  else areas[area] = level;
  return { ...pack, areas: areas as MemberPack["areas"] };
}

function saveButton(view: View): HTMLButtonElement {
  const el = view
    .getAllByRole("button")
    .find((b) =>
      [t("common.save"), t("common.saved")].includes(b.textContent ?? ""),
    );
  if (!el) throw new Error("no Save button");
  return el as HTMLButtonElement;
}

async function setArea(view: View, area: string, level: string) {
  await act(async () => {
    fireEvent.change(areaSelect(view, area), { target: { value: level } });
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

async function save(view: View) {
  await click(saveButton(view));
  await settle();
}

const writes = () => calls.filter((c) => c.method !== "GET");

describe("each level shows its values", () => {
  it("Full access, Read only, Work with agents and Owner each fill the ceiling and the grid", async () => {
    const view = await open(member());
    expect(lit(view)).toBe("full");
    expect(shown(view)).toEqual(asShown(ALL_WRITE));
    await click(step(view, "readOnly"));
    expect(lit(view)).toBe("readOnly");
    expect(shown(view)).toEqual(asShown(READ_ONLY));
    await click(step(view, "workWithAgents"));
    expect(lit(view)).toBe("workWithAgents");
    expect(shown(view)).toEqual(asShown(WITH_AGENTS));
    await click(step(view, "owner"));
    expect(lit(view)).toBe("owner");
    expect(shown(view)).toEqual(asShown(ALL_WRITE));
    expect(isCustom(view)).toBe(false);
  });
});

describe("an edit makes Custom, and setting it back relights the preset", () => {
  it("a saved pack equal to a preset loads lit; an area or ceiling edit flips to Custom seeded from the shown values; undoing it relights the preset with Save off", async () => {
    // The preset with its areas in the other key order: equal by value.
    const reordered: MemberPack = {
      agentCeiling: READ_ONLY.agentCeiling,
      areas: Object.fromEntries(
        Object.entries(READ_ONLY.areas).reverse(),
      ) as MemberPack["areas"],
    };
    const view = await open(member({ pack: reordered }));
    expect({ lit: lit(view), custom: isCustom(view) }).toEqual({
      lit: "readOnly",
      custom: false,
    });
    expect(saveButton(view).disabled).toBe(true);

    // The enabling condition: Read only gives tasks read, not write.
    expect(areaSelect(view, "tasks").value).toBe("read");
    await setArea(view, "tasks", "write");
    expect({ lit: lit(view), custom: isCustom(view) }).toEqual({
      lit: null,
      custom: true,
    });
    expect(shown(view)).toEqual(asShown(withArea(READ_ONLY, "tasks", "write")));
    expect(saveButton(view).disabled).toBe(false);
    await setArea(view, "tasks", "read");
    expect({ lit: lit(view), custom: isCustom(view) }).toEqual({
      lit: "readOnly",
      custom: false,
    });
    expect(saveButton(view).disabled).toBe(true);

    // The ceiling is a value of the level too.
    await click(ceilingStep(view, "office"));
    expect({ lit: lit(view), custom: isCustom(view) }).toEqual({
      lit: null,
      custom: true,
    });
    expect(shown(view)).toEqual(
      asShown({ ...READ_ONLY, agentCeiling: "office" }),
    );
    await click(ceilingStep(view, "chat"));
    expect(lit(view)).toBe("readOnly");
    expect(saveButton(view).disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("a step tap from Custom sets that preset's values, and Save sends them", async () => {
    const custom = withArea(READ_ONLY, "tasks", "write");
    const view = await open(member({ pack: custom }));
    expect({ lit: lit(view), custom: isCustom(view) }).toEqual({
      lit: null,
      custom: true,
    });
    expect(shown(view)).toEqual(asShown(custom));
    await click(step(view, "workWithAgents"));
    expect({ lit: lit(view), custom: isCustom(view) }).toEqual({
      lit: "workWithAgents",
      custom: false,
    });
    expect(shown(view)).toEqual(asShown(WITH_AGENTS));
    await save(view);
    expect(writes()).toEqual([
      {
        method: "PUT",
        path: "/api/users/Marc/access",
        body: expect.objectContaining({ pack: WITH_AGENTS }),
      },
    ]);
  });
});

describe("Full access and Owner light by role, not by value", () => {
  it("a saved pack at every area write and agents up to Web loads as Custom, and the form is clean", async () => {
    const view = await open(member({ pack: ALL_WRITE }));
    expect({ lit: lit(view), custom: isCustom(view) }).toEqual({
      lit: null,
      custom: true,
    });
    expect(shown(view)).toEqual(asShown(ALL_WRITE));
    expect(saveButton(view).disabled).toBe(true);
  });

  it("an edit under Full access set back by hand stays Custom and would save a pack; the Full access step clears it", async () => {
    const view = await open(member());
    expect(lit(view)).toBe("full");
    await setArea(view, "tasks", "read");
    await setArea(view, "tasks", "write");
    expect({ lit: lit(view), custom: isCustom(view) }).toEqual({
      lit: null,
      custom: true,
    });
    expect(shown(view)).toEqual(asShown(ALL_WRITE));
    // The values equal Full access's, but they are a pack now.
    expect(saveButton(view).disabled).toBe(false);
    await click(step(view, "full"));
    expect(lit(view)).toBe("full");
    expect(saveButton(view).disabled).toBe(true);
    expect(writes()).toEqual([]);
  });
});

describe("an edit under Owner is a demote", () => {
  it("shows the demote line and saves role member with the pack in one PATCH, with no access PUT", async () => {
    const view = await open(member({ name: "Olive", role: "owner" }));
    expect(lit(view)).toBe("owner");
    expect(shown(view)).toEqual(asShown(ALL_WRITE));
    expect(
      section(view).querySelector("[data-member-access-demote]"),
    ).toBeNull();
    await setArea(view, "tasks", "read");
    expect({ lit: lit(view), custom: isCustom(view) }).toEqual({
      lit: null,
      custom: true,
    });
    expect(
      section(view).querySelector("[data-member-access-demote]"),
    ).not.toBeNull();
    await save(view);
    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: "/api/users/Olive",
        body: expect.objectContaining({
          role: "member",
          pack: withArea(ALL_WRITE, "tasks", "read"),
        }),
      },
    ]);
  });

  it("on the viewer's own row, a refused demote shows the refusal and writes nothing else", async () => {
    const message = "the office must keep an owner (test refusal)";
    const view = await open(SELF);
    expect(lit(view)).toBe("owner");
    patchRefusal = new ApiError(409, "last_owner", message);
    await setArea(view, "tasks", "read");
    await save(view);
    // The one write is the refused PATCH: no access PUT before or after it.
    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: `/api/users/${SELF.name}`,
        body: expect.objectContaining({ role: "member" }),
      },
    ]);
    expect(within(view.container).getByText(message)).toBeTruthy();
    // The draft stays, so the owner can set it back.
    expect({
      custom: isCustom(view),
      dirty: !saveButton(view).disabled,
    }).toEqual({ custom: true, dirty: true });
  });
});

describe("the keyboard", () => {
  it("after an edit, the step the edit left is the tabbable one and the arrows move from it", async () => {
    const view = await open(member({ pack: WITH_AGENTS }));
    await setArea(view, "tasks", "read");
    expect(lit(view)).toBeNull();
    const tabbable = [
      ...levelGroup(view).querySelectorAll('[role="radio"][tabindex="0"]'),
    ].map((el) => el.getAttribute("data-member-level"));
    expect(tabbable).toEqual(["workWithAgents"]);
    await act(async () => {
      fireEvent.keyDown(step(view, "workWithAgents"), { key: "ArrowLeft" });
    });
    expect(lit(view)).toBe("readOnly");
    expect(shown(view)).toEqual(asShown(READ_ONLY));
    await act(async () => {
      fireEvent.keyDown(step(view, "readOnly"), { key: "ArrowRight" });
    });
    expect(lit(view)).toBe("workWithAgents");
    expect(shown(view)).toEqual(asShown(WITH_AGENTS));
  });
});

describe("a new member", () => {
  it("is created with the picked level's role and pack in one POST", async () => {
    const users = new Map([[SELF.name.toLowerCase(), SELF]]);
    const view = render(
      onLanguage(
        "en",
        createElement(UserSettingsView, {
          onClose: () => {},
          onSwitchUser: () => {},
        }),
        { users, rooms: [], hasReceivedInitialState: true },
      ),
    );
    await settle();
    const members = view.container.querySelector(
      '[data-sidebar-group-toggle="members"][aria-expanded="false"]',
    );
    if (members) await click(members as HTMLElement);
    await click(
      view.getByRole("button", { name: t("settings.members.newMember") }),
    );
    const detail = view.getByTestId("settings-content");
    expect(lit(view)).toBe("full");
    await click(step(view, "workWithAgents"));
    fireEvent.change(detail.querySelector("input")!, {
      target: { value: "Pia" },
    });
    await click(
      within(detail).getByRole("button", {
        name: t("settings.members.create"),
      }),
    );
    expect(writes()).toEqual([
      {
        method: "POST",
        path: "/api/users",
        body: expect.objectContaining({
          name: "Pia",
          role: "member",
          pack: WITH_AGENTS,
        }),
      },
    ]);
  });
});
