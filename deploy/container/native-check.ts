// Run as node in an isolated image, with networking disabled and no credentials.
import { spawn, spawnSync } from "node:child_process";
import { resolveCodexLauncherPath } from "../../server/backends/codex/native-bin.ts";
import { resolveOpenCodeBinary } from "../../server/backends/opencode/runtime.ts";
import { launchOptions } from "../../server/browser-session.ts";
import { resolveRealNode } from "../../server/terminal.ts";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";

for (const args of [
  ["node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude", "--version"],
  ["node", resolveCodexLauncherPath(), "--version"],
  [resolveOpenCodeBinary(), "--version"],
]) {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) throw new Error(`${args[0]} executable check failed: ${result.stderr}`);
  console.log(result.stdout.trim());
}

// Exercise the same Node resolver, sidecar file, and JSONL exchange as terminal.ts.
const nodePath = resolveRealNode();
if (!nodePath) throw new Error("Real Node executable is unavailable");
const identity = spawnSync(nodePath, ["-e", "process.exit(process.versions.bun ? 1 : 0)"], { timeout: 5000 });
if (identity.status !== 0) throw new Error("PTY sidecar requires real Node");
await new Promise<void>((resolve, reject) => {
  const child = spawn(nodePath, [new URL("../../server/pty-sidecar.cjs", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let statusSeen = false;
  let exitSeen = false;
  let output = "";
  let stderr = "";
  let failure: Error | undefined;
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => {
    failure = new Error("PTY sidecar timed out");
    child.kill("SIGKILL");
  }, 10_000);
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
  child.stdin.on("error", (error) => { failure = error; });
  child.on("error", (error) => { failure = error; });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { type: string; process?: string; shell?: boolean; data?: string; exitCode?: number };
      if (message.type === "status" && !statusSeen) {
        if (message.process !== "bash" || message.shell !== true) throw new Error("PTY initial shell status failed");
        statusSeen = true;
        // The complete sentinel is absent from the echoed command.
        send({ type: "input", data: "printf 'native-%s-ready\\n' pty; exit\r" });
      } else if (message.type === "output") {
        output += message.data || "";
      } else if (message.type === "exit") {
        if (message.exitCode !== 0) throw new Error("PTY shell exit failed");
        exitSeen = true;
        child.stdin.end();
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Invalid PTY protocol");
      child.stdin.end();
    }
  });
  child.on("close", (code) => {
    clearTimeout(timeout);
    lines.close();
    if (failure || stderr || code !== 0 || !statusSeen || !exitSeen || !output.includes("native-pty-ready")) {
      reject(failure || new Error(`PTY sidecar failed (code=${code}, status=${statusSeen}, exit=${exitSeen}, stderr=${stderr})`));
    } else resolve();
  });
  send({ type: "spawn", shell: "/bin/bash", cols: 80, rows: 24,
    cwd: process.env.HOME, env: { ...process.env, TERM: "xterm-256color", SHELL: "/bin/bash" } });
});
console.log(`PASS production PTY sidecar JSONL via ${nodePath}`);
const browser = await chromium.launch(launchOptions("/usr/bin/chromium"));
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>Container browser</title><p>Local browser check</p>");
  if (await page.title() !== "Container browser") throw new Error("browser DOM failed");
  const screenshot = await page.screenshot({ path: "/tmp/isomux-native-check.png" });
  if (screenshot.length < 100) throw new Error("browser screenshot failed");
  console.log(`PASS Chromium DOM and screenshot (${screenshot.length} bytes)`);
} finally {
  await browser.close();
}
