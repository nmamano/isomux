// Test-only driver for Chrome's native action popup, which is not surfaced as
// a Playwright Page. All commands use the public browser CDPSession interface.
import type { CDPSession } from "playwright-core";
import { writeFileSync } from "node:fs";

export async function openExtensionActionPopup(
  cdp: CDPSession,
  extensionId: string,
  pageTargetId: string,
) {
  const exactURL = `chrome-extension://${extensionId}/connection.html`;
  const before = new Set(
    (await cdp.send("Target.getTargets")).targetInfos.map((t) => t.targetId),
  );
  const page = (
    await cdp.send("Target.getTargetInfo", { targetId: pageTargetId })
  ).targetInfo;
  const tabs = (
    await cdp.send("Target.getTargets", {
      filter: [{ type: "tab" }, { exclude: true }],
    })
  ).targetInfos;
  const matches = tabs.filter(
    (t) =>
      t.targetId === page.parentId || (!page.parentId && t.url === page.url),
  );
  if (matches.length > 1)
    throw new Error("Ambiguous Chrome tab target for action popup");
  const tab = matches[0];
  if (!tab) throw new Error("No Chrome tab target for action popup");
  await cdp.send("Extensions.triggerAction", {
    id: extensionId,
    targetId: tab.targetId,
  });
  let targetId: string | undefined;
  for (let i = 0; i < 100; i++) {
    const candidates = (await cdp.send("Target.getTargets")).targetInfos.filter(
      (t) => !before.has(t.targetId) && t.type === "page" && t.url === exactURL,
    );
    if (candidates.length > 1)
      throw new Error("Ambiguous extension action popup");
    if (candidates.length === 1) {
      targetId = candidates[0].targetId;
      break;
    }
    await Bun.sleep(50);
  }
  if (!targetId) throw new Error("Extension action popup did not open");
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: false,
  });
  let nextId = 0,
    closed = false;
  const pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const receive = (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error("Popup CDP command failed"));
    else waiter.resolve(message.result ?? {});
  };
  cdp.on("Target.receivedMessageFromTarget", receive);
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (closed) {
        reject(new Error("Popup test session closed"));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Popup CDP command timed out: " + method));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      void cdp
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(() => {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error("Popup test transport closed"));
        });
    });
  const read = async <T>(expression: string): Promise<T> => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) throw new Error("Popup fixture read failed");
    return (response.result as { value: T }).value;
  };
  const waitFor = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await read<boolean>(expression)) return;
      await Bun.sleep(50);
    }
    throw new Error("Popup state wait failed: " + expression);
  };
  const click = async (selector: string) => {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
    const box = await read<{
      x: number;
      y: number;
      width: number;
      height: number;
      hidden: boolean;
    }>(
      `(() => { const e=document.querySelector(${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,hidden:!e.checkVisibility()}; })()`,
    );
    if (box.hidden || box.width <= 0 || box.height <= 0)
      throw new Error("Popup control is not visible");
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  };
  await waitFor('!!document.querySelector("#status")?.dataset.state');
  return {
    read,
    waitFor,
    click,
    async fill(selector: string, text: string) {
      await click(selector);
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: 2,
        windowsVirtualKeyCode: 65,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: 2,
        windowsVirtualKeyCode: 65,
      });
      await send("Input.insertText", { text });
    },
    async screenshot(path: string) {
      const result = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(String(result.data), "base64"));
    },
    async close() {
      if (closed) return;
      closed = true;
      cdp.off("Target.receivedMessageFromTarget", receive);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Popup test session closed"));
      }
      pending.clear();
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
}
