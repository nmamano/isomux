import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContainerAppSupervisor } from "./container-app-supervisor.ts";
import type { AppRecord } from "../shared/types.ts";
import type { AppSupervisor } from "./app-supervisor.ts";

const program = fileURLToPath(
  new URL("../deploy/container/supervisor.py", import.meta.url),
);
let root: string;
let daemon: ChildProcess | undefined;
let supervisor: AppSupervisor;
let app: AppRecord;
let origin: string;
let detachedPid: number | undefined;
let detachedStart: string | undefined;
let containerStdout = "";
let containerStderr = "";
let lastResponseError: unknown;

async function until<T>(
  check: () => T | Promise<T>,
  message: string,
  ms = 6000,
) {
  const end = Date.now() + ms;
  do {
    const value = await check();
    if (value) return value;
    await Bun.sleep(30);
  } while (Date.now() < end);
  throw new Error(message);
}

// Loads the real supervisor as a module and overrides its timing constants.
// Workers start from the real file (__file__), so only serve sees the values.
const patchedServe = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("supervisor", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for key, value in json.loads(sys.argv[2]).items():
    setattr(module, key, value)
sys.argv = [sys.argv[1], "serve", *sys.argv[3:]]
sys.exit(module.main())
`;

async function boot(
  office: string[] = [],
  stdout: "pipe" | number = "pipe",
  options: {
    patch?: Record<string, number>;
    env?: Record<string, string>;
  } = {},
) {
  containerStdout = "";
  containerStderr = "";
  const args = options.patch
    ? ["-c", patchedServe, program, JSON.stringify(options.patch)]
    : [program, "serve"];
  daemon = spawn("python3", [...args, join(root, "runtime"), ...office], {
    stdio: ["ignore", stdout, "pipe"],
    env: {
      ...process.env,
      RENDER_SECRET_SENTINEL: "must-not-reach-app",
      ...options.env,
    },
  });
  daemon.stdout?.on("data", (chunk) => (containerStdout += String(chunk)));
  daemon.stderr?.on("data", (chunk) => (containerStderr += String(chunk)));
  supervisor = createContainerAppSupervisor(
    join(root, "runtime", "control.sock"),
    () => "office.example.com",
  );
  await until(() => {
    try {
      supervisor.reloadUnits();
      return true;
    } catch {
      return false;
    }
  }, "supervisor did not start");
}

async function closeDaemon() {
  if (!daemon) return;
  const process = daemon;
  daemon = undefined;
  if (process.exitCode === null) {
    process.kill("SIGTERM");
    await until(
      () => process.exitCode !== null || process.signalCode !== null,
      "supervisor did not stop",
      14000,
    );
  }
}

async function response() {
  let res: Response;
  try {
    res = await fetch(origin, { signal: AbortSignal.timeout(300) });
  } catch (error) {
    lastResponseError = error;
    return null;
  }
  lastResponseError = undefined;
  if (!res.ok) throw new Error(`app returned HTTP ${res.status}`);
  // A bad body is a test failure, not a connection that is still starting.
  return (await res.json()) as {
    pid: number;
    token: string;
    count: number;
    secret?: string;
    url: string;
  };
}

async function appResponse(count?: number, ms = 6000) {
  let last: Awaited<ReturnType<typeof response>> = null;
  const message =
    count === undefined
      ? "app did not answer"
      : `app did not reach start count ${count}`;
  try {
    // Return the sample that proves readiness. A second one-shot request can
    // fail even after this one succeeds, especially while the host is busy.
    return await until(
      async () => {
        last = await response();
        return last && (count === undefined || last.count === count)
          ? last
          : null;
      },
      message,
      ms,
    );
  } catch (error) {
    throw new Error(
      `${message}; last transport error: ${String(lastResponseError)}; ` +
        `last response: ${JSON.stringify(last)}; supervisor stderr: ${containerStderr}`,
      { cause: error },
    );
  }
}

function freePort() {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

beforeEach(async () => {
  lastResponseError = undefined;
  detachedPid = undefined;
  detachedStart = undefined;
  root = mkdtempSync(join(tmpdir(), "container-app-test-"));
  mkdirSync(join(root, "data"));
  const port = freePort();
  writeFileSync(
    join(root, "app.ts"),
    `
import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.ISOMUX_APP_DATA_DIR + "/counter";
let count = 0; try { count = Number(readFileSync(file, "utf8")); } catch {}
writeFileSync(file, String(++count));
console.log("synthetic-app-start");
Bun.serve({hostname: process.env.ISOMUX_APP_HOST, port: Number(process.env.PORT), fetch(req) {
  if (new URL(req.url).pathname === "/crash" && req.method === "POST") {
    setTimeout(() => process.exit(73), 10); return new Response("crashing");
  }
  return Response.json({pid: process.pid, token: process.env.ISOMUX_APP_TOKEN,
    secret: process.env.RENDER_SECRET_SENTINEL, url: process.env.ISOMUX_APP_URL, count});
}});
`,
  );
  app = {
    name: "sample",
    hostLabel: "sample",
    hostGen: 1,
    port,
    command: `${process.execPath} app.ts`,
    cwd: root,
    dataDir: join(root, "data"),
    userId: null,
    username: null,
    createdBy: "test",
    createdAt: 0,
  };
  origin = `http://127.0.0.1:${port}`;
  await boot();
});

