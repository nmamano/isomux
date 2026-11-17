// The Skills page keeps its layout while it loads (task 299d7b03, the UI rule
// in AGENTS.md). Before GET /api/skills answers, each engine tab draws its
// count span with the count it showed when it last loaded on this device, the
// list draws that tab's groups with one placeholder per stored row height, and
// the desktop detail draws its header, controls and body as placeholders.
// While a skill's file loads, the detail draws its real header and controls
// and a body placeholder. After a load the page stores what it drew.
//
// happy-dom lays nothing out: the stored heights are read from the
// placeholders' style, and the page measures rows and the detail through
// getBoundingClientRect, which this file stubs per element.
//
// Seam: SkillsView over setApiShim, under the real store reducer.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { SkillsView } = await import("./SkillsView.tsx");
const { setApiShim } = await import("../api.ts");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { SKILLS_LAYOUT_FALLBACK } = await import("../device-settings.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type SkillCatalogRes =
  import("../../shared/contract-shapes.ts").SkillCatalogRes;
type SkillsLayout = import("../device-settings.ts").SkillsLayout;

const en = translatorFor("en");
const LAYOUT_KEY = "isomux-skills-layout";
const ENGINE_KEY = "isomux:skills:engine";

const skill = (
  name: string,
  source: "user" | "isomux",
  editable = source === "user",
) => ({
  name,
  source,
  kind: "skill" as const,
  path: `/h/skills/${name}/SKILL.md`,
  dir: "/h/skills",
  editable,
  uses: 0,
});
// Shared by every engine: mine, other (user), grill-me (built in). Codex has
// one skill of its own.
const catalog: SkillCatalogRes = {
  engines: (["claude", "codex", "opencode"] as const).map((engine) => ({
    engine,
    skills: [
      skill("mine", "user"),
      skill("other", "user"),
      skill("grill-me", "isomux"),
      ...(engine === "codex" ? [skill("codex-only", "user")] : []),
    ],
  })),
  newSkillDir: "/h/skills",
  home: "/h",
};
const LOADED_COUNTS = { all: 3, claude: 0, codex: 1, opencode: 0 };
const ENGINE_TABS = ["all", "claude", "codex", "opencode"] as const;

// What the page measures: each row, the detail header and the controls row.
// The header of each skill has its own height, so a measure of the wrong
// skill shows in the stored value.
const ROW_HEIGHT: Record<string, number> = {
  mine: 61,
  other: 44,
  "grill-me": 52,
  "codex-only": 47,
};
const HEAD_HEIGHT: Record<string, number> = {
  mine: 90,
  other: 70,
  "grill-me": 120,
  "codex-only": 75,
};
const CONTROLS_HEIGHT = 30;
function heightOf(el: Element): number {
  const row = el.getAttribute("data-skill-row");
  if (row !== null) return ROW_HEIGHT[row] ?? 0;
  if (el.hasAttribute("data-skill-head")) {
    const name =
      el.closest("[data-skill-detail]")?.getAttribute("data-skill-detail") ??
      "";
    return HEAD_HEIGHT[name] ?? 0;
  }
  if (el.hasAttribute("data-skill-controls")) return CONTROLS_HEIGHT;
  return 0;
}
// happy-dom defines getBoundingClientRect on Element.prototype. Keep the
// prototype itself: the DOM harness removes the globals before afterAll runs.
const ElementProto = Element.prototype;
const boundsDesc = Object.getOwnPropertyDescriptor(
  ElementProto,
  "getBoundingClientRect",
);
beforeAll(() => {
  Object.defineProperty(ElementProto, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      const height = heightOf(this);
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 300,
        height,
        right: 300,
        bottom: height,
        toJSON: () => ({}),
      };
    },
  });
});
afterAll(() => {
  if (boundsDesc)
    Object.defineProperty(ElementProto, "getBoundingClientRect", boundsDesc);
  else Reflect.deleteProperty(ElementProto, "getBoundingClientRect");
  setApiShim(null);
});

