import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, waitFor } = await import("@testing-library/react");
const { SkillsView } = await import("./SkillsView.tsx");
const { StoreProvider } = await import("../store.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { EditorView } = await import("@codemirror/view");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type Entry = import("../../shared/contract-shapes.ts").SkillCatalogEntry;
const path = "/home/member/.claude/skills/mine/SKILL.md";
const mine: Entry = {
  name: "mine",
  path,
  dir: "/home/member/.claude/skills",
  kind: "skill",
  source: "user",
  editable: true,
  uses: 0,
};
let entries: Entry[], deletes: unknown[], reads: number;
let answer: () => Promise<void>;
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
beforeEach(() => {
  entries = [
    mine,
    {
      ...mine,
      name: "command",
      path: "/home/member/.claude/commands/command.md",
      kind: "command",
    },
    {
      ...mine,
      name: "plugin",
      path: "/plugin/SKILL.md",
      source: "plugin",
      editable: false,
    },
  ];
  deletes = [];
  reads = 0;
  answer = async () => {
    entries = entries.filter((entry) => entry.path !== path);
  };
  localStorage.removeItem("isomux:skills:engine");
  setApiShim(async (method, url, body) => {
    if (method === "GET" && url === "/api/skills") {
      reads++;
      return {
        engines: ["claude", "codex", "opencode"].map((engine) => ({
          engine,
          skills: entries,
        })),
        newSkillDir: mine.dir,
        home: "/home/member",
      };
    }
    if (method === "GET" && url.startsWith("/api/skills/file?"))
      return {
        path: new URLSearchParams(url.split("?")[1]).get("path"),
        content: "---\nname: mine\ndescription: fixture\n---\nBody\n",
        rev: 7,
        mtime: 1,
        editable: true,
      };
    if (method === "DELETE" && url === "/api/skills/file") {
      deletes.push(body);
      return answer();
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
});
async function click(selector: string) {
  await act(async () => {
    const button = document.querySelector(selector) as HTMLElement;
    if (!button) throw new Error(`missing ${selector}`);
    button.click();
  });
}
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
  await click('[data-skill-row="mine"]');
  await waitFor(() =>
    expect(view.container.querySelector("[data-skill-delete]")).not.toBe(null),
  );
  return view;
}
it("cancel and stale delete keep the draft; successful delete removes the selection and refreshes the catalog", async () => {
  const view = await mount();
  await click("[data-skill-edit]");
  // The source editor's module (CodeMirror) loads when the editor first
  // mounts: wait for it.
  const cm = await waitFor(() => {
    const dom = view.container.querySelector(".cm-editor") as HTMLElement;
    const found = dom ? EditorView.findFromDOM(dom) : null;
    if (!found) throw new Error("no editor");
    return found;
  });
  await act(async () => {
    cm.dispatch({
      changes: { from: 0, to: cm.state.doc.length, insert: "unsaved draft" },
    });
  });
  await click("[data-skill-delete]");
  const dialog = view.getByRole("dialog");
  expect(dialog.textContent).toContain(mine.name);
  expect(dialog.textContent).toContain(
    translatorFor("en").t("skills.delete.folder"),
  );
  await click("[data-skill-delete-cancel]");
  expect(deletes).toHaveLength(0);
  expect(cm.state.doc.toString()).toBe("unsaved draft");
  answer = async () => {
    throw new ApiError(409, "stale", "changed");
  };
  await click("[data-skill-delete]");
  await click("[data-skill-delete-submit]");
  expect(
    document.querySelector("[data-skill-delete-problem]")?.textContent,
  ).toBe(translatorFor("en").t("skills.delete.stale"));
  expect(cm.state.doc.toString()).toBe("unsaved draft");
  expect(deletes).toEqual([{ path, expectedRev: 7 }]);
  answer = async () => {
    entries = entries.filter((entry) => entry.path !== path);
  };
  const readsBefore = reads;
  await click("[data-skill-delete-submit]");
  // The deleted skill's pane closes, so desktop opens the first skill left.
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-skill-detail="command"]'),
    ).not.toBe(null),
  );
  expect(view.container.querySelector('[data-skill-row="mine"]')).toBe(null);
  await waitFor(() => expect(reads).toBeGreaterThan(readsBefore));
  view.unmount();
});
it("leaves a newer selection open when a delete answer lands", async () => {
  const view = await mount();
  let finish!: () => void;
  answer = () =>
    new Promise<void>((resolve) => {
      finish = () => {
        entries = entries.filter((entry) => entry.path !== path);
        resolve();
      };
    });
  await click("[data-skill-delete]");
  await click("[data-skill-delete-submit]");
  await click('[data-skill-row="plugin"]');
  await waitFor(() =>
    expect(
      view.container.querySelector(
        '[data-skill-detail="plugin"] [data-skill-preview]',
      ),
    ).not.toBe(null),
  );
  const readsBefore = reads;
  await act(async () => finish());
  // A delete the server accepts refetches the catalog after it settles.
  await waitFor(() => expect(reads).toBeGreaterThan(readsBefore));
  expect(deletes).toEqual([{ path, expectedRev: 7 }]);
  expect(view.container.querySelector('[data-skill-detail="plugin"]')).not.toBe(
    null,
  );
  await click('[data-skill-row="command"]');
  await waitFor(() =>
    expect(
      view.container.querySelector(
        '[data-skill-detail="command"] [data-skill-preview]',
      ),
    ).not.toBe(null),
  );
  await click("[data-skill-delete]");
  expect(view.getByRole("dialog").textContent).toContain(
    translatorFor("en").t("skills.delete.command"),
  );
  await click("[data-skill-delete-cancel]");
  view.unmount();
});
