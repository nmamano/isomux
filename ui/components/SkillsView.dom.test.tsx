// The Skills page with the real store and the api shim: a built-in skill has
// no Edit control, a save sends the revision the page read, and a stale save
// keeps the member's text in the editor and says why it was not saved.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render, waitFor } = await import("@testing-library/react");
const { SkillsView } = await import("./SkillsView.tsx");
const { StoreProvider } = await import("../store.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { connect, setShim } = await import("../ws.ts");
const { EditorView } = await import("@codemirror/view");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { ENGINE_NAMES } = await import("../../shared/types.ts");
const ENGINE_NAMES_KEYS = Object.keys(
  ENGINE_NAMES,
) as (keyof typeof ENGINE_NAMES)[];
const { commands } = await import("../../shared/commands.ts");
const { skillFileProblem } = await import("../../shared/skill-validation.ts");
type SkillCatalogRes =
  import("../../shared/contract-shapes.ts").SkillCatalogRes;

setShim(() => {});
afterAll(() => {
  setApiShim(null);
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});

const USER_PATH = "/h/.claude/skills/mine/SKILL.md";
const OTHER_PATH = "/h/.claude/skills/other/SKILL.md";
const BUILTIN_PATH = "/opt/isomux/skills/grill-me/SKILL.md";
const CODEX_PATH = "/h/.codex/skills/codex-only/SKILL.md";
const catalog: SkillCatalogRes = {
  engines: (["claude", "codex", "opencode"] as const).map((engine) => ({
    engine,
    skills: [
      {
        name: "mine",
        source: "user",
        kind: "skill",
        path: USER_PATH,
        dir: "/h/.claude/skills",
        editable: true,
        uses: 3,
      },
      {
        name: "other",
        source: "user",
        kind: "skill",
        path: OTHER_PATH,
        dir: "/h/.claude/skills",
        editable: true,
        uses: 0,
      },
      {
        name: "grill-me",
        source: "isomux",
        kind: "skill",
        path: BUILTIN_PATH,
        dir: "/opt/isomux/skills",
        editable: false,
        uses: 0,
      },
      ...(engine === "codex"
        ? [
            {
              name: "codex-only",
              source: "user" as const,
              kind: "skill" as const,
              path: CODEX_PATH,
              dir: "/h/.codex/skills",
              editable: true,
              uses: 0,
            },
          ]
        : []),
    ],
  })),
  newSkillDir: "/h/.claude/skills",
  home: "/h",
};

let puts: unknown[] = [];
let catalogReads = 0;
let putAnswer: () => unknown = () => ({ path: USER_PATH, rev: 2, mtime: 2 });
beforeEach(() => {
  puts = [];
  catalogReads = 0;
  localStorage.removeItem("isomux:skills:engine");
  setApiShim(async (method, path, body) => {
    if (method === "GET" && path === "/api/skills") {
      catalogReads++;
      return catalog;
    }
    if (method === "GET" && path.startsWith("/api/skills/file?")) {
      const p = new URLSearchParams(path.split("?")[1]).get("path");
      return {
        path: p,
        content:
          p === USER_PATH
            ? "---\ndescription: d\n---\nold body\n"
            : p === OTHER_PATH
              ? "---\ndescription: o\n---\nother body\n"
              : "---\ndescription: g\n---\ngrill body\n",
        rev: 1,
        mtime: 1,
        editable: p !== BUILTIN_PATH,
      };
    }
    if (method === "PUT" && path === "/api/skills/file") {
      puts.push(body);
      return putAnswer();
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

async function mount() {
  const view = render(
    <StoreProvider>
      <SkillsView onClose={() => {}} />
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelector('[data-skill-row="mine"]')).not.toBe(
      null,
    ),
  );
  return view;
}

async function open(view: ReturnType<typeof render>, name: string) {
  await act(async () => {
    (
      view.container.querySelector(
        `[data-skill-row="${name}"]`,
      ) as HTMLButtonElement
    ).click();
  });
  await waitFor(() =>
    expect(
      view.container.querySelector(
        `[data-skill-detail="${name}"] [data-skill-preview]`,
      ),
    ).not.toBe(null),
  );
}

// The source editor's module (CodeMirror) loads when the editor first mounts,
// so wait for it: in a file run alone, no earlier test has loaded it.
async function editor(view: ReturnType<typeof render>) {
  return await waitFor(() => {
    const dom = view.container.querySelector(".cm-editor") as HTMLElement;
    const cm = dom ? EditorView.findFromDOM(dom) : null;
    if (!cm) throw new Error("no editor");
    return cm;
  });
}

it("shows a built-in skill read-only, without an Edit control", async () => {
  const view = await mount();
  await open(view, "grill-me");
  expect(view.container.querySelector("[data-skill-edit]")).toBe(null);
  expect(view.container.querySelector("[data-skill-delete]")).toBe(null);
  expect(view.container.querySelector("[data-skill-preview]")).not.toBe(null);
  await act(async () => {
    view
      .getByRole("tab", { name: translatorFor("en").t("skills.view.source") })
      .click();
  });
  // The source editor's module loads when the tab first opens.
  await waitFor(() =>
    expect(
      view.container
        .querySelector("[data-skill-source]")
        ?.getAttribute("data-editable"),
    ).toBe("false"),
  );
  view.unmount();
});

it("keeps the member's text and explains a stale save", async () => {
  putAnswer = () => {
    throw new ApiError(409, "stale", "changed", { currentRev: 5 });
  };
  const view = await mount();
  await open(view, "mine");
  await act(async () => {
    (
      view.container.querySelector("[data-skill-edit]") as HTMLButtonElement
    ).click();
  });
  const cm = await editor(view);
  await act(async () => {
    cm.dispatch({
      changes: { from: cm.state.doc.length, insert: "my edit\n" },
    });
  });
  await act(async () => {
    (
      view.container.querySelector("[data-skill-save]") as HTMLButtonElement
    ).click();
  });
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-skill-save-problem="stale"]'),
    ).not.toBe(null),
  );
  expect(puts).toEqual([
    {
      path: USER_PATH,
      content: "---\ndescription: d\n---\nold body\nmy edit\n",
      expectedRev: 1,
    },
  ]);
  // Still editing, with the edit intact.
  expect((await editor(view)).state.doc.toString()).toContain("my edit");
  expect(
    view.container
      .querySelector("[data-skill-source]")
      ?.getAttribute("data-editable"),
  ).toBe("true");
  view.unmount();
});

it("leaves edit mode after a save the server accepts", async () => {
  putAnswer = () => ({ path: USER_PATH, rev: 2, mtime: 2 });
  const view = await mount();
  await open(view, "mine");
  await act(async () => {
    (
      view.container.querySelector("[data-skill-edit]") as HTMLButtonElement
    ).click();
  });
  const cm = await editor(view);
  await act(async () => {
    cm.dispatch({ changes: { from: 0, insert: "x" } });
  });
  await act(async () => {
    (
      view.container.querySelector("[data-skill-save]") as HTMLButtonElement
    ).click();
  });
  await waitFor(() =>
    expect(
      view.container
        .querySelector("[data-skill-source]")
        ?.getAttribute("data-editable"),
    ).toBe("false"),
  );
  expect(puts).toHaveLength(1);
  expect(view.container.querySelector("[data-skill-save-problem]")).toBe(null);
  view.unmount();
});

// A PUT whose answer the test releases by hand.
function deferredPut() {
  let release: (v: unknown) => void = () => {};
  putAnswer = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  return () => release({ path: USER_PATH, rev: 2, mtime: 2 });
}

async function startEditing(view: ReturnType<typeof render>, text: string) {
  await open(view, "mine");
  await act(async () => {
    (
      view.container.querySelector("[data-skill-edit]") as HTMLButtonElement
    ).click();
  });
  const cm = await editor(view);
  await act(async () => {
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: text } });
  });
}

