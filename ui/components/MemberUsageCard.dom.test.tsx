import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { MemberUsageCard } = await import("./MemberUsageCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const t = translatorFor("en").t;

// The member usage cap switch and member share (task 6de8f530), on the office
// half of Connections: they round-trip through the version-guarded settings
// PUT, which carries only these fields (an absent name keeps it). The share
// select shows while the switch is on, and the status lines show once it is
// saved on.
let enabled = false;
let share = 80;
let savedBody: Record<string, unknown> | null = null;
setApiShim(async (method, path, body) => {
  if (path === "/api/office/settings" && method === "GET")
    return {
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
  await act(async () => fireEvent.change(select, { target: { value: "70" } }));
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: t("common.save") })),
  );
  // Only its own fields and the version: no name, and no `prompt`, the old
  // field the server refuses since task 744fa64a.
  expect(savedBody).toEqual({
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

it("reserves the card frame, with the switch neither on nor off and writes disabled, until settings arrive", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  setApiShim(async () => pending);
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  const frame = view.container.querySelector('section[aria-busy="true"]');
  expect(frame?.tagName).toBe("SECTION");
  const box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.disabled).toBe(true);
  expect(box.indeterminate).toBe(true);
  const buttons = view.getAllByRole("button") as HTMLButtonElement[];
  expect(buttons.every((button) => button.disabled)).toBe(true);
  await act(async () =>
    resolve({ version: "1", memberUsageCap: true, memberUsageShare: 80 }),
  );
  expect(
    view.container.querySelector('section[aria-busy="false"]')?.tagName,
  ).toBe("SECTION");
  expect(box.disabled).toBe(false);
  expect(box.indeterminate).toBe(false);
  expect(box.checked).toBe(true);
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

it("holds the share row and status lines it last showed on this device while settings load", async () => {
  const mount = () => render(onLanguage(null, createElement(MemberUsageCard)));
  const held = (view: ReturnType<typeof mount>) => ({
    shares: view.container.querySelectorAll("[data-reserved] select").length,
    lines: view.container.querySelectorAll("[data-reserved] p").length,
  });
  let resolve!: (value: unknown) => void;
  setApiShim(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );

  // A device that never loaded the card holds the switched-on layout.
  window.localStorage.clear();
  let view = mount();
  expect(held(view)).toEqual({ shares: 1, lines: 2 });
  for (const node of view.container.querySelectorAll("[data-reserved]"))
    expect(node.getAttribute("aria-hidden")).toBe("true");
  await act(async () =>
    resolve({
      version: "1",
      memberUsageCap: true,
      memberUsageShare: 80,
      memberUsageStatus: [{ provider: "claude", state: "no_limit" }],
    }),
  );
  expect(view.container.querySelector("[data-reserved]")).toBeNull();
  view.unmount();

  // The next load holds what this one showed: the share row and one line.
  view = mount();
  expect(held(view)).toEqual({ shares: 1, lines: 1 });
  await act(async () =>
    resolve({ version: "1", memberUsageCap: false, memberUsageShare: 80 }),
  );
  view.unmount();

  // Switched off, the card showed neither.
  view = mount();
  expect(view.container.querySelector("[data-reserved]")).toBeNull();
  view.unmount();
});

// Task 32c25445: the Office and Room panes keep Save live with nothing
// changed, so a click always answers. This card does the same.
it("saves and says so when Save is clicked with nothing changed", async () => {
  const writes: Record<string, unknown>[] = [];
  setApiShim(async (method, _path, body) => {
    if (method === "PUT") {
      writes.push(body as Record<string, unknown>);
      return undefined;
    }
    return { version: "1", memberUsageCap: true, memberUsageShare: 80 };
  });
  const view = render(onLanguage(null, createElement(MemberUsageCard)));
  await act(async () => {});
  const buttons = view.getAllByRole("button") as HTMLButtonElement[];
  const save = buttons[buttons.length - 1];
  expect(save.disabled).toBe(false);
  const before = save.textContent;
  await act(async () => fireEvent.click(save));
  expect(writes).toEqual([
    {
      version: "1",
      memberUsageCap: true,
      memberUsageShare: 80,
    },
  ]);
  expect(save.textContent).not.toBe(before);
  view.unmount();
});
