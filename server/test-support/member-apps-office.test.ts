// An isolated member's apps through the office's routes (slice 3b of task
// b94dfd25). The member host is the recording stand-in of
// member-host-fixture.ts; her app supervisor is the production host on a
// fake runner (fake-member-runner.ts), captured here. The properties:
// - her app's folder is checked and stored on her host (`~` is her home),
//   at register and at a cwd change; a folder that is not there is refused;
// - her app's data folder is made in her agent space, through her host, and
//   a delete sets it aside there;
// - a start whose host holds no token that matches gets a new one first;
// - at her runner's connect, her app the lock stopped starts, and her app
//   her pack does not allow stops.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { resetStateRoot } from "./temp-state.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMember, updateUserById } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { appRegistry } from "../app-registry.ts";
import { appTokens } from "../app-tokens.ts";
import { STATE_ROOT } from "../config.ts";
import { LOCKDOWN_WAITING_APPS_FILE } from "../lockdown.ts";
import { connectMemberHost } from "../member-hosts.ts";
import { lockOfficeNow, resetOfficeLockGate } from "../office-lock-gate.ts";
import { createMemberAppHost } from "../member-app-host.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import {
  createFakeMemberRunner,
  type FakeMemberRunner,
} from "./fake-member-runner.ts";
import {
  createFakeAppSupervisor,
  type FakeAppSupervisor,
} from "./fake-app-supervisor.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
let iso: IsolatedMember | null = null;
afterEach(async () => {
  resetOfficeLockGate();
  await server?.stop();
  server = null;
  iso?.dispose();
  iso = null;
});

