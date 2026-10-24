// The Variables tab for the member's own card and the owner's office card
// (ported from the Settings ManagedEnvEditor and ConnectionNotes tests):
// values masked until Show, and one variable per request on both cards, so a
// save never undoes a change made elsewhere after the page loaded.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { expectMasked } from "../test-support/masked.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setApiShim } = await import("../api.ts");
const { VariablesSection } = await import("./VariablesSection.tsx");
const { onManagedEnvSaved } = await import("../connections-events.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { MODEL_KEY_SECRET_NAMES } = await import("../../shared/secret-hosts.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "ann", owner: true }, [
    "ann",
  ]).install();
});

async function mount(target: object, role = "owner") {
  const view = render(
    createElement(VariablesSection, { target, role } as never),
  );
  await act(async () => {});
  return view;
}

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
}

async function type(el: Element | null, value: string) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.change(el!, { target: { value } });
  });
}

it("masks your values until Show, and saves one variable at a time", async () => {
  fake.scope("ann").values = { A: "secret-a", TZ: "UTC" };
  fake.scope("ann").notes = { A: "first line\nsecond line" };
  let saved = 0;
  const off = onManagedEnvSaved(() => saved++);
  const view = await mount({ kind: "self", username: "ann" });
  const row = view.container.querySelector('[data-env-entry="A"]')!;
  expect(row.textContent).not.toContain("secret-a");
  expect(row.querySelector("[data-connection-note]")!.textContent).toBe(
    "first line\nsecond line",
  );
  await click(row.querySelector("[data-env-show]"));
  expect(row.textContent).toContain("secret-a");
  await click(row.querySelector("[data-env-show]"));
  expect(row.textContent).not.toContain("secret-a");

  // Edit: your own value and note start filled.
  await click(row.querySelector("[data-env-edit]"));
  const value = view.container.querySelector<HTMLInputElement>(
    "[data-env-value-input]",
  )!;
  expect(value.value).toBe("secret-a");
  expectMasked(value);
  const note = view.container.querySelector<HTMLTextAreaElement>(
    "[data-env-edit-panel] textarea",
  )!;
  expect(note.value).toBe("first line\nsecond line");
  await type(note, " use for A ");
  await click(view.container.querySelector("[data-panel-save]"));
  expect(fake.requests("PUT", "/api/users/ann/env/A")[0].body).toEqual({
    value: "secret-a",
    note: "use for A",
  });
  expect(saved).toBe(1);

  // Add, with the duplicate name refused before any request.
  await click(view.container.querySelector("[data-integrations-add]"));
  await type(view.container.querySelector("[data-env-name]"), "TZ");
  expect(view.container.textContent).toContain(
    t("integrations.variables.exists"),
  );
  expect(
    view.container.querySelector<HTMLButtonElement>("[data-panel-save]")!
      .disabled,
  ).toBe(true);
  await type(view.container.querySelector("[data-env-name]"), "REGION");
  await type(view.container.querySelector("[data-env-value-input]"), "eu");
  await click(view.container.querySelector("[data-panel-save]"));
  expect(fake.requests("PUT", "/api/users/ann/env/REGION")[0].body).toEqual({
    value: "eu",
    note: null,
  });
  expect(
    view.container.querySelector('[data-env-entry="REGION"]'),
  ).not.toBeNull();

  await click(
    view.container.querySelector('[data-env-entry="TZ"] [data-env-remove]'),
  );
  await click(view.container.querySelector("[data-panel-save]"));
  expect(fake.requests("DELETE", "/api/users/ann/env/TZ")).toHaveLength(1);
  // The personal card never sends the whole map.
  expect(fake.requests("PUT", "/api/users/ann/env")).toHaveLength(0);
  off();
});

// Task ab26a507: another owner, a token or an agent changes the office
// variables after this page loaded; a save here touches only its own name.
it("saves one office variable at a time, so a change made elsewhere survives", async () => {
  const office = fake.scope("office");
  office.values = { A: "1", B: "2", C: "3", D: "4" };
  office.notes = { A: "first line\nsecond line" };
  const view = await mount({ kind: "office" });
  const writes = () =>
    fake.calls
      .filter((c) => c.method !== "GET" && c.path.startsWith("/api/office/"))
      .map((c) => `${c.method} ${c.path}`);
  const elsewhere = (values: Record<string, string>, notes: object) => {
    office.values = values;
    office.notes = notes as Record<string, string>;
  };

  // Edit: B changed and C went elsewhere after the load.
  elsewhere(
    { A: "1", B: "theirs", D: "4" },
    { A: "first line\nsecond line", B: "their note" },
  );
  await click(
    view.container.querySelector('[data-env-entry="A"] [data-env-edit]'),
  );
  await type(
    view.container.querySelector(
      "[data-env-edit-panel] [data-env-value-input]",
    ),
    "1b",
  );
  await type(
    view.container.querySelector("[data-env-edit-panel] textarea"),
    " use for A ",
  );
  await click(view.container.querySelector("[data-panel-save]"));
  expect(office.values).toEqual({ A: "1b", B: "theirs", D: "4" });
  expect(office.notes).toEqual({ A: "use for A", B: "their note" });
  expect(fake.requests("PUT", "/api/office/env/A")[0]?.body).toEqual({
    value: "1b",
    note: "use for A",
  });

  // Remove: B changed again after the reload.
  elsewhere({ ...office.values, B: "again" }, office.notes);
  await click(
    view.container.querySelector('[data-env-entry="A"] [data-env-remove]'),
  );
  await click(view.container.querySelector("[data-panel-save]"));
  expect(office.values).toEqual({ B: "again", D: "4" });
  expect(office.notes).toEqual({ B: "their note" });

  // Rename: the new name first, then the old one goes; B changed again.
  elsewhere({ ...office.values, B: "third" }, office.notes);
  await click(
    view.container.querySelector('[data-env-entry="D"] [data-env-edit]'),
  );
  await type(
    view.container.querySelector("[data-env-edit-panel] [data-env-name]"),
    "E",
  );
  await click(view.container.querySelector("[data-panel-save]"));
  expect(office.values).toEqual({ B: "third", E: "4" });
  expect(office.notes).toEqual({ B: "their note" });

  // One request per name, never the whole map.
  expect(writes()).toEqual([
    "PUT /api/office/env/A",
    "DELETE /api/office/env/A",
    "PUT /api/office/env/E",
    "DELETE /api/office/env/D",
  ]);
});

it("flags a key-like name, except the model API keys that belong here", async () => {
  const view = await mount({ kind: "self", username: "ann" });
  await click(view.container.querySelector("[data-integrations-add]"));
  const flagged = async (name: string) => {
    await type(view.container.querySelector("[data-env-name]"), name);
    return view.container.querySelector("[data-env-key-hint]") !== null;
  };
  expect(await flagged("GH_TOKEN")).toBe(true);
  expect(await flagged("my_password")).toBe(true);
  expect(await flagged("TZ")).toBe(false);
  // The names the Secrets tab refuses on a secret with an address
  // (task f51e4ab9): one list for both tabs.
  expect(MODEL_KEY_SECRET_NAMES).toContain("GROQ_API_KEY");
  for (const name of MODEL_KEY_SECRET_NAMES)
    expect([name, await flagged(name)]).toEqual([name, false]);
});

it("shows the load failure, not a crash, when a server answers with another shape", async () => {
  setApiShim(async () => ({}));
  const view = await mount({ kind: "self", username: "ann" });
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.env.loadFailed"),
  );
});
