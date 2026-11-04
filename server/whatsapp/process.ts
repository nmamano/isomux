// The real processes behind the WhatsApp supervisor's injectables: the bridge
// child, its memory reading and the package download. The supervisor tests
// use fakes; this file is the thin Bun glue.

import { readFileSync } from "fs";
import { join } from "path";
import {
  encodeCommand,
  parseBridgeEvent,
  type BridgeEvent,
} from "./protocol.ts";
import type { BridgeChild, BridgeSpawnSpec } from "./supervisor.ts";

// server/whatsapp/bridge: the bridge entry, its package.json and bun.lock.
export const WHATSAPP_PACKAGE_DIR = join(import.meta.dir, "bridge");
export const WHATSAPP_BRIDGE_ENTRY = join(WHATSAPP_PACKAGE_DIR, "bridge.ts");

const INSTALL_TIMEOUT_MS = 5 * 60_000;

async function* lines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
    }
  }
  if (buffered) yield buffered;
}

// Runs each listener on its own: one that throws must not stop the others,
// and must not escape, since a throw here ends the office server.
function callEach<T>(listeners: ((value: T) => void)[], value: T): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      console.error("[whatsapp] a bridge listener failed");
    }
  }
}

export function spawnBridge(spec: BridgeSpawnSpec): BridgeChild {
  const proc = Bun.spawn({
    cmd: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    stdin: "pipe",
    stdout: "pipe",
    // Baileys' own output can name contacts: none of it reaches the log.
    stderr: "ignore",
  });
  const eventListeners: ((event: BridgeEvent) => void)[] = [];
  const exitListeners: ((code: number | null) => void)[] = [];
  const read = (async () => {
    try {
      for await (const line of lines(proc.stdout)) {
        const event = parseBridgeEvent(line);
        if (!event) {
          console.warn("[whatsapp] dropped a line the bridge sent");
          continue;
        }
        callEach(eventListeners, event);
      }
    } catch {
      console.warn("[whatsapp] the bridge output failed");
    }
  })();
  // The exit comes after every event the child wrote, so a `closed` event is
  // seen before the exit it explains.
  void Promise.all([proc.exited, read]).then(([code]) =>
    callEach(exitListeners, code),
  );
  return {
    pid: proc.pid,
    send(cmd) {
      try {
        // A write to a closed pipe can also fail later, as a rejection.
        void Promise.resolve(proc.stdin.write(encodeCommand(cmd))).catch(
          () => {},
        );
        void Promise.resolve(proc.stdin.flush()).catch(() => {});
      } catch {
        // The child is gone; its exit reports it.
      }
    },
    kill() {
      proc.kill("SIGKILL");
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
  };
}

// Resident memory from /proc; null where there is no /proc (macOS).
export function readProcRss(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
    return kb === undefined ? null : Number(kb) * 1024;
  } catch {
    return null;
  }
}

// `bun install` of the pinned bridge package, with no lifecycle scripts and
// none of the office's environment beyond what bun needs to run.
export async function runBridgeInstall(
  runtimeDir: string,
  env: Record<string, string | undefined>,
): Promise<number> {
  const childEnv: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TZ", "LANG"])
    if (typeof env[key] === "string") childEnv[key] = env[key];
  const proc = Bun.spawn({
    cmd: [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
    cwd: runtimeDir,
    env: childEnv,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
  try {
    return await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}
