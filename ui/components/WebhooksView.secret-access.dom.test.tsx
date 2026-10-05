// Who gets the secret controls on a hook's detail (design section 2): Show
// and Rotate exist only for the hook owner and office owners, and Rotate asks
// before it posts.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { WebhooksView } = await import("./WebhooksView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { hookWire, HOOK_ID } =
  await import("../test-support/webhook-fixture.ts");
type AppState = import("../store.tsx").AppState;
type WebhookWire = import("../../shared/types.ts").WebhookWire;

const SECRET = "SECRET_VALUE_MARKER";
let secretCalls: string[] = [];
setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/webhooks") return [hookWire()];
  if (
    method === "GET" &&
    path.startsWith(`/api/webhooks/${HOOK_ID}/deliveries`)
  )
    return { deliveries: [] };
  if (path === `/api/webhooks/${HOOK_ID}/secret`) {
    secretCalls.push(method);
    return { secret: SECRET };
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  secretCalls = [];
});

function tree(hook: WebhookWire, role: "owner" | "member", session = true) {
  const base = stateWithSelfUser("en");
  const state: Partial<AppState> = {
    webhooks: [hook],
    webhooksLoaded: true,
    hydrationEpoch: 1,
    sessionContext: session ? { ...base.sessionContext!, role } : null,
  };
  return onLanguage(
    "en",
    <WebhooksView
      openHookId={HOOK_ID}
      focusDeliveryId={null}
      onOpenHook={() => {}}
      onCloseHook={() => {}}
      onEdit={() => {}}
      onOpenRun={() => {}}
    />,
    state,
  );
}

const q = (root: HTMLElement, attr: string) =>
  root.querySelector<HTMLElement>(`[${attr}]`);

it("Show and Rotate are there for the hook owner and an office owner only", async () => {
  // One mount; each viewer is a rerender of the same detail.
  const view = render(tree(hookWire(), "member"));
  await act(async () => {});
  const controls = () => [
    q(view.container, "data-webhook-secret-show") !== null,
    q(view.container, "data-webhook-rotate") !== null,
  ];
  expect(controls()).toEqual([true, true]);
  view.rerender(tree(hookWire({ userId: "u2" }), "owner"));
  await act(async () => {});
  expect(controls()).toEqual([true, true]);
  // Another member's hook, seen by a member.
  view.rerender(tree(hookWire({ userId: "u2" }), "member"));
  await act(async () => {});
  expect(controls()).toEqual([false, false]);
  // No session at all.
  view.rerender(tree(hookWire(), "owner", false));
  await act(async () => {});
  expect(controls()).toEqual([false, false]);
  expect(secretCalls).toEqual([]);
  view.unmount();
});

it("Rotate asks first and posts only after the confirm", async () => {
  const view = render(tree(hookWire(), "member"));
  await act(async () => {});
  await act(async () => q(view.container, "data-webhook-rotate")!.click());
  expect(secretCalls).toEqual([]);
  const confirm = q(view.container, "data-webhook-rotate-confirm");
  expect(confirm).not.toBeNull();
  await act(async () => confirm!.click());
  expect(secretCalls).toEqual(["POST"]);
  expect(q(view.container, "data-webhook-secret")!.textContent).toBe(SECRET);
  view.unmount();
});