// GET /api/skills and each file read wait until the test settles them.
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let catalogReads: Pending[] = [];
let fileReads: { path: string; p: Pending }[] = [];
let others: string[] = [];
function serve() {
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/skills")
      return new Promise((resolve, reject) =>
        catalogReads.push({ resolve, reject }),
      );
    if (method === "GET" && path.startsWith("/api/skills/file?")) {
      const p = new URLSearchParams(path.split("?")[1]).get("path") ?? "";
      return new Promise((resolve, reject) =>
        fileReads.push({ path: p, p: { resolve, reject } }),
      );
    }
    others.push(`${method} ${path}`);
    throw new Error(`no shim for ${method} ${path}`);
  });
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function answerCatalog() {
  await act(async () => catalogReads.shift()!.resolve(catalog));
  await settle();
}
async function failCatalog() {
  await act(async () => catalogReads.shift()!.reject(new Error("down")));
  await settle();
}
async function answerFile(name: string) {
  const i = fileReads.findIndex((r) => r.path.includes(`/${name}/`));
  expect(i).toBeGreaterThanOrEqual(0);
  const [read] = fileReads.splice(i, 1);
  await act(async () =>
    read!.p.resolve({
      path: read!.path,
      content: `---\ndescription: d\n---\n${name} body\n`,
      rev: 1,
      mtime: 1,
      editable: !read!.path.includes("grill-me"),
    }),
  );
  await settle();
}

function mount(isMobile: boolean) {
  function Harness() {
    const [state, dispatch] = useReducer(
      reducer,
      stateWithSelfUser("en", { hydrationEpoch: 1, isMobile }),
    );
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(
          LanguageProvider,
          null,
          createElement(SkillsView, { onClose: () => {} }),
        ),
      ),
    );
  }
  return render(createElement(Harness));
}

const q = (root: Element, sel: string) => root.querySelector<HTMLElement>(sel);
const qa = (root: Element, sel: string) => [
  ...root.querySelectorAll<HTMLElement>(sel),
];
const countSpan = (root: Element, tab: string) =>
  q(root, `[data-skill-engine="${tab}"] [data-skill-count]`);
const list = (root: Element) => q(root, "[data-skills-list]")!;
const placeholderRows = (root: Element) =>
  qa(root, "[data-skill-placeholder-row]");
const heldGroups = (root: Element) =>
  qa(list(root), "section[data-skill-group]").map((s) => ({
    source: s.getAttribute("data-skill-group"),
    rows: qa(s, "[data-skill-placeholder-row]").map((r) => r.style.height),
  }));
const stored = (): unknown =>
  JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
const seed = (l: SkillsLayout) =>
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));

const SEEDED: SkillsLayout = {
  counts: { all: 12, claude: 3, codex: 5, opencode: 0 },
  tab: "all",
  groups: [
    { source: "user", rows: [50, 60] },
    { source: "isomux", rows: [40] },
  ],
  detail: { head: 95, controls: 33 },
};

beforeEach(() => {
  localStorage.clear();
  catalogReads = [];
  fileReads = [];
  others = [];
  serve();
});
afterEach(() => {
  cleanup();
  // The page asks for nothing but the catalog and the files.
  expect(others).toEqual([]);
});

for (const isMobile of [false, true]) {
  describe(`while the catalog loads (${isMobile ? "phone" : "desktop"})`, () => {
    it("holds each tab's stored count in the span the real count lands in", async () => {
      seed(SEEDED);
      const view = mount(isMobile);
      await settle();
      expect(catalogReads).toHaveLength(1);

      const held = ENGINE_TABS.map((tab) => countSpan(view.container, tab));
      for (const [i, tab] of ENGINE_TABS.entries()) {
        const span = held[i];
        expect(span).not.toBe(null);
        expect(span!.textContent).toBe(String(SEEDED.counts[tab]));
        expect(span!.style.color).toBe("transparent");
        expect(span!.getAttribute("aria-hidden")).toBe("true");
      }

      await answerCatalog();
      for (const [i, tab] of ENGINE_TABS.entries()) {
        const span = countSpan(view.container, tab);
        // The same element, so the tab keeps its width.
        expect(span === held[i]).toBe(true);
        expect(span!.textContent).toBe(String(LOADED_COUNTS[tab]));
        expect(span!.style.color).not.toBe("transparent");
        expect(span!.getAttribute("aria-hidden")).toBe(null);
      }
    });

    it("holds the stored groups of the open tab, one placeholder per row height", async () => {
      seed(SEEDED);
      const view = mount(isMobile);
      await settle();

      expect(list(view.container).getAttribute("aria-busy")).toBe("true");
      expect(heldGroups(view.container)).toEqual([
        { source: "user", rows: ["50px", "60px"] },
        { source: "isomux", rows: ["40px"] },
      ]);
      // A placeholder is no control: it takes no focus and opens nothing.
      for (const row of placeholderRows(view.container)) {
        expect(row.tagName).toBe("DIV");
        expect(row.getAttribute("aria-hidden")).toBe("true");
      }
      expect(qa(view.container, "[data-skill-row]").length).toBe(0);
      expect(view.container.textContent).not.toContain(en.t("skills.empty"));

      await answerCatalog();
      expect(list(view.container).getAttribute("aria-busy")).toBe(null);
      expect(placeholderRows(view.container).length).toBe(0);
      expect(
        qa(list(view.container), "section[data-skill-group]").map((s) => [
          s.getAttribute("data-skill-group"),
          qa(s, "[data-skill-row]").length,
        ]),
      ).toEqual([
        ["user", 2],
        ["isomux", 1],
      ]);
    });

    it("holds the fallback groups when the stored groups belong to another tab", async () => {
      seed({ ...SEEDED, tab: "codex" });
      localStorage.setItem(ENGINE_KEY, "all");
      const view = mount(isMobile);
      await settle();

      expect(heldGroups(view.container)).toEqual(
        SKILLS_LAYOUT_FALLBACK.groups.map((g) => ({
          source: g.source,
          rows: g.rows.map((h) => `${h}px`),
        })),
      );
      // The counts belong to every tab: they hold whatever tab is open.
      expect(countSpan(view.container, "codex")!.textContent).toBe("5");
    });

    it("drops the placeholders and shows the error after a failed first load", async () => {
      seed(SEEDED);
      const view = mount(isMobile);
      await settle();
      expect(placeholderRows(view.container).length).toBe(3);

      await failCatalog();
      expect(view.container.textContent).toContain(en.t("skills.loadFailed"));
      expect(placeholderRows(view.container).length).toBe(0);
      expect(qa(view.container, "[data-skill-body-placeholder]").length).toBe(
        0,
      );
      expect(qa(view.container, '[aria-busy="true"]').length).toBe(0);
      for (const tab of ENGINE_TABS)
        expect(countSpan(view.container, tab)?.textContent ?? "").toBe("");
      // Nothing was drawn, so nothing is stored over the last good load.
      expect(stored()).toEqual(SEEDED);
    });
  });
}

