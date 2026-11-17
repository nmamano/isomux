// One save footer for every Settings part that saves (task f0d50877): the
// sections of the member's own settings that saved through a Save of their
// own - Language and chat (blue Save, enabled on open for an English
// browser), Recording mode (gray Save) and Device label (inline Cancel and
// Save). Each now uses the footer every part uses
// (ui/test-support/save-footer-contract.ts), and an exit with an unsaved edit
// asks first.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("./api.ts");
const { selfUserRecord } = await import("./test-support/language-fixture.tsx");
const {
  expectFooterPlacement,
  expectSaveCycle,
  footer,
  footerState,
  mountSettingsAt,
  OPENED,
  settle,
} = await import("./test-support/save-footer-contract.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");

const { t } = translatorFor("en");
type UserRecord = import("../shared/types.ts").UserRecord;
type Section = import("./components/UserSettingsView.tsx").SettingsSection;

afterAll(() => setApiShim(null));

const OWNER: UserRecord = {
  ...selfUserRecord(null),
  id: "owner",
  name: "Owner",
  recordingWords: [{ word: "Acme", standIn: "Office 1" }],
};

let writes: { method: string; path: string; body: unknown }[] = [];
beforeEach(() => {
  window.localStorage.clear();
  writes = [];
  setApiShim(async (method, path, body) => {
    if (method === "GET") return {};
    writes.push({ method, path, body });
    return undefined;
  });
});

function mountSection(section: Section, self: UserRecord = OWNER) {
  return mountSettingsAt(
    { kind: "section", section },
    { users: [self], agents: [] },
  );
}

const formBody = (root: HTMLElement) => {
  const all = root.querySelectorAll<HTMLElement>("[data-settings-form-body]");
  if (all.length !== 1)
    throw new Error(`expected one form body, found ${all.length}`);
  return all[0];
};

/** The sidebar row that reads `label`. */
function sidebarRow(root: HTMLElement, label: string): HTMLButtonElement {
  const row = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label && !b.closest("[data-settings-footer]"),
  );
  if (!row) throw new Error(`no sidebar row ${label}`);
  return row;
}

/** Leaving with an unsaved edit: the footer asks, the section stays. */
async function expectLeaveAsks(root: HTMLElement, stays: () => unknown) {
  await act(async () => {
    fireEvent.click(sidebarRow(root, t("settings.sidebar.deviceLabel")));
  });
  await settle();
  expect(stays() ?? null).not.toBeNull();
  const discard = [...footer(root).querySelectorAll("button")].filter(
    (b) => b.textContent === t("common.discard"),
  );
  expect(discard.length).toBe(1);
}

/** Runs `body` with the browser's language set to `language`. */
async function onBrowserLanguage(language: string, body: () => Promise<void>) {
  const own = Object.getOwnPropertyDescriptor(navigator, "language");
  Object.defineProperty(navigator, "language", {
    configurable: true,
    value: language,
  });
  try {
    await body();
  } finally {
    if (own) Object.defineProperty(navigator, "language", own);
    else Reflect.deleteProperty(navigator, "language");
  }
}

it("Language and chat: opens with nothing to save, and saves, edits and cancels like every part", async () => {
  const { view, update } = mountSection("prefs");
  await settle();
  const box = () =>
    formBody(view.container).querySelector<HTMLInputElement>(
      "input[data-show-tool-calls]",
    )!;
  expectFooterPlacement(view.container);
  await expectSaveCycle({
    root: view.container,
    value: () => box().checked,
    edit: async () => {
      await act(async () => {
        fireEvent.click(box());
      });
    },
    broadcast: () => update({ users: [{ ...OWNER, showToolCalls: true }] }),
  });
  expect(writes.map((w) => [w.method, w.path])).toEqual([
    ["PATCH", "/api/me/preferences"],
  ]);
  view.unmount();
});

