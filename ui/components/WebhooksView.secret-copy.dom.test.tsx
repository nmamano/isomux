// Copy while the secret is hidden (task 645f475e): the read goes to the
// clipboard and never onto the page. On a secure page the clipboard write
// starts inside the click, with the secret still pending; elsewhere the
// textarea fallback runs after the read and must report success.
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { WebhooksView } = await import("./WebhooksView.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { hookWire, HOOK_ID } =
  await import("../test-support/webhook-fixture.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type AppState = import("../store.tsx").AppState;

const en = translatorFor("en");
const SECRET = "SECRET_VALUE_MARKER";
let secretCalls = 0;
let readFails = false;
// A secret read waits until the test answers it.
let answerSecret: (() => void) | null = null;
setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/webhooks") return [hookWire()];
  if (
    method === "GET" &&
    path.startsWith(`/api/webhooks/${HOOK_ID}/deliveries`)
  )
    return { deliveries: [] };
  if (method === "GET" && path === `/api/webhooks/${HOOK_ID}/secret`) {
    secretCalls++;
    await new Promise<void>((resolve) => (answerSecret = resolve));
    if (readFails) throw new ApiError(403, "forbidden", "READ_REFUSED_MARKER");
    return { secret: SECRET };
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));

const saved = {
  secure: Object.getOwnPropertyDescriptor(window, "isSecureContext"),
  clipboard: Object.getOwnPropertyDescriptor(navigator, "clipboard"),
  item: Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem"),
  exec: Object.getOwnPropertyDescriptor(document, "execCommand"),
};
const restore = (target: object, key: string, d?: PropertyDescriptor) => {
  if (d) Object.defineProperty(target, key, d);
  else delete (target as Record<string, unknown>)[key];
};
beforeEach(() => {
  secretCalls = 0;
  readFails = false;
  answerSecret = null;
});
afterEach(() => {
  restore(window, "isSecureContext", saved.secure);
  restore(navigator, "clipboard", saved.clipboard);
  restore(globalThis, "ClipboardItem", saved.item);
  restore(document, "execCommand", saved.exec);
});

function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, value });
}

// A secure page: navigator.clipboard.write takes promise-valued items.
function secureClipboard() {
  const writes: Promise<Blob>[] = [];
  define(window, "isSecureContext", true);
  define(
    globalThis,
    "ClipboardItem",
    class {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    },
  );
  define(navigator, "clipboard", {
    write: async (items: { items: Record<string, Promise<Blob>> }[]) => {
      const blob = items[0].items["text/plain"];
      writes.push(blob);
      await blob;
    },
    writeText: async () => {
      throw new Error("writeText is not the secure path");
    },
  });
  return writes;
}

// An insecure page: no navigator.clipboard, only execCommand.
function insecureClipboard(result: boolean) {
  const copied: string[] = [];
  define(window, "isSecureContext", false);
  define(navigator, "clipboard", undefined);
  define(document, "execCommand", (command: string) => {
    // The fallback appends its textarea to the end of the body.
    const ta = document.body.lastElementChild;
    if (command === "copy" && ta instanceof HTMLTextAreaElement)
      copied.push(ta.value);
    return result;
  });
  return copied;
}

function tree() {
  const base = stateWithSelfUser("en");
  const state: Partial<AppState> = {
    webhooks: [hookWire()],
    webhooksLoaded: true,
    hydrationEpoch: 1,
    sessionContext: { ...base.sessionContext!, role: "owner" },
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

async function clickCopy() {
  const view = render(tree());
  await act(async () => {});
  const button = view.container.querySelector<HTMLElement>(
    "[data-webhook-secret-copy] button",
  )!;
  expect(button).not.toBeNull();
  await act(async () => button.click());
  return view;
}

it("on a secure page the write starts inside the click, and the secret never shows", async () => {
  const writes = secureClipboard();
  const view = await clickCopy();
  // Written before the read answered: the click's permission still holds.
  expect(secretCalls).toBe(1);
  expect(writes.length).toBe(1);
  await act(async () => answerSecret!());
  expect(await (await writes[0]).text()).toBe(SECRET);
  expect(view.container.textContent).not.toContain(SECRET);
  expect(view.container.querySelector("[data-webhook-secret]")).toBeNull();
  expect(
    view.container.querySelector("[data-webhook-secret-show]"),
  ).not.toBeNull();
  view.unmount();
});

it("on an insecure page the fallback copies after the read and leaves no textarea", async () => {
  const copied = insecureClipboard(true);
  const view = await clickCopy();
  expect(copied).toEqual([]);
  await act(async () => answerSecret!());
  expect(copied).toEqual([SECRET]);
  expect(document.body.lastElementChild?.tagName).not.toBe("TEXTAREA");
  expect(view.container.textContent).not.toContain(SECRET);
  expect(view.container.textContent).not.toContain(
    en.t("webhooks.setup.copyFailed"),
  );
  view.unmount();
});

it("a refused fallback copy reports failure instead of success", async () => {
  insecureClipboard(false);
  const view = await clickCopy();
  await act(async () => answerSecret!());
  expect(view.container.textContent).toContain(
    en.t("webhooks.setup.copyFailed"),
  );
  expect(view.container.textContent).not.toContain(SECRET);
  expect(document.body.lastElementChild?.tagName).not.toBe("TEXTAREA");
  view.unmount();
});

it("a failed read shows the server's error, not the copy failure", async () => {
  const writes = secureClipboard();
  readFails = true;
  const view = await clickCopy();
  await act(async () => answerSecret!());
  expect(writes.length).toBe(1);
  expect(view.container.textContent).toContain("READ_REFUSED_MARKER");
  expect(view.container.textContent).not.toContain(
    en.t("webhooks.setup.copyFailed"),
  );
  view.unmount();
});
