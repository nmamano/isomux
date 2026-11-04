// A member edits their profile, presses Save and, while it still says
// Saving..., picks another settings page (task ee577900, Nil's report). The
// discard prompt opens because the form is still dirty. When the save lands,
// the prompt goes away by itself and the page the member picked opens. When
// the save fails, the prompt stays and the page does not change. The same
// holds in the other order: the prompt first, then Save.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { UserSettingsView } = await import("./UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const { t } = translatorFor("en");

const SELF = selfUserRecord(null);
const INSTRUCTIONS = `/api/users/${SELF.name}/instructions`;

// The instructions PUT waits until the test settles it.
let held: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] =
  [];
setApiShim(async (method, path) => {
  if (method === "PUT" && path === INSTRUCTIONS)
    return new Promise((resolve, reject) => held.push({ resolve, reject }));
  if (path === "/api/removed-members") return { members: [] };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path.endsWith("/instructions")) return { instructions: "", version: "1" };
  throw new Error(`no shim for ${method} ${path}`);
});
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  held = [];
});

type View = ReturnType<typeof render>;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(): Promise<View> {
  const view = render(
    onLanguage(
      null,
      createElement(UserSettingsView, {
        onSwitchUser: () => {},
        onClose: () => {},
      }),
      { rooms: [], hasReceivedInitialState: true },
    ),
  );
  await settle();
  return view;
}

/** The sidebar row that reads `label`. */
function row(view: View, label: string): HTMLElement {
  const el = view
    .getAllByText(label)
    .map((e) => e.closest("button"))
    .find((e): e is HTMLButtonElement => e !== null);
  if (!el) throw new Error(`no sidebar row ${label}`);
  return el;
}
const current = (view: View, label: string) =>
  row(view, label).getAttribute("aria-current") === "true";
const PROFILE = t("settings.sidebar.profile");
const LANGUAGE = t("settings.sidebar.language");

const prompt = (view: View) =>
  view.queryByText(t("common.discardPrompt")) !== null;

async function editInstructions(view: View) {
  const field = view.getByPlaceholderText(
    t("settings.profile.profilePromptPlaceholder"),
  );
  await act(async () => {
    fireEvent.change(field, { target: { value: "Answer in one line." } });
  });
}
async function save(view: View) {
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: t("common.save") }));
  });
}
async function leave(view: View) {
  await act(async () => {
    fireEvent.click(row(view, LANGUAGE));
  });
}

const ORDERS = [
  ["Save, then leave while saving", [save, leave]],
  ["leave, then Save from the prompt", [leave, save]],
] as const;

describe("the profile's discard prompt during a save", () => {
  for (const [name, steps] of ORDERS) {
    it(`${name}: goes away and opens the picked page when the save lands`, async () => {
      const view = await mount();
      expect(current(view, PROFILE)).toBe(true);
      await editInstructions(view);
      for (const step of steps) await step(view);
      // The save is in flight and the form is still dirty.
      expect(held).toHaveLength(1);
      expect(prompt(view)).toBe(true);
      expect(current(view, PROFILE)).toBe(true);

      await act(async () =>
        held[0]!.resolve({ instructions: "Answer in one line.", version: "2" }),
      );
      await settle();
      expect(prompt(view)).toBe(false);
      expect(current(view, LANGUAGE)).toBe(true);
      view.unmount();
    });

    it(`${name}: stays, and the page stays, when the save fails`, async () => {
      const view = await mount();
      await editInstructions(view);
      for (const step of steps) await step(view);
      expect(held).toHaveLength(1);
      expect(prompt(view)).toBe(true);

      await act(async () =>
        held[0]!.reject(new ApiError(500, "internal", "disk full")),
      );
      await settle();
      expect(view.queryByText("disk full")).not.toBeNull();
      expect(prompt(view)).toBe(true);
      expect(current(view, PROFILE)).toBe(true);
      expect(current(view, LANGUAGE)).toBe(false);

      // The prompt still carries the member's exit.
      await act(async () => {
        fireEvent.click(
          view.getByRole("button", { name: t("common.discard") }),
        );
      });
      expect(current(view, LANGUAGE)).toBe(true);
      view.unmount();
    });
  }
});
