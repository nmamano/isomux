// How long a shown secret lives (design section 2): Hide removes it, a lost
// permission clears it for good, another hook's detail does not show it, and
// a read answered after the view stopped asking for it shows nothing. Rotate
// asks before it posts.
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
let secretCalls = 0;
let rotations = 0;
// A secret read waits until the test answers it; a rotation answers at once.
let answerSecret: (() => void) | null = null;
setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/webhooks") return [hookWire()];
  if (method === "GET" && /^\/api\/webhooks\/[^/]+\/deliveries/.test(path))
    return { deliveries: [] };
  if (method === "GET" && path === `/api/webhooks/${HOOK_ID}/secret`) {
    secretCalls++;
    await new Promise<void>((resolve) => (answerSecret = resolve));
    return { secret: SECRET };
  }
  if (method === "POST" && path === `/api/webhooks/${HOOK_ID}/secret`) {
    rotations++;
    return { secret: SECRET };
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  secretCalls = 0;
  rotations = 0;
  answerSecret = null;
});

// The office owner viewing another member's hook: a role change alone takes
// the permission away and gives it back.
const othersHook = hookWire({ userId: "u2" });

function tree(
  role: "owner" | "member",
  openHookId: string | null = HOOK_ID,
  webhooks: WebhookWire[] = [othersHook],
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

const q = (root: HTMLElement, attr: string) =>
  root.querySelector<HTMLElement>(`[${attr}]`);

it("Show reads the secret, and Hide removes it from the page", async () => {
  const view = render(tree("owner"));
  await act(async () => {});
  await act(async () => q(view.container, "data-webhook-secret-show")!.click());
  expect(secretCalls).toBe(1);
  await act(async () => answerSecret!());
  expect(q(view.container, "data-webhook-secret")!.textContent).toBe(SECRET);
  await act(async () => q(view.container, "data-webhook-secret-hide")!.click());
  expect(view.container.textContent).not.toContain(SECRET);
  view.unmount();
});

it("a lost permission clears a shown secret, and it stays gone when the permission returns", async () => {
  const view = render(tree("owner"));
  await act(async () => {});
  await act(async () => q(view.container, "data-webhook-secret-show")!.click());
  await act(async () => answerSecret!());
  expect(view.container.textContent).toContain(SECRET);
  view.rerender(tree("member"));
  await act(async () => {});
  expect(view.container.textContent).not.toContain(SECRET);
  // The same detail stays mounted while the permission comes back.
  view.rerender(tree("owner"));
  await act(async () => {});
  expect(view.container.textContent).not.toContain(SECRET);
  expect(q(view.container, "data-webhook-secret-show")).not.toBeNull();
  view.unmount();
});

it("a read in flight when the permission is lost shows nothing, also after it returns", async () => {
  const view = render(tree("owner"));
  await act(async () => {});
  await act(async () => q(view.container, "data-webhook-secret-show")!.click());
  view.rerender(tree("member"));
  await act(async () => {});
  view.rerender(tree("owner"));
  await act(async () => {});
  await act(async () => answerSecret!());
  expect(view.container.textContent).not.toContain(SECRET);
  view.unmount();
});

it("a shown secret goes when the detail switches to another hook", async () => {
  const second = hookWire({
    id: "wh_1111111111111111",
    name: "second",
    userId: "u2",
  });
  const hooks = [othersHook, second];
  const view = render(tree("owner", HOOK_ID, hooks));
  await act(async () => {});
  await act(async () => q(view.container, "data-webhook-secret-show")!.click());
  await act(async () => answerSecret!());
  expect(q(view.container, "data-webhook-secret")!.textContent).toBe(SECRET);
  view.rerender(tree("owner", second.id, hooks));
  await act(async () => {});
  expect(q(view.container, "data-webhook-name")!.textContent).toBe(second.name);
  expect(q(view.container, "data-webhook-secret")).toBeNull();
  expect(q(view.container, "data-webhook-secret-show")).not.toBeNull();
  view.unmount();
});

// The member's own hook: Rotate is there without the office owner role.
it("Rotate asks first and posts only after the confirm", async () => {
  const view = render(tree("member", HOOK_ID, [hookWire()]));
  await act(async () => {});
  await act(async () => q(view.container, "data-webhook-rotate")!.click());
  expect(rotations).toBe(0);
  const confirm = q(view.container, "data-webhook-rotate-confirm");
  expect(confirm).not.toBeNull();
  await act(async () => confirm!.click());
  expect(rotations).toBe(1);
  expect(q(view.container, "data-webhook-secret")!.textContent).toBe(SECRET);
  view.unmount();
});