async function clickSave(view: ReturnType<typeof render>) {
  await act(async () => {
    (
      view.container.querySelector("[data-skill-save]") as HTMLButtonElement
    ).click();
  });
}

it("keeps text typed while a save is in flight", async () => {
  const release = deferredPut();
  const view = await mount();
  await startEditing(view, "first\n");
  await clickSave(view);
  const cm = await editor(view);
  await act(async () => {
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: "later\n" } });
  });
  const readsBefore = catalogReads;
  await act(async () => {
    release();
  });
  // An accepted save refetches the catalog after it settles the editor.
  await waitFor(() => expect(catalogReads).toBeGreaterThan(readsBefore));
  expect(puts).toHaveLength(1);
  expect((await editor(view)).state.doc.toString()).toContain("first\nlater\n");
  expect(
    view.container
      .querySelector("[data-skill-source]")
      ?.getAttribute("data-editable"),
  ).toBe("true");
  view.unmount();
});

it("drops a save answer that lands after the member opened another skill", async () => {
  const release = deferredPut();
  const view = await mount();
  await startEditing(view, "first\n");
  await clickSave(view);
  // The draft is unsaved, so opening another skill asks first.
  await act(async () => {
    (
      view.container.querySelector(
        '[data-skill-row="other"]',
      ) as HTMLButtonElement
    ).click();
  });
  const discard = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent === translatorFor("en").t("common.discard"),
  );
  if (!discard) throw new Error("no discard prompt");
  await act(async () => {
    discard.click();
  });
  const remove = await waitFor(() => {
    const button = view.container.querySelector<HTMLButtonElement>(
      '[data-skill-detail="other"] [data-skill-delete]',
    );
    if (!button) throw new Error("other skill not open");
    return button;
  });
  // Delete stays disabled while the save is in flight.
  expect(remove.disabled).toBe(true);
  await act(async () => {
    release();
  });
  await waitFor(() => expect(remove.disabled).toBe(false));
  const detail = view.container.querySelector('[data-skill-detail="other"]');
  expect(detail?.querySelector("[data-skill-preview]")?.textContent).toContain(
    "other body",
  );
  expect(
    detail?.querySelector("[data-skill-preview]")?.textContent,
  ).not.toContain("first");
  view.unmount();
});

