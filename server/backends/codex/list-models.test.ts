// Real-process tests for codexBackend.listModels (listCodexModels) with an
// abort signal (task 141beeb6). A spawn with no model waits for model/list on
// a bound; at the bound the signal aborts, and the abort must stop the codex
// app-server, not only the wait. Only a real pid shows a leaked process group,
// so the launcher is a small script, as in client.test.ts.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listCodexModels } from "./adapter.ts";

const tmpDirs: string[] = [];
// Every fake pid seen. A red run (an abort that kills nothing) must not leave
// its app-server behind.
const fakePids: number[] = [];
afterEach(() => {
  for (const pid of fakePids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number) {
  const start = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// A fake app-server. It answers initialize; model/list it answers with one
// model ("list" mode) or never ("hang" mode). It writes its own pid and the pid
// of a grandchild sleeper (the native codex process the real launcher starts)
// to PID_FILE, one per line.
function writeFakeAppServer(dir: string): string {
  const bin = join(dir, "fake-app-server");
  writeFileSync(
    bin,
    `#!${process.execPath}
const { spawn } = require("child_process");
const { writeFileSync } = require("fs");
const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
writeFileSync(process.env.PID_FILE, process.pid + "\\n" + sleeper.pid + "\\n");
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
require("readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (msg.method === "initialize") reply(msg.id, { userAgent: "fake" });
    if (msg.method === "model/list" && process.env.FAKE_MODE === "list")
      reply(msg.id, {
        data: [
          {
            id: "gpt-fake",
            model: "gpt-fake",
            displayName: "GPT Fake",
            description: "",
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "" },
            ],
            defaultReasoningEffort: "high",
          },
        ],
        nextCursor: null,
      });
  });
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function setup(mode: "list" | "hang") {
  const dir = mkdtempSync(join(tmpdir(), "codex-list-models-test-"));
  tmpDirs.push(dir);
  const pidFile = join(dir, "pids");
  const opts = {
    cwd: dir,
    env: {
      ...process.env,
      CODEX_HOME: join(dir, "codex-home"),
      PID_FILE: pidFile,
      FAKE_MODE: mode,
    },
  };
  // The fake runs no tools, so the safety preflight is not the contract.
  const launcher = {
    codexBin: writeFakeAppServer(dir),
    args: [],
    skipSafetyPreflightForTestProbe: true,
  };
  const pids = async (): Promise<number[]> => {
    const ok = await waitFor(() => {
      try {
        return readFileSync(pidFile, "utf8").trim().split("\n").length === 2;
      } catch {
        return false;
      }
    }, 5000);
    if (!ok) throw new Error("the fake app-server never wrote its pids");
    const seen = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    fakePids.push(...seen);
    return seen;
  };
  return { opts, launcher, pids };
}

describe("listCodexModels with a signal", () => {
  it("lists the models when the signal does not fire, and stops the app-server", async () => {
    const { opts, launcher, pids } = setup("list");
    const models = await listCodexModels(
      { ...opts, signal: new AbortController().signal },
      launcher,
    );
    expect(models.map((m) => [m.id, m.isDefault])).toEqual([
      ["gpt-fake", true],
    ]);
    const [server, sleeper] = await pids();
    expect(await waitFor(() => !isAlive(server), 6000)).toBe(true);
    expect(await waitFor(() => !isAlive(sleeper), 6000)).toBe(true);
  }, 15_000);

  it("an abort while model/list is unanswered rejects and kills the process group", async () => {
    const { opts, launcher, pids } = setup("hang");
    const controller = new AbortController();
    const listing = listCodexModels(
      { ...opts, signal: controller.signal },
      launcher,
    );
    const settled = listing.then(
      () => "resolved",
      () => "rejected",
    );
    const [server, sleeper] = await pids();
    // Hung, not done: both processes run and the promise is open.
    const within = (ms: number) =>
      Promise.race([
        settled,
        new Promise((r) => setTimeout(() => r("pending"), ms)),
      ]);
    expect(await within(300)).toBe("pending");
    expect(isAlive(server)).toBe(true);
    expect(isAlive(sleeper)).toBe(true);

    controller.abort();
    expect(await within(3000)).toBe("rejected");
    expect(await waitFor(() => !isAlive(server), 6000)).toBe(true);
    expect(await waitFor(() => !isAlive(sleeper), 6000)).toBe(true);
  }, 15_000);
});
