import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContainerAppSupervisor } from "./container-app-supervisor.ts";
import type { AppRecord } from "../shared/types.ts";
import type { AppSupervisor } from "./app-supervisor.ts";

const program = fileURLToPath(
  new URL("../deploy/render/supervisor.py", import.meta.url),
);
let root: string;
let daemon: ChildProcess | undefined;
let supervisor: AppSupervisor;
let app: AppRecord;
let origin: string;
let detachedPid: number | undefined;
let detachedStart: string | undefined;

async function until(
  check: () => boolean | Promise<boolean>,
  message: string,
  ms = 6000,
) {
  const end = Date.now() + ms;
  do {
    if (await check()) return;
    await Bun.sleep(30);
  } while (Date.now() < end);
  throw new Error(message);
}

async function boot() {
  daemon = spawn("python3", [program, "serve", join(root, "runtime")], {
    stdio: "ignore",
    env: { ...process.env, RENDER_SECRET_SENTINEL: "must-not-reach-app" },
  });
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
  try {
    const res = await fetch(origin, { signal: AbortSignal.timeout(300) });
    return (await res.json()) as {
      pid: number;
      token: string;
      count: number;
      secret?: string;
      url: string;
    };
  } catch {
    return null;
  }
}

beforeEach(async () => {
  detachedPid = undefined;
  detachedStart = undefined;
  root = mkdtempSync(join(tmpdir(), "container-app-test-"));
  mkdirSync(join(root, "data"));
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = probe.port;
  probe.stop(true);
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

test("real app: token, logs, crash restart, stop, delete, and port reuse", async () => {
  supervisor.provisionToken(app.name, "synthetic-token-one");
  supervisor.install(app);
  await until(
    async () => (await response())?.count === 1,
    "app did not become reachable",
  );
  const first = await response();
  expect(first?.token).toBe("synthetic-token-one");
  expect(first?.secret).toBeUndefined();
  expect(first?.url).toBe("https://sample.office.example.com");
  expect(supervisor.logs(app.name, 5)).toContain("synthetic-app-start");
  supervisor.provisionToken(app.name, "synthetic-token-two");
  expect((await response())?.token).toBe("synthetic-token-one");
  const crash = await fetch(origin + "/crash", { method: "POST" });
  expect(crash.status).toBe(200);
  await until(
    async () => (await response())?.count === 2,
    "crashed app was not restarted",
  );
  expect((await response())?.token).toBe("synthetic-token-two");
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
}, 30000);

test("container restart restores running apps, data, credentials, and stopped intent", async () => {
  supervisor.provisionToken(app.name, "synthetic-persistent-token");
  supervisor.install(app);
  await until(
    async () => (await response())?.count === 1,
    "first app boot failed",
  );
  await closeDaemon();
  await boot();
  await until(
    async () => (await response())?.count === 2,
    "running intent was not restored",
  );
  expect((await response())?.token).toBe("synthetic-persistent-token");
  supervisor.stop(app.name);
  await closeDaemon();
  await boot();
  expect(supervisor.states([app.name]).get(app.name)?.state).toBe("stopped");
  expect(await response()).toBeNull();
  expect(readFileSync(join(root, "data", "counter"), "utf8")).toBe("2");
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