afterEach(async () => {
  // A held monitor waits for this file; a failed case must not leave it held.
  if (existsSync(join(root, "hold"))) releaseMonitors();
  await closeDaemon();
  // Mutation runs must not leave the deliberately detached fixture behind.
  if (detachedPid !== undefined) {
    try {
      const stat = readFileSync(`/proc/${detachedPid}/stat`, "utf8");
      if (
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === detachedStart
      )
        process.kill(detachedPid, "SIGKILL");
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

// Measured 2026-10-11: the full case took 21.75 s at load average 32.11.
// The 60 s case budget leaves room for process cleanup under load.
test("real app: token, logs, crash restart, stop, delete, and port reuse", async () => {
  supervisor.provisionToken(app.name, "synthetic-token-one");
  supervisor.install(app);
  const first = await appResponse(1);
  expect(first.count).toBe(1);
  expect(first.token).toBe("synthetic-token-one");
  expect(first.secret).toBeUndefined();
  expect(first.url).toBe("https://sample.office.example.com");
  const logs = await until(() => {
    const lines = supervisor.logs(app.name, 5);
    return lines.includes("synthetic-app-start") ? lines : null;
  }, "app startup log did not arrive");
  expect(logs).toContain("synthetic-app-start");
  supervisor.provisionToken(app.name, "synthetic-token-two");
  const provisioned = await appResponse();
  expect(provisioned.pid).toBe(first.pid);
  expect(provisioned.count).toBe(1);
  expect(provisioned.token).toBe("synthetic-token-one");
  const crash = await fetch(origin + "/crash", { method: "POST" });
  expect(crash.status).toBe(200);
  // Measured 2026-10-11: recovery took up to 5.98 s at load averages 47-53.
  // This includes the 2 s restart delay, host /proc scans, and cold starts.
  const restarted = await appResponse(2, 15_000);
  expect(restarted.count).toBe(2);
  expect(restarted.token).toBe("synthetic-token-two");
  expect(supervisor.states([app.name]).get(app.name)?.restartCount).toBe(1);
  supervisor.stop(app.name);
  expect(supervisor.states([app.name]).get(app.name)?.state).toBe("stopped");
  expect(await response()).toBeNull();
  supervisor.teardown(app.name);
  expect(supervisor.readToken(app.name)).toBeNull();
  expect(supervisor.states([app.name]).get(app.name)?.state).toBe("unknown");
  // The OS, not the supervisor status, proves that the old listener is gone.
  const reused = Bun.listen({
    hostname: "127.0.0.1",
    port: app.port,
    socket: { data() {} },
  });
  reused.stop(true);
}, 60_000);

// Quarantined (task 3be3b31b): red once in ci:remote on 4e4233ff (the app
// reached start count 2 before the first check), green on the next run.
test.skip("container restart restores running apps, data, credentials, and stopped intent", async () => {
  supervisor.provisionToken(app.name, "synthetic-persistent-token");
  supervisor.install(app);
  await appResponse(1);
  await closeDaemon();
  await boot();
  const restored = await appResponse(2);
  expect(restored.token).toBe("synthetic-persistent-token");
  supervisor.stop(app.name);
  await closeDaemon();
  await boot();
  expect(supervisor.states([app.name]).get(app.name)?.state).toBe("stopped");
  expect(await response()).toBeNull();
  expect(readFileSync(join(root, "data", "counter"), "utf8")).toBe("2");
}, 30000);

test("office output reaches the container stdout and its file; app output does not", async () => {
  await closeDaemon();
  writeFileSync(
    join(root, "office.py"),
    `import time\nprint("synthetic-office-line", flush=True)\ntime.sleep(60)\n`,
  );
  await boot(["python3", join(root, "office.py")]);
  supervisor.install(app);
  await until(
    () => containerStdout.includes("synthetic-office-line"),
    "office output did not reach the container stdout",
  );
  await until(() => {
    try {
      return readFileSync(join(root, "runtime", "sample.log"), "utf8").includes(
        "synthetic-app-start",
      );
    } catch {
      return false;
    }
  }, "app output did not reach its log file");
  expect(readFileSync(join(root, "runtime", "office.log"), "utf8")).toContain(
    "synthetic-office-line",
  );
  expect(containerStdout).not.toContain("synthetic-app-start");
}, 30000);

// The production control client, with a short timeout instead of its 18 s.
function ping(): boolean {
  const result = spawnSync(
    "python3",
    [program, "client", join(root, "runtime", "control.sock")],
    { input: '{"op":"ping"}', timeout: 1500 },
  );
  try {
    return JSON.parse(String(result.stdout)).ok === true;
  } catch {
    return false;
  }
}

test("supervision continues while the container stdout is full", async () => {
  await closeDaemon();
  const total = 1024 * 1024;
  writeFileSync(
    join(root, "office.py"),
    `import sys, time\ntime.sleep(0.5)\nsys.stdout.write("x" * ${total})\nsys.stdout.flush()\ntime.sleep(60)\n`,
  );
  const fifo = join(root, "stdout.fifo");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const writer = openSync(fifo, constants.O_WRONLY);
  // A second, nonblocking writer probes for a full pipe without reading it.
  const probe = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    await boot(["python3", join(root, "office.py")], writer);
    closeSync(writer);
    await until(() => {
      try {
        writeSync(probe, "x");
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EAGAIN";
      }
    }, "container stdout did not fill");
    expect(ping()).toBe(true);
    await until(() => {
      try {
        return statSync(join(root, "runtime", "office.log")).size === total;
      } catch {
        return false;
      }
    }, "office.log did not receive all office output");
    let drained = 0;
    const buffer = Buffer.alloc(65536);
    for (;;) {
      try {
        const n = readSync(reader, buffer);
        if (n === 0) break;
        drained += n;
      } catch {
        break;
      }
    }
    // The pipe held part of the output; the rest was dropped for stdout only.
    expect(drained).toBeGreaterThan(0);
    expect(drained).toBeLessThan(total);
  } finally {
    closeSync(probe);
    closeSync(reader);
  }
}, 30000);

test("delete reaps a double-forked child that left the original process group", async () => {
  writeFileSync(
    join(root, "detach.py"),
    `
import os, signal, socket, time
original_group = os.getpgrp()
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        s = socket.socket()
        s.bind(("127.0.0.1", int(os.environ["PORT"])))
        s.listen()
        open("detached-ready", "w").write(str(os.getpid()) + " " + str(original_group))
        while True: time.sleep(1)
    os._exit(0)
while True: time.sleep(1)
`,
  );
  supervisor.install({ ...app, command: "python3 detach.py" });
  await until(() => {
    try {
      return (
        Number(
          readFileSync(join(root, "detached-ready"), "utf8").split(" ")[0],
        ) > 0
      );
    } catch {
      return false;
    }
  }, "detached child did not bind");
  const [childPid, originalGroup] = readFileSync(
    join(root, "detached-ready"),
    "utf8",
  )
    .split(" ")
    .map(Number);
  detachedPid = childPid;
  // Establish the process-group escape before testing deletion.
  const stat = readFileSync(`/proc/${childPid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  detachedStart = fields[19];
  expect(Number(fields[2])).not.toBe(originalGroup);
  supervisor.teardown(app.name);
  expect(() => process.kill(childPid, 0)).toThrow();
  const reused = Bun.listen({
    hostname: "127.0.0.1",
    port: app.port,
    socket: { data() {} },
  });
  reused.stop(true);
}, 30000);

// Holds every "sample" app monitor at interpreter startup, before supervisor.py
// runs, until the test creates the release file. This is the window in which a
// slow host leaves a monitor that has not yet installed its stop handler.
function holdSampleMonitors(): Record<string, string> {
  const hooks = join(root, "pyhooks");
  mkdirSync(join(root, "hold"), { recursive: true });
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, "sitecustomize.py"),
    `
import os, sys, time
if sys.argv[1:2] == ["worker"] and sys.argv[3:4] == ["sample"]:
    hold = ${JSON.stringify(join(root, "hold"))}
    parent = os.getppid()
    open(os.path.join(hold, "held-" + str(os.getpid())), "w").close()
    while not os.path.exists(os.path.join(hold, "release")) and os.getppid() == parent:
        time.sleep(0.02)
`,
  );
  return { PYTHONPATH: hooks };
}

function heldMonitor(): number | null {
  try {
    const held = readdirSync(join(root, "hold")).find((f) =>
      f.startsWith("held-"),
    );
    return held ? Number(held.slice("held-".length)) : null;
  } catch {
    return null;
  }
}

function releaseMonitors() {
  writeFileSync(join(root, "hold", "release"), "");
}

function monitorPid(name: string): number | null {
  const runtime = join(root, "runtime");
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      const at = args.indexOf("worker");
      if (at > 0 && args[at + 1] === runtime && args[at + 2] === name)
        return Number(entry);
    } catch {}
  }
  return null;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// SIGTERM is pending (blocked or not yet handled) in this process.
function sigtermPending(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return ["SigPnd", "ShdPnd"].some((field) => {
    const hex = status.match(new RegExp(`^${field}:\\s*([0-9a-f]+)`, "m"));
    return hex !== null && (BigInt(`0x${hex[1]}`) & (1n << 14n)) !== 0n;
  });
}

// The app process outlives a monitor that the test kills: register it for
// afterEach, which checks its start time before it kills it.
function adoptApp(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  detachedPid = pid;
  detachedStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

function rawRpc(
  request: unknown,
  timeout = 15_000,
): Record<string, unknown> | null {
  const result = spawnSync(
    "python3",
    [program, "client", join(root, "runtime", "control.sock")],
    { input: JSON.stringify(request), timeout },
  );
  try {
    return JSON.parse(String(result.stdout)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function state(name = app.name) {
  return supervisor.states([name]).get(name);
}

async function answers(url: string) {
  return until(async () => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(300) })).ok;
    } catch {
      return false;
    }
  }, `${url} did not answer`);
}

test("a monitor that is slow to start stalls neither supervision nor other apps", async () => {
  await closeDaemon();
  await boot([], "pipe", { env: holdSampleMonitors() });
  mkdirSync(join(root, "other-data"));
  const other = {
    ...app,
    name: "other",
    hostLabel: "other",
    port: freePort(),
    dataDir: join(root, "other-data"),
  };
  supervisor.install(other);
  await answers(`http://127.0.0.1:${other.port}`);
  // The old launch waited 3 s for the monitor and then stopped the container.
  supervisor.install(app);
  expect(state()?.state).toBe("starting");
  await until(heldMonitor, "the sample monitor was not held");
  await Bun.sleep(3500);
  expect(heldMonitor()).not.toBeNull();
  expect(existsSync(join(root, "hold", "release"))).toBe(false);
  expect(ping()).toBe(true);
  await answers(`http://127.0.0.1:${other.port}`);
  expect(state()?.state).toBe("starting");
  releaseMonitors();
  expect((await appResponse(1)).count).toBe(1);
  await until(
    () => state()?.state === "running",
    "the released app did not reach running",
  );
}, 30_000);

test("stop while the monitor is still starting starts no app and leaves no process", async () => {
  await closeDaemon();
  await boot([], "pipe", { env: holdSampleMonitors() });
  supervisor.install(app);
  const monitor = await until(heldMonitor, "the sample monitor was not held");
  // Release from another process: stop blocks this one until the monitor exits.
  const releaser = spawn("sh", [
    "-c",
    `sleep 1; : > '${join(root, "hold", "release")}'`,
  ]);
  try {
    expect(existsSync(join(root, "hold", "release"))).toBe(false);
    supervisor.stop(app.name);
    expect(existsSync(join(root, "hold", "release"))).toBe(true);
  } finally {
    releaser.kill();
  }
  expect(state()?.state).toBe("stopped");
  expect(alive(monitor)).toBe(false);
  // The monitor got the stop before it could start the app: no start ran.
  expect(existsSync(join(root, "data", "counter"))).toBe(false);
  const reused = Bun.listen({
    hostname: "127.0.0.1",
    port: app.port,
    socket: { data() {} },
  });
  reused.stop(true);
  expect(ping()).toBe(true);
}, 30_000);

test("the readiness deadline stops a held monitor and the app restarts alone", async () => {
  await closeDaemon();
  await boot([], "pipe", {
    env: holdSampleMonitors(),
    patch: { READY_TIMEOUT: 1 },
  });
  supervisor.install(app);
  const monitor = await until(heldMonitor, "the sample monitor was not held");
  await until(
    () => sigtermPending(monitor),
    "the readiness deadline did not signal the monitor",
  );
  expect(alive(monitor)).toBe(true);
  expect(state()?.state).toBe("starting");
  expect(ping()).toBe(true);
  releaseMonitors();
  // Count 1: the signalled monitor did not start the app; its successor did.
  const started = await appResponse(1, 15_000);
  expect(started.count).toBe(1);
  expect(alive(monitor)).toBe(false);
  expect(state()?.restartCount).toBe(1);
  await until(
    () => state()?.state === "running",
    "the restarted app did not reach running",
  );
}, 30_000);

const canaries = [
  "canary-command-7f3a",
  "canary-env-7f3a",
  "canary-token-7f3a",
  "synthetic-app-start",
];

async function installCanaryApp() {
  const dataDir = join(root, "canary-env-7f3a");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "counter"), "0");
  supervisor.provisionToken(app.name, "canary-token-7f3a");
  supervisor.install({
    ...app,
    dataDir,
    command: `${process.execPath} app.ts canary-command-7f3a`,
  });
  const started = await appResponse(1);
  expect(started.token).toBe("canary-token-7f3a");
  const monitor = monitorPid(app.name);
  expect(monitor).not.toBeNull();
  adoptApp(started.pid);
  return monitor!;
}

async function daemonExit() {
  const process = daemon!;
  await until(
    () => process.exitCode !== null || process.signalCode !== null,
    "the supervisor did not stop",
    14_000,
  );
  expect(process.exitCode).toBe(1);
}

function expectNoCanary(...outputs: string[]) {
  for (const output of outputs)
    for (const canary of canaries) expect(output).not.toContain(canary);
}

test("a fatal error during an RPC answers with a fatal reply, then stops the container", async () => {
  const monitor = await installCanaryApp();
  process.kill(monitor, "SIGSTOP");
  // The monitor dies without a receipt while stop waits for it.
  const killer = spawn("sh", ["-c", `sleep 2; kill -KILL ${monitor}`]);
  try {
    const reply = rawRpc({ op: "stop", name: app.name });
    expect(reply?.ok).toBe(false);
    expect(reply?.fatal).toBe(true);
    expect(typeof reply?.error).toBe("string");
    expectNoCanary(JSON.stringify(reply));
  } finally {
    killer.kill();
  }
  await daemonExit();
  expect(containerStderr.trim().split("\n")).toHaveLength(1);
  expectNoCanary(containerStdout, containerStderr);
}, 30_000);

function bootFailure(state: unknown) {
  const runtime = join(root, `failed-${Math.random().toString(36).slice(2)}`);
  mkdirSync(runtime, { mode: 0o700 });
  writeFileSync(join(runtime, "definitions.json"), JSON.stringify(state));
  const result = spawnSync("python3", [program, "serve", runtime], {
    timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(String(result.stdout)).toBe("");
  const lines = String(result.stderr).trim().split("\n");
  expect(lines).toHaveLength(1);
  return lines[0];
}

test("supervision failures write one fixed stderr line that names the reason", async () => {
  const monitor = await installCanaryApp();
  // No RPC is open: the supervisor loop finds the unproved cleanup itself.
  process.kill(monitor, "SIGKILL");
  await daemonExit();
  const lost = containerStderr.trim().split("\n");
  expect(lost).toHaveLength(1);
  expectNoCanary(containerStdout, containerStderr);
  // A record with no definition is an unexpected error: the generic line.
  const generic = bootFailure({ sample: {} });
  const invalid = bootFailure([]);
  expect(new Set([lost[0], generic, invalid]).size).toBe(3);
}, 30_000);

test("office restarts back off, cap, reset after a stable run, and log each exit", async () => {
  await closeDaemon();
  const starts = join(root, "office-starts");
  const exits = join(root, "office-exits");
  writeFileSync(
    join(root, "office.py"),
    `
import sys, time
with open(${JSON.stringify(starts)}, "a") as f: f.write(f"{time.time()}\\n")
count = sum(1 for _ in open(${JSON.stringify(starts)}))
print("office-canary-output", flush=True)
if count == 5: time.sleep(2.5)
with open(${JSON.stringify(exits)}, "a") as f: f.write(f"{time.time()}\\n")
sys.exit(3)
`,
  );
  await boot(["python3", join(root, "office.py")], "pipe", {
    patch: {
      OFFICE_BACKOFF_START: 0.5,
      OFFICE_BACKOFF_MAX: 1,
      OFFICE_STABLE_RUN: 2,
    },
  });
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8").trim().split("\n").map(Number);
    } catch {
      return [];
    }
  };
  await until(
    () => read(starts).length >= 6,
    "the office did not restart",
    20_000,
  );
  const started = read(starts);
  const exited = read(exits);
  // delay[k]: from the end of run k to the start of run k + 1.
  const delay = [0, 1, 2, 3, 4].map((k) => started[k + 1] - exited[k]);
  expect(delay[1]).toBeGreaterThan(delay[0] + 0.25); // 0.5 -> 1
  expect(delay[2]).toBeLessThan(delay[1] + 0.5); // capped at 1, not 2
  expect(delay[3]).toBeLessThan(delay[2] + 0.5); // capped at 1, not 4
  expect(delay[4]).toBeLessThan(delay[3] - 0.25); // reset after a 2.5 s run
  await closeDaemon();
  expect(containerStdout).toContain("office-canary-output");
  const lines = containerStderr.trim().split("\n");
  expect(lines.length).toBeGreaterThanOrEqual(5);
  expect(containerStderr).not.toContain("office-canary-output");
}, 40_000);

test("office output is drained as fast as the office writes it", async () => {
  await closeDaemon();
  const took = join(root, "office-write-seconds");
  writeFileSync(
    join(root, "office.py"),
    `
import sys, time
start = time.monotonic()
sys.stdout.buffer.write(b"y" * (8 * 1024 * 1024))
sys.stdout.flush()
open(${JSON.stringify(took)}, "w").write(str(time.monotonic() - start))
time.sleep(60)
`,
  );
  await boot(["python3", join(root, "office.py")]);
  // One 64 KiB read per 50 ms loop turn needs at least 6.4 s for 8 MiB.
  const seconds = await until(
    () => {
      try {
        return Number(readFileSync(took, "utf8"));
      } catch {
        return 0;
      }
    },
    "the office write did not finish",
    15_000,
  );
  expect(seconds).toBeLessThan(3);
}, 30_000);

test("a client that sends one byte at a time cannot hold the supervisor", async () => {
  const dripper = spawn(
    "python3",
    [
      "-c",
      `
import socket, sys, time
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])
print("connected", flush=True)
try:
    for _ in range(10):
        s.send(b" ")
        print("sent", flush=True)
        time.sleep(1.5)
except OSError:
    pass
`,
      join(root, "runtime", "control.sock"),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let output = "";
  dripper.stdout?.on("data", (chunk) => (output += String(chunk)));
  try {
    await until(
      () => output.includes("connected"),
      "the dripper did not connect",
    );
    await Bun.sleep(200);
    // The old per-recv 2 s timeout never fires against a 1.5 s drip.
    await until(
      ping,
      "ping did not get through while the client dripped",
      5000,
    );
    // The drip was under way: at least two bytes, each within 2 s.
    expect(output.split("sent").length - 1).toBeGreaterThanOrEqual(2);
  } finally {
    dripper.kill("SIGKILL");
  }
}, 30_000);
