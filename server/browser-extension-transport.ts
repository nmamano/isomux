import type { ConnectOverCDPTransport } from "playwright-core";
import type { ExtensionConnection } from "./browser-extension-bridge";

// Public Playwright seam. Agent CDP never traverses an HTTP/WS endpoint.
export function browserExtensionTransport(
  connection: ExtensionConnection,
  agentId: string,
  retainGrant = false,
  target?: string,
): ConnectOverCDPTransport & {
  signal: AbortSignal;
  inputs: number;
  mouseReleases: number;
} {
  let closed = false;
  const controller = new AbortController();
  const transport: ConnectOverCDPTransport & {
    signal: AbortSignal;
    inputs: number;
    mouseReleases: number;
  } = {
    signal: controller.signal,
    // Input commands sent so far. An action that sent none dispatched no input.
    inputs: 0,
    // Mouse releases handed to the browser bridge, not proof the page applied them.
    mouseReleases: 0,
    send(message) {
      if (closed || !assignment)
        throw new Error("Browser transport is not available");
      const { method, params } = message as {
        method?: unknown;
        params?: { type?: unknown };
      };
      if (typeof method === "string" && method.startsWith("Input."))
        transport.inputs++;
      if (
        method === "Input.dispatchMouseEvent" &&
        params?.type === "mouseReleased"
      )
        transport.mouseReleases++;
      void assignment.receive(message);
    },
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
      assignment?.close();
      // Playwright records a command callback after send returns. Deliver close
      // on the next microtask so a synchronous refusal cannot strand that call.
      queueMicrotask(() =>
        transport.onclose?.(
          "Browser control ended; pending outcomes may be unknown",
        ),
      );
    },
  };
  const assignment = connection.assign(
    agentId,
    {
      send: (message) => {
        if (!closed) transport.onmessage?.(message);
      },
      close: () => transport.close(),
    },
    retainGrant,
    target,
  );
  return transport;
}
