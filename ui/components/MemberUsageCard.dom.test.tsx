import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { MemberUsageCard } = await import("./MemberUsageCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");

// The member usage cap switch and member share (task 6de8f530), on the office
// half of Connections: they round-trip through the version-guarded settings
// PUT, which carries back the prompt it read (an absent prompt clears it) and
// no name (an absent name keeps it). The share select shows while the switch is
// on, and the status lines show once it is saved on.
let enabled = false;
let share = 80;
let savedBody: Record<string, unknown> | null = null;
setApiShim(async (method, path, body) => {
  if (path === "/api/office/settings" && method === "GET")
    return {
      prompt: "Office rules",
      name: "Office name",
      version: enabled ? "2" : "1",
      memberUsageCap: enabled,
      memberUsageShare: share,
      memberUsageStatus: enabled
        ? [
            {
              provider: "claude",
              state: "weekly",
              usedPercent: 41.6,
              linePercent: (80 * 4) / 7,
            },
            { provider: "codex", state: "failed" },
          ]
        : [],
    };
  if (path === "/api/office/settings" && method === "PUT") {
    savedBody = body as Record<string, unknown>;
    enabled = savedBody.memberUsageCap === true;
    share = savedBody.memberUsageShare as number;
    return undefined;
  }
  throw new Error(`no shim for ${method} ${path}`);
});

afterAll(() => {
  setApiShim(null);
});

it("saves the switch and share with the settings and shows one status line per provider once on", async () => {
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  await act(async () => {});
  const box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.checked).toBe(false);
  expect(view.queryByRole("combobox")).toBeNull();
  expect(view.queryByText(/Claude/)).toBeNull();

  await act(async () => fireEvent.click(box));
  const select = view.getByRole("combobox") as HTMLSelectElement;
  expect(select.value).toBe("80");
  expect(
    Array.from(select.options).map((option) => Number(option.value)),
  ).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  await act(async () => fireEvent.change(select, { target: { value: "70" } }));
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Save" })),
  );
  expect(savedBody).not.toHaveProperty("name");
  expect(savedBody).toMatchObject({
    prompt: "Office rules",
    version: "1",
    memberUsageCap: true,
    memberUsageShare: 70,
  });
  expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  expect((view.getByRole("combobox") as HTMLSelectElement).value).toBe("70");
  // The use rounded, the line to one decimal, and a line for each provider.
  expect(view.getByText(/Claude/).textContent).toContain("42");
  expect(view.getByText(/Claude/).textContent).toContain("45.7");
  expect(view.getByText(/Codex/)).toBeTruthy();
  view.unmount();
});

it("reserves the card frame and disables writes until settings arrive", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const writes: unknown[] = [];
  setApiShim(async (method, _path, body) => {
    if (method === "GET") return pending;
    writes.push(body);
  });
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  const frame = view.container.querySelector('section[aria-busy="true"]');
  expect(frame?.tagName).toBe("SECTION");
  const box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.disabled).toBe(true);
  const buttons = view.getAllByRole("button") as HTMLButtonElement[];
  expect(buttons.every((button) => button.disabled)).toBe(true);
  await act(async () => {
    for (const button of buttons) fireEvent.click(button);
    resolve({ version: "1", memberUsageCap: false, memberUsageShare: 80 });
  });
  expect(writes).toHaveLength(0);
  expect(
    view.container.querySelector('section[aria-busy="false"]')?.tagName,
  ).toBe("SECTION");
  expect((view.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false);
  view.unmount();
});

for (const outcome of ["failed", "unsupported"] as const) {
  it(`removes the reserved card after ${outcome} settings`, async () => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    setApiShim(async () => pending);
    const view = render(onLanguage(null, createElement(MemberUsageCard)));
    expect(
      view.container.querySelector('section[aria-busy="true"]')?.tagName,
    ).toBe("SECTION");
    await act(async () => {
      if (outcome === "failed") reject(new Error("unavailable"));
      else resolve({ version: "1" });
    });
    expect(view.container.childElementCount).toBe(0);
    view.unmount();
  });
}
