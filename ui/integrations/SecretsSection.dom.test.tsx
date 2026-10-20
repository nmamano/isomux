// The Secrets tab's list and forms (ported from the Settings SecretsList
// tests): a value is write-only, a preset hides its fields, Other clears what
// a preset filled, and the server's refusals read as fixed sentences.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { expectMasked } from "../test-support/masked.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setApiShim } = await import("../api.ts");
const { SecretsSection } = await import("./SecretsSection.tsx");
const { demoSecretsRoute } = await import("../demo-secrets.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");
const FAKE = "fake-secret-value-0000-ui";
const SELF = { kind: "self", username: "alice" } as const;

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "alice", owner: true }, [
    "alice",
  ]).install();
});

// The target member's user id: alice's for her own card, none for the
// office, whose secrets may go to every app.
async function mount(
  target: { kind: string } = SELF,
  role = "owner",
  ownerUserId: string | null = target.kind === "office" ? null : "u-alice",
) {
  const view = render(
    createElement(SecretsSection, { target, role, ownerUserId } as never),
  );
  await act(async () => {});
  return view;
}

const valueInput = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLInputElement>("[data-masked-credential]");

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
}

async function choose(view: ReturnType<typeof render>, value: string) {
  await click(view.container.querySelector(`[data-choice="${value}"]`));
}

it("saves a preset secret, lists it without a value, and clears the value field", async () => {
  const view = await mount();
  await click(view.container.querySelector("[data-integrations-add]"));
  // GitHub is the first preset: its name and addresses stay out of sight.
  expect(view.container.querySelector("[data-secret-name-input]")).toBeNull();
  expect(view.container.querySelector("[data-secret-hosts]")).toBeNull();
  expect(view.container.textContent).toContain(
    t("integrations.secrets.presetGoesTo", { service: "GitHub" }),
  );
  await click(view.container.querySelector("[data-show-addresses]"));
  expect(
    view.container.querySelector("[data-preset-hosts]")!.textContent,
  ).toContain("api.github.com");
  const input = valueInput(view)!;
  expectMasked(input);
  await act(async () => {
    fireEvent.change(input, { target: { value: FAKE } });
  });
  await click(view.container.querySelector("[data-panel-save]"));

  const post = fake.requests("POST", "/api/users/alice/secrets")[0];
  expect(post.body).toEqual(
    expect.objectContaining({
      name: "GH_TOKEN",
      value: FAKE,
      hosts: ["api.github.com", "github.com", "uploads.github.com"],
      form: { kind: "authorization" },
    }),
  );
  const row = view.container.querySelector('[data-secret-name="GH_TOKEN"]')!;
  expect(row.textContent).toContain("GitHub");
  expect(view.container.textContent).not.toContain(FAKE);
  expect(valueInput(view)).toBeNull();

  // A new value field opens empty, and a cancel clears what was typed.
  await click(row.querySelector("[data-secret-replace]"));
  expect(valueInput(view)!.value).toBe("");
  await act(async () => {
    fireEvent.change(valueInput(view)!, { target: { value: `${FAKE}-2` } });
  });
  await click(view.getByRole("button", { name: t("common.cancel") }));
  await click(row.querySelector("[data-secret-replace]"));
  expect(valueInput(view)!.value).toBe("");
  await act(async () => {
    fireEvent.change(valueInput(view)!, { target: { value: `${FAKE}-3` } });
  });
  await click(view.container.querySelector("[data-panel-save]"));
  expect(
    fake.requests("PUT", "/api/users/alice/secrets/GH_TOKEN/value")[0].body,
  ).toEqual({
    value: `${FAKE}-3`,
  });
  expect(valueInput(view)).toBeNull();

  // A new stand-in: from Edit, a confirm step, then a body-less POST.
  await click(row.querySelector("[data-secret-edit]"));
  await click(view.container.querySelector("[data-secret-reissue]"));
  expect(fake.requests("POST", /\/reissue$/)).toHaveLength(0);
  await click(view.container.querySelector("[data-panel-save]"));
  const reissue = fake.requests("POST", /\/reissue$/)[0];
  expect(reissue.path).toBe("/api/users/alice/secrets/GH_TOKEN/reissue");
  expect(reissue.body).toBeUndefined();

  await click(row.querySelector("[data-secret-remove]"));
  await click(view.container.querySelector("[data-panel-save]"));
  expect(
    fake.requests("DELETE", "/api/users/alice/secrets/GH_TOKEN"),
  ).toHaveLength(1);
  expect(
    view.container.querySelector('[data-secret-name="GH_TOKEN"]'),
  ).toBeNull();
  // No URL carries the value.
  for (const call of fake.calls) expect(call.path).not.toContain("fake-secret");
});

