// Agent-dialog translations and costume behavior split from
// dialogs.i18n.dom.test.tsx.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

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
  spawnTitle: {
    ca: "Crear un agent nou",
    es: "Crear un agente nuevo",
    en: "Spawn New Agent",
  },
  identity: {
    ca: "Instruccions i memòria",
    es: "Instrucciones y memoria",
    en: "Instructions and memory",
  },
  access: {
    ca: "Accés i ubicació",
    es: "Acceso y ubicación",
    en: "Access and location",
  },
  blank: { ca: "En blanc", es: "En blanco", en: "Blank" },
  codeReviewer: {
    ca: "Revisor de codi",
    es: "Revisor de código",
    en: "Code Reviewer",
  },
  permissionMode: {
    ca: "Mode de permisos",
    es: "Modo de permisos",
    en: "Permission Mode",
  },
  permissionDefault: {
    ca: "Per defecte (preguntar per a tot)",
    es: "Por defecto (preguntar para todo)",
    en: "Default (ask for everything)",
  },
  permissionBypass: {
    ca: "Ometre els permisos (s'aprova tot automàticament)",
    es: "Omitir permisos (se aprueba todo automáticamente)",
    en: "Bypass (auto-approve all)",
  },
  effortXhigh: { ca: "Molt alt", es: "Muy alto", en: "Extra high" },
  expandInstructions: {
    ca: "Amplia Instruccions personalitzades",
    es: "Ampliar Instrucciones personalizadas",
    en: "Expand Custom Instructions",
  },
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

it("uses distinct anchors in all three tested languages", () => {
  for (const [name, anchor] of Object.entries(ANCHOR))
    expect(new Set(Object.values(anchor)).size, name).toBe(3);
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
  checkCostume(view, "Disfressa", "Treballador de la construcció");

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
