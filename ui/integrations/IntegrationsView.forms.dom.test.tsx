// The forms on the Integrations page: one open form per card (a click
// elsewhere never drops a typed value), each removal's refusal in the words
// its route maps, nothing saved from a list that did not load, a variable
// rename, and an MCP note set and cleared.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { ApiError, setApiShim } = await import("../api.ts");
const { IntegrationsFake, secret, server } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { card, click, open, tab, type } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
  fake.scope("Ricky").secrets.push(secret("A_KEY"), secret("B_KEY"));
  fake.scope("Ricky").servers.push(server("alpha"), server("beta"));
  fake.scope("Ricky").values = { A_VAR: "1", B_VAR: "2" };
});

// Fail every request that matches, with this error.
function refuse(method: string, pattern: RegExp, error: unknown) {
  const shim = fake.handle.bind(fake);
  setApiShim(async (m, path, body) => {
    if (m === method && pattern.test(path)) throw error;
    return shim(m, path, body);
  });
}

describe("one open form per card", () => {
  for (const [tabId, open1, rowAction] of [
    ["secrets", "[data-secret-replace]", "[data-secret-edit]"],
    ["mcp", "[data-mcp-edit]", "[data-mcp-remove]"],
    ["variables", "[data-env-edit]", "[data-env-remove]"],
  ] as const)
    it(`${tabId}: hides Add and the other rows' actions while a form is open`, async () => {
      const view = await open();
      await tab(view, tabId);
      const mine = card(view, "personal");
      expect(mine.querySelectorAll(rowAction)).toHaveLength(2);
      await click(mine.querySelector(open1));
      expect(mine.querySelector("[data-integrations-add]")).toBeNull();
      expect(mine.querySelectorAll(rowAction)).toHaveLength(0);
      const cancel = [...mine.querySelectorAll("button")].find(
        (b) => b.textContent === t("common.cancel"),
      );
      await click(cancel ?? null);
      // Cancel brings them back.
      expect(mine.querySelector("[data-integrations-add]")).not.toBeNull();
    });

  it("keeps a typed value while the form is open", async () => {
    const view = await open();
    await tab(view, "secrets");
    const mine = card(view, "personal");
    await click(mine.querySelector("[data-integrations-add]"));
    await type(mine.querySelector("[data-secret-value-input]"), "typed-value");
    // No other action is there to take the form away.
    expect(mine.querySelector("[data-secret-edit]")).toBeNull();
    expect(
      mine.querySelector<HTMLInputElement>("[data-secret-value-input]")!.value,
    ).toBe("typed-value");
  });
});

describe("a refused removal reads in its route's words", () => {
  it("secrets", async () => {
    refuse(
      "DELETE",
      /\/secrets\/A_KEY$/,
      new ApiError(400, "invalid_secret", "x", { field: "name" }),
    );
    const view = await open();
    await tab(view, "secrets");
    const mine = card(view, "personal");
    await click(
      mine.querySelector('[data-secret-name="A_KEY"] [data-secret-remove]'),
    );
    await click(mine.querySelector("[data-panel-save]"));
    expect(mine.querySelector('[role="alert"]')!.textContent).toBe(
      t("settings.secrets.error.name"),
    );
  });

  it("MCP servers", async () => {
    refuse(
      "DELETE",
      /\/mcp-servers\/alpha$/,
      new ApiError(422, "secret_not_found", "x"),
    );
    const view = await open();
    await tab(view, "mcp");
    const mine = card(view, "personal");
    await click(
      mine.querySelector('[data-mcp-server-name="alpha"] [data-mcp-remove]'),
    );
    await click(mine.querySelector("[data-panel-save]"));
    expect(mine.querySelector('[role="alert"]')!.textContent).toBe(
      t("settings.mcpServers.error.secretNotFound"),
    );
  });

  it("variables", async () => {
    refuse(
      "DELETE",
      /\/env\/A_VAR$/,
      new ApiError(400, "invalid_env", "A_VAR is not a valid name"),
    );
    const view = await open();
    await tab(view, "variables");
    const mine = card(view, "personal");
    await click(
      mine.querySelector('[data-env-entry="A_VAR"] [data-env-remove]'),
    );
    await click(mine.querySelector("[data-panel-save]"));
    expect(mine.querySelector('[role="alert"]')!.textContent).toBe(
      "A_VAR is not a valid name",
    );
  });
});

