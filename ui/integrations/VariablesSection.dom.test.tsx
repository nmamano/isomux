// The Variables tab for the member's own card and the owner's office card
// (ported from the Settings ManagedEnvEditor and ConnectionNotes tests):
// values masked until Show, one variable per request on a personal card, and
// a whole-map save on the office card that keeps every other value and note.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { expectMasked } from "../test-support/masked.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setApiShim } = await import("../api.ts");
const { VariablesSection, looksLikeKey } =
  await import("./VariablesSection.tsx");
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

it("saves the office's whole map with every other value and note kept", async () => {
  fake.scope("office").values = { A: "1", B: "2" };
  fake.scope("office").notes = { A: "first line\nsecond line" };
  const view = await mount({ kind: "office" });
  await click(
    view.container.querySelector('[data-env-entry="B"] [data-env-edit]'),
  );
  await type(
    view.container.querySelector("[data-env-edit-panel] textarea"),
    " use for B ",
  );
  await click(view.container.querySelector("[data-panel-save]"));
  expect(fake.requests("PUT", "/api/office/env")[0].body).toEqual({
    values: { A: "1", B: "2" },
    notes: { A: "first line\nsecond line", B: "use for B" },
  });
  await click(
    view.container.querySelector('[data-env-entry="A"] [data-env-remove]'),
  );
  await click(view.container.querySelector("[data-panel-save]"));
  expect(fake.requests("PUT", "/api/office/env")[1].body).toEqual({
    values: { B: "2" },
    notes: { B: "use for B" },
  });
});

it("flags a key-like name, except the model API keys that belong here", async () => {
  expect(looksLikeKey("GH_TOKEN")).toBe(true);
  expect(looksLikeKey("my_password")).toBe(true);
  expect(looksLikeKey("TZ")).toBe(false);
  // The names the Secrets tab refuses on a secret with an address
  // (task f51e4ab9): one list for both tabs.
  expect(MODEL_KEY_SECRET_NAMES).toContain("GROQ_API_KEY");
  for (const name of MODEL_KEY_SECRET_NAMES)
    expect([name, looksLikeKey(name)]).toEqual([name, false]);
  const view = await mount({ kind: "self", username: "ann" });
  await click(view.container.querySelector("[data-integrations-add]"));
  await type(view.container.querySelector("[data-env-name]"), "GH_TOKEN");
  expect(view.container.querySelector("[data-env-key-hint]")).not.toBeNull();
  await type(view.container.querySelector("[data-env-name]"), "OPENAI_API_KEY");
  expect(view.container.querySelector("[data-env-key-hint]")).toBeNull();
});

it("shows the load failure, not a crash, when a server answers with another shape", async () => {
  setApiShim(async () => ({}));
  const view = await mount({ kind: "self", username: "ann" });
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.env.loadFailed"),
  );
});
