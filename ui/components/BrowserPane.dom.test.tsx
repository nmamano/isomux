import { afterAll, test, expect } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { BrowserPane } = await import("./BrowserPane");
const { setApiShim } = await import("../api");
const { onLanguage } = await import("../test-support/language-fixture");
afterAll(() => setApiShim(null));

test("Chrome pairing adds named browsers; each one unpairs through its own self route", async () => {
  type Status =
    import("../../shared/browser-extension-protocol").MemberBrowserStatus;
  let status: Status = {
    paired: false,
    online: false,
    member: { id: "self", name: "Fixture member" },
    version: "0.1.0",
    browsers: [],
  };
  const writes: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "GET") return status;
    writes.push([method, path, body]);
    if (method === "DELETE") {
      const browsers = status.browsers.filter(
        (b) => path !== `/api/me/browser/browsers/${b.id}`,
      );
      status = {
        ...status,
        browsers,
        paired: browsers.length > 0,
        online: browsers.some((b) => b.online),
      };
    }
    if (method === "POST")
      return { code: "fixture-code", expiresAt: Date.now() + 300000 };
  });
  const view = render(<BrowserPane />);
  await act(async () => {});
  expect(view.queryByTestId("browser-backend")).toBeNull();
  expect(view.queryAllByTestId("browser-row")).toHaveLength(0);
  expect(writes).toHaveLength(0);
  await act(async () =>
    fireEvent.change(view.getByTestId("browser-name"), {
      target: { value: "Work laptop" },
    }),
  );
  await act(async () => fireEvent.click(view.getByTestId("browser-pair")));
  expect(writes).toEqual([
    ["POST", "/api/me/browser/pair", { name: "Work laptop" }],
  ]);
  expect((view.getByTestId("browser-name") as HTMLInputElement).value).toBe("");
  expect((view.getByTestId("browser-code") as HTMLInputElement).value).toBe(
    "fixture-code",
  );
  expect((view.getByTestId("browser-code") as HTMLInputElement).type).toBe(
    "password",
  );
  view.unmount();
  status = {
    ...status,
    paired: true,
    online: true,
    browsers: [
      { id: "laptop", name: "Work laptop", pairedAt: 0, online: true },
      { id: "desk", name: "Desk", pairedAt: null, online: false },
    ],
  };
  const paired = render(<BrowserPane />);
  await act(async () => {});
  expect(paired.getByTestId("browser-state").dataset.online).toBe("true");
  const rows = paired.getAllByTestId("browser-row");
  expect(rows.map((r) => r.dataset.online)).toEqual(["true", "false"]);
  expect(rows[0].textContent).toContain("Work laptop");
  expect(rows[1].textContent).toContain("Desk");
  // A paired member still creates codes the same way; no replace flag.
  await act(async () => fireEvent.click(paired.getByTestId("browser-pair")));
  expect(writes.at(-1)).toEqual(["POST", "/api/me/browser/pair", { name: "" }]);
  await act(async () =>
    fireEvent.click(paired.getAllByTestId("browser-revoke")[0]),
  );
  expect(writes.at(-1)).toEqual([
    "DELETE",
    "/api/me/browser/browsers/laptop",
    undefined,
  ]);
  expect(
    paired.getAllByTestId("browser-row").map((r) => r.dataset.online),
  ).toEqual(["false"]);
  expect(paired.getByTestId("browser-state").dataset.paired).toBe("true");
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
    browsers: [],
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
