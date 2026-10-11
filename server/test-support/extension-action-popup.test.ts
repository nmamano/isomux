import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserContext, CDPSession } from "playwright-core";
import { openExtensionActionPopup } from "./extension-action-popup";

test("native popup attaches only after the new window client is visible", async () => {
  const extension = "a".repeat(32);
  const url = `chrome-extension://${extension}/connection.html`;
  let popupOpen = false, visible = false, attachments = 0;
  const hiddenObserved = Promise.withResolvers<void>();
  const attached = Promise.withResolvers<void>();
  const root = { targetId: "root", parentId: "tab", type: "page", url: "https://example.test" };
  const popup = { targetId: "popup", type: "page", url };
  const cdp = Object.assign(new EventEmitter(), {
    async send(method: string, params?: Record<string, unknown>) {
      switch (method) {
        case "Target.setDiscoverTargets": return {};
        case "Target.getTargetInfo": return { targetInfo: root };
        case "Target.getTargets": return { targetInfos: params?.filter
          ? [{ targetId: "tab", type: "tab", url: root.url }]
          : [root, ...(popupOpen ? [popup] : [])] };
        case "Extensions.triggerAction": popupOpen = true; return {};
        case "Target.attachToTarget":
          attachments++;
          attached.resolve();
          if (!visible) cdp.emit("Target.targetCreated", { targetInfo: { targetId: "devtools", url: "devtools://fixture" } });
          return { sessionId: "popup-session" };
        case "Target.sendMessageToTarget": {
          const command = JSON.parse(String(params?.message));
          queueMicrotask(() => cdp.emit("Target.receivedMessageFromTarget", {
            sessionId: "popup-session",
            message: JSON.stringify({ id: command.id, result: { result: { value: true } } }),
          }));
          return {};
        }
        case "Target.detachFromTarget": return {};
        case "Target.closeTarget":
          popupOpen = false;
          cdp.emit("Target.targetDestroyed", { targetId: "popup" });
          return { success: true };
        default: throw new Error(`Unexpected fixture command ${method}`);
      }
    },
  });
  const context = {
    serviceWorkers: () => [{
      url: () => `chrome-extension://${extension}/background.js`,
      evaluate: async () => {
        if (!popupOpen) return [];
        if (!visible) hiddenObserved.resolve();
        return [{ id: "new-popup-client", url, visibilityState: visible ? "visible" : "hidden" }];
      },
    }],
  };
  const opened = openExtensionActionPopup(cdp as unknown as CDPSession, extension, "root", context as unknown as BrowserContext);
  // Consume either result even if the ordering assertion fails in a mutant.
  const settled = opened.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  let result: Awaited<typeof settled>;
  try {
    await Promise.race([hiddenObserved.promise, attached.promise]);
    expect(popupOpen).toBe(true);
    expect(visible).toBe(false);
    expect(attachments).toBe(0);
  } finally {
    visible = true;
    result = await settled;
    await result.value?.close();
  }
  if (result.error instanceof Error) throw result.error;
  if (result.error) throw new Error("Popup fixture failed", { cause: result.error });
  expect(attachments).toBe(1);
  expect(popupOpen).toBe(false);
});
