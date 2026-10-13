// Starts and supervises the proxy child (internal-docs/secrets-design.md,
// section 2.2). The child gets its snapshot over IPC, never through argv or
// the environment. It keeps one loopback port: a restarted child asks for the
// same port, and a port that is taken is replaced once, through `onPort`.
//
// Restart backoff: 0.5 s, doubling to 10 s; a child that ran for a minute
// resets it.

import type { Subprocess } from "bun";
import { join } from "node:path";

import type { FromChild, ToChild } from "./child.ts";
import type { ProxySnapshot, ProxyUse } from "./proxy.ts";

export const PROXY_CHILD_ENTRY = join(import.meta.dir, "main.ts");

const FIRST_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const STABLE_MS = 60_000;

export interface ProxySupervisorOptions {
  // The child's entry file. Only tests pass another one, from
  // server/test-support/.
  entry?: string;
  // The child's whole environment. It needs none of the server's.
  env?: Record<string, string>;
  snapshot: () => ProxySnapshot;
  // The port to ask for first: the saved one, or null for any free port.
  savedPort: number | null;
  // The child listens on a port other than the last known one (the saved
  // one at first). `previous` is the port that agents may still use.
  onPort: (port: number, previous: number | null) => void;
  // Every time a child listens, after onPort.
  onListening?: (port: number) => void;
  onUse: (use: ProxyUse) => void;
  // Fixed codes only. No message body ever reaches it.
  log: (code: string) => void;
  // Tests only: the child's stdout and stderr. In production they go
  // nowhere, so no line of the child can reach the server's log.
  onOutput?: (text: string) => void;
}

export interface ProxySupervisor {
  // Resolves with the port once the first child listens.
  start(): Promise<number>;
  push(): void;
  stop(): Promise<void>;
  readonly port: number | null;
  readonly pid: number | null;
}

export function createProxySupervisor(
  options: ProxySupervisorOptions,
): ProxySupervisor {
  const entry = options.entry ?? PROXY_CHILD_ENTRY;
  let child: Subprocess | null = null;
  let port: number | null = null;
  let wanted = options.savedPort ?? 0;
  let backoff = FIRST_BACKOFF_MS;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started: Promise<number> | null = null;
  let resolveStarted: ((port: number) => void) | null = null;

  function retryLater(startedAt: number) {
    if (Date.now() - startedAt > STABLE_MS) backoff = FIRST_BACKOFF_MS;
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    timer = setTimeout(() => {
      timer = null;
      if (!stopping) spawn();
    }, delay);
  }

  function spawn() {
    const startedAt = Date.now();
    // Every start gets the current snapshot, so a change made while no child
    // ran is not lost. A snapshot that cannot be built is retried with the
    // same backoff: the restart loop never stops.
    let snapshot: ProxySnapshot;
    try {
      snapshot = options.snapshot();
    } catch {
      options.log("snapshot_failed");
      retryLater(startedAt);
      return;
    }
    const output = options.onOutput ? "pipe" : "ignore";
    const proc = Bun.spawn([process.execPath, entry], {
      env: options.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["ignore", output, output],
      serialization: "json",
      ipc(message: FromChild) {
        switch (message.type) {
          case "listening": {
            const previous = port ?? options.savedPort;
            port = message.port;
            wanted = message.port;
            if (previous !== message.port)
              options.onPort(message.port, previous);
            options.onListening?.(message.port);
            resolveStarted?.(message.port);
            resolveStarted = null;
            break;
          }
          case "listen_failed":
            // The port is taken: the next child takes any free port.
            options.log("listen_failed");
            wanted = 0;
            break;
          case "use":
            options.onUse(message.use);
            break;
          case "log":
            options.log(message.code);
            break;
        }
      },
      onExit() {
        if (child === proc) child = null;
        if (stopping) return;
        options.log("child_exited");
        retryLater(startedAt);
      },
    });
    child = proc;
    if (options.onOutput) {
      const collect = async (stream: ReadableStream<Uint8Array>) => {
        for await (const piece of stream)
          options.onOutput?.(new TextDecoder().decode(piece));
      };
      void collect(proc.stdout as ReadableStream<Uint8Array>);
      void collect(proc.stderr as ReadableStream<Uint8Array>);
    }
    sendTo(proc, { type: "start", port: wanted, snapshot });
  }

  function sendTo(proc: Subprocess, message: ToChild) {
    try {
      proc.send(message);
    } catch {
      // The child is gone; its exit restarts it with a fresh snapshot.
      options.log("ipc_send_failed");
    }
  }

  return {
    start() {
      if (!started) {
        started = new Promise((resolve) => {
          resolveStarted = resolve;
        });
        spawn();
      }
      return started;
    },
    push() {
      if (!child) return;
      let snapshot: ProxySnapshot;
      try {
        snapshot = options.snapshot();
      } catch {
        // The child keeps the last snapshot; its next start retries.
        options.log("snapshot_failed");
        return;
      }
      sendTo(child, { type: "snapshot", snapshot });
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      const proc = child;
      child = null;
      if (proc) {
        proc.kill();
        await proc.exited;
      }
    },
    get port() {
      return port;
    },
    get pid() {
      return child?.pid ?? null;
    },
  };
}
