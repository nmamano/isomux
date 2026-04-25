import { join } from "path";
import { homedir } from "os";
import type { ManagedAgent } from "./internal-types.ts";

const PTY_SIDECAR_PATH = join(import.meta.dir, "pty-sidecar.cjs");
const MAX_PTY_BUFFER = 100_000;

type TerminalEvent =
  | { type: "terminal_output"; agentId: string; data: string }
  | { type: "terminal_exit"; agentId: string; exitCode: number };

export interface TerminalDeps {
  getAgent: (agentId: string) => ManagedAgent | undefined;
  emit: (event: TerminalEvent) => void;
}

function sidecarSend(managed: ManagedAgent, msg: Record<string, unknown>) {
  const stdin = managed.ptySidecar?.stdin;
  if (stdin && typeof stdin !== "number") stdin.write(JSON.stringify(msg) + "\n");
}

export function openTerminal(agentId: string, deps: TerminalDeps): boolean {
  const managed = deps.getAgent(agentId);
  if (!managed) return false;

  // Already running — just replay buffered output
  if (managed.ptySidecar) return true;

  const shell = process.env.SHELL || "/bin/bash";
  const home = homedir();
  const ptyEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    TERM: "xterm-256color",
    SHELL: shell,
    HOME: home,
    USER: process.env.USER || require("os").userInfo().username,
    LANG: process.env.LANG || "en_US.UTF-8",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };

  const sidecar = Bun.spawn(["node", PTY_SIDECAR_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  managed.ptySidecar = sidecar;
  managed.ptyBuffer = "";

  // Read stdout as text lines using Bun's native ReadableStream
  (async () => {
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
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "output") {
            managed.ptyBuffer += msg.data;
            if (managed.ptyBuffer.length > MAX_PTY_BUFFER) {
              managed.ptyBuffer = managed.ptyBuffer.slice(-MAX_PTY_BUFFER);
            }
            deps.emit({ type: "terminal_output", agentId, data: msg.data });
          } else if (msg.type === "exit") {
            console.log(`[terminal] PTY exited for ${agentId}: code=${msg.exitCode}, signal=${msg.signal}`);
            managed.ptySidecar = null;
            deps.emit({ type: "terminal_exit", agentId, exitCode: msg.exitCode });
          }
        }
      }
    } catch {}
  })();

  sidecar.exited.then(() => {
    if (managed.ptySidecar === sidecar) {
      managed.ptySidecar = null;
    }
  });

  // Tell sidecar to spawn the PTY
  sidecarSend(managed, {
    type: "spawn",
    shell,
    cols: 80,
    rows: 24,
    cwd: managed.info.cwd,
    env: ptyEnv,
  });

  console.log(`[terminal] Spawned sidecar for ${agentId}: shell=${shell}, cwd=${managed.info.cwd}, pid=${sidecar.pid}`);
  return true;
}

export function getTerminalBuffer(agentId: string, deps: TerminalDeps): string | null {
  const managed = deps.getAgent(agentId);
  if (!managed?.ptySidecar) return null;
  return managed.ptyBuffer;
}

export function terminalInput(agentId: string, data: string, deps: TerminalDeps) {
  const managed = deps.getAgent(agentId);
  if (managed?.ptySidecar) sidecarSend(managed, { type: "input", data });
}

export function terminalResize(agentId: string, cols: number, rows: number, deps: TerminalDeps) {
  const managed = deps.getAgent(agentId);
  if (managed?.ptySidecar) sidecarSend(managed, { type: "resize", cols, rows });
}

export function closeTerminal(agentId: string, deps: TerminalDeps) {
  const managed = deps.getAgent(agentId);
  if (!managed?.ptySidecar) return;
  sidecarSend(managed, { type: "kill" });
  managed.ptySidecar = null;
  managed.ptyBuffer = "";
}

// Used during kill flow: shut down a sidecar held in `managed` directly.
export function killSidecar(managed: ManagedAgent) {
  try { sidecarSend(managed, { type: "kill" }); managed.ptySidecar?.kill(); } catch {}
}
