import type { AuditActor } from "../shared/audit.ts";
import { recordAudit } from "./audit-store.ts";
import { join } from "path";
import type { ManagedAgent } from "./internal-types.ts";
import { getAgentHost, type AgentHost } from "./agent-host.ts";
import { createTerminalFinalizer } from "./terminal-finalizer.ts";
import { startTerminalRecording } from "./terminal-recorder.ts";

const PTY_SIDECAR_PATH = join(import.meta.dir, "pty-sidecar.ts");
const MAX_PTY_BUFFER = 100_000;

type TerminalEvent =
  | { type: "terminal_output"; agentId: string; data: string }
  | {
      type: "terminal_status";
      agentId: string;
      process: string;
      shell: boolean;
      envStale?: true;
      recorded?: true;
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
  buildEnvForUserId: (
    userId: string | null | undefined,
  ) => Record<string, string | undefined> | undefined;
  // Defaults to the office's agent host (server/agent-host.ts).
  host?: AgentHost;
  // The office setting "Record terminals", read at each terminal start.
  recordTerminals?: () => boolean;
}

function sidecarSend(managed: ManagedAgent, msg: Record<string, unknown>) {
  const stdin = managed.ptySidecar?.stdin;
  if (stdin) void stdin.write(JSON.stringify(msg) + "\n");
}

// Ends the session's recording and forgets who joined it. Idempotent.
function endSession(managed: ManagedAgent) {
  void managed.ptyRecording?.close();
  managed.ptyRecording = null;
  managed.ptyMembers = new Set();
}

