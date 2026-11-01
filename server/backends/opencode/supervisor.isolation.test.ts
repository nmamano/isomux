// Task 8db21c8b: the OpenCode server of a member runs in its own PID namespace
// while process isolation is on, and the wrap form is part of what a start
// adopts: turning the switch replaces an idle server, also one that a new
// supervisor (an Isomux restart) finds running. A health-only stand-in server
// writes its own pid at each launch: inside a namespace that pid is not the
// record's (the outer bwrap). Skips where this host cannot make a PID
// namespace (checked directly, never through the probe).
import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeSupervisor } from "./supervisor.ts";
import {
  setProcessIsolationProbe,
  setProcessIsolationSwitch,
} from "../../process-isolation-state.ts";
import { bwrapMakesPidNamespace } from "../../test-support/process-markers.ts";

const pidNamespaces = bwrapMakesPidNamespace();
const supervisors: OpenCodeSupervisor[] = [];
const scratch: string[] = [];
let switchOn = true;

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => supervisor.shutdown()),
  );
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  setProcessIsolationProbe(null);
  setProcessIsolationSwitch(() => true);
  switchOn = true;
});

async function office() {
  const path = await mkdtemp(join(tmpdir(), "isomux-opencode-isolation-"));
  scratch.push(path);
  const binary = join(path, "health-only-opencode");
  const launches = join(path, "launches");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(launches)}, process.pid + "\\n");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
  if (new URL(request.url).pathname === "/api/experimental/migration/v1") return Response.json({ status: "completed" });
  if (new URL(request.url).pathname !== "/api/info")
    return new Response("not found", { status: 404 });
  return Response.json({ version: "2.1.4", pid: process.pid });
}});
await new Promise(() => {});
`,
  );
  await chmod(binary, 0o700);
  setProcessIsolationProbe({ available: true });
  setProcessIsolationSwitch(() => switchOn);
  const supervisor = () => {
    const created = new OpenCodeSupervisor({
      profileDir: join(path, "profile"),
      serverCwd: path,
      config: { autoupdate: false, share: "disabled" },
      idleShutdownMs: 60_000,
      binary,
    });
    supervisors.push(created);
    return created;
  };
  // The pid the server saw for itself at its last launch, and the launches.
  const lastLaunch = async () => {
    const lines = (await readFile(launches, "utf8")).trim().split("\n");
    return { pid: Number(lines.at(-1)), count: lines.length };
  };
  const record = async () =>
    JSON.parse(
      await readFile(join(path, "profile", "server.lock"), "utf8"),
    ) as {
      pid: number;
      isolated?: boolean;
    };
  return { supervisor, lastLaunch, record };
}

describe.skipIf(!pidNamespaces)("OpenCode server isolation", () => {
  it("starts in its own namespace while on, and a switch to off replaces the idle server", async () => {
    const o = await office();
    const supervisor = o.supervisor();
    const wrapped = await supervisor.acquire();
    const inside = await o.lastLaunch();
    expect(inside.pid).not.toBe(wrapped.pid);
    expect((await o.record()).isolated).toBe(true);
    wrapped.release();

    switchOn = false;
    const plain = await supervisor.acquire();
    const after = await o.lastLaunch();
    expect(after.count).toBe(2);
    expect(after.pid).toBe(plain.pid);
    expect((await o.record()).isolated).not.toBe(true);
    plain.release();
  });

  it("is adopted by a new supervisor only in the same form", async () => {
    const o = await office();
    const first = await o.supervisor().acquire();
    first.release();
    // The control: the same form adopts the running server.
    const same = await o.supervisor().acquire();
    expect(same.pid).toBe(first.pid);
    expect((await o.lastLaunch()).count).toBe(1);
    same.release();

    switchOn = false;
    const plain = await o.supervisor().acquire();
    const after = await o.lastLaunch();
    expect(after.count).toBe(2);
    expect(plain.pid).not.toBe(first.pid);
    expect(after.pid).toBe(plain.pid);
    plain.release();
  });
});
