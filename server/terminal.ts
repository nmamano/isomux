import { join } from "path";
import { homedir, userInfo } from "os";
import { accessSync, constants as fsConstants } from "fs";
import { spawnSync } from "child_process";
import type { ManagedAgent } from "./internal-types.ts";
import { createTerminalFinalizer } from "./terminal-finalizer.ts";

const PTY_SIDECAR_PATH = join(import.meta.dir, "pty-sidecar.cjs");
const MAX_PTY_BUFFER = 100_000;

// Resolve an absolute path to a REAL Node.js binary for spawning the PTY
// sidecar. Bun.spawn(["node", …]) is unsafe here: if a launch env lacks `node`
// on PATH (cron, systemd-user, non-login SSH on macOS), Bun falls back to
// running ITSELF in node-compat mode under the name "node". The sidecar then
// loads node-pty's native binding under Bun's runtime, which doesn't drive
// the PTY correctly - terminal panel comes up blank/dead. Probe order:
//   1. ISOMUX_NODE_PATH override
//   2. Known absolute installs (Homebrew arm64, Homebrew/Linux x64,
//      distro Linux, MacPorts)
//   3. Bare "node" via PATH (still validated - Bun's node-compat answers
//      `process.versions.bun`, which we reject)
// Validation is `accessSync(X_OK)` + a one-shot `--exit-on-Bun` probe.
// Cached after the first probe; restart the server to re-resolve.
const NODE_CANDIDATES = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
  "/opt/local/bin/node",
];

let cachedNodePath: string | null | undefined;

function probeRealNode(candidate: string): boolean {
  // X_OK check is path-form-aware: absolute paths get a direct executable
  // check; bare "node" would throw ENOENT here, so we skip and let spawnSync
  // do its own PATH lookup. Either way the version probe below is the final
  // arbiter - accessSync just rejects obviously-broken absolute paths fast.
  if (candidate.startsWith("/")) {
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      return false;
    }
  }
  // Reject Bun's node-compat: under Bun, process.versions.bun is set.
  const result = spawnSync(
    candidate,
    [
      "-e",
      "process.exit(process.versions && process.versions.node && !process.versions.bun ? 0 : 1)",
    ],
    { timeout: 5000, stdio: "ignore" },
  );
  return result.status === 0;
}

export function resolveRealNode(): string | null {
  if (cachedNodePath !== undefined) return cachedNodePath;
  const override = process.env.ISOMUX_NODE_PATH;
  if (override) {
    if (probeRealNode(override)) {
      cachedNodePath = override;
      return cachedNodePath;
    }
    console.warn(
      `[terminal] ISOMUX_NODE_PATH=${override} did not validate as real Node; falling back to default probe`,
    );
  }
  for (const candidate of NODE_CANDIDATES) {
    if (probeRealNode(candidate)) {
      cachedNodePath = candidate;
      return cachedNodePath;
    }
  }
  if (probeRealNode("node")) {
    cachedNodePath = "node";
    return cachedNodePath;
  }
  cachedNodePath = null;
  return null;
}

type TerminalEvent =
  | { type: "terminal_output"; agentId: string; data: string }
  | {
      type: "terminal_status";
      agentId: string;
      process: string;
      shell: boolean;
    }
  | { type: "terminal_exit"; agentId: string; exitCode: number };

// Wire shape of messages sent by the PTY sidecar over JSONL stdout.
type SidecarMessage =
  | { type: "output"; data: string }
  | { type: "status"; process: string; shell: boolean }
  | { type: "exit"; exitCode?: number; signal?: string | null };

export interface TerminalDeps {
  getAgent: (agentId: string) => ManagedAgent | undefined;
  emit: (event: TerminalEvent) => void;
}

function sidecarSend(managed: ManagedAgent, msg: Record<string, unknown>) {
  const stdin = managed.ptySidecar?.stdin;
  if (stdin && typeof stdin !== "number")
    void stdin.write(JSON.stringify(msg) + "\n");
}

