#!/usr/bin/env node
// PTY sidecar — runs under Node.js to work around Bun's libuv incompatibility with node-pty.
// Protocol: JSON messages over stdin/stdout, one per line.
//   → { type: "spawn", shell, cols, rows, cwd, env }
//   → { type: "input", data }
//   → { type: "resize", cols, rows }
//   → { type: "kill" }
//   ← { type: "output", data }
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
      proc = pty.spawn(msg.shell || "/bin/bash", ["-i", "-l"], {
        name: "xterm-256color",
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        cwd: msg.cwd || process.env.HOME,
        env: msg.env || process.env,
      });
      proc.onData((data) => sendMsg({ type: "output", data }));
      proc.onExit(({ exitCode, signal }) => {
        sendMsg({ type: "exit", exitCode, signal });
        proc = null;
      });
      break;
    case "input":
      proc?.write(msg.data);
      break;
    case "resize":
      try {
        proc?.resize(msg.cols, msg.rows);
      } catch {}
      break;
    case "kill":
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
