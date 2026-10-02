import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { OfficePane } = await import("./OfficePane.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");

// The member usage cap switch (task 6de8f530): it round-trips through the
// version-guarded settings PUT, and its status lines show while it is on.
let enabled = false;
let savedBody: Record<string, unknown> | null = null;
setApiShim(async (method, path, body) => {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path === "/api/office/settings" && method === "GET")
    return {
      prompt: null,
      name: null,
      version: enabled ? "2" : "1",
      memberUsageCap: enabled,
      memberUsageStatus: enabled
        ? [
            {
              provider: "claude",
              state: "weekly",
              usedPercent: 41.6,
              pacePercent: 50.2,
            },
            { provider: "codex", state: "failed" },
          ]
        : [],
    };
  if (path === "/api/office/settings" && method === "PUT") {
    savedBody = body as Record<string, unknown>;
    enabled = savedBody.memberUsageCap === true;
    return undefined;
  }
  throw new Error(`no shim for ${method} ${path}`);
});

afterAll(() => {
  setApiShim(null);
});

it("saves the switch with the settings and shows one status line per provider once on", async () => {
  const view = render(onLanguage(null, createElement(OfficePane)));
  await act(async () => {});
  const box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.checked).toBe(false);
  expect(view.queryByText(/Claude/)).toBeNull();

  await act(async () => fireEvent.click(box));
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Save" })),
  );
  expect(savedBody).toMatchObject({ version: "1", memberUsageCap: true });
  expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  // Rounded numbers from the status, and a line for each provider.
  expect(view.getByText(/Claude/).textContent).toContain("42");
  expect(view.getByText(/Claude/).textContent).toContain("50");
  expect(view.getByText(/Codex/)).toBeTruthy();
  view.unmount();
});
