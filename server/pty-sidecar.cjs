#!/usr/bin/env node
// PTY sidecar - runs under Node.js to work around Bun's libuv incompatibility with node-pty.
// Protocol: JSON messages over stdin/stdout, one per line.
//   → { type: "spawn", shell, cols, rows, cwd, env }
//   → { type: "input", data }
//   → { type: "resize", cols, rows }
//   → { type: "status" }
//   → { type: "kill" }
//   ← { type: "output", data }
//   ← { type: "status", process, shell }
//   ← { type: "exit", exitCode, signal }

// Bun's installer sometimes drops the execute bit on node-pty's prebuilt
// spawn-helper binary, which makes pty.spawn() fail with `posix_spawnp failed`
// and produces a blank terminal. Restore it before loading node-pty.
(() => {
  const fs = require("fs");
  const path = require("path");
  const prebuilds = path.join(
    __dirname,
    "..",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  try {
    for (const entry of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, entry, "spawn-helper");
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch {}
})();

const pty = require("node-pty");
const readline = require("readline");

let proc = null;
let shell = "/bin/bash";
let owner = null;
let shellOwnerConfirmed = false;
let statusTimer = null;
let activityChecks = 0;

function normalizeProcess(value) {
  const name =
    String(value || "")
      .split("/")
      .pop() || "";
  return name.replace(/^-/, "");
}

function reportOwner(force = false) {
  if (!proc) return;
  const next = normalizeProcess(proc.process);
  const shellName = normalizeProcess(shell);
  const sidecarName = normalizeProcess(process.execPath);
  // node-pty can briefly report this Node sidecar as the PTY owner directly
  // after spawn. The sidecar created the shell, so keep the seeded shell owner
  // until node-pty confirms a meaningful reading. After that, a real `node`
  // foreground job is reported normally.
  if (!shellOwnerConfirmed && next === sidecarName) return;
  if (next === shellName) shellOwnerConfirmed = true;
  if (!next || (!force && next === owner)) return;
  owner = next;
  sendMsg({ type: "status", process: owner, shell: owner === shellName });
}

function scheduleOwnerPoll(delay = 500) {
  if (statusTimer || !proc) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    reportOwner();
    if (!proc) return;
    if (activityChecks > 0) activityChecks--;
    if (owner !== normalizeProcess(shell) || activityChecks > 0) {
      scheduleOwnerPoll(500);
    }
  }, delay);
}

function sendMsg(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  switch (msg.type) {
    case "spawn":
      if (proc) return;
      shell = msg.shell || "/bin/bash";
      proc = pty.spawn(shell, ["-i", "-l"], {
        name: "xterm-256color",
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        cwd: msg.cwd || process.env.HOME,
        env: msg.env || process.env,
      });
      proc.onData((data) => sendMsg({ type: "output", data }));
      proc.onExit(({ exitCode, signal }) => {
        if (statusTimer) clearTimeout(statusTimer);
        sendMsg({ type: "exit", exitCode, signal });
        proc = null;
      });
      // At spawn, the shell owns the new PTY by construction. Seed that fact
      // so a cold-open card click cannot be rejected by node-pty's transient
      // report of the sidecar process itself. Polling starts on input, not
      // here, so an open idle panel has no recurring background work.
      owner = normalizeProcess(shell);
      shellOwnerConfirmed = false;
      sendMsg({ type: "status", process: owner, shell: true });
      break;
    case "input":
      proc?.write(msg.data);
      // A foreground owner can change after input starts a command. Check once
      // after 50 ms, then every 500 ms while another process owns the PTY. Four
      // shell-owner checks cover command startup without polling forever when
      // the terminal stays idle.
      activityChecks = 4;
      scheduleOwnerPoll(50);
      break;
    case "resize":
      try {
        proc?.resize(msg.cols, msg.rows);
      } catch {}
      break;
    case "status":
      reportOwner(true);
      break;
    case "kill":
      if (statusTimer) clearTimeout(statusTimer);
      try {
        proc?.kill();
      } catch {}
      proc = null;
      process.exit(0);
      break;
  }
});

rl.on("close", () => {
  try {
    proc?.kill();
  } catch {}
  process.exit(0);
});
