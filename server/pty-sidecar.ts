// Bun PTY sidecar. The JSONL protocol stays the same across local and runner
// hosts; the agent user's Bun starts this file in both cases.
import { createInterface } from "node:readline";
import { normalizeTerminalProcess, terminalOwner } from "./pty-owner.ts";

let child: ReturnType<typeof Bun.spawn> | null = null;
let terminal: Bun.Terminal | null = null;
let shellName = "bash";
let owner = "";
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let activityChecks = 0;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;
let outputEnded = false;
let exit: { exitCode: number; signal: string | null } | null = null;
const decoder = new TextDecoder();
const input = createInterface({ input: process.stdin });

function send(message: object) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function finish() {
  // A reaped shell can still have unread PTY bytes. Only the terminal EOF
  // callback establishes that all output has been delivered.
  if (!exit || !outputEnded) return;
  if (statusTimer) clearTimeout(statusTimer);
  if (drainTimer) clearTimeout(drainTimer);
  const tail = decoder.decode();
  if (tail) send({ type: "output", data: tail });
  send({ type: "exit", ...exit });
  exit = null;
  stopping = true;
  terminal?.close();
  input.close();
  process.stdin.pause();
}

async function reportOwner(force = false) {
  if (!child || stopping || exit) return;
  const next = await terminalOwner(child.pid);
  if (stopping || exit) return;
  const name = next ?? "";
  if (!force && name === owner) return;
  owner = name;
  send({ type: "status", process: owner, shell: owner === shellName });
}

function scheduleOwnerPoll(delay = 500) {
  if (statusTimer || stopping || !child) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    void reportOwner().then(() => {
      if (activityChecks > 0) activityChecks--;
      if (owner !== shellName || activityChecks > 0) scheduleOwnerPoll();
    });
  }, delay);
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (statusTimer) clearTimeout(statusTimer);
  // Master close hangs up the controlling terminal. Bash forwards SIGHUP
  // to its jobs, including a foreground group different from its own.
  // Do not send a second SIGHUP: it can interrupt Bash forwarding the first.
  terminal?.close();
  input.close();
  process.stdin.pause();
}

input.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  switch (msg.type) {
    case "spawn": {
      if (child || stopping) return;
      if (typeof Bun.Terminal !== "function") {
        send({ type: "output", data: "This terminal needs Bun 1.3.11 or later. Update Bun and restart Isomux.\r\n" });
        send({ type: "exit", exitCode: 127, signal: null });
        stop();
        return;
      }
      const shell = msg.shell || "/bin/bash";
      shellName = normalizeTerminalProcess(shell);
      const terminalOptions: Bun.TerminalOptions = {
        cols: msg.cols || 80, rows: msg.rows || 24,
        data(_terminal, bytes) {
          const data = decoder.decode(bytes, { stream: true });
          if (data) send({ type: "output", data });
        },
        exit() { outputEnded = true; finish(); },
      };
      try {
        child = Bun.spawn([shell, "-i", "-l"], {
          terminal: terminalOptions,
          // Explicitly give the shell its own session. The integration
          // tests pin the controlling terminal and job-control behavior.
          detached: true,
          cwd: msg.cwd || msg.env?.HOME || process.env.HOME,
          env: msg.env || process.env,
        });
        terminal = child.terminal ?? null;
      } catch (error) {
        terminal?.close();
        send({ type: "exit", exitCode: 1, signal: null });
        console.error(error);
        stop();
        return;
      }
      const spawned = child;
      void spawned.exited.then((exitCode) => {
        exit = { exitCode, signal: spawned.signalCode };
        // A background job can retain the slave after the shell exits. Keep
        // node-pty's 200 ms drain bound for that case; normal exits use EOF.
        if (!outputEnded) drainTimer = setTimeout(() => {
          outputEnded = true;
          finish();
        }, 200);
        finish();
      });
      owner = shellName;
      send({ type: "status", process: owner, shell: true });
      break;
    }
    case "input":
      if (typeof msg.data === "string" && !stopping) {
        terminal?.write(msg.data);
        activityChecks = 4;
        scheduleOwnerPoll(50);
      }
      break;
    case "resize":
      try { terminal?.resize(msg.cols, msg.rows); } catch {}
      break;
    case "status":
      void reportOwner(true);
      break;
    case "kill":
      stop();
      break;
  }
});
input.on("close", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
