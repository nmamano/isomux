import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { OfficePane } = await import("./OfficePane.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { createElement } = await import("react");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

afterAll(() => {
  setApiShim(null);
});

// A fake office with the server's two version rules during the alias release
// (task 379ae5db): the settings version covers the name AND the text, the
// instructions version covers the text only. A PUT with any other version is
// a 409, as on the server.
function fakeOffice() {
  const state = {
    prompt: null as string | null,
    name: null as string | null,
  };
  const settingsVersion = () =>
    `s:${JSON.stringify([state.prompt, state.name])}`;
  const instructionsVersion = () => `i:${JSON.stringify(state.prompt)}`;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const conflict = () =>
    new ApiError(409, "version_conflict", "conflict", { version: "x" });
  setApiShim(async (method, path, body) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/office/settings" && method === "GET")
      return {
        prompt: state.prompt,
        name: state.name,
        experimental: { browserPanel: true }, // stale server data is ignored
        version: settingsVersion(),
      };
    if (path === "/api/office/instructions" && method === "GET")
      return { instructions: state.prompt, version: instructionsVersion() };
    if (path === "/api/office/settings" && method === "PUT") {
      writes.push({ path, body: b });
      if (b.version !== settingsVersion()) throw conflict();
      if ("name" in b) state.name = (b.name as string | null) || null;
      if ("prompt" in b) state.prompt = (b.prompt as string | null) || null;
      return undefined;
    }
    if (path === "/api/office/instructions" && method === "PUT") {
      writes.push({ path, body: b });
      if (b.version !== instructionsVersion()) throw conflict();
      state.prompt = (b.instructions as string | null) || null;
      return { instructions: state.prompt, version: instructionsVersion() };
    }
    throw new Error(`no shim for ${method} ${path}`);
  });
  return { state, writes };
}

// The pane's office-name field is its only input; the instructions are its
// first textarea (the memory editor comes after).
function fields(container: HTMLElement) {
  const name = container.querySelector("input");
  const text = container.querySelector("textarea");
  if (!name || !text) throw new Error("office pane fields not found");
  return { name, text };
}

async function save(view: ReturnType<typeof render>) {
  const { t } = translatorFor("en");
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: t("common.save") })),
  );
}

it("saves a new name and new instructions together, each in its own request, with no conflict", async () => {
  const office = fakeOffice();
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  const f = fields(view.container);
  await act(async () => {
    fireEvent.change(f.name, { target: { value: "Acme" } });
    fireEvent.change(f.text, { target: { value: "Be brief." } });
  });
  await save(view);
  await waitFor(() =>
    expect(office.state).toEqual({ prompt: "Be brief.", name: "Acme" }),
  );
  // Each request went through on its first try: no 409 and no retry.
  expect(office.writes.map((w) => w.path).sort()).toEqual([
    "/api/office/instructions",
    "/api/office/settings",
  ]);
  // The settings request carries no text and no retired field.
  const settings = office.writes.find(
    (w) => w.path === "/api/office/settings",
  )!;
  expect(Object.keys(settings.body).sort()).toEqual(["name", "version"]);
  view.unmount();
});

it("sends only the request whose fields changed", async () => {
  const office = fakeOffice();
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  await act(async () => {
    fireEvent.change(fields(view.container).text, {
      target: { value: "Only text." },
    });
  });
  await save(view);
  await waitFor(() => expect(office.state.prompt).toBe("Only text."));
  expect(office.writes.map((w) => w.path)).toEqual([
    "/api/office/instructions",
  ]);

  office.writes.length = 0;
  await act(async () => {
    fireEvent.change(fields(view.container).name, {
      target: { value: "Only name" },
    });
  });
  await save(view);
  await waitFor(() => expect(office.state.name).toBe("Only name"));
  expect(office.writes.map((w) => w.path)).toEqual(["/api/office/settings"]);
  expect(office.state.prompt).toBe("Only text.");
  view.unmount();
});

it("states the memory cap while the memory loads", async () => {
  const { MEMORY_CAPS } = await import("../../shared/memory-caps.ts");
  const { t } = translatorFor("en");
  setApiShim(async (method, path) => {
    if (path.startsWith("/api/memory")) return new Promise(() => {});
    if (path === "/api/office/settings" && method === "GET")
      return { prompt: null, name: null, version: "1" };
    if (path === "/api/office/instructions" && method === "GET")
      return { instructions: null, version: "1" };
    throw new Error(`no shim for ${method} ${path}`);
  });
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  expect(view.container.textContent).toContain(
    t("settings.office.memoryHint", { size: "…", cap: MEMORY_CAPS.office }),
  );
  view.unmount();
});

it("shows the memory size against its cap in the expanded editor, live", async () => {
  const { t } = translatorFor("en");
  setApiShim(async (method, path) => {
    if (path.startsWith("/api/memory"))
      return { text: "one\ntwo", version: "0", size: 7, cap: 4000 };
    if (path === "/api/office/settings" && method === "GET")
      return { prompt: null, name: null, version: "1" };
    if (path === "/api/office/instructions" && method === "GET")
      return { instructions: null, version: "1" };
    throw new Error(`no shim for ${method} ${path}`);
  });
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  const status = () =>
    document.body.querySelector("[data-expanded-status]")?.textContent;
  expect(status()).toBeUndefined();

  await act(async () =>
    fireEvent.click(
      view.getByRole("button", {
        name: t("dialogs.textarea.expand", {
          title: t("settings.office.memoryTitle"),
        }),
      }),
    ),
  );
  expect(status()).toBe(t("common.memorySize", { size: 7, cap: 4000 }));

  const overlay = document.body.querySelector<HTMLTextAreaElement>(
    '[role="dialog"] textarea',
  );
  expect(overlay).not.toBeNull();
  await act(async () =>
    fireEvent.change(overlay!, { target: { value: "one\ntwo\nthree" } }),
  );
  expect(status()).toBe(t("common.memorySize", { size: 13, cap: 4000 }));
  view.unmount();
});
