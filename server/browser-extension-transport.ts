import type { ConnectOverCDPTransport } from "playwright-core";
import type { ExtensionConnection } from "./browser-extension-bridge";

// Public Playwright seam. Agent CDP never traverses an HTTP/WS endpoint.
export function browserExtensionTransport(
  connection: ExtensionConnection,
  agentId: string,
  retainGrant = false,
  target?: string,
): ConnectOverCDPTransport & { signal: AbortSignal } {
  let closed = false;
  const controller = new AbortController();
  const transport: ConnectOverCDPTransport & { signal: AbortSignal } = {
    signal: controller.signal,
    send(message) {
      if (closed || !assignment)
        throw new Error("Browser transport is not available");
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
  const assignment = connection.assign(agentId, {
    send: (message) => {
      if (!closed) transport.onmessage?.(message);
    },
    close: () => transport.close(),
  }, retainGrant, target);
  return transport;
}
