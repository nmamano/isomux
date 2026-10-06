// A member of a hook's room reads it (task fe0c21fd): the row and the detail,
// with no enabled toggle, no Edit and no secret controls. The hook owner and
// office owners keep them. When the hook leaves the viewer's sight, its open
// detail and delivery log go with it.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { WebhooksView } = await import("./WebhooksView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { hookWire, deliveryRow, HOOK_ID } =
  await import("../test-support/webhook-fixture.ts");
type AppState = import("../store.tsx").AppState;
type WebhookWire = import("../../shared/types.ts").WebhookWire;

const ROW_ID = "d_00000001";
let requests: string[] = [];
setApiShim(async (method, path) => {
  requests.push(`${method} ${path}`);
  if (method === "GET" && path === "/api/webhooks") return [];
  if (
    method === "GET" &&
    path.startsWith(`/api/webhooks/${HOOK_ID}/deliveries`)
  )
    return { deliveries: [deliveryRow({ id: ROW_ID })] };
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  requests = [];
});

// Another member's hook. The self user of the fixture is "u1".
const othersHook = hookWire({ userId: "u-other", username: "Other" });

function tree(
  webhooks: WebhookWire[],
  openHookId: string | null,
  role: "member" | "owner" = "member",
) {
  const base = stateWithSelfUser("en");
  const state: Partial<AppState> = {
    webhooks,
    webhooksLoaded: true,
    hydrationEpoch: 1,
    sessionContext: { ...base.sessionContext!, role },
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

const q = (view: { container: HTMLElement }, selector: string) =>
  view.container.querySelector<HTMLElement>(selector);

it("a reader's row has no enabled toggle, and a click on the dot sends nothing", async () => {
  const view = render(tree([othersHook], null));
  await act(async () => {});
  expect(q(view, `tr[data-webhook-row="${HOOK_ID}"]`)).not.toBeNull();
  expect(q(view, "[data-webhook-toggle]")).toBeNull();
  const dotCell = q(view, `tr[data-webhook-row="${HOOK_ID}"] td`)!;
  await act(async () => dotCell.click());
  expect(requests.filter((r) => r.startsWith("PATCH"))).toEqual([]);
  view.unmount();

  // The owner of the hook and an office owner keep the toggle.
  const own = render(tree([hookWire()], null));
  await act(async () => {});
  expect(q(own, "[data-webhook-toggle]")).not.toBeNull();
  own.unmount();
  const officeOwner = render(tree([othersHook], null, "owner"));
  await act(async () => {});
  expect(q(officeOwner, "[data-webhook-toggle]")).not.toBeNull();
  officeOwner.unmount();
});

it("a reader's detail shows the hook and its delivery log, with no Edit and no secret controls", async () => {
  const view = render(tree([othersHook], HOOK_ID));
  await act(async () => {});
  expect(q(view, "[data-webhook-name]")?.textContent).toBe(othersHook.name);
  expect(q(view, `[data-delivery-row="${ROW_ID}"]`)).not.toBeNull();
  expect(q(view, "[data-webhook-edit]")).toBeNull();
  expect(q(view, "[data-webhook-secret-show]")).toBeNull();
  expect(q(view, "[data-webhook-rotate]")).toBeNull();
  view.unmount();

  const officeOwner = render(tree([othersHook], HOOK_ID, "owner"));
  await act(async () => {});
  expect(q(officeOwner, "[data-webhook-edit]")).not.toBeNull();
  expect(q(officeOwner, "[data-webhook-secret-show]")).not.toBeNull();
  expect(q(officeOwner, "[data-webhook-rotate]")).not.toBeNull();
  officeOwner.unmount();
});

it("an open detail and its delivery log go when the hook leaves the viewer's sight", async () => {
  const view = render(tree([othersHook], HOOK_ID));
  await act(async () => {});
  expect(q(view, `[data-delivery-row="${ROW_ID}"]`)).not.toBeNull();
  // A webhook_deleted delta drops the hook from the store.
  view.rerender(tree([], HOOK_ID));
  await act(async () => {});
  expect(q(view, "[data-webhook-name]")).toBeNull();
  expect(q(view, `[data-delivery-row="${ROW_ID}"]`)).toBeNull();
  // It comes back as a fresh detail, which reads the log again.
  const before = requests.filter((r) => r.includes("/deliveries")).length;
  view.rerender(tree([othersHook], HOOK_ID));
  await act(async () => {});
  expect(requests.filter((r) => r.includes("/deliveries")).length).toBe(
    before + 1,
  );
  view.unmount();
});