it("edits the addresses, how the service expects it and the note", async () => {
  fake.scope("alice").secrets.push({
    name: "MY_KEY",
    hosts: ["api.example.com"],
    form: { kind: "authorization" },
    createdAt: 1,
    valueSetAt: 1,
    updatedAt: 1,
    note: null,
    apps: [],
    value: FAKE,
  });
  const view = await mount();
  await click(view.container.querySelector("[data-secret-edit]"));
  await act(async () => {
    fireEvent.change(view.container.querySelector("[data-secret-hosts]")!, {
      target: { value: "api.example.com\nuploads.example.com" },
    });
  });
  await choose(view, "header");
  await act(async () => {
    fireEvent.change(view.getByLabelText(t("settings.secrets.headerName")), {
      target: { value: "x-api-key" },
    });
    fireEvent.change(view.getByLabelText(t("settings.connections.note")), {
      target: { value: "for the CI bot" },
    });
  });
  await click(view.container.querySelector("[data-panel-save]"));
  expect(
    fake.requests("PATCH", "/api/users/alice/secrets/MY_KEY")[0].body,
  ).toEqual({
    hosts: ["api.example.com", "uploads.example.com"],
    form: { kind: "header", header: "x-api-key" },
    note: "for the CI bot",
  });
});

it("names the refused host when a host is on the never-list", async () => {
  // The demo's route has the server's checks.
  setApiShim(async (method, path, body) => {
    const answer = demoSecretsRoute(method, path, body, () => "u-test");
    if (!answer) throw new Error(`unexpected ${method} ${path}`);
    return answer.result;
  });
  const view = await mount({ kind: "office" });
  await click(view.container.querySelector("[data-integrations-add]"));
  await choose(view, "other");
  await act(async () => {
    fireEvent.change(
      view.container.querySelector("[data-secret-name-input]")!,
      {
        target: { value: "OPENAI_KEY" },
      },
    );
    fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
    fireEvent.change(view.container.querySelector("[data-secret-hosts]")!, {
      target: { value: "api.openai.com" },
    });
  });
  await click(view.container.querySelector("[data-panel-save]"));
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.secrets.error.neverListed", { host: "api.openai.com" }),
  );
});

it("clears the preset's name and addresses when the member picks Other", async () => {
  const view = await mount();
  await click(view.container.querySelector("[data-integrations-add]"));
  await choose(view, "stripe");
  await act(async () => {
    fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
    fireEvent.change(view.getByLabelText(t("settings.connections.note")), {
      target: { value: "for the CI bot" },
    });
  });
  await choose(view, "other");
  const name = view.container.querySelector<HTMLInputElement>(
    "[data-secret-name-input]",
  )!;
  const hosts = view.container.querySelector<HTMLTextAreaElement>(
    "[data-secret-hosts]",
  )!;
  expect(name.value).toBe("");
  expect(hosts.value).toBe("");
  // What the member typed stays.
  expect(valueInput(view)!.value).toBe(FAKE);
  expect(
    (view.getByLabelText(t("settings.connections.note")) as HTMLTextAreaElement)
      .value,
  ).toBe("for the CI bot");
  // Save stays off until the name and an address are back.
  expect(
    view.container.querySelector<HTMLButtonElement>("[data-panel-save]")!
      .disabled,
  ).toBe(true);
});

it("has a Test only for a secret whose hosts have an identity check", async () => {
  const base = {
    form: { kind: "authorization" as const },
    createdAt: 1,
    valueSetAt: 1,
    updatedAt: 1,
    note: null,
    apps: [],
    value: FAKE,
  };
  fake.scope("alice").secrets.push(
    { ...base, name: "GH_TOKEN", hosts: ["api.github.com"] },
    { ...base, name: "OTHER", hosts: ["api.example.com"] },
    {
      ...base,
      name: "HEADERED",
      hosts: ["api.github.com"],
      form: { kind: "header", header: "x-api-key" },
    },
  );
  const view = await mount();
  const test = (name: string) =>
    view.container.querySelector(
      `[data-secret-name="${name}"] [data-connection-test]`,
    );
  expect(test("GH_TOKEN")).not.toBeNull();
  expect(test("OTHER")).toBeNull();
  expect(test("HEADERED")).toBeNull();
  await click(test("GH_TOKEN"));
  expect(
    view.container.querySelector('[data-connection-test-result="ok"]')!
      .textContent,
  ).toBe(`${t("settings.connections.test.works")} · octocat`);
});

