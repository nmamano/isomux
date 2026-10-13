// The body of the proxy child, shared by main.ts (no seams) and the test
// entry under server/test-support/ (seams for stub hosts).
//
// Messages from the server: {type:"start", port, snapshot} once, then
// {type:"snapshot", snapshot} on every change. Messages to the server:
// {type:"listening", port}, {type:"listen_failed"}, {type:"use", use},
// {type:"log", code}. Codes are fixed text, never request content.

import {
  createSecretProxy,
  type ProxyOptions,
  type ProxySnapshot,
  type SecretProxy,
} from "./proxy.ts";

export type ToChild =
  | { type: "start"; port: number; snapshot: ProxySnapshot }
  | { type: "snapshot"; snapshot: ProxySnapshot };

export type FromChild =
  | { type: "listening"; port: number }
  | { type: "listen_failed" }
  | { type: "use"; use: import("./proxy.ts").ProxyUse }
  | { type: "log"; code: string };

export function runProxyChild(options: ProxyOptions): void {
  const send = (message: FromChild) => process.send?.(message);
  let proxy: SecretProxy | null = null;

  process.on("disconnect", () => process.exit(0));
  // Never let an error print a request or a value: report a fixed code.
  process.on("uncaughtException", () => {
    send({ type: "log", code: "uncaught_exception" });
    process.exit(1);
  });
  process.on("unhandledRejection", () => {
    send({ type: "log", code: "unhandled_rejection" });
  });

  process.on("message", (message: ToChild) => {
    if (message.type === "start" && !proxy) {
      proxy = createSecretProxy(
        message.snapshot,
        {
          use: (use) => send({ type: "use", use }),
          log: (code) => send({ type: "log", code }),
        },
        options,
      );
      proxy.listen(message.port).then(
        (port) => send({ type: "listening", port }),
        () => {
          send({ type: "listen_failed" });
          process.exit(2);
        },
      );
    } else if (message.type === "snapshot" && proxy) {
      proxy.update(message.snapshot);
    }
  });
}
