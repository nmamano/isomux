// A member's apps when their OS user changes (member-app-move.ts, slice 3b
// of task b94dfd25), through the real router and the member's real
// supervisor on a fake runner. The properties:
// - enable: the office's teardown, then her host's install with a new
//   token; an app runs again only when it ran;
// - disable: her host's teardown, then the office's install, and the office
//   never reads a file back from her host;
// - a host that cannot run apps: the app stays stopped and its token goes;
// - a teardown that fails puts back what left and stops the move;
// - a slow stop is tried again.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeAppHostDomain } from "../app-domain.ts";
import { APP_STILL_STOPPING, AppSupervisorError } from "../app-supervisor.ts";
import {
  createAppSupervisorRouter,
  type AppOwnerTarget,
} from "../app-supervisor-router.ts";
import {
  appsArrive,
  appsLeave,
  setMemberAppMoveDeps,
} from "../member-app-move.ts";
import { createFakeAppSupervisor } from "./fake-app-supervisor.ts";
import { createFakeMemberRunner } from "./fake-member-runner.ts";
import type { AppRecord } from "../../shared/types.ts";

beforeAll(() => {
  freezeAppHostDomain();
});
// The office's data folders (an office install makes the app's folder).
const DATA = mkdtempSync(join(tmpdir(), "member-app-move-"));
afterEach(() => {
  setMemberAppMoveDeps(null);
});
afterAll(() => rmSync(DATA, { recursive: true, force: true }));

const ALICE = "u-alice";
const HOME = "/home/isomux-alice";
const AGENT_ROOT = join(HOME, ".isomux-agent");

const record = (name: string): AppRecord => ({
  name,
  hostLabel: name,
  hostGen: 1,
  port: 21000 + name.length,
  command: "bun run serve.ts",
  cwd: HOME,
  dataDir: join(DATA, name),
  userId: ALICE,
  username: "Alice",
  createdBy: "AppBot",
  createdAt: 1,
});

function setup(start: "office" | "member") {
  const apps = [record("hello"), record("idle")];
  const office = createFakeAppSupervisor();
  const runner = createFakeMemberRunner({
    uid: 4711,
    home: HOME,
    agentRoot: AGENT_ROOT,
  });
  let where = start;
  let key: object = {};
  const router = createAppSupervisorRouter({
    office,
    officeAppUid: () => 1000,
    owners: (names) =>
      new Map(
        apps
          .filter((a) => names.includes(a.name))
          .map((a) => [a.name, a.userId]),
      ),
    anyIsolated: () => true,
    target: (): AppOwnerTarget =>
      where === "office"
        ? { kind: "office" }
        : {
            kind: "member",
            key,
            uid: 4711,
            socketPath: "/run/alice.sock",
            home: HOME,
            agentRoot: AGENT_ROOT,
          },
    memberName: () => "Alice",
    memberHostCall: () => runner.call,
    log: () => {},
  });
  // A token store: the hash is the token itself, enough to tell old from new.
  const hashes = new Map<string, string>();
  let minted = 0;
  const log: string[] = [];
  const order: string[] = [];
  setMemberAppMoveDeps({
    apps: () => apps,
    supervisor: router,
    provisionToken: (app) => {
      const token = `tok-${++minted}`;
      hashes.set(app.name, token);
      router.provisionToken(app.name, token);
      order.push(`token:${app.name}`);
      return true;
    },
    revokeToken: (name) => void hashes.delete(name),
    syncSecrets: () => void order.push("secrets"),
    sleep: async () => {},
    log: (line) => void log.push(line),
  });
  return {
    apps,
    office,
    runner,
    router,
    hashes,
    log,
    order,
    moveTo: (next: "office" | "member") => {
      where = next;
      key = {};
    },
  };
}

const readsOfAppFiles = (runner: ReturnType<typeof createFakeMemberRunner>) =>
  runner.requests.filter(
    (r) =>
      r.op === "fs" &&
      r.call === "readText" &&
      (r.path.endsWith("/hello.env") || r.path.endsWith("/idle.env")),
  ).length;

describe("enable moves her apps onto her host", () => {
  // MUTANT: appsArrive installs every app (dies on idle's state).
  it("tears them down on the office, then installs them on her host with new tokens; only the running one starts", async () => {
    const s = setup("office");
    s.office.install(s.apps[0]!);
    s.office.install(s.apps[1]!);
    s.office.stop("idle");
    s.hashes.set("hello", "old-hello");
    const left = await appsLeave(ALICE);
    expect(s.office.calls.filter((c) => c.startsWith("teardown:"))).toEqual([
      "teardown:hello",
      "teardown:idle",
    ]);
    s.moveTo("member");
    appsArrive(ALICE, left);
    const states = s.router.states(["hello", "idle"]);
    expect([states.get("hello")?.state, states.get("idle")?.state]).toEqual([
      "running",
      "stopped",
    ]);
    // A new token, delivered into her agent space; the old hash is gone.
    const tokenFile = s.runner.fs.get(
      join(AGENT_ROOT, "apps", "units", "hello.env"),
    );
    expect([
      s.hashes.get("hello"),
      tokenFile?.kind === "file" &&
        tokenFile.text.includes(s.hashes.get("hello")!),
    ]).toEqual(["tok-1", true]);
    // The secrets are written before the first start.
    expect(s.order).toEqual(["token:hello", "token:idle", "secrets"]);
  });
});