it("shows the load failure, not a crash, when a server answers with another shape", async () => {
  setApiShim(async () => ({ unexpected: true }));
  const view = await mount();
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.secrets.loadFailed"),
  );
});

// Task c7007f8b: a secret can go to apps. The form offers the target
// member's apps (every app for the office), a secret with an app needs no
// address, and an edit sends apps only when the list changed.
describe("apps that read a secret", () => {
  beforeEach(() => {
    // Owners are matched by id: bot's username is from before alice was
    // renamed, and bob took her old name before he registered "impostor".
    fake.apps = [
      { name: "bot", userId: "u-alice", username: "alice-before" },
      { name: "impostor", userId: "u-bob", username: "alice" },
      { name: "web", userId: "u-bob", username: "bob" },
    ];
  });

  const appBoxes = (view: ReturnType<typeof render>) =>
    [
      ...view.container.querySelectorAll<HTMLInputElement>("[data-secret-app]"),
    ].map((box) => [box.dataset.secretApp, box.checked]);

  it("adds a secret that only the member's own app reads, and lists who reads it", async () => {
    const view = await mount();
    await click(view.container.querySelector("[data-integrations-add]"));
    await choose(view, "other");
    expect(appBoxes(view)).toEqual([["bot", false]]);
    await act(async () => {
      fireEvent.change(
        view.container.querySelector("[data-secret-name-input]")!,
        { target: { value: "BOT_TOKEN" } },
      );
      fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
    });
    const save =
      view.container.querySelector<HTMLButtonElement>("[data-panel-save]")!;
    // No address and no app: nothing to save.
    expect(save.disabled).toBe(true);
    await click(view.container.querySelector('[data-secret-app="bot"]'));
    expect(save.disabled).toBe(false);
    await click(save);
    expect(fake.requests("POST", "/api/users/alice/secrets")[0].body).toEqual(
      expect.objectContaining({ name: "BOT_TOKEN", hosts: [], apps: ["bot"] }),
    );
    const row = view.container.textContent;
    expect(row).toContain("BOT_TOKEN");
    expect(row).toContain(t("integrations.secrets.readBy", { apps: "bot" }));
  });

  it("does not tell a member that an office secret apps read goes nowhere", async () => {
    // A member reads office secrets as a summary: name, hosts and note.
    fake = new IntegrationsFake({ username: "alice", owner: false }, [
      "alice",
    ]).install();
    fake.scope("office").secrets.push({
      name: "OFFICE_BOT",
      hosts: [],
      form: { kind: "authorization" },
      createdAt: 1,
      valueSetAt: 1,
      updatedAt: 1,
      note: null,
      apps: ["bot"],
      value: FAKE,
    });
    const view = await mount({ kind: "office" }, "member");
    const text = view.container.textContent;
    expect(text).toContain("OFFICE_BOT");
    expect(text).not.toContain(t("integrations.secrets.reachesNothing"));
  });

  it("offers every app for an office secret", async () => {
    const view = await mount({ kind: "office" });
    await click(view.container.querySelector("[data-integrations-add]"));
    await choose(view, "other");
    expect(appBoxes(view)).toEqual([
      ["bot", false],
      ["impostor", false],
      ["web", false],
    ]);
  });

  it("keeps a granted app on the list, and an edit sends apps only when they changed", async () => {
    fake.scope("alice").secrets.push({
      name: "MY_KEY",
      hosts: ["api.example.com"],
      form: { kind: "authorization" },
      createdAt: 1,
      valueSetAt: 1,
      updatedAt: 1,
      note: null,
      // An app the list does not offer, as after the app moved owners.
      apps: ["bot", "old-app"],
      value: FAKE,
    });
    const view = await mount();
    await click(view.container.querySelector("[data-secret-edit]"));
    expect(appBoxes(view)).toEqual([
      ["bot", true],
      ["old-app", true],
    ]);
    await click(view.container.querySelector("[data-panel-save]"));
    expect(
      fake.requests("PATCH", "/api/users/alice/secrets/MY_KEY")[0].body,
    ).not.toHaveProperty("apps");

    await click(view.container.querySelector("[data-secret-edit]"));
    await click(view.container.querySelector('[data-secret-app="old-app"]'));
    await click(view.container.querySelector("[data-panel-save]"));
    expect(
      fake.requests("PATCH", "/api/users/alice/secrets/MY_KEY")[1].body,
    ).toEqual(expect.objectContaining({ apps: ["bot"] }));
  });
});