async function office() {
  const hers: { runner?: FakeMemberRunner; supervisor?: FakeAppSupervisor } =
    {};
  const srv = (server = await startTestServer({
    startServer: {
      memberAppSupervisor: (userId, target) => {
        const runner = (hers.runner ??= createFakeMemberRunner({
          uid: target.uid,
          home: target.home,
          agentRoot: target.agentRoot,
        }));
        const supervisor = (hers.supervisor ??= createFakeAppSupervisor());
        const host = createMemberAppHost({
          userId,
          memberName: "AppsAlice",
          uid: target.uid,
          socketPath: target.socketPath,
          home: target.home,
          agentRoot: target.agentRoot,
          call: runner.call,
        });
        return { host, supervisor };
      },
    },
  }));
  await srv.seedOwner("AppsMorgan");
  const room = srv.agentManager.getRooms()[0]!.id;
  const made = createMember("AppsAlice", { role: "member" });
  if (!made.ok) throw new Error(made.error);
  const alice = made.user.id;
  if (!updateUserById(alice, { allowedRooms: [room] }).ok)
    throw new Error("allowedRooms");
  iso = await isolateMember(alice);
  const home = iso.member.host.home();
  const agentRoot = iso.member.host.agentRoot();
  mkdirSync(join(home, "app-sub"), { recursive: true });
  mkdirSync(join(home, "app-other"), { recursive: true });
  const agent = (await srv.agentManager.spawn(
    "Alice apps bot",
    home,
    "default",
    undefined,
    undefined,
    room,
    undefined,
    undefined,
    undefined,
    "AppsAlice",
    "claude",
    undefined,
    alice,
  )) as AgentInfo;
  const token = mintAgentToken(agent.id, alice);
  const call = (method: string, path: string, body?: unknown) =>
    srv.http(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { srv, alice, home, agentRoot, call, hers };
}

describe("an isolated member's app", () => {
  // MUTANT: register validates the folder as the office (dies on the
  // stored folder: the office's `~` is not her home).
  it("stores `~/sub` in her home at register and at a cwd change, and refuses a folder that is not there", async () => {
    const o = await office();
    const reg = await o.call("POST", "/api/apps", {
      name: "alice-app",
      command: "bun run serve.ts",
      cwd: "~/app-sub",
    });
    expect(reg.status).toBe(201);
    expect(appRegistry.get("alice-app")?.cwd).toBe(join(o.home, "app-sub"));
    const moved = await o.call("PATCH", "/api/apps/alice-app", {
      cwd: "~/app-other",
    });
    expect([moved.status, appRegistry.get("alice-app")?.cwd]).toEqual([
      200,
      join(o.home, "app-other"),
    ]);
    const missing = await o.call("PATCH", "/api/apps/alice-app", {
      cwd: "~/not-there",
    });
    expect([
      missing.status,
      ((await missing.json()) as { error?: { code?: string } }).error?.code,
      appRegistry.get("alice-app")?.cwd,
    ]).toEqual([400, "invalid_cwd", join(o.home, "app-other")]);
  });

  // MUTANT: register makes the data folder with the office's fs (dies on
  // the runner's folder).
  it("gets its data folder in her agent space through her host, and the delete sets it aside there", async () => {
    const o = await office();
    const reg = await o.call("POST", "/api/apps", {
      name: "alice-data",
      command: "bun run serve.ts",
      cwd: "~",
    });
    expect(reg.status).toBe(201);
    const data = join(o.agentRoot, "apps", "data", "alice-data");
    expect([
      appRegistry.get("alice-data")?.dataDir,
      o.hers.runner?.fs.get(data)?.kind,
    ]).toEqual([data, "dir"]);
    const gone = await o.call("DELETE", "/api/apps/alice-data");
    expect(gone.status).toBe(204);
    const retired = [...(o.hers.runner?.fs.keys() ?? [])].filter((p) =>
      p.startsWith(
        join(o.agentRoot, "apps", "data", ".retired", "alice-data-"),
      ),
    );
    expect([retired.length, o.hers.runner?.fs.has(data)]).toEqual([1, false]);
  });

  // B5a. MUTANT: start without ensureAppToken (dies on the match).
  it("gets a new token at a start when her host holds none that matches", async () => {
    const o = await office();
    const reg = await o.call("POST", "/api/apps", {
      name: "alice-tok",
      command: "bun run serve.ts",
      cwd: "~",
    });
    expect(reg.status).toBe(201);
    const supervisor = o.hers.supervisor!;
    // The enabling condition: register delivered a token that matches.
    const first = supervisor.tokenFiles.get("alice-tok") ?? "";
    expect(appTokens.matches("alice-tok", first)).toBe(true);
    // A move whose install failed: no token file on her host.
    supervisor.tokenFiles.delete("alice-tok");
    await o.call("POST", "/api/apps/alice-tok/stop");
    const started = await o.call("POST", "/api/apps/alice-tok/start");
    expect(started.status).toBe(200);
    const now = supervisor.tokenFiles.get("alice-tok") ?? "";
    expect([
      now !== "" && now !== first,
      appTokens.matches("alice-tok", now),
    ]).toEqual([true, true]);
  });
});

describe("at her runner's connect", () => {
  // MUTANT: reconcileMemberApps without the lock start (dies on the start).
  it("starts her app that a lock stopped and that waited for her runner, and the waiting file goes", async () => {
    const o = await office();
    const reg = await o.call("POST", "/api/apps", {
      name: "alice-wait",
      command: "bun run serve.ts",
      cwd: "~",
    });
    expect(reg.status).toBe(201);
    await o.call("POST", "/api/apps/alice-wait/stop");
    const waiting = join(STATE_ROOT, LOCKDOWN_WAITING_APPS_FILE);
    writeFileSync(waiting, JSON.stringify(["alice-wait"]));
    const supervisor = o.hers.supervisor!;
    const before = supervisor.calls.length;
    expect(await connectMemberHost(o.alice)).toBe(true);
    expect([
      supervisor.calls.slice(before).filter((c) => c === "start:alice-wait"),
      existsSync(waiting),
    ]).toEqual([["start:alice-wait"], false]);
  });

  // R2-F1: a runner that connects between the lockdown route's lock and the
  // process's stop starts nothing.
  it("starts nothing while the office is locked, and keeps the waiting file", async () => {
    const o = await office();
    const reg = await o.call("POST", "/api/apps", {
      name: "alice-locked",
      command: "bun run serve.ts",
      cwd: "~",
    });
    expect(reg.status).toBe(201);
    await o.call("POST", "/api/apps/alice-locked/stop");
    const waiting = join(STATE_ROOT, LOCKDOWN_WAITING_APPS_FILE);
    writeFileSync(waiting, JSON.stringify(["alice-locked"]));
    const supervisor = o.hers.supervisor!;
    const before = supervisor.calls.length;
    lockOfficeNow();
    await connectMemberHost(o.alice);
    expect([
      supervisor.calls.slice(before).filter((c) => c.startsWith("start:")),
      existsSync(waiting),
    ]).toEqual([[], true]);
  });

  // MUTANT: reconcileMemberApps without stopAppsThatMayNotRun (dies on the
  // stop).
  it("stops her app when her pack gives no apps write", async () => {
    const o = await office();
    const reg = await o.call("POST", "/api/apps", {
      name: "alice-pack",
      command: "bun run serve.ts",
      cwd: "~",
    });
    expect(reg.status).toBe(201);
    // Set without the pack save's own stops: the case of a boot while her
    // runner was away.
    expect(
      updateUserById(o.alice, {
        pack: { areas: { agents: "write" }, agentCeiling: "office" },
      }).ok,
    ).toBe(true);
    const supervisor = o.hers.supervisor!;
    const before = supervisor.calls.length;
    expect(await connectMemberHost(o.alice)).toBe(true);
    expect(
      supervisor.calls.slice(before).filter((c) => c === "stop:alice-pack"),
    ).toEqual(["stop:alice-pack"]);
  });
});

// Later files in the same bun process: none of this file's members or their
// files on disk (task 3a93528c).
afterAll(() => resetStateRoot(STATE_ROOT));