export function openTerminal(agentId: string, deps: TerminalDeps): boolean {
  const managed = deps.getAgent(agentId);
  if (!managed) return false;

  // Already running - just replay buffered output
  if (managed.ptySidecar) return true;

  const shell = process.env.SHELL || "/bin/bash";
  const home = homedir();
  const ptyEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
    SHELL: shell,
    HOME: home,
    USER: process.env.USER || userInfo().username,
    LANG: process.env.LANG || "en_US.UTF-8",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };

  const nodePath = resolveRealNode();
  if (!nodePath) {
    console.warn(
      `[terminal] cannot open PTY for ${agentId}: no real Node.js binary found. ` +
        `node-pty's native bindings won't run under Bun's node-compat. ` +
        `Install Node and either put it on PATH or set ISOMUX_NODE_PATH.`,
    );
    deps.emit({ type: "terminal_exit", agentId, exitCode: 127 });
    return false;
  }

  const sidecar = Bun.spawn([nodePath, PTY_SIDECAR_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  managed.ptySidecar = sidecar;
  managed.ptyBuffer = "";

  const finalize = createTerminalFinalizer({
    // A restarted terminal may already have installed a replacement sidecar.
    // A late exit from the old process must not detach that replacement.
    isCurrent: () => managed.ptySidecar === sidecar,
    detach: () => {
      managed.ptySidecar = null;
    },
    emitExit: (exitCode) =>
      deps.emit({ type: "terminal_exit", agentId, exitCode }),
  });

  // Read stdout as text lines using Bun's native ReadableStream
  void (async () => {
    const reader = sidecar.stdout.getReader();
    const decoder = new TextDecoder();
    let partial = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        partial += decoder.decode(value, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop()!; // keep incomplete last line
        for (const line of lines) {
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          const msg = parsed as SidecarMessage;
          if (msg.type === "output" && typeof msg.data === "string") {
            if (managed.ptySidecar !== sidecar) continue;
            managed.ptyBuffer += msg.data;
            if (managed.ptyBuffer.length > MAX_PTY_BUFFER) {
              managed.ptyBuffer = managed.ptyBuffer.slice(-MAX_PTY_BUFFER);
            }
            deps.emit({ type: "terminal_output", agentId, data: msg.data });
          } else if (
            msg.type === "status" &&
            typeof msg.process === "string" &&
            typeof msg.shell === "boolean"
          ) {
            // Same identity check as the output branch, and for a sharper
            // reason: the panel decides whether to send a card's command from
            // this status, so a stale owner from a replaced sidecar is a
            // refused click rather than a cosmetic line. Exit is deliberately
            // NOT guarded here - a stale exit must still reach finalize(),
            // which makes it a no-op itself.
            if (managed.ptySidecar !== sidecar) continue;
            deps.emit({
              type: "terminal_status",
              agentId,
              process: msg.process,
              shell: msg.shell,
            });
          } else if (msg.type === "exit") {
            console.log(
              `[terminal] PTY exited for ${agentId}: code=${msg.exitCode ?? null}, signal=${msg.signal ?? null}`,
            );
            finalize(typeof msg.exitCode === "number" ? msg.exitCode : 0);
          }
        }
      }
    } catch {}
  })();

  // The sidecar normally reports a structured exit line. If it dies before it
  // can do that, this fallback still tells the client instead of silently
  // clearing the reference. finalize makes the two paths one-shot.
  void sidecar.exited.then((exitCode) => finalize(exitCode));

  // Tell sidecar to spawn the PTY
  sidecarSend(managed, {
    type: "spawn",
    shell,
    cols: 80,
    rows: 24,
    cwd: managed.info.cwd,
    env: ptyEnv,
  });

  console.log(
    `[terminal] Spawned sidecar for ${agentId}: shell=${shell}, cwd=${managed.info.cwd}, node=${nodePath}, pid=${sidecar.pid}`,
  );
  return true;
}

export function getTerminalBuffer(
  agentId: string,
  deps: TerminalDeps,
): string | null {
  const managed = deps.getAgent(agentId);
  if (!managed?.ptySidecar) return null;
  return managed.ptyBuffer;
}

export function terminalInput(
  agentId: string,
  data: string,
  deps: TerminalDeps,
) {
  const managed = deps.getAgent(agentId);
  if (managed?.ptySidecar) sidecarSend(managed, { type: "input", data });
}

export function terminalResize(
  agentId: string,
  cols: number,
  rows: number,
  deps: TerminalDeps,
) {
  const managed = deps.getAgent(agentId);
  if (managed?.ptySidecar) sidecarSend(managed, { type: "resize", cols, rows });
}

export function terminalStatus(agentId: string, deps: TerminalDeps) {
  const managed = deps.getAgent(agentId);
  if (managed?.ptySidecar) sidecarSend(managed, { type: "status" });
}

export function closeTerminal(agentId: string, deps: TerminalDeps) {
  const managed = deps.getAgent(agentId);
  if (!managed?.ptySidecar) return;
  sidecarSend(managed, { type: "kill" });
  managed.ptySidecar = null;
  managed.ptyBuffer = "";
}

export function restartTerminal(agentId: string, deps: TerminalDeps): boolean {
  closeTerminal(agentId, deps);
  return openTerminal(agentId, deps);
}

// Used during kill flow: shut down a sidecar held in `managed` directly.
export function killSidecar(managed: ManagedAgent) {
  try {
    sidecarSend(managed, { type: "kill" });
    managed.ptySidecar?.kill();
  } catch {}
}
