// The real processes behind the WhatsApp supervisor's injectables: the bridge
// child, its memory reading and the package download. The supervisor tests
// use fakes; this file is the thin Bun glue.

import { readFileSync } from "fs";
import { join } from "path";
import { spawnLineChild } from "../messaging/line-child.ts";
import { encodeCommand, parseBridgeEvent } from "./protocol.ts";
import type { BridgeChild, BridgeSpawnSpec } from "./supervisor.ts";

// server/whatsapp/bridge: the bridge entry, its package.json and bun.lock.
export const WHATSAPP_PACKAGE_DIR = join(import.meta.dir, "bridge");
export const WHATSAPP_BRIDGE_ENTRY = join(WHATSAPP_PACKAGE_DIR, "bridge.ts");

const INSTALL_TIMEOUT_MS = 5 * 60_000;

export function spawnBridge(spec: BridgeSpawnSpec): BridgeChild {
  return spawnLineChild({
    ...spec,
    encode: encodeCommand,
    parse: parseBridgeEvent,
    tag: "whatsapp",
  });
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
