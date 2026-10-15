import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { OfficePane } = await import("./OfficePane.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");

let savedBody: unknown = null;
setApiShim(async (method, path, body) => {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path === "/api/office/settings" && method === "GET")
    return {
      prompt: null,
      name: null,
      experimental: { browserPanel: true }, // stale server data is ignored
      version: "1",
    };
  if (path === "/api/office/settings" && method === "PUT") {
    savedBody = body;
    return undefined;
  }
  throw new Error(`no shim for ${method} ${path}`);
});

afterAll(() => {
  setApiShim(null);
});

it("ignores retired panel settings and saves only current office fields", async () => {
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  expect(view.queryByRole("switch")).toBeNull();
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Save" })),
  );
  expect(savedBody).toEqual({ prompt: null, name: null, version: "1" });
  view.unmount();
});

it("states the memory cap while the memory loads", async () => {
  const { MEMORY_CAPS } = await import("../../shared/memory-caps.ts");
  const { translatorFor } = await import("../../shared/i18n/translate.ts");
  const { t } = translatorFor("en");
  setApiShim(async (method, path) => {
    if (path.startsWith("/api/memory")) return new Promise(() => {});
    if (path === "/api/office/settings" && method === "GET")
      return { prompt: null, name: null, version: "1" };
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
  const { translatorFor } = await import("../../shared/i18n/translate.ts");
  const { t } = translatorFor("en");
  setApiShim(async (method, path) => {
    if (path.startsWith("/api/memory"))
      return { text: "one\ntwo", version: "0", size: 7, cap: 4000 };
    if (path === "/api/office/settings" && method === "GET")
      return { prompt: null, name: null, version: "1" };
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
