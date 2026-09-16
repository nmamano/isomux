// Agent-dialog translations and costume behavior split from
// dialogs.i18n.dom.test.tsx.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFrom,
  translationsFor,
} from "./test-support/i18n.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./components/EditAgentDialog.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;
type Language = "ca" | "es" | null;

setApiShim(async (_method, path) => {
  if (path === "/api/validate/cwd") return { ok: true };
  throw new Error(`no shim for ${path}`);
});
afterAll(() => setApiShim(null));

const ROOM = {
  id: "r1",
  name: "Sala Nord",
  prompt: null,
  canCloseWhenEmpty: true,
};
const agentDialog = (language: Language) =>
  onLanguage(
    language,
    createElement(EditAgentDialog, {
      onClose: () => {},
      deskIndex: 2,
      roomId: ROOM.id,
      defaultCwd: "~",
      spawnAgentType: "claude" as const,
    }),
    { rooms: [ROOM], hasReceivedInitialState: true },
  );
const ANCHOR = {
  spawnTitle: translationsFor("dialogs.agent.titleSpawn"),
  identity: translationsFor("common.instructionsAndMemory"),
  access: translationsFor("dialogs.agent.group.access"),
  blank: translationsFor("dialogs.agent.blank"),
  codeReviewer: translationsFor("templates.codeReviewer.label"),
  permissionMode: translationsFor("common.field.permissionMode"),
  permissionDefault: translationsFor("dialogs.agent.permission.claudeDefault"),
  permissionBypass: translationsFor("common.permission.claudeBypass"),
  effortXhigh: translationsFor("common.effort.xhigh"),
  expandInstructions: translationsFrom(({ t }) =>
    t("dialogs.textarea.expand", {
      title: t("dialogs.agent.customInstructions"),
    }),
  ),
  costume: translationsFor("dialogs.agent.costume"),
  construction: translationsFor("dialogs.agent.costume.construction"),
} as const;

const shows = (view: View, text: string) =>
  expect(view.queryAllByText(text).length, text).toBeGreaterThan(0);
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function checkCostume(view: View, label: string, construction: string): void {
  const group = view.getByRole("group", { name: new RegExp(`^${label} · `) });
  const buttons = Array.from(group.querySelectorAll("button"));
  const selected = buttons.find(
    (button) => button.getAttribute("aria-label") === construction,
  )!;
  expect(selected !== undefined).toBe(true);
  act(() => selected.click());
  const preview = () =>
    view.container.querySelector("[data-outfit-preview]") as HTMLElement;
  expect(
    preview().querySelector('[data-costume-body="construction"]') !== null,
  ).toBe(true);
  act(() => buttons[0].click());
  expect(preview().querySelector("[data-costume-body]") === null).toBe(true);
}

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

it("reads Catalan, Spanish and default English, including the costume picker", async () => {
  const view = render(agentDialog("ca"));
  shows(view, ANCHOR.spawnTitle.ca);
  shows(view, ANCHOR.identity.ca);
  shows(view, ANCHOR.blank.ca);
  shows(view, ANCHOR.codeReviewer.ca);
  shows(view, ANCHOR.permissionMode.ca);
  shows(view, ANCHOR.permissionDefault.ca);
  shows(view, ANCHOR.permissionBypass.ca);
  shows(view, ANCHOR.effortXhigh.ca);
  expect(view.queryByLabelText(ANCHOR.expandInstructions.ca)).not.toBeNull();
  expect(view.queryByText(ANCHOR.spawnTitle.en)).toBeNull();
  checkCostume(view, ANCHOR.costume.ca, ANCHOR.construction.ca);

  view.rerender(agentDialog("es"));
  shows(view, ANCHOR.spawnTitle.es);
  shows(view, ANCHOR.identity.es);
  shows(view, ANCHOR.access.es);

  view.rerender(agentDialog(null));
  shows(view, ANCHOR.spawnTitle.en);
  shows(view, ANCHOR.identity.en);
  shows(view, ANCHOR.blank.en);
  shows(view, ANCHOR.codeReviewer.en);
  shows(view, ANCHOR.permissionDefault.en);
  shows(view, ANCHOR.permissionBypass.en);
  shows(view, ANCHOR.effortXhigh.en);
  expect(view.queryByText(ANCHOR.blank.ca)).toBeNull();
  await settle();
});
