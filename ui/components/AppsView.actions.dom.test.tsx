import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { AppsView } = await import("./AppsView.tsx");
const { StoreProvider } = await import("../store.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { connect, setShim } = await import("../ws.ts");

setShim(() => {});
afterAll(() => {
  setApiShim(null);
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});

it("keeps the same action buttons through pending, successful, and failed lifecycle requests", async () => {
  const app = {
    name: "controls-fixture",
    command: "bun run start",
    cwd: "/fixture",
    dataDir: "/fixture/data",
    port: 21000,
    hostLabel: "controls-fixture",
    hostGen: 1,
    userId: "owner",
    username: "Owner",
    createdBy: "Owner",
    createdAt: 1,
    state: "running" as const,
    restartCount: 0,
  };
  let settle!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const calls: string[] = [];
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/apps")
      return [{ ...app, canManage: true }];
    if (method === "POST") {
      calls.push(path);
      return new Promise((resolve, fail) => {
        settle = resolve;
        reject = fail;
      });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  const view = render(
    <StoreProvider>
      <AppsView onClose={() => {}} />
    </StoreProvider>,
  );
  await act(async () => {});
  const card = view.getByRole("link", { name: app.name }).parentElement!
    .parentElement!;
  const buttons = Array.from(card.querySelectorAll("button"));
  expect(buttons.length).toBe(5);
  const row = buttons[0].parentElement!;
  const sameButtons = () => {
    expect(row.isConnected).toBe(true);
    const current = card.querySelectorAll("button");
    expect(current.length).toBe(5);
    buttons.forEach((button, index) =>
      expect(current[index] === button).toBe(true),
    );
  };
  for (const [index, verb, state] of [
    [1, "stop", "stopped"],
    [0, "start", "running"],
    [2, "restart", "running"],
  ] as const) {
    await act(async () => buttons[index].click());
    expect(calls.at(-1)).toBe(`/api/apps/${app.name}/${verb}`);
    sameButtons();
    expect(buttons.every((button) => button.disabled)).toBe(true);
    // Lifecycle responses carry AppWire, without the list's canManage field.
    await act(async () => settle({ ...app, state }));
    sameButtons();
    expect(buttons.map((button) => button.disabled)).toEqual(
      state === "stopped"
        ? [false, true, true, false, false]
        : [true, false, false, false, false],
    );
  }
  await act(async () => buttons[1].click());
  const failure = "fixture supervisor failure";
  await act(async () =>
    reject(new ApiError(500, "supervisor_failed", failure)),
  );
  sameButtons();
  expect(view.container.textContent).toContain(failure);
  expect(buttons[1].disabled).toBe(false);
  await act(async () => buttons[1].click());
  expect(view.container.textContent).not.toContain(failure);
  expect(buttons.every((button) => button.disabled)).toBe(true);
  await act(async () => settle({ ...app, state: "stopped" }));
  sameButtons();
  expect(buttons[0].disabled).toBe(false);
});
