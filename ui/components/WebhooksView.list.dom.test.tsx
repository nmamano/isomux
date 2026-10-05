// The Webhooks list (one row per hook, the warning mark) and the dry run on a
// hook's detail (design section 8).
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { WebhooksView } = await import("./WebhooksView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { hookWire, deliveryRow, HOOK_ID } =
  await import("../test-support/webhook-fixture.ts");
type AppState = import("../store.tsx").AppState;
type WebhookWire = import("../../shared/types.ts").WebhookWire;
type WebhookDelivery = import("../../shared/types.ts").WebhookDelivery;

const BLOCK = "BLOCK_MARKER";
let posted: { path: string; body: unknown }[] = [];
let deliveries: WebhookDelivery[] = [];
let listGets = 0;
setApiShim(async (method, path, body) => {
  if (method === "GET" && path === "/api/webhooks") {
    listGets++;
    return [];
  }
  if (
    method === "GET" &&
    path.startsWith(`/api/webhooks/${HOOK_ID}/deliveries`)
  )
    return { deliveries };
  if (method === "POST" && path === `/api/webhooks/${HOOK_ID}/dry-run`) {
    posted.push({ path, body });
    return {
      outcome: "match",
      ruleIndex: 1,
      args: { pr: "7" },
      block: BLOCK,
    };
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  posted = [];
  listGets = 0;
  deliveries = [];
});

const quiet = hookWire({
  id: "wh_1111111111111111",
  name: "quiet",
});
const rejected = hookWire({
  id: "wh_2222222222222222",
  name: "rejected",
  counters: { bad_signature: { count: 3, lastAt: 5 } },
});
const noSecret = hookWire({
  id: "wh_3333333333333333",
  name: "no-secret",
  secretState: "missing",
});

function tree(
  webhooks: WebhookWire[],
  openHookId: string | null,
  isMobile = false,
) {
  const base = stateWithSelfUser("en");
  const state: Partial<AppState> = {
    isMobile,
    webhooks,
    webhooksLoaded: true,
    hydrationEpoch: 1,
    sessionContext: base.sessionContext,
  };
  return onLanguage(
    "en",
    <WebhooksView
      openHookId={openHookId}
      focusDeliveryId={null}
      onOpenHook={() => {}}
      onCloseHook={() => {}}
      onEdit={() => {}}
      onOpenRun={() => {}}
    />,
    state,
  );
}

it("lists one row per hook and marks a missing secret or a rejection", async () => {
  const view = render(tree([quiet, rejected, noSecret], null));
  await act(async () => {});
  expect(listGets).toBe(1);
  const rows = [
    ...view.container.querySelectorAll<HTMLElement>("tr[data-webhook-row]"),
  ];
  expect(rows.map((r) => r.dataset.webhookRow)).toEqual([
    quiet.id,
    rejected.id,
    noSecret.id,
  ]);
  const marked = rows.map(
    (r) => r.querySelector("[data-webhook-attention]") !== null,
  );
  expect(marked).toEqual([false, true, true]);
  view.unmount();
});

it("the dry run posts the event and the parsed payload and shows the matched rule and block", async () => {
  const hook = hookWire();
  const view = render(tree([hook], HOOK_ID));
  await act(async () => {});
  const event = view.container.querySelector<HTMLInputElement>(
    "[data-dry-run-event]",
  )!;
  // Prefilled from the first named rule.
  expect(event.value).toBe("pull_request");
  const payload = view.container.querySelector<HTMLTextAreaElement>(
    "[data-dry-run-payload]",
  )!;
  act(() => {
    fireEvent.change(payload, { target: { value: '{"action":"opened"}' } });
  });
  await act(async () =>
    view.container.querySelector<HTMLElement>("[data-dry-run-test]")!.click(),
  );
  expect(posted).toHaveLength(1);
  expect(posted[0].body).toEqual({
    event: "pull_request",
    payload: { action: "opened" },
  });
  const result = view.container.querySelector<HTMLElement>(
    "[data-dry-run-result]",
  )!;
  expect(result.dataset.dryRunResult).toBe("match");
  // ruleIndex 1 is the second rule.
  expect(result.textContent).toContain("2");
  expect(
    view.container.querySelector("[data-dry-run-block]")!.textContent,
  ).toBe(BLOCK);
  view.unmount();
});

it("the dry run sends nothing for a payload that is not a JSON object", async () => {
  const view = render(tree([hookWire()], HOOK_ID));
  await act(async () => {});
  const payload = view.container.querySelector<HTMLTextAreaElement>(
    "[data-dry-run-payload]",
  )!;
  for (const text of ["not json", "[1,2]", "null"]) {
    act(() => {
      fireEvent.change(payload, { target: { value: text } });
    });
    await act(async () =>
      view.container.querySelector<HTMLElement>("[data-dry-run-test]")!.click(),
    );
  }
  expect(posted).toHaveLength(0);
  expect(view.container.querySelector("[data-dry-run-result]")).toBeNull();
  view.unmount();
});

it("at phone width a delivery row still names its rule and its args", async () => {
  deliveries = [
    deliveryRow({
      id: "d_1",
      outcome: "dispatched",
      ruleIndex: 0,
      args: { pr: "7" },
    }),
  ];
  const view = render(tree([hookWire()], HOOK_ID, true));
  await act(async () => {});
  const row = view.container.querySelector<HTMLElement>(
    '[data-delivery-row="d_1"]',
  )!;
  expect(row.querySelector('[data-delivery-rule="1"]')).not.toBeNull();
  expect(row.querySelector("[data-delivery-args]")!.textContent).toBe("pr=7");
  view.unmount();
});