// Task abdb452b: an agent's host move takes only the apps it made.
describe("an agent's host move", () => {
  // MUTANT: names ignored (dies on idle's teardown).
  it("tears down only the named apps, and the others keep running", async () => {
    const s = setup("office");
    s.office.install(s.apps[0]!);
    s.office.install(s.apps[1]!);
    const left = await appsLeave(ALICE, ["hello"]);
    expect(s.office.calls.filter((c) => c.startsWith("teardown:"))).toEqual([
      "teardown:hello",
    ]);
    expect(left).toEqual([{ name: "hello", running: true }]);
    expect(s.router.states(["idle"]).get("idle")?.state).toBe("running");
  });

  // MUTANT: theirApps by "" for a null owner (dies on the teardown: the
  // app keeps running while its record goes to the new member).
  it("takes the apps of an agent with no manager, on the office's host", async () => {
    const s = setup("office");
    const legacy = { ...s.apps[0]!, userId: null, username: null };
    s.apps.splice(0, 1, legacy);
    s.office.install(legacy);
    const left = await appsLeave(null, ["hello"]);
    expect(s.office.calls.filter((c) => c.startsWith("teardown:"))).toEqual([
      "teardown:hello",
    ]);
    expect(left).toEqual([{ name: "hello", running: true }]);
    appsArrive(null, left);
    expect(s.router.states(["hello"]).get("hello")?.state).toBe("running");
  });
});

describe("disable moves her apps back to the office", () => {
  // B5: no read of an app file through her host, and the office's token is
  // not her copy.
  it("tears them down on her host and installs them on the office, reading nothing back from her host", async () => {
    const s = setup("member");
    s.router.install(s.apps[0]!);
    s.router.provisionToken("hello", "her-copy");
    const reads = readsOfAppFiles(s.runner);
    const left = await appsLeave(ALICE);
    expect(s.runner.appFiles("hello")).toEqual([]);
    s.moveTo("office");
    appsArrive(ALICE, left);
    expect([
      readsOfAppFiles(s.runner) - reads,
      s.office.calls.includes("install:hello"),
      s.office.tokenFiles.get("hello") === "her-copy",
    ]).toEqual([0, true, false]);
  });
});

describe("a host that cannot run apps", () => {
  it("leaves the app registered and stopped, with its token revoked and a log line", async () => {
    const s = setup("office");
    s.office.install(s.apps[0]!);
    s.hashes.set("hello", "old");
    const left = await appsLeave(ALICE);
    s.runner.setManager("down");
    s.moveTo("member");
    appsArrive(ALICE, left);
    expect([
      s.hashes.has("hello"),
      s.runner.appFiles("hello"),
      s.log.some((l) => l.includes("hello")),
    ]).toEqual([false, [], true]);
  });
});

describe("a teardown that fails", () => {
  // MUTANT: appsLeave rethrows without putting back (dies on hello's state).
  it("puts back the apps that left and stops the move", async () => {
    const s = setup("office");
    s.office.install(s.apps[0]!);
    s.office.install(s.apps[1]!);
    let calls = 0;
    const teardown = s.office.teardown.bind(s.office);
    s.office.teardown = (name) => {
      calls++;
      if (name === "idle")
        throw new AppSupervisorError("supervisor_failed", "nope");
      teardown(name);
    };
    const error = await appsLeave(ALICE).then(
      () => null,
      (e: Error) => e.message,
    );
    expect([error?.includes("idle"), calls]).toEqual([true, 2]);
    expect(s.office.calls.filter((c) => c === "install:hello").length).toBe(2);
  });

  it("tries a slow stop again until it ends", async () => {
    const s = setup("office");
    s.office.install(s.apps[0]!);
    let tries = 0;
    s.office.teardown = () => {
      tries++;
      if (tries < 3)
        throw new AppSupervisorError("supervisor_failed", APP_STILL_STOPPING);
    };
    const left = await appsLeave(ALICE);
    // hello three times, then idle once.
    expect([tries, left.map((a) => a.name)]).toEqual([4, ["hello", "idle"]]);
  });
});
