import { afterAll, test, expect } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { PagerSettingsPane } = await import("./PagerSettingsPane");
const { setApiShim } = await import("../api");
afterAll(() => setApiShim(null));

type Res = import("../../shared/contract-shapes").PagerSettingsRes;
const PATH = "/api/users/boss/pager-settings";
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
  const view = render(<PagerSettingsPane username="boss" />);
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
  expect(field.type).toBe("password");
  expect(view.getByTestId("pager-webhook-current").textContent).toContain(
    "…WXYZ",
  );
  expect(view.container.textContent).not.toContain("abcdWXYZ");

  // An interval change sends the interval alone.
  await act(async () =>
    fireEvent.change(view.getByTestId("pager-repeat"), {
      target: { value: "never" },
    }),
  );
  await act(async () => fireEvent.click(save));
  expect(writes.at(-1)).toEqual(["PATCH", PATH, { repeatMinutes: null }]);

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
