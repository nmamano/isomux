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
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Save" })));
  expect(savedBody).toEqual({ prompt: null, name: null, version: "1" });
  view.unmount();
});