export function openTerminal(
  agentId: string,
  deps: TerminalDeps,
  actor?: AuditActor,
): boolean {
  const managed = deps.getAgent(agentId);
  if (!managed) return false;

  if (managed.ptySidecar) {
    // One row per member who joins a running session; the opener and a
    // remount write nothing.
    const members = (managed.ptyMembers ??= new Set());
    if (actor && !members.has(actor.id)) {
      members.add(actor.id);
      recordAudit({
        actor,
        operation: "terminal.join",
        targets: [agentId],
        fields: [],
        ...(managed.ptyRecording
          ? { terminalRecording: { id: managed.ptyRecording.id } }
          : {}),
      });
    }
    return true;
  }

  let managedEnv: Record<string, string | undefined> | undefined;
  try {
    managedEnv = deps.buildEnvForUserId(managed.info.userId);
  } catch (error) {
    console.warn(`[terminal] cannot open PTY for ${agentId}:`, error);
    deps.emit({ type: "terminal_exit", agentId, exitCode: 1 });
    return false;
  }

  // The shell runs as the agent user, so its HOME, USER and PATH come from
  // the host, never from the server's own environment in split mode.
  const host = deps.host ?? getAgentHost();
  const hostEnv = host.baseEnv();
  const shell = hostEnv.SHELL || "/bin/bash";
  const ptyEnv: Record<string, string> = {
    ...((managedEnv ?? hostEnv) as Record<string, string>),
    TERM: "xterm-256color",
    SHELL: shell,
    HOME: host.home(),
    USER: hostEnv.USER || host.username(),
    LANG: hostEnv.LANG || "en_US.UTF-8",
    PATH: hostEnv.PATH || "/usr/local/bin:/usr/bin:/bin",
  };

  const bunPath = host.bunPath();
  const sidecar = host.spawnPipe([bunPath, PTY_SIDECAR_PATH]);

  managed.ptySidecar = sidecar;
  // A new terminal starts with the current environment.
  managed.ptyEnvStale = false;
  // The setting applies at the start: a running session keeps its state.
  const recording =
    actor && deps.recordTerminals?.()
      ? startTerminalRecording({
          agentId,
          cols: 80,
          rows: 24,
          startedBy: actor,
        })
      : null;
  managed.ptyRecording = recording;
  managed.ptyMembers = new Set(actor ? [actor.id] : []);
  if (actor)
    recordAudit({
      actor,
      operation: "terminal.open",
      targets: [agentId],
      fields: [],
      ...(recording ? { terminalRecording: { id: recording.id } } : {}),
    });
  managed.ptyBuffer = "";

  const finalize = createTerminalFinalizer({
    // A restarted terminal may already have installed a replacement sidecar.
    // A late exit from the old process must not detach that replacement.
    isCurrent: () => managed.ptySidecar === sidecar,
    detach: () => {
      managed.ptySidecar = null;
      endSession(managed);
    },
    emitExit: (exitCode) =>
      deps.emit({ type: "terminal_exit", agentId, exitCode }),
  });

  const outputDone = (async () => {
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
            recording?.output(msg.data);
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
              ...(managed.ptyEnvStale ? { envStale: true as const } : {}),
              ...(recording ? { recorded: true as const } : {}),
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
  void sidecar.exited.then(async (exitCode) => {
    await outputDone;
    finalize(exitCode);
  });

  sidecarSend(managed, {
    type: "spawn",
    shell,
    cols: 80,
    rows: 24,
    cwd: managed.info.cwd,
    env: ptyEnv,
  });

  console.log(
    `[terminal] Spawned sidecar for ${agentId}: shell=${shell}, cwd=${managed.info.cwd}, bun=${bunPath}, pid=${sidecar.pid}`,
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

// The agent's terminal output as the read route needs it. truncated is true
// when the buffer reached MAX_PTY_BUFFER, so older output was dropped.
export function readTerminal(
  agentId: string,
  deps: TerminalDeps,
): { open: boolean; raw: string; truncated: boolean } {
  const managed = deps.getAgent(agentId);
  if (!managed?.ptySidecar) return { open: false, raw: "", truncated: false };
  const raw = managed.ptyBuffer;
  return { open: true, raw, truncated: raw.length >= MAX_PTY_BUFFER };
}

export function terminalInput(
  agentId: string,
  data: string,
  deps: TerminalDeps,
  actor?: AuditActor,
) {
  const managed = deps.getAgent(agentId);
  if (!managed?.ptySidecar) return;
  sidecarSend(managed, { type: "input", data });
  // Who typed, never what: the data stays out of the recording.
  if (actor) managed.ptyRecording?.input(actor);
}

export function terminalResize(
  agentId: string,
  cols: number,
  rows: number,
  deps: TerminalDeps,
  actor?: AuditActor,
) {
  void actor;
  const managed = deps.getAgent(agentId);
  if (!managed?.ptySidecar) return;
  sidecarSend(managed, { type: "resize", cols, rows });
  managed.ptyRecording?.resize(cols, rows);
}

export function terminalStatus(agentId: string, deps: TerminalDeps) {
  const managed = deps.getAgent(agentId);
  if (managed?.ptySidecar) sidecarSend(managed, { type: "status" });
}

export function closeTerminal(
  agentId: string,
  deps: TerminalDeps,
  actor?: AuditActor,
) {
  const managed = deps.getAgent(agentId);
  if (!managed?.ptySidecar) return;
  sidecarSend(managed, { type: "kill" });
  if (actor)
    recordAudit({
      actor,
      operation: "terminal.close",
      targets: [agentId],
      fields: [],
    });
  managed.ptySidecar = null;
  managed.ptyBuffer = "";
  endSession(managed);
}

export function restartTerminal(
  agentId: string,
  deps: TerminalDeps,
  actor?: AuditActor,
): boolean {
  closeTerminal(agentId, deps, actor);
  return openTerminal(agentId, deps, actor);
}

// Used during kill flow: shut down a sidecar held in `managed` directly.
export function killSidecar(managed: ManagedAgent) {
  endSession(managed);
  try {
    sidecarSend(managed, { type: "kill" });
    managed.ptySidecar?.kill();
  } catch {}
}
