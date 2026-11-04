// Task 11b5ef0c: the owner's "label Claude agents as Isomux" checkbox in the
// Office pane. It saves at once with the pane's settings version, as the
// process isolation switch does.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { OfficePane } = await import("./OfficePane.tsx");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { createElement } = await import("react");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const { t } = translatorFor("en");

afterAll(() => {
  setApiShim(null);
});

// A fake office whose settings version covers the name and the switch. A PUT
// with any other version is a 409, as on the server. `label: undefined` is an
// older server that does not know the field.
function fakeOffice(label: boolean | undefined) {
  const state = { name: null as string | null, label };
  const version = () => `s:${JSON.stringify([state.name, state.label])}`;
  const writes: Record<string, unknown>[] = [];
  setApiShim(async (method, path, body) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/office/instructions" && method === "GET")
      return { instructions: null, version: "i" };
    if (path === "/api/office/settings" && method === "GET")
      return {
        name: state.name,
        version: version(),
        processIsolation: true,
        processIsolationStatus: "on",
        ...(state.label === undefined
          ? {}
          : { claudeIsomuxLabel: state.label }),
      };
    if (path === "/api/office/settings" && method === "PUT") {
      writes.push(b);
      if (b.version !== version())
        throw new ApiError(409, "version_conflict", "conflict", {
          version: version(),
        });
      if ("name" in b) state.name = (b.name as string | null) || null;
      if ("claudeIsomuxLabel" in b)
        state.label = b.claudeIsomuxLabel as boolean;
      return undefined;
    }
    throw new Error(`no shim for ${method} ${path}`);
  });
  return { state, writes, version };
}

const labelBox = (view: ReturnType<typeof render>) =>
  view.queryByRole("checkbox", {
    name: t("settings.office.claudeIsomuxLabel"),
  }) as HTMLInputElement | null;

const isolationBox = (view: ReturnType<typeof render>) =>
  view.queryByRole("checkbox", { name: t("settings.office.processIsolation") });

it("saves the owner's click at once, with the pane's version, and a later Save goes through", async () => {
  const office = fakeOffice(false);
  const first = office.version();
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  const box = labelBox(view);
  expect(box?.checked).toBe(false);

  await act(async () => {
    fireEvent.click(box!);
  });
  await waitFor(() => expect(labelBox(view)?.checked).toBe(true));
  expect(office.state.label).toBe(true);
  expect(office.writes).toEqual([{ version: first, claudeIsomuxLabel: true }]);

  // The switch's own write moved the version: the pane took the new one, so
  // the name Save is not refused for it.
  await act(async () => {
    fireEvent.change(view.container.querySelector("input")!, {
      target: { value: "Acme" },
    });
  });
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: t("common.save") })),
  );
  await waitFor(() => expect(office.state.name).toBe("Acme"));
  expect(office.writes).toHaveLength(2);
  expect(office.state.label).toBe(true);
  view.unmount();
});

it("reports a change by another writer as a conflict and saves nothing", async () => {
  const office = fakeOffice(false);
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  office.state.name = "Changed elsewhere";
  await act(async () => {
    fireEvent.click(labelBox(view)!);
  });
  await waitFor(() =>
    expect(view.container.textContent).toContain(t("settings.office.conflict")),
  );
  expect(office.state.label).toBe(false);
  expect(labelBox(view)?.checked).toBe(false);
  view.unmount();
});

it("shows nothing for a server that does not know the setting", async () => {
  fakeOffice(undefined);
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  // The pane loaded: the isolation switch beside it is there.
  expect(isolationBox(view)).not.toBeNull();
  expect(labelBox(view)).toBeNull();
  view.unmount();
});

it("is not offered to a member who is not an owner", async () => {
  fakeOffice(true);
  const own = stateWithSelfUser(null, {}).sessionContext!;
  const view = render(
    onLanguage(null, createElement(OfficePane), {
      sessionContext: { ...own, role: "member" },
    }),
  );
  await act(async () => {});
  // The pane loaded (read-only).
  expect(view.container.textContent).toContain(t("settings.office.viewOnly"));
  expect(labelBox(view)).toBeNull();
  view.unmount();
});