it("Language and chat: a never-chosen language counts as unsaved only when the browser's is one to store", async () => {
  // An English browser: a record with no language already acts as English.
  await onBrowserLanguage("en-US", async () => {
    const { view } = mountSection("prefs");
    await settle();
    expect(footerState(view.container)).toEqual(OPENED);
    view.unmount();
  });
  // A Spanish browser: the picker shows Spanish, which the server does not
  // hold yet, so Save can store it. The browser's language takes effect
  // before a save, so the page reads Spanish.
  await onBrowserLanguage("es-ES", async () => {
    const { view } = mountSection("prefs");
    await settle();
    const { save, label } = footerState(view.container);
    expect([save, label]).toEqual([
      "enabled",
      translatorFor("es").t("common.save"),
    ]);
    view.unmount();
  });
});

it("Language and chat: leaving with an unsaved edit asks first", async () => {
  const { view } = mountSection("prefs");
  await settle();
  const box = () =>
    view.container.querySelector<HTMLInputElement>(
      "input[data-show-tool-calls]",
    );
  await act(async () => {
    fireEvent.click(box()!);
  });
  await expectLeaveAsks(view.container, box);
  view.unmount();
});

it("Recording mode: opens with nothing to save, and saves, edits and cancels like every part", async () => {
  const { view, update } = mountSection("recording");
  await settle();
  const word = () =>
    formBody(view.container).querySelector<HTMLInputElement>(
      "[data-recording-word-row] input",
    )!;
  expect(word().value).toBe("Acme");
  expectFooterPlacement(view.container);
  await expectSaveCycle({
    root: view.container,
    value: () => word().value,
    edit: async (step) => {
      await act(async () => {
        fireEvent.change(word(), { target: { value: `Acme ${step}` } });
      });
    },
    broadcast: () =>
      update({
        users: [
          {
            ...OWNER,
            recordingWords: [{ word: "Acme 1", standIn: "Office 1" }],
          },
        ],
      }),
  });
  expect(writes.map((w) => w.body)).toEqual([
    { recordingWords: [{ word: "Acme 1", standIn: "Office 1" }] },
  ]);
  view.unmount();
});

it("Recording mode: a list Save refuses says why in the footer, and leaving with an edit asks first", async () => {
  const { view } = mountSection("recording");
  await settle();
  const standIn = () =>
    view.container.querySelectorAll<HTMLInputElement>(
      "[data-recording-word-row] input",
    )[1];
  // A word with no stand-in cannot be saved.
  await act(async () => {
    fireEvent.change(standIn(), { target: { value: "" } });
  });
  expect(footerState(view.container)).toEqual({
    save: "disabled",
    cancel: "enabled",
    label: t("common.save"),
  });
  expect(footer(view.container).querySelectorAll('[role="alert"]').length).toBe(
    1,
  );
  await expectLeaveAsks(view.container, standIn);
  view.unmount();
});

it("Device label: opens with nothing to save, saves, edits and cancels like every part; Enter saves only an edit", async () => {
  const { view } = mountSection("deviceLabel");
  await settle();
  const label = () =>
    formBody(view.container).querySelector<HTMLInputElement>("input")!;
  expectFooterPlacement(view.container);
  // Enter on a form with nothing changed saves nothing.
  await act(async () => {
    fireEvent.keyDown(label(), { key: "Enter" });
  });
  expect(footerState(view.container)).toEqual(OPENED);
  await expectSaveCycle({
    root: view.container,
    value: () => label().value,
    edit: async (step) => {
      await act(async () => {
        fireEvent.change(label(), { target: { value: `Laptop ${step}` } });
      });
    },
  });
  // Enter saves an edit, as the Save button does.
  await act(async () => {
    fireEvent.change(label(), { target: { value: "Phone" } });
  });
  await act(async () => {
    fireEvent.keyDown(label(), { key: "Enter" });
  });
  expect(footerState(view.container).label).toBe(t("common.saved"));
  view.unmount();
});
