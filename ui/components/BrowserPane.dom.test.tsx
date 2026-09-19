import { afterAll, test, expect } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { BrowserPane } = await import("./BrowserPane");
const { setApiShim } = await import("../api");
const { onLanguage } = await import("../test-support/language-fixture");
afterAll(() => setApiShim(null));

test("unavailable selection stays explicit; pairing, replacement and revoke use self routes", async () => {
  let status = {
    backend: null as string | null,
    selectionRequired: true,
    paired: false,
    online: false,
    member: { id: "self", name: "Fixture member" },
    version: "0.1.0",
  };
  const writes: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "GET") return status;
    writes.push([method, path, body]);
    if (method === "PATCH")
      status = {
        ...status,
        backend: (body as { backend: string }).backend,
        selectionRequired: false,
      };
    if (method === "DELETE")
      status = { ...status, paired: false, online: false };
    if (method === "POST")
      return { code: "fixture-code", expiresAt: Date.now() + 300000 };
  });
  const view = render(<BrowserPane />);
  await act(async () => {});
  expect((view.getByTestId("browser-backend") as HTMLSelectElement).value).toBe(
    "",
  );
  expect(view.queryByTestId("browser-pair")).toBeNull();
  expect(writes).toHaveLength(0);
  await act(async () =>
    fireEvent.change(view.getByTestId("browser-backend"), {
      target: { value: "extension" },
    }),
  );
  await act(async () => fireEvent.click(view.getByTestId("browser-pair")));
  expect(writes).toEqual([
    ["PATCH", "/api/me/browser", { backend: "extension" }],
    ["POST", "/api/me/browser/pair", { replace: false }],
  ]);
  expect((view.getByTestId("browser-code") as HTMLInputElement).value).toBe(
    "fixture-code",
  );
  expect((view.getByTestId("browser-code") as HTMLInputElement).type).toBe("password");
  view.unmount();
  status = { ...status, paired: true, online: true };
  const paired = render(<BrowserPane />);
  await act(async () => {});
  expect(paired.getByTestId("browser-state").dataset.online).toBe("true");
  await act(async () => fireEvent.click(paired.getByTestId("browser-pair")));
  expect(writes.at(-1)).toEqual([
    "POST",
    "/api/me/browser/pair",
    { replace: true },
  ]);
  await act(async () => fireEvent.click(paired.getByTestId("browser-revoke")));
  expect(writes.at(-1)).toEqual(["DELETE", "/api/me/browser", undefined]);
  expect(paired.getByTestId("browser-state").dataset.paired).toBe("false");
  const english = paired.container.textContent;
  paired.unmount();
  const translated = render(onLanguage("es", <BrowserPane />));
  await act(async () => {});
  expect(translated.container.textContent).not.toBe(english);
  translated.unmount();
});
