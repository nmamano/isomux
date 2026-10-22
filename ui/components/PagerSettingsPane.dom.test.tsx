import { afterAll, test, expect } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom";
import { expectMasked } from "../test-support/masked";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { PagerSettingsPane } = await import("./PagerSettingsPane");
const { setApiShim } = await import("../api");
afterAll(() => setApiShim(null));

type Res = import("../../shared/contract-shapes").PagerSettingsRes;
const PATH = "/api/users/morgan/pager-settings";
const URL_ = "https://discord.com/api/webhooks/1234/abcdWXYZ";

test("the pane saves only what changed, never shows the saved URL, and runs the test send", async () => {
  let res: Res = {
    webhookUrlMasked: null,
    discordUserId: null,
    repeatMinutes: 5,
  };
  const writes: unknown[] = [];
  let testRes: unknown = { delivered: true };
  setApiShim(async (method, path, body) => {
    if (method === "GET" && path === PATH) return res;
    // The push devices block below the form reads its own route.
    if (method === "GET" && path === "/api/users/morgan/push-devices") {
      return { publicKey: "", devices: [] };
    }
    writes.push([method, path, body]);
    if (method === "PATCH") {
      const b = body as Record<string, unknown>;
      res = {
        webhookUrlMasked:
          "webhookUrl" in b
            ? b.webhookUrl === null
              ? null
              : "https://discord.com/api/webhooks/…WXYZ"
            : res.webhookUrlMasked,
        discordUserId:
          "discordUserId" in b
            ? (b.discordUserId as string | null)
            : res.discordUserId,
        repeatMinutes:
          "repeatMinutes" in b
            ? (b.repeatMinutes as number | null)
            : res.repeatMinutes,
      };
      return res;
    }
    if (method === "POST") return testRes;
  });
  const view = render(<PagerSettingsPane username="morgan" />);
  await act(async () => {});
  const save = view.getByTestId("pager-save") as HTMLButtonElement;
  const send = view.getByTestId("pager-test") as HTMLButtonElement;
  // Nothing to save, and nowhere to send a test yet.
  expect(save.disabled).toBe(true);
  expect(send.disabled).toBe(true);
  expect(view.queryByTestId("pager-webhook-remove")).toBeNull();

  await act(async () => {
    fireEvent.change(view.getByTestId("pager-webhook"), {
      target: { value: URL_ },
    });
    fireEvent.change(view.getByTestId("pager-user-id"), {
      target: { value: "112233445566778899" },
    });
  });
  await act(async () => fireEvent.click(save));
  expect(writes).toEqual([
    ["PATCH", PATH, { webhookUrl: URL_, discordUserId: "112233445566778899" }],
  ]);
  // The field empties after the save; only the mask is shown.
  const field = view.getByTestId("pager-webhook") as HTMLInputElement;
  expect(field.value).toBe("");
  expectMasked(field);
  expect(view.getByTestId("pager-webhook-current").textContent).toContain(
    "…WXYZ",
  );
  expect(view.container.textContent).not.toContain("abcdWXYZ");

  // An interval change saves at once, the interval alone, and leaves a typed
  // but unsaved user ID in its field.
  await act(async () =>
    fireEvent.change(view.getByTestId("pager-user-id"), {
      target: { value: "998877665544332211" },
    }),
  );
  await act(async () =>
    fireEvent.change(view.getByTestId("pager-repeat"), {
      target: { value: "never" },
    }),
  );
  expect(writes.at(-1)).toEqual(["PATCH", PATH, { repeatMinutes: null }]);
  expect((view.getByTestId("pager-user-id") as HTMLInputElement).value).toBe(
    "998877665544332211",
  );
  await act(async () =>
    fireEvent.change(view.getByTestId("pager-user-id"), {
      target: { value: "112233445566778899" },
    }),
  );

  await act(async () => fireEvent.click(send));
  expect(writes.at(-1)).toEqual(["POST", `${PATH}/test`, undefined]);
  expect(view.getByTestId("pager-status").dataset.ok).toBe("true");

  testRes = { delivered: false, failure: "http_4xx" };
  await act(async () => fireEvent.click(send));
  expect(view.getByTestId("pager-status").dataset.ok).toBe("false");

  await act(async () =>
    fireEvent.click(view.getByTestId("pager-webhook-remove")),
  );
  expect(writes.at(-1)).toEqual(["PATCH", PATH, { webhookUrl: null }]);
  expect(view.queryByTestId("pager-webhook-remove")).toBeNull();
  view.unmount();
});

test("while the settings load, the pane shows its form with nothing to act on, and holds the webhook row it last showed", async () => {
  let resolve!: (value: unknown) => void;
  setApiShim(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const mount = () => render(<PagerSettingsPane username="morgan" />);
  const busy = (view: ReturnType<typeof mount>) =>
    view.container.querySelector('[aria-busy="true"]');
  const heldRemove = (view: ReturnType<typeof mount>) =>
    view.container.querySelectorAll("[data-reserved] button").length;

  // A device that never loaded the pane holds a saved webhook's row.
  window.localStorage.clear();
  let view = mount();
  expect(busy(view)?.hasAttribute("inert")).toBe(true);
  expect(heldRemove(view)).toBe(1);
  // The held row is not the real one, and no repeat choice shows yet.
  expect(view.queryByTestId("pager-webhook-current")).toBeNull();
  expect((view.getByTestId("pager-repeat") as HTMLSelectElement).value).toBe(
    "",
  );
  expect((view.getByTestId("pager-save") as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () =>
    resolve({ webhookUrlMasked: null, discordUserId: null, repeatMinutes: 5 }),
  );
  expect(busy(view)).toBeNull();
  expect(view.container.querySelector("[data-reserved]")).toBeNull();
  expect((view.getByTestId("pager-repeat") as HTMLSelectElement).value).toBe(
    "5",
  );
  view.unmount();

  // No webhook saved: the next load holds the shorter "none" line.
  view = mount();
  expect(heldRemove(view)).toBe(0);
  expect(view.container.querySelector("[data-reserved]")).not.toBeNull();
  await act(async () =>
    resolve({ webhookUrlMasked: null, discordUserId: null, repeatMinutes: 5 }),
  );
  view.unmount();
});