it("keeps a broken disk file editable and keeps the draft when validation refuses a save", async () => {
  putAnswer = () => {
    throw new ApiError(422, "invalid_skill", "invalid metadata");
  };
  const view = await mount();
  await open(view, "mine");
  expect(view.container.querySelector("[data-skill-file-problem]")).not.toBe(
    null,
  );
  await act(async () => {
    (
      view.container.querySelector("[data-skill-edit]") as HTMLButtonElement
    ).click();
  });
  const cm = await editor(view);
  await act(async () => {
    cm.dispatch({
      changes: { from: 0, to: cm.state.doc.length, insert: "broken draft" },
    });
  });
  await clickSave(view);
  // The page names the rule the draft breaks, not the server's message.
  const problem = await waitFor(() => {
    const el = view.container.querySelector(
      '[data-skill-save-problem="error"]',
    );
    if (!el) throw new Error("no save problem");
    return el;
  });
  expect(problem.textContent).toBe(
    translatorFor("en").t(
      skillFileProblem("broken draft") ?? "common.saveFailed",
    ),
  );
  expect((await editor(view)).state.doc.toString()).toBe("broken draft");
  expect(
    view.container
      .querySelector("[data-skill-source]")
      ?.getAttribute("data-editable"),
  ).toBe("true");
  expect(view.container.querySelector("[data-skill-delete]")).not.toBe(null);
  expect(puts).toHaveLength(1);
  view.unmount();
});

async function openTab(view: ReturnType<typeof render>, tab: string) {
  await act(async () => {
    (
      view.container.querySelector(
        `[data-skill-engine="${tab}"]`,
      ) as HTMLButtonElement
    ).click();
  });
}

it("keeps shared skills out of the engine tabs and returns to the shared list", async () => {
  const view = await mount();
  expect(view.container.querySelector('[data-skill-row="codex-only"]')).toBe(
    null,
  );
  await openTab(view, "codex");
  expect(
    view.container.querySelector('[data-skill-row="codex-only"]'),
  ).not.toBe(null);
  expect(view.container.querySelector('[data-skill-row="mine"]')).toBe(null);
  await openTab(view, "all");
  await waitFor(() =>
    expect(view.container.querySelector('[data-skill-row="mine"]')).not.toBe(
      null,
    ),
  );
  view.unmount();
});

it("lists office commands read-only, with aliases and engine lines", async () => {
  const view = await mount();
  await openTab(view, "commands");
  const commandList = view.container.querySelector("[data-office-commands]");
  const supported = Object.entries(commands).filter(
    ([, config]) => config.supported,
  );
  const listed = supported.filter(([, config]) => !config.aliasFor);
  expect(commandList?.querySelectorAll("[data-office-command]")).toHaveLength(
    listed.length,
  );
  const clear = commandList?.querySelector('[data-office-command="clear"]');
  expect(clear?.textContent).toContain(
    translatorFor("en").t("commands.clear.description"),
  );
  // An alias shows on its command's row, never as a row of its own.
  for (const [alias, config] of supported.filter(([, c]) => c.aliasFor)) {
    const row = commandList?.querySelector(
      `[data-office-command="${config.aliasFor}"]`,
    );
    expect(row?.querySelector("[data-command-aliases]")?.textContent).toContain(
      `/${alias}`,
    );
    expect(commandList?.querySelector(`[data-office-command="${alias}"]`)).toBe(
      null,
    );
  }
  // Engine built-ins Isomux passes through are listed with the engines that
  // run them; a command every engine runs has no engine line.
  expect(clear?.querySelector("[data-command-engines]")).toBe(null);
  const engineBound = listed.filter(([, config]) => config.engines);
  expect(engineBound.length).toBeGreaterThan(0);
  for (const [name, config] of engineBound) {
    const line = commandList
      ?.querySelector(`[data-office-command="${name}"]`)
      ?.querySelector("[data-command-engines]")?.textContent;
    for (const engine of ENGINE_NAMES_KEYS)
      if (config.engines?.includes(engine))
        expect(line).toContain(ENGINE_NAMES[engine]);
      else expect(line).not.toContain(ENGINE_NAMES[engine]);
  }
  expect(
    commandList?.querySelector("button, input, textarea, [contenteditable]"),
  ).toBe(null);
  expect(view.container.querySelector("[data-skill-edit]")).toBe(null);
  expect(view.container.querySelector("[data-skill-delete]")).toBe(null);
  view.unmount();
});