describe("the office variables save only what they read", () => {
  it("offers no Add and no change when the office read fails", async () => {
    fake.scope("office").values = { TZ: "UTC" };
    refuse("GET", /^\/api\/office\/env$/, new ApiError(500, "internal", "x"));
    const view = await open();
    await tab(view, "variables");
    const office = card(view, "office");
    expect(office.querySelector('[role="alert"]')).not.toBeNull();
    expect(office.querySelector("[data-integrations-add]")).toBeNull();
    expect(office.querySelector("[data-env-edit]")).toBeNull();
    expect(fake.requests("PUT", "/api/office/env")).toHaveLength(0);
  });

  // The Add row stands in while the read is out, so the card keeps its
  // height, but it cannot be used.
  it("offers no usable Add while the office read is out", async () => {
    fake.hold("/api/office/env");
    const view = await open();
    await tab(view, "variables");
    const office = card(view, "office");
    const add = office.querySelector<HTMLButtonElement>(
      "[data-integrations-add]",
    );
    expect(add?.disabled).toBe(true);
    await click(add);
    expect(office.querySelector("[data-panel-heading]")).toBeNull();
  });
});

it("renames your variable: the new name first, then the old one goes", async () => {
  const view = await open();
  await tab(view, "variables");
  const mine = card(view, "personal");
  await click(mine.querySelector('[data-env-entry="A_VAR"] [data-env-edit]'));
  await type(
    mine.querySelector("[data-env-edit-panel] [data-env-name]"),
    "B_VAR",
  );
  // A name already on the card is refused.
  expect(
    mine.querySelector<HTMLButtonElement>("[data-panel-save]")!.disabled,
  ).toBe(true);
  await type(
    mine.querySelector("[data-env-edit-panel] [data-env-name]"),
    "C_VAR",
  );
  await click(mine.querySelector("[data-panel-save]"));
  const writes = fake.calls
    .filter((c) => c.method !== "GET" && c.path.includes("/env/"))
    .map((c) => `${c.method} ${c.path}`);
  expect(writes).toEqual([
    "PUT /api/users/Ricky/env/C_VAR",
    "DELETE /api/users/Ricky/env/A_VAR",
  ]);
  expect(fake.scope("Ricky").values).toEqual({ B_VAR: "2", C_VAR: "1" });
});

it("sets an MCP server's note and clears it", async () => {
  const view = await open();
  await tab(view, "mcp");
  const mine = card(view, "personal");
  await click(
    mine.querySelector('[data-mcp-server-name="alpha"] [data-mcp-edit]'),
  );
  await type(mine.querySelector("[data-mcp-edit-panel] textarea"), "read only");
  await click(mine.querySelector("[data-panel-save]"));
  expect(
    fake.requests("PATCH", "/api/users/Ricky/mcp-servers/alpha")[0].body,
  ).toMatchObject({
    note: "read only",
  });
  expect(
    mine.querySelector('[data-mcp-server-name="alpha"] [data-connection-note]')!
      .textContent,
  ).toBe("read only");
  await click(
    mine.querySelector('[data-mcp-server-name="alpha"] [data-mcp-edit]'),
  );
  const note = mine.querySelector<HTMLTextAreaElement>(
    "[data-mcp-edit-panel] textarea",
  )!;
  expect(note.value).toBe("read only");
  await type(note, "");
  await click(mine.querySelector("[data-panel-save]"));
  expect(
    fake.requests("PATCH", "/api/users/Ricky/mcp-servers/alpha")[1].body,
  ).toMatchObject({
    note: "",
  });
});
