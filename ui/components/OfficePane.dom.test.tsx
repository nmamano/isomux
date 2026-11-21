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
const { layOutTextareas, scrolledToEnd } =
  await import("../test-support/textarea-layout.ts");

afterAll(() => {
  setApiShim(null);
});

// A fake office with the server's two version rules: the settings version
// covers the name, the instructions version the text (task 744fa64a). A PUT
// with any other version is a 409, and a settings PUT with the old prompt
// field a 400, as on the server.
function fakeOffice() {
  const state = {
    prompt: null as string | null,
    name: null as string | null,
  };
  const settingsVersion = () => `s:${JSON.stringify(state.name)}`;
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
        name: state.name,
        experimental: { browserPanel: true }, // stale server data is ignored
        version: settingsVersion(),
      };
    if (path === "/api/office/instructions" && method === "GET")
      return { instructions: state.prompt, version: instructionsVersion() };
    if (path === "/api/office/settings" && method === "PUT") {
      writes.push({ path, body: b });
      if ("prompt" in b)
        throw new ApiError(400, "invalid_request", "prompt was renamed");
      if (b.version !== settingsVersion()) throw conflict();
      if ("name" in b) state.name = (b.name as string | null) || null;
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

// The instructions field takes the focus on open, while it is still empty;
// the text comes with the read (task 75c7ce43). A long text then shows its
// end with the caret there, unless the member went to another field first.
// The model has no wrap, so a long text is written as many lines.
const LONG = Array.from({ length: 20 }, (_, i) => `rule ${i + 1}`).join("\n");

// An office whose instructions read waits for release().
function heldOffice() {
  let release = () => {};
  const read = new Promise<void>((resolve) => (release = resolve));
  setApiShim(async (method, path, body) => {
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/office/settings" && method === "GET")
      return { name: null, version: "s1" };
    if (path === "/api/office/instructions" && method === "GET") {
      await read;
      return { instructions: LONG, version: "i1" };
    }
    if (path === "/api/office/instructions" && method === "PUT") {
      const b = body as { instructions: string | null };
      return { instructions: b.instructions, version: "i2" };
    }
    throw new Error(`no shim for ${method} ${path}`);
  });
  return { release: () => act(async () => release()) };
}

// A boolean, not toBe on two nodes: a red run would serialise both.
const focused = (el: HTMLElement) => document.activeElement === el;

it("a long text that arrives after the open shows its end in the focused field, with the caret there", async () => {
  const undoLayout = layOutTextareas();
  try {
    const office = heldOffice();
    const view = render(onLanguage(null, createElement(OfficePane)));
    const f = fields(view.container);
    expect(f.text.value).toBe("");
    expect(focused(f.text)).toBe(true);
    await office.release();
    expect(f.text.value).toBe(LONG);
    expect(focused(f.text)).toBe(true);
    expect(f.text.selectionStart).toBe(LONG.length);
    expect(scrolledToEnd(f.text)).toEqual({ overflows: true, atEnd: true });
    view.unmount();
  } finally {
    undoLayout();
  }
});

it("a member who went to the name field before the text arrived keeps the focus there, and the text shows its top", async () => {
  const undoLayout = layOutTextareas();
  try {
    const office = heldOffice();
    const view = render(onLanguage(null, createElement(OfficePane)));
    const f = fields(view.container);
    expect(focused(f.text)).toBe(true);
    act(() => f.name.focus());
    expect(focused(f.name)).toBe(true);
    await office.release();
    expect(f.text.value).toBe(LONG);
    expect(focused(f.name)).toBe(true);
    expect(f.text.scrollHeight > f.text.clientHeight).toBe(true);
    expect(f.text.scrollTop).toBe(0);
    view.unmount();
  } finally {
    undoLayout();
  }
});

// Safari does not focus a button on a click, so the caret can still be in
// the field when Save lands with the new version.
it("a save leaves the caret and the scroll where the member put them", async () => {
  const undoLayout = layOutTextareas();
  try {
    const office = heldOffice();
    const view = render(onLanguage(null, createElement(OfficePane)));
    const f = fields(view.container);
    await office.release();
    const edited = `${LONG}\nrule 21`;
    await act(async () => {
      fireEvent.change(f.text, { target: { value: edited } });
    });
    f.text.setSelectionRange(5, 5);
    f.text.scrollTop = 0;
    expect(focused(f.text)).toBe(true);
    await save(view);
    // The save landed: the version moved and the field is no longer dirty.
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-settings-save]")?.textContent,
      ).toBe(translatorFor("en").t("common.saved")),
    );
    expect(f.text.value).toBe(edited);
    expect(focused(f.text)).toBe(true);
    expect(f.text.selectionStart).toBe(5);
    expect(f.text.scrollTop).toBe(0);
    view.unmount();
  } finally {
    undoLayout();
  }
});