describe("the detail (desktop)", () => {
  it("holds the stored header and controls heights and a body while the catalog loads", async () => {
    seed(SEEDED);
    const view = mount(false);
    await settle();

    const detail = q(view.container, '[data-skill-detail=""]');
    expect(detail).not.toBe(null);
    expect(q(detail!, "[data-skill-head]")!.style.height).toBe("95px");
    expect(q(detail!, "[data-skill-controls]")!.style.height).toBe("33px");
    expect(q(detail!, "[data-skill-body-placeholder]")).not.toBe(null);
  });

  it("holds the fallback detail when the stored layout has none", async () => {
    seed({ ...SEEDED, detail: null });
    const view = mount(false);
    await settle();
    const detail = q(view.container, '[data-skill-detail=""]')!;
    expect(detail).not.toBe(null);
    expect(q(detail, "[data-skill-head]")!.style.height).toBe(
      `${SKILLS_LAYOUT_FALLBACK.detail!.head}px`,
    );
    expect(q(detail, "[data-skill-controls]")!.style.height).toBe(
      `${SKILLS_LAYOUT_FALLBACK.detail!.controls}px`,
    );
  });

  it("draws the real header and controls and a body placeholder while a file loads", async () => {
    const view = mount(false);
    await settle();
    await answerCatalog();

    // The desktop opens the first skill; its file read waits.
    const opening = q(view.container, '[data-skill-detail="mine"]')!;
    expect(opening).not.toBe(null);
    expect(q(opening, "[data-skill-head]")).not.toBe(null);
    expect(q(opening, "[data-skill-path]")).not.toBe(null);
    expect(q(opening, "[data-skill-controls]")).not.toBe(null);
    expect(q(opening, "[data-skill-body-placeholder]")).not.toBe(null);
    expect(q(opening, "[data-skill-preview]")).toBe(null);
    const edit = q(opening, "[data-skill-edit]") as HTMLButtonElement;
    const del = q(opening, "[data-skill-delete]") as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(del.disabled).toBe(true);

    await answerFile("mine");
    const open = q(view.container, '[data-skill-detail="mine"]')!;
    expect(q(open, "[data-skill-body-placeholder]")).toBe(null);
    expect(q(open, "[data-skill-preview]")).not.toBe(null);
    expect((q(open, "[data-skill-edit]") as HTMLButtonElement).disabled).toBe(
      false,
    );

    // A click to another skill: the same held shape until its file lands.
    await act(async () =>
      q(view.container, '[data-skill-row="other"]')!.click(),
    );
    const next = q(view.container, '[data-skill-detail="other"]')!;
    expect(q(next, "[data-skill-controls]")).not.toBe(null);
    expect(q(next, "[data-skill-body-placeholder]")).not.toBe(null);
    expect((q(next, "[data-skill-edit]") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

it("on a phone, an opened skill holds its controls and body while the file loads", async () => {
  const view = mount(true);
  await settle();
  await answerCatalog();
  // The phone opens nothing on its own.
  expect(fileReads).toHaveLength(0);
  expect(q(view.container, "[data-skill-detail]")).toBe(null);

  await act(async () => q(view.container, '[data-skill-row="other"]')!.click());
  const detail = q(view.container, '[data-skill-detail="other"]')!;
  expect(q(detail, "[data-skill-head]")).not.toBe(null);
  expect(q(detail, "[data-skill-controls]")).not.toBe(null);
  expect(q(detail, "[data-skill-body-placeholder]")).not.toBe(null);

  await answerFile("other");
  expect(
    q(view.container, '[data-skill-detail="other"] [data-skill-preview]'),
  ).not.toBe(null);
});

describe("what the page stores", () => {
  // The rows as the list draws them, with the heights the page measures.
  const drawnGroups = (root: Element) =>
    qa(list(root), "section[data-skill-group]").map((s) => ({
      source: s.getAttribute("data-skill-group"),
      rows: qa(s, "[data-skill-row]").map(
        (r) => ROW_HEIGHT[r.getAttribute("data-skill-row")!],
      ),
    }));

  it("stores the counts, the open tab's rows and the auto-opened skill's detail after a load", async () => {
    const view = mount(false);
    await settle();
    await answerCatalog();
    await answerFile("mine");

    const groups = drawnGroups(view.container);
    expect(groups.map((g) => g.source)).toEqual(["user", "isomux"]);
    expect(stored()).toEqual({
      counts: LOADED_COUNTS,
      tab: "all",
      groups,
      detail: { head: HEAD_HEIGHT.mine, controls: CONTROLS_HEIGHT },
    });

    // Another skill's header is not the one the next load opens first.
    await act(async () =>
      q(view.container, '[data-skill-row="grill-me"]')!.click(),
    );
    await answerFile("grill-me");
    expect(
      q(view.container, '[data-skill-detail="grill-me"] [data-skill-preview]'),
    ).not.toBe(null);
    expect((stored() as SkillsLayout).detail).toEqual({
      head: HEAD_HEIGHT.mine,
      controls: CONTROLS_HEIGHT,
    });
  });

  it("stores the open engine tab's groups", async () => {
    localStorage.setItem(ENGINE_KEY, "codex");
    const view = mount(false);
    await settle();
    await answerCatalog();
    await answerFile("codex-only");

    expect(drawnGroups(view.container)).toEqual([
      { source: "user", rows: [ROW_HEIGHT["codex-only"]!] },
    ]);
    expect(stored()).toEqual({
      counts: LOADED_COUNTS,
      tab: "codex",
      groups: drawnGroups(view.container),
      detail: { head: HEAD_HEIGHT["codex-only"], controls: CONTROLS_HEIGHT },
    });
  });

  it("stores nothing new while a search filters the list or on the Commands tab", async () => {
    const view = mount(false);
    await settle();
    await answerCatalog();
    await answerFile("mine");
    // The load stored its layout: two groups.
    expect(stored()).not.toBe(null);
    expect((stored() as SkillsLayout).groups).toHaveLength(2);
    const before = JSON.stringify(stored());

    const search = q(view.container, "[data-skills-toolbar] input")!;
    await act(async () => {
      fireEvent.change(search, { target: { value: "grill" } });
    });
    await settle();
    // The search took: one group shows.
    expect(qa(list(view.container), "section[data-skill-group]").length).toBe(
      1,
    );
    expect(JSON.stringify(stored())).toBe(before);

    await act(async () => {
      fireEvent.change(search, { target: { value: "" } });
    });
    await act(async () =>
      q(view.container, '[data-skill-engine="commands"]')!.click(),
    );
    await settle();
    expect(
      q(view.container, '[data-skill-engine="commands"]')!.getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(JSON.stringify(stored())).toBe(before);
  });

  it("stores nothing for a load with a search typed while it waited", async () => {
    seed(SEEDED);
    const view = mount(false);
    await settle();
    const search = q(view.container, "[data-skills-toolbar] input")!;
    await act(async () => {
      fireEvent.change(search, { target: { value: "grill" } });
    });
    await answerCatalog();
    expect(qa(view.container, "[data-skill-row]").length).toBe(1);
    expect(stored()).toEqual(SEEDED);
  });
});
