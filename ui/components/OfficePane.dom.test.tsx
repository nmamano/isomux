import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { OfficePane } = await import("./OfficePane.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");

let browserPanel = false;
let savedBody: unknown = null;
setApiShim(async (method, path, body) => {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path === "/api/office/settings" && method === "GET")
    return {
      prompt: null,
      name: null,
      ...(browserPanel ? { experimental: { browserPanel } } : {}),
      version: browserPanel ? "2" : "1",
    };
  if (path === "/api/office/settings" && method === "PUT") {
    savedBody = body;
    browserPanel = !!(body as { experimental?: { browserPanel?: boolean } })
      .experimental?.browserPanel;
    return undefined;
  }
  throw new Error(`no shim for ${method} ${path}`);
});

afterAll(() => {
  setApiShim(null);
});

it("defaults a pre-toggle response off, labels the setting experimental, and saves it", async () => {
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

  const toggle = view.getByRole("switch", {
    name: "Browser panel (experimental)",
  }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(
    view.queryByText(
      "Show the live Browser panel in agent chats. Off by default.",
    ) !== null,
  ).toBe(true);

  fireEvent.click(toggle);
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

  expect(savedBody).toEqual({
    prompt: null,
    name: null,
    experimental: { browserPanel: true },
    version: "1",
  });
  view.unmount();
});
