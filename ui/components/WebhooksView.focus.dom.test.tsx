// A delivery row named by a webhook run's link (design section 8): every
// link asks for the whole log, also when the detail is already open, and the
// row counts as gone only on that answer.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { WebhooksView } = await import("./WebhooksView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { hookWire, deliveryRow, HOOK_ID } =
  await import("../test-support/webhook-fixture.ts");
type WebhookDelivery = import("../../shared/types.ts").WebhookDelivery;

let limits: string[] = [];
// Each deliveries GET waits for the test, which answers it with these rows.
let pending: ((rows: WebhookDelivery[]) => void)[] = [];
setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/webhooks") return [hookWire()];
  if (
    method === "GET" &&
    path.startsWith(`/api/webhooks/${HOOK_ID}/deliveries`)
  ) {
    limits.push(new URLSearchParams(path.split("?")[1]).get("limit")!);
    const rows = await new Promise<WebhookDelivery[]>((resolve) =>
      pending.push(resolve),
    );
    return { deliveries: rows };
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  limits = [];
  pending = [];
});

function tree(focus: string | null, focusSeq: number) {
  return onLanguage(
    "en",
    <WebhooksView
      openHookId={HOOK_ID}
      focusDeliveryId={focus}
      focusSeq={focusSeq}
      onOpenHook={() => {}}
      onCloseHook={() => {}}
      onEdit={() => {}}
      onOpenRun={() => {}}
    />,
    { webhooks: [hookWire()], webhooksLoaded: true, hydrationEpoch: 1 },
  );
}

const answer = async (rows: WebhookDelivery[]) =>
  act(async () => pending.shift()!(rows));

it("a link into an open detail fetches the whole log, and a second link fetches it again", async () => {
  const view = render(tree(null, 0));
  await act(async () => {});
  expect(limits).toEqual(["50"]);
  await answer([deliveryRow({ id: "d_new" })]);

  view.rerender(tree("d_old", 1));
  await act(async () => {});
  expect(limits).toEqual(["50", "500"]);
  // The first page does not hold the row, but the whole log is not back yet:
  // nothing says it is gone.
  expect(view.container.querySelector("[data-delivery-missing]")).toBeNull();
  await answer([deliveryRow({ id: "d_new" }), deliveryRow({ id: "d_old" })]);
  const focused = view.container.querySelector<HTMLElement>(
    '[data-focused="true"]',
  );
  expect(focused?.dataset.deliveryRow).toBe("d_old");

  // The same link again: a new fetch, and the row has since left the log.
  view.rerender(tree("d_old", 2));
  await act(async () => {});
  expect(limits).toEqual(["50", "500", "500"]);
  await answer([deliveryRow({ id: "d_new" })]);
  expect(view.container.querySelector('[data-focused="true"]')).toBeNull();
  expect(
    view.container.querySelector("[data-delivery-missing]"),
  ).not.toBeNull();
  view.unmount();
});
