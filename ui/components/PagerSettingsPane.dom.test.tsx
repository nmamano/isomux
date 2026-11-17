import { afterAll, test, expect } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom";
import { expectMasked } from "../test-support/masked";
import { asData, sentenceValues } from "../test-support/data-values";
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

  // Remove asks first: the server keeps only the mask, so a removed webhook
  // must be copied from Discord again. The first click arms the button and
  // writes nothing; Escape disarms it; only a second click removes.
  const remove = () => view.getByTestId("pager-webhook-remove");
  const label = remove().textContent;
  const before = writes.length;
  await act(async () => fireEvent.click(remove()));
  expect(writes.length).toBe(before);
  expect(remove().hasAttribute("data-confirm-armed")).toBe(true);
  expect(remove().textContent).not.toBe(label);
  await act(async () => fireEvent.keyDown(remove(), { key: "Escape" }));
  expect(remove().hasAttribute("data-confirm-armed")).toBe(false);
  expect(remove().textContent).toBe(label);
  // A click after Escape arms again; it does not remove.
  await act(async () => fireEvent.click(remove()));
  expect(writes.length).toBe(before);
  expect(remove().hasAttribute("data-confirm-armed")).toBe(true);
  await act(async () => fireEvent.click(remove()));
  expect(writes.length).toBe(before + 1);
  expect(writes.at(-1)).toEqual(["PATCH", PATH, { webhookUrl: null }]);
  expect(view.queryByTestId("pager-webhook-remove")).toBeNull();
  view.unmount();
});

test("while the settings load, the pane shows its form with nothing to act on, and holds the webhook row it last showed", async () => {
  // Only the settings read is held; the push devices block answers at once.
  let resolve!: (value: unknown) => void;
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/users/morgan/push-devices") {
      return { publicKey: "", devices: [] };
    }
    if (method !== "GET" || path !== PATH) {
      throw new Error(`Unexpected request: ${method} ${path}`);
    }
    return new Promise((done) => {
      resolve = done;
    });
  });
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

// Task da868bd9: the held webhook row paints, dimmed, and says nothing the
// answer has not said yet: bars stand in for whether a webhook is saved and
// for its address. A control's caption is not an answer.
test("the held webhook row paints with bars, not a webhook or its absence, either way it was last shown", async () => {
  let resolve!: (value: unknown) => void;
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/users/morgan/push-devices")
      return { publicKey: "", devices: [] };
    if (method !== "GET" || path !== PATH)
      throw new Error(`Unexpected request: ${method} ${path}`);
    return new Promise((done) => {
      resolve = done;
    });
  });
  const looks = (root: Element) =>
    [...root.querySelectorAll<HTMLElement>("[data-reserved]")].map((node) => {
      const copy = node.cloneNode(true) as Element;
      for (const button of copy.querySelectorAll("button")) button.remove();
      return {
        painted: node.style.visibility !== "hidden",
        bars: node.querySelectorAll("[data-placeholder]").length > 0,
        text: (copy.textContent ?? "").trim(),
      };
    });
  const bare = { painted: true, bars: true, text: "" };

  // A first visit holds a saved webhook's row.
  window.localStorage.clear();
  let view = render(<PagerSettingsPane username="morgan" />);
  await act(async () => {});
  expect({ saved: looks(view.container) }).toEqual({ saved: [bare] });
  await act(async () =>
    resolve({ webhookUrlMasked: null, discordUserId: null, repeatMinutes: 5 }),
  );
  view.unmount();

  // That load had none: the next holds the "none" line.
  view = render(<PagerSettingsPane username="morgan" />);
  await act(async () => {});
  expect({ none: looks(view.container) }).toEqual({ none: [bare] });
  await act(async () =>
    resolve({ webhookUrlMasked: null, discordUserId: null, repeatMinutes: 5 }),
  );
  view.unmount();
});

// Another member's pager (an owner on their page): their name is a value in
// the intro and in the user ID help, each time it shows (AGENTS.md "UI
// rules").
test("on another member's pager, their name shows as a value in the intro and the user ID help", async () => {
  const MEMBER = "Robin Member";
  setApiShim(async (method, path) => {
    if (method === "GET" && path === PATH)
      return { webhookUrlMasked: null, discordUserId: null, repeatMinutes: 5 };
    if (method === "GET" && path === "/api/users/morgan/push-devices")
      return { publicKey: "", devices: [] };
    throw new Error(`no shim for ${method} ${path}`);
  });
  const view = render(<PagerSettingsPane username="morgan" member={MEMBER} />);
  await act(async () => {});
  const pane = view.getByTestId("pager-settings");
  expect(sentenceValues(pane, [MEMBER])).toEqual(asData([MEMBER]));
  const tip = view.container.querySelector<HTMLElement>(
    'label[for="pager-user-id"] [data-help-tip]',
  );
  expect(tip).not.toBeNull();
  await act(async () => fireEvent.click(tip!));
  const note = view.container.querySelector('[role="note"]');
  expect(note).not.toBeNull();
  expect(sentenceValues(note!, [MEMBER])).toEqual(asData([MEMBER, MEMBER]));
  view.unmount();
});
