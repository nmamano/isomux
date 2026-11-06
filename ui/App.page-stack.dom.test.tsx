// A page opened over a page the old fixed order ranked higher shows, and
// closes back to that page (task 3484f6c9): an ask chip on the Skills page
// opens the Inbox on top, Escape uncovers Skills, and a second Escape goes to
// the office. Pages stacked in the old order (Settings over Tasks over a chat)
// are in ui/App.stacked-pages.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { ask, boot, inboxOpen, setAsks, setExtraApi, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;
type SkillCatalogRes = import("../shared/contract-shapes.ts").SkillCatalogRes;

setUpInboxTests();

const ASK_ID = "a6b624d3";
const SKILL_PATH = "/h/.claude/skills/deploy/SKILL.md";
const catalog: SkillCatalogRes = {
  // In every engine, so the page's default "All agents" list shows it.
  engines: (["claude", "codex", "opencode"] as const).map((engine) => ({
    engine,
    skills: [
      {
        name: "deploy",
        source: "user",
        kind: "skill",
        path: SKILL_PATH,
        dir: "/h/.claude/skills",
        editable: true,
        uses: 0,
      },
    ],
  })),
  newSkillDir: "/h/.claude/skills",
  home: "/h",
};

// The Skills page's reads: its catalog, and the one skill, whose body names
// an open ask of the member's.
function serveSkills() {
  setExtraApi((method, path) => {
    if (method === "GET" && path === "/api/skills")
      return Promise.resolve(catalog);
    if (method === "GET" && path.startsWith("/api/skills/file?"))
      return Promise.resolve({
        path: SKILL_PATH,
        content: `---\ndescription: d\n---\nAnswer ${ASK_ID} before a deploy.\n`,
        rev: 1,
        mtime: 1,
        editable: true,
      });
    return undefined;
  });
}

const skillsOpen = (view: View) =>
  view.container.querySelector("[data-skills-page]") !== null;
const pinnedAsk = (view: View) =>
  view.container
    .querySelector("[data-asks-pinned]")
    ?.getAttribute("data-asks-pinned") ?? null;

async function press(key: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

it("opens the Inbox over Skills from an ask chip, and Escape uncovers Skills, then the office", async () => {
  setAsks([{ ...ask(ASK_ID, "a1"), prompt: "Deploy the new build now?" }]);
  serveSkills();
  const view = await boot("/skills");
  expect(skillsOpen(view)).toBe(true);
  const chip = await waitFor(() => {
    const found = view.container.querySelector<HTMLButtonElement>(
      `[data-skill-preview] button[data-ask-chip="${ASK_ID}"]`,
    );
    if (found === null) throw new Error("no ask chip in the skill yet");
    return found;
  });

  await act(async () => fireEvent.click(chip));
  expect(inboxOpen(view)).toBe(true);
  expect(skillsOpen(view)).toBe(false);
  expect(pinnedAsk(view)).toBe(ASK_ID);
  expect(window.location.pathname).toBe("/inbox/asks");

  await press("Escape");
  expect(inboxOpen(view)).toBe(false);
  expect(skillsOpen(view)).toBe(true);
  expect(window.location.pathname).toBe("/skills");

  await press("Escape");
  expect(skillsOpen(view)).toBe(false);
  expect(inboxOpen(view)).toBe(false);
  expect(window.location.pathname).toBe("/");
});

// A page's one-shot state lives while the page is in the stack, not only
// while it shows: Tasks over the Inbox keeps the Inbox's pinned ask.
it("keeps the Inbox's pinned ask under Tasks, and drops it when the Inbox closes", async () => {
  setAsks([{ ...ask(ASK_ID, "a1"), prompt: "Deploy the new build now?" }]);
  const view = await boot(`/inbox/asks/${ASK_ID}`);
  expect(pinnedAsk(view)).toBe(ASK_ID);

  await press("t");
  expect(view.container.querySelector("[data-tasks-page]")).not.toBeNull();
  expect(inboxOpen(view)).toBe(false);

  await press("Escape");
  expect(inboxOpen(view)).toBe(true);
  expect(pinnedAsk(view)).toBe(ASK_ID);

  // Closed and opened again, the Inbox pins nothing.
  await press("Escape");
  expect(inboxOpen(view)).toBe(false);
  await press("i");
  expect(inboxOpen(view)).toBe(true);
  expect(pinnedAsk(view)).toBeNull();
});
