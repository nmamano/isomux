import { afterAll, test, expect } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { BrowserPane } = await import("./BrowserPane");
const { setApiShim } = await import("../api");
const { onLanguage } = await import("../test-support/language-fixture");
afterAll(() => setApiShim(null));

test("Chrome pairing is direct; replacement and revoke use self routes", async () => {
  let status = {
    paired: false,
    online: false,
    member: { id: "self", name: "Fixture member" },
    version: "0.1.0",
  };
  const writes: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "GET") return status;
    writes.push([method, path, body]);
    if (method === "DELETE")
      status = { ...status, paired: false, online: false };
    if (method === "POST")
      return { code: "fixture-code", expiresAt: Date.now() + 300000 };
  });
  const view = render(<BrowserPane />);
  await act(async () => {});
  expect(view.queryByTestId("browser-backend")).toBeNull();
  expect(view.getByTestId("browser-pair")).toBeTruthy();
  expect(writes).toHaveLength(0);
  await act(async () => fireEvent.click(view.getByTestId("browser-pair")));
  expect(writes).toEqual([
    ["POST", "/api/me/browser/pair", { replace: false }],
  ]);
  expect((view.getByTestId("browser-code") as HTMLInputElement).value).toBe(
    "fixture-code",
  );
  expect((view.getByTestId("browser-code") as HTMLInputElement).type).toBe(
    "password",
  );
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

test("the extensions step copies the Chrome address it names", async () => {
  setApiShim(async () => ({
    paired: false,
    online: false,
    member: { id: "self", name: "Fixture member" },
    version: "0.1.0",
  }));
  const copied: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  try {
    const view = render(<BrowserPane />);
    await act(async () => {});
    const button = view.getByTestId("browser-extensions-copy");
    const step = button.closest("li")!;
    const address = step.querySelector("code")!.textContent;
    expect(address.startsWith("chrome://")).toBe(true);
    const before = button.textContent;
    await act(async () => fireEvent.click(button));
    expect(copied).toEqual([address]);
    expect(button.textContent).not.toBe(before);
    view.unmount();
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  }
});
