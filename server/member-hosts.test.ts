// The host of each member (internal-docs/member-os-user-design.md, slice 1a).
// The property under test is one direction of trust: an isolated member's work
// never runs on the office host, and an env built for the office never reaches
// a member's runner. Every failure fails closed.
//
// One user runs these tests, so the peer uid comes from an injected reader, as
// in server/agent-runner/runner.test.ts; the split rig checks real uids.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  localAgentHost,
  MEMBER_ENV,
  MEMBER_ENV_REFUSED,
  memberEnvOwner,
  officeAgentHost,
  setOfficeAgentHost,
  tagMemberEnv,
  type AgentChild,
  type AgentHost,
} from "./agent-host.ts";
import { RunnerAgentHost } from "./agent-runner/client.ts";
import { startRunner } from "./agent-runner/runner.ts";
import {
  connectMemberHost,
  connectMemberHosts,
  createNotReadyHost,
  hostFor,
  MEMBER_HOST_NOT_READY,
  memberHostRefusal,
  memberRunnerSocketPath,
  memberCodeTreeChecks,
  memberTrustedChecks,
  NOT_READY_PATH,
  resetMemberHosts,
  setMemberHostDeps,
  setMemberConnectedHook,
  setMemberRunnerRoot,
  writeMemberCaBundles,
  type MemberCheckInput,
} from "./member-hosts.ts";
import {
  memberOsUsersPath,
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "./member-os-users.ts";
import { STATE_ROOT } from "./config.ts";
import {
  memberRuntimePaths,
  memberSharePath,
  runtimeSource,
  setMemberRuntimeDeps,
  setMemberShareRoot,
} from "./member-runtime.ts";
import { checkMemberShare, realShareProbe } from "./member-share-check.ts";
import { CLAUDE_NATIVE_BIN } from "./cwd-utils.ts";
import { resolveCodexLauncherPath } from "./backends/codex/native-bin.ts";
import { resolveOpenCodeBinary } from "./backends/opencode/runtime.ts";
import { _testResetUsers, claimUser, deleteUserById } from "./users.ts";
import {
  ACL_GROUP_OBJ,
  ACL_MASK,
  ACL_OTHER,
  ACL_USER,
  ACL_USER_OBJ,
  type AclEntry,
} from "./split/acl.ts";
import type { FileFacts, FsProbe } from "./split/trusted-checks.ts";
import { expectRejection } from "./test-support/expect-rejection.ts";

// The error code a promise rejects with, or "resolved".
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return "resolved";
}
const NOT_READY = MEMBER_HOST_NOT_READY;

const UID = process.getuid!();
// The runtime hash the test runners report and the test runtime deps
// install (slice 1b-i): a connect takes their runtime as current.
const TEST_RUNTIME_HASH = "e".repeat(64);
const MEMBER_MAIN = join(import.meta.dir, "agent-runner", "member-main.ts");
const TEST_RUNTIME_DEPS = {
  checkShare: () => ({ ok: true }) as const,
  runtime: {
    hash: async () => TEST_RUNTIME_HASH,
    install: async () => {},
    prune: async () => {},
  },
};
let dir: string;
let runners: { stop(): void }[] = [];

// An office host that records every call and runs nothing.
function recordingOfficeHost(): { host: AgentHost; calls: string[] } {
  const calls: string[] = [];
  const host: AgentHost = {
    ...localAgentHost,
    spawnPipe: (argv) => {
      calls.push(`spawnPipe ${argv.join(" ")}`);
      return localAgentHost.spawnPipe(["true"]);
    },
    spawnChild: (argv) => {
      calls.push(`spawnChild ${argv.join(" ")}`);
      return localAgentHost.spawnChild(["true"]);
    },
    run: async (argv) => {
      calls.push(`run ${argv.join(" ")}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    isomuxDiff: async (req) => {
      calls.push("isomuxDiff");
      return { kind: "clean", cwd: req.agentCwd } as never;
    },
    runEntry: async (name) => {
      calls.push(`runEntry ${name}`);
      return {};
    },
  };
  return { host, calls };
}

// Every event of a child; resolves on "close", or after "error" when no
// "close" follows.
function events(child: AgentChild): Promise<string[]> {
  const seen: string[] = [];
  return new Promise((resolve) => {
    child.on("spawn", () => seen.push("spawn"));
    child.on("exit", (code) => seen.push(`exit:${code}`));
    child.on("error", (error: NodeJS.ErrnoException) => {
      seen.push(`error:${error.code}`);
      setTimeout(() => resolve(seen), 200);
    });
    child.on("close", () => {
      seen.push("close");
      resolve(seen);
    });
  });
}

function startMemberRunner(socketPath: string): void {
  mkdirSync(dirname(socketPath), { recursive: true });
  runners.push(
    startRunner({
      socketPath,
      serverUid: UID,
      readPeerUid: () => UID,
      killGraceMs: 300,
      bundle: { path: MEMBER_MAIN, hash: TEST_RUNTIME_HASH },
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "member-hosts-"));
  setMemberRunnerRoot(join(dir, "run"));
  rmSync(memberOsUsersPath(), { force: true });
  reloadMemberOsUsers();
});

afterEach(() => {
  resetMemberHosts();
  setMemberHostDeps(null);
  setMemberRunnerRoot(null);
  setOfficeAgentHost(localAgentHost);
  for (const runner of runners) runner.stop();
  runners = [];
  rmSync(memberOsUsersPath(), { force: true });
  reloadMemberOsUsers();
  rmSync(dir, { recursive: true, force: true });
});

describe("hostFor", () => {
  it("gives the office host to an agent with no manager and to a member without an OS user", () => {
    const office = recordingOfficeHost().host;
    setOfficeAgentHost(office);
    expect(hostFor(null)).toBe(office);
    expect(hostFor(undefined)).toBe(office);
    expect(hostFor("u-plain")).toBe(office);
  });

  it("never gives the office host to an isolated member whose runner is not connected", async () => {
    const { host: office, calls } = recordingOfficeHost();
    setOfficeAgentHost(office);
    recordMemberOsUser("u-alice", { name: "isomux-alice", uid: 2001 });
    const host = hostFor("u-alice");
    expect(host).not.toBe(office);
    expect(host).not.toBe(localAgentHost);
    expect(await codeOf(host.run(["true"]))).toBe(NOT_READY);
    expect(calls).toEqual([]);
  });

  it("keeps the member off the office host after the member is removed", async () => {
    const office = recordingOfficeHost();
    setOfficeAgentHost(office.host);
    const alice = claimUser("Alice-osuser-removed");
    recordMemberOsUser(alice.id, { name: "isomux-alice", uid: 2001 });
    deleteUserById(alice.id);
    const host = hostFor(alice.id);
    expect(host).not.toBe(office.host);
    expect(await codeOf(host.run(["true"]))).toBe(NOT_READY);
    expect(office.calls).toEqual([]);
  });

  it("keeps the member off the office host when users.json does not parse", async () => {
    const office = recordingOfficeHost();
    setOfficeAgentHost(office.host);
    const alice = claimUser("Alice-osuser-corrupt");
    recordMemberOsUser(alice.id, { name: "isomux-alice", uid: 2001 });
    const usersFile = join(STATE_ROOT, "users.json");
    writeFileSync(usersFile, "{");
    _testResetUsers();
    try {
      const host = hostFor(alice.id);
      expect(host).not.toBe(office.host);
      expect(await codeOf(host.run(["true"]))).toBe(NOT_READY);
      expect(office.calls).toEqual([]);
    } finally {
      rmSync(usersFile, { force: true });
      _testResetUsers();
    }
  });

  it("gives every member a not-ready host when the record does not parse, and a malformed entry its member", async () => {
    const office = recordingOfficeHost();
    setOfficeAgentHost(office.host);
    writeFileSync(memberOsUsersPath(), "{");
    reloadMemberOsUsers();
    for (const userId of ["u-alice", "u-plain"]) {
      expect(hostFor(userId)).not.toBe(office.host);
      expect(await codeOf(hostFor(userId).run(["true"]))).toBe(NOT_READY);
    }
    expect(hostFor(null)).toBe(office.host);
    writeFileSync(
      memberOsUsersPath(),
      JSON.stringify({ "u-alice": { name: "Alice", uid: 2001 } }),
    );
    reloadMemberOsUsers();
    expect(hostFor("u-alice")).not.toBe(office.host);
    expect(await codeOf(hostFor("u-alice").run(["true"]))).toBe(NOT_READY);
    expect(hostFor("u-plain")).toBe(office.host);
    expect(office.calls).toEqual([]);
  });
});

describe("the not-ready host", () => {
  it("fails every operation and never reaches the office host", async () => {
    const { host: office, calls } = recordingOfficeHost();
    setOfficeAgentHost(office);
    const host = createNotReadyHost("u-alice", "runner down");
    const marker = join(dir, "ran");
    const touch = ["sh", "-c", `touch ${marker}`];

    expect(await events(host.spawnChild(touch))).toEqual([
      `error:${MEMBER_HOST_NOT_READY}`,
    ]);
    const pipe = host.spawnPipe(touch);
    expect(await pipe.exited).not.toBe(0);
    expect(await new Response(pipe.stdout).text()).toBe("");
    expect(await codeOf(host.run(touch))).toBe(NOT_READY);
    expect(await codeOf(host.runEntry("bun-path", {}))).toBe(NOT_READY);
    expect(await codeOf(host.fs.readText(join(dir, "x")))).toBe(NOT_READY);
    expect(
      await codeOf(host.fs.writeText(join(dir, "x"), "x", { mode: 0o600 })),
    ).toBe(NOT_READY);
    expect(await codeOf(host.fs.mkdir(join(dir, "d"), 0o700))).toBe(NOT_READY);
    expect(await codeOf(host.fs.rm(join(dir, "x")))).toBe(NOT_READY);
    expect(await codeOf(host.fs.exists(dir))).toBe(NOT_READY);
    expect(await codeOf(host.fs.chmod(dir, 0o700))).toBe(NOT_READY);
    expect((await host.isomuxDiff({ agentCwd: dir } as never)).kind).toBe(
      "git_error",
    );

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, "x"))).toBe(false);
    expect(existsSync(join(dir, "d"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("carries no office value in its environment, home, user or Bun path", () => {
    const host = createNotReadyHost("u-alice", "runner down");
    expect(host.baseEnv()).toEqual({});
    expect(host.home()).toBe(NOT_READY_PATH);
    expect(host.bunPath()).toBe(NOT_READY_PATH);
    expect(host.username()).toBe("");
    expect(existsSync(NOT_READY_PATH)).toBe(false);
  });
});

describe("the env tag", () => {
  it("survives a spread and names its member", () => {
    const env = tagMemberEnv({ PATH: "/usr/bin" }, "u-alice");
    expect(memberEnvOwner(env)).toBe("u-alice");
    expect(memberEnvOwner({ ...env, EXTRA: "1" })).toBe("u-alice");
    expect(memberEnvOwner({ PATH: "/usr/bin" })).toBeUndefined();
    expect(memberEnvOwner(undefined)).toBeUndefined();
    expect(JSON.stringify(env)).toBe('{"PATH":"/usr/bin"}');
    expect((env as Record<symbol, unknown>)[MEMBER_ENV]).toBe("u-alice");
  });

  it("the local office host refuses a member's env and runs nothing", async () => {
    const marker = join(dir, "ran");
    const env = tagMemberEnv({ PATH: process.env.PATH }, "u-alice");
    const child = localAgentHost.spawnChild(["sh", "-c", `touch ${marker}`], {
      env,
    });
    expect(await events(child)).toEqual([`error:${MEMBER_ENV_REFUSED}`]);
    const isolated = localAgentHost.spawnChild(
      ["sh", "-c", `touch ${marker}`],
      { env, isolate: true },
    );
    expect(await events(isolated)).toEqual([`error:${MEMBER_ENV_REFUSED}`]);
    expect(
      await codeOf(
        localAgentHost.run(["sh", "-c", `touch ${marker}`], { env }),
      ),
    ).toBe(MEMBER_ENV_REFUSED);
    expect(existsSync(marker)).toBe(false);
    // An untagged env still runs (no change for an office without the feature).
    const plain = localAgentHost.spawnChild(["true"], {
      env: { PATH: process.env.PATH },
    });
    expect(await events(plain)).toContain("exit:0");
  });

  it("the office runner of split mode refuses a member's env", async () => {
    const socketPath = join(dir, "office", "runner.sock");
    startMemberRunner(socketPath);
    const office = await RunnerAgentHost.connect(socketPath);
    const marker = join(dir, "ran");
    const env = tagMemberEnv({ PATH: process.env.PATH }, "u-alice");
    expect(
      await events(office.spawnChild(["sh", "-c", `touch ${marker}`], { env })),
    ).toEqual([`error:${MEMBER_ENV_REFUSED}`]);
    expect(
      await codeOf(office.run(["sh", "-c", `touch ${marker}`], { env })),
    ).toBe(MEMBER_ENV_REFUSED);
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("a member's runner host", () => {
  let runnerCount = 0;
  async function aliceHost(
    readPeerUid: () => number | null = () => UID,
  ): Promise<RunnerAgentHost> {
    const socketPath = join(dir, `alice-${++runnerCount}`, "runner.sock");
    startMemberRunner(socketPath);
    const runner = await RunnerAgentHost.connectMember(socketPath, {
      userId: "u-alice",
      uid: UID,
      share: join(dir, "share"),
      readPeerUid,
    });
    return runner.host;
  }

  it("refuses an env not built for its member: an office env and another member's", async () => {
    const host = await aliceHost();
    expect(host.member).toBe("u-alice");
    const marker = join(dir, "ran");
    const touch = ["sh", "-c", `touch ${marker}`];
    for (const env of [
      { PATH: process.env.PATH },
      { ...process.env },
      tagMemberEnv({ PATH: process.env.PATH }, "u-bob"),
    ]) {
      expect(await events(host.spawnChild(touch, { env }))).toEqual([
        `error:${MEMBER_ENV_REFUSED}`,
      ]);
      expect(await codeOf(host.run(touch, { env }))).toBe(MEMBER_ENV_REFUSED);
    }
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);
  });

  it("runs with its member's env, and with its own base env when given none", async () => {
    const host = await aliceHost();
    const env = tagMemberEnv(
      { PATH: process.env.PATH, MARK: "alice" },
      "u-alice",
    );
    const tagged = await host.run(["sh", "-c", "printf %s $MARK"], { env });
    expect(tagged).toMatchObject({ exitCode: 0, stdout: "alice" });
    const base = await host.run(["true"]);
    expect(base.exitCode).toBe(0);
  });

  it("refuses a runner whose socket's peer is not the member's uid", async () => {
    await expectRejection(
      aliceHost(() => UID + 1),
      /./,
    );
    await expectRejection(
      aliceHost(() => null),
      /./,
    );
  });

  // Slice 1b-i: the member host runs the engines of its runtime folder in
  // the share, named by the hash the runner reports, never the office's.
  it("names the engines, the sidecar and Bun of runtime/<reported hash>, and turns the engine updaters off", async () => {
    const host = await aliceHost();
    const runtime = join(dir, "share", "runtime", TEST_RUNTIME_HASH);
    const paths = memberRuntimePaths(runtime);
    expect(host.bunPath()).toBe(join(runtime, "bun"));
    expect(host.claudeBin()).toBe(paths.claudeBin);
    expect(
      host.claudeBin().startsWith(join(runtime, "node_modules") + "/"),
    ).toBe(true);
    expect(host.codexLauncher()).toBe(paths.codexLauncher());
    expect(
      host.codexLauncher().startsWith(join(runtime, "node_modules") + "/"),
    ).toBe(true);
    expect(host.ptySidecarArgv()).toEqual([
      join(runtime, "bun"),
      join(runtime, "runner.js"),
      "pty",
    ]);
    expect(host.openCodeHelperArgv()).toEqual([
      join(runtime, "bun"),
      join(runtime, "runner.js"),
      "opencode-helper",
    ]);
    if (process.platform === "linux")
      expect(
        host.openCodeBin().startsWith(join(runtime, "node_modules") + "/"),
      ).toBe(true);
    const env = host.baseEnv();
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect((env.PATH ?? "").split(":")).toContain(dirname(paths.claudeBin));
  });

  it("checks the peer uid on every connection, not only the first", async () => {
    let peer = UID;
    const host = await aliceHost(() => peer);
    const marker = join(dir, "ran");
    const env = tagMemberEnv({ PATH: process.env.PATH }, "u-alice");
    peer = UID + 1;
    expect(
      (
        await events(host.spawnChild(["sh", "-c", `touch ${marker}`], { env }))
      ).some((e) => e.startsWith("error:")),
    ).toBe(true);
    expect(await codeOf(host.run(["true"], { env }))).not.toBe("resolved");
    expect(await codeOf(host.fs.readText(join(dir, "x")))).not.toBe("resolved");
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("the office host's engines (slice 1b-i)", () => {
  it("are today's values: the code tree's engines and sidecar, under the office's Bun", () => {
    expect(localAgentHost.claudeBin()).toBe(CLAUDE_NATIVE_BIN);
    expect(localAgentHost.codexLauncher()).toBe(resolveCodexLauncherPath());
    expect(localAgentHost.ptySidecarArgv()).toEqual([
      process.execPath,
      join(import.meta.dir, "pty-sidecar.ts"),
    ]);
    expect(localAgentHost.openCodeHelperArgv()).toEqual([
      process.execPath,
      "run",
      join(import.meta.dir, "backends", "opencode", "start-server.ts"),
    ]);
    if (process.platform === "linux")
      expect(localAgentHost.openCodeBin()).toBe(resolveOpenCodeBinary());
    // A host with its own Bun keeps its own Bun for the sidecar.
    const other = { ...localAgentHost, bunPath: () => "/other/bun" };
    expect(other.ptySidecarArgv()[0]).toBe("/other/bun");
  });
});

// Slice 1b-i: the connect puts the member on the runtime this server
// installs. The runner and the runtime are recorded stand-ins; each event is
// logged in order.
describe("the connect's runtime", () => {
  const NAME = "isomux-alice";
  const WANTED = "1".repeat(64);
  const OLD = "2".repeat(64);

  function stand(
    over: {
      // The hash each successive runner reports; the last repeats.
      reports?: (string | null)[];
      // How many connects fail before one succeeds (from the first).
      unreachable?: number;
      // Share check verdicts in order; the last repeats.
      shares?: boolean[];
      install?: () => Promise<void>;
      exit?: () => Promise<void>;
      wanted?: () => string;
      // The secret proxy's side (slice 2d-ii).
      tie?: (uid: number) => Promise<boolean>;
      bundle?: string | null;
    } = {},
  ) {
    const log: string[] = [];
    const hosts: AgentHost[] = [];
    const reports = over.reports ?? [WANTED];
    const shares = over.shares ?? [true];
    let unreachable = over.unreachable ?? 0;
    let connects = 0;
    let shareChecks = 0;
    setMemberHostDeps({
      readPeerUid: () => UID,
      lookupUser: () => ({ uid: UID, gid: 4242, groups: [4242] }),
      checks: async () => {
        log.push("checks");
        return [];
      },
      checkShare: (input) => {
        log.push(`share ${input.memberGid}`);
        const ok = shares[Math.min(shareChecks++, shares.length - 1)];
        return ok
          ? { ok: true }
          : { ok: false, path: input.share, reason: "test" };
      },
      runtime: {
        hash: async () => (over.wanted ? over.wanted() : WANTED),
        install: async (_share, gid) => {
          log.push(`install ${gid}`);
          await over.install?.();
        },
        prune: async (_share, keep) => {
          log.push(`prune ${keep.join(",")}`);
        },
      },
      connectRunner: async () => {
        if (unreachable > 0) {
          unreachable--;
          log.push("connect failed");
          throw new Error("no runner");
        }
        const hash = reports[Math.min(connects++, reports.length - 1)];
        log.push(`connect ${hash ?? "none"}`);
        const host = {
          ...localAgentHost,
          kind: "runner",
          member: "u-alice",
        } as AgentHost;
        hosts.push(host);
        return {
          host,
          runtimeHash: hash,
          exit: async () => {
            log.push("exit");
            await over.exit?.();
          },
        };
      },
      restartWaitMs: 300,
      restartPollMs: 10,
      retryMs: 60_000,
      // Logged only when the test gives one: the other cases end on the prune.
      tieProxyUid: async (uid) => {
        if (!over.tie) return true;
        log.push(`tie ${uid}`);
        return over.tie(uid);
      },
      caBundle: () => over.bundle ?? null,
      writeCaBundle: async (_share, pem) => {
        log.push(`bundle ${pem}`);
      },
    });
    recordMemberOsUser("u-alice", { name: NAME, uid: UID });
    return { log, hosts };
  }
  const index = (log: string[], event: string, from = 0) =>
    log.indexOf(event, from);

  it("takes a runner on the wanted runtime as it is, and prunes the rest", async () => {
    const { log, hosts } = stand();
    expect(await connectMemberHost("u-alice")).toBe(true);
    expect(hostFor("u-alice")).toBe(hosts[0]);
    expect(log).not.toContain("exit");
    expect(log.filter((e) => e.startsWith("connect"))).toEqual([
      `connect ${WANTED}`,
    ]);
    expect(log.at(-1)).toBe(`prune ${WANTED}`);
    // The share check comes before any runner op.
    expect(index(log, "share 4242")).toBeLessThan(
      index(log, `connect ${WANTED}`),
    );
  });

  // Slice 2d-ii of task b94dfd25: the member's agents start only after the
  // secret proxy ties their uid; their share gets the CA bundle before the
  // share check that covers it.
  it("is ready only after the proxy ties the member's uid, and writes the CA bundle before the share check", async () => {
    const { log } = stand({ bundle: "PEM", tie: async () => true });
    expect(await connectMemberHost("u-alice")).toBe(true);
    expect(log.filter((e) => e.startsWith("tie"))).toEqual([`tie ${UID}`]);
    expect(index(log, "bundle PEM")).toBeGreaterThan(-1);
    // The share check after the install covers the copy.
    expect(index(log, "bundle PEM")).toBeLessThan(
      log.lastIndexOf("share 4242"),
    );
  });

  it("stays not ready, with a reason, when the proxy does not tie the uid", async () => {
    const { log, hosts } = stand({ tie: async () => false });
    expect(await connectMemberHost("u-alice")).toBe(false);
    expect(log).toContain(`tie ${UID}`);
    expect(memberHostRefusal("u-alice")).toBeTruthy();
    const host = hostFor("u-alice");
    expect(hosts).toHaveLength(1);
    expect(host).not.toBe(hosts[0]);
    expect(await codeOf(host.run(["true"]))).toBe(NOT_READY);
  });

  it("writes no bundle while the office has no secret material", async () => {
    const { log } = stand({ bundle: null });
    expect(await connectMemberHost("u-alice")).toBe(true);
    expect(log.filter((e) => e.startsWith("bundle"))).toEqual([]);
  });

  // Round 1 F1: the office makes its material while the member is between
  // the first write and `connected` (here at the tie). The office's own
  // write (writeMemberCaBundles) skips a member who is not connected yet, so
  // the connect itself must write the bundle, before the agents start.
  it("writes the CA bundle the office made during the connect, before the member's agents start", async () => {
    const over: { bundle: string | null; tie: () => Promise<boolean> } = {
      bundle: null,
      tie: async () => {
        over.bundle = "PEM";
        // The office's onBundle, as server/isomux-office.ts wires it.
        await writeMemberCaBundles();
        log.push("material made");
        return true;
      },
    };
    const { log } = stand(over);
    setMemberConnectedHook(() => log.push("agents start"));
    try {
      expect(await connectMemberHost("u-alice")).toBe(true);
    } finally {
      setMemberConnectedHook(null);
    }
    // The enabling condition: the material came after the first write.
    expect(index(log, "material made")).toBeGreaterThan(
      index(log, "share 4242"),
    );
    expect(log.filter((e) => e.startsWith("bundle"))).toEqual(["bundle PEM"]);
    expect(index(log, "bundle PEM")).toBeGreaterThan(
      index(log, "material made"),
    );
    expect(index(log, "bundle PEM")).toBeLessThan(index(log, "agents start"));
  });

  it("on another runtime: installs, checks the share again, asks the runner to exit, and takes the restarted runner", async () => {
    const { log, hosts } = stand({ reports: [OLD, WANTED] });
    expect(await connectMemberHost("u-alice")).toBe(true);
    expect(hostFor("u-alice")).toBe(hosts[1]);
    const install = index(log, "install 4242");
    const exit = index(log, "exit");
    expect(install).toBeGreaterThanOrEqual(0);
    // A share check after the install, before the exit.
    const recheck = log.findIndex((e, i) => i > install && e === "share 4242");
    expect(recheck).toBeGreaterThan(install);
    expect(exit).toBeGreaterThan(recheck);
    expect(index(log, `connect ${WANTED}`)).toBeGreaterThan(exit);
    // The prune comes only after the runner runs the wanted runtime.
    expect(log.filter((e) => e.startsWith("prune"))).toEqual([
      `prune ${WANTED}`,
    ]);
    expect(index(log, `prune ${WANTED}`)).toBeGreaterThan(
      index(log, `connect ${WANTED}`),
    );
  });

  it("refuses a runner that still reports another runtime after its restart: one install, one exit, no prune", async () => {
    const { log } = stand({ reports: [OLD] });
    expect(await connectMemberHost("u-alice")).toBe(false);
    expect(hostFor("u-alice")).not.toBeInstanceOf(RunnerAgentHost);
    expect(await codeOf(hostFor("u-alice").run(["true"]))).toBe(NOT_READY);
    expect(log.filter((e) => e.startsWith("install"))).toHaveLength(1);
    expect(log.filter((e) => e === "exit")).toHaveLength(1);
    expect(log.filter((e) => e.startsWith("connect "))).toHaveLength(2);
    expect(log.filter((e) => e.startsWith("prune"))).toEqual([]);
  });

  it("refuses when the runner does not come back after its exit, and prunes nothing", async () => {
    let calls = 0;
    const { log } = stand({ reports: [OLD] });
    // Every connect after the first fails.
    setMemberHostDeps({
      readPeerUid: () => UID,
      lookupUser: () => ({ uid: UID, gid: 4242, groups: [4242] }),
      checks: async () => [],
      checkShare: () => ({ ok: true }),
      runtime: {
        hash: async () => WANTED,
        install: async () => {},
        prune: async () => {
          log.push("prune");
        },
      },
      connectRunner: async () => {
        if (calls++ > 0) throw new Error("no runner");
        return {
          host: { ...localAgentHost, kind: "runner" } as AgentHost,
          runtimeHash: OLD,
          exit: async () => {},
        };
      },
      restartWaitMs: 100,
      restartPollMs: 10,
      retryMs: 60_000,
    });
    expect(await connectMemberHost("u-alice")).toBe(false);
    expect(calls).toBeGreaterThan(2);
    expect(log).not.toContain("prune");
  });

  it("is not ready from the install to the restarted runner: no spawn reaches the old runner", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let wanted = OLD;
    const { log, hosts } = stand({
      reports: [OLD, OLD, WANTED],
      wanted: () => wanted,
      install: () => (wanted === WANTED ? gate : Promise.resolve()),
    });
    // Connected on the old runtime.
    expect(await connectMemberHost("u-alice")).toBe(true);
    expect(hostFor("u-alice")).toBe(hosts[0]);
    // The server now installs a new runtime.
    wanted = WANTED;
    const second = connectMemberHost("u-alice");
    const deadline = Date.now() + 2000;
    // The first connect installs too: wait for the second connect's install.
    const installs = () => log.filter((e) => e === "install 4242").length;
    while (installs() < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(installs()).toBe(2);
    const during = hostFor("u-alice");
    expect(hosts).not.toContain(during);
    expect(await codeOf(during.run(["true"]))).toBe(NOT_READY);
    release();
    expect(await second).toBe(true);
    expect(hostFor("u-alice")).toBe(hosts.at(-1)!);
  });

  it("drops a connected runner that now reports another runtime until its restart matches", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const { log, hosts } = stand({
      reports: [WANTED, OLD, WANTED],
      exit: () => (held ? gate : Promise.resolve()),
    });
    expect(await connectMemberHost("u-alice")).toBe(true);
    expect(hostFor("u-alice")).toBe(hosts[0]);
    held = true;
    const second = connectMemberHost("u-alice");
    const deadline = Date.now() + 2000;
    while (!log.includes("exit") && Date.now() < deadline) await Bun.sleep(5);
    expect(log).toContain("exit");
    const during = hostFor("u-alice");
    expect(hosts).not.toContain(during);
    expect(await codeOf(during.run(["true"]))).toBe(NOT_READY);
    release();
    expect(await second).toBe(true);
    expect(hostFor("u-alice")).toBe(hosts.at(-1)!);
  });

  it("writes nothing and sends no runner op when the share check fails", async () => {
    const { log } = stand({ shares: [false] });
    expect(await connectMemberHost("u-alice")).toBe(false);
    // The server never writes into a share whose root it does not trust.
    expect(log.some((e) => e.startsWith("install"))).toBe(false);
    expect(log.some((e) => e.startsWith("connect"))).toBe(false);
    expect(log).not.toContain("exit");
  });

  it("does not restart the runner when the installed runtime fails the share check", async () => {
    const { log } = stand({ reports: [OLD, WANTED], shares: [true, false] });
    expect(await connectMemberHost("u-alice")).toBe(false);
    expect(log).toContain("install 4242");
    expect(log).not.toContain("exit");
    expect(log.some((e) => e.startsWith("prune"))).toBe(false);
  });

  // A share whose runtime is missing or broken has no runner to answer
  // (the unit cannot start it): the connect must install anyway, or the
  // member stays not ready for good.
  it("installs the runtime when no runner answers", async () => {
    const { log } = stand({ unreachable: 1_000 });
    expect(await connectMemberHost("u-alice")).toBe(false);
    expect(log).toContain("connect failed");
    expect(log).toContain("install 4242");
  });

  // The real share check and the real install on a share in a temp folder;
  // the probe reports the share's parent as root's, which a test user
  // cannot make. The runner is a stand-in on the wanted runtime.
  async function realShare() {
    const shares = join(dir, "shares");
    mkdirSync(shares);
    chmodSync(shares, 0o755);
    setMemberShareRoot(shares);
    const share = memberSharePath(NAME);
    mkdirSync(share);
    chmodSync(share, 0o2750);
    const modules = join(dir, "office", "node_modules");
    mkdirSync(join(modules, "pkg-a"), { recursive: true });
    writeFileSync(join(modules, "pkg-a", "tool"), "tool\n");
    const bun = join(dir, "office", "bun");
    writeFileSync(bun, "bun\n");
    chmodSync(bun, 0o755);
    setMemberRuntimeDeps({
      build: async () => new TextEncoder().encode("bundle\n"),
      bunPath: bun,
      modules,
      packages: () => ["pkg-a"],
      codexHook: async () => ({ path: bun, sha256: "hook" }),
    });
    const gid = process.getgid!();
    const probe = {
      lstat: (path: string) => {
        const entry = realShareProbe.lstat(path);
        return entry && path === shares ? { ...entry, uid: 0 } : entry;
      },
      readdir: (path: string) => realShareProbe.readdir(path),
    };
    const wanted = (await runtimeSource()).hash;
    const runnerOps: string[] = [];
    setMemberHostDeps({
      readPeerUid: () => UID,
      lookupUser: () => ({ uid: UID, gid, groups: [gid] }),
      checks: async () => [],
      checkShare: (input) => checkMemberShare({ ...input, probe }),
      connectRunner: async () => {
        runnerOps.push("connect");
        return {
          host: { ...localAgentHost, kind: "runner" } as AgentHost,
          runtimeHash: wanted,
          exit: async () => {
            runnerOps.push("exit");
          },
        };
      },
      retryMs: 60_000,
    });
    recordMemberOsUser("u-alice", { name: NAME, uid: UID });
    return { share, wanted, runnerOps };
  }
  const forgetRealShare = () => {
    setMemberRuntimeDeps(null);
    setMemberShareRoot(null);
  };

  // A runtime folder removed by hand leaves runtime/current naming nothing:
  // the unit cannot start the runner, so only the connect's install repairs
  // it.
  it("repairs a share whose runtime/current names a runtime that is gone", async () => {
    try {
      const { share, wanted } = await realShare();
      expect(await connectMemberHost("u-alice")).toBe(true);
      const folder = join(share, "runtime", wanted);
      expect(existsSync(folder)).toBe(true);
      // Removed by hand.
      rmSync(folder, { recursive: true, force: true });
      resetMemberHosts();
      expect(await connectMemberHost("u-alice")).toBe(true);
      expect(existsSync(join(folder, "runner.js"))).toBe(true);
      expect(readlinkSync(join(share, "runtime", "current"))).toBe(wanted);
    } finally {
      forgetRealShare();
    }
  });

  // The install repairs only the wanted runtime; anything else wrong in the
  // share is still refused after it, before any runner op.
  it("refuses, after the install, a share with a bad old runtime folder, and sends the runner nothing", async () => {
    try {
      const { share, runnerOps } = await realShare();
      // The enabling condition: the same share connects without it.
      expect(await connectMemberHost("u-alice")).toBe(true);
      expect(runnerOps).toEqual(["connect"]);
      const old = join(share, "runtime", "9".repeat(64));
      mkdirSync(old);
      chmodSync(old, 0o755);
      writeFileSync(join(old, "x"), "x\n");
      chmodSync(join(old, "x"), 0o666);
      resetMemberHosts();
      expect(await connectMemberHost("u-alice")).toBe(false);
      expect(runnerOps).toEqual(["connect"]);
    } finally {
      forgetRealShare();
    }
  });

  it("runs one connect per member at a time", async () => {
    const { log } = stand();
    const [a, b] = await Promise.all([
      connectMemberHost("u-alice"),
      connectMemberHost("u-alice"),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(log.filter((e) => e.startsWith("connect "))).toHaveLength(1);
  });
});

describe("connectMemberHost", () => {
  const NAME = "isomux-alice";

  function deps(
    over: Partial<{
      peer: number;
      lookupUid: number;
      failures: readonly { check: string; detail: string }[];
    }> = {},
  ) {
    setMemberHostDeps({
      readPeerUid: () => over.peer ?? UID,
      lookupUser: () => ({
        uid: over.lookupUid ?? UID,
        gid: 4242,
        groups: [4242],
      }),
      checks: () => (over.failures ?? []) as never,
      ...TEST_RUNTIME_DEPS,
      retryMs: 50,
    });
  }

  it("puts a member on its runner host only when the peer uid, the user database and the checks agree", async () => {
    recordMemberOsUser("u-alice", { name: NAME, uid: UID });
    expect(memberRunnerSocketPath(NAME)).toBe(
      join(dir, "run", `isomux-runner-${NAME}`, "runner.sock"),
    );
    startMemberRunner(memberRunnerSocketPath(NAME));
    deps();
    expect(await connectMemberHost("u-alice")).toBe(true);
    const host = hostFor("u-alice") as RunnerAgentHost;
    expect(host).toBeInstanceOf(RunnerAgentHost);
    expect(host.member).toBe("u-alice");
    const env = tagMemberEnv({ PATH: process.env.PATH }, "u-alice");
    expect((await host.run(["true"], { env })).exitCode).toBe(0);
  });

  for (const [name, over] of [
    ["the runner's peer uid differs", { peer: UID + 1 }],
    ["the user database has another uid for the name", { lookupUid: UID + 1 }],
    ["a trusted check fails", { failures: [{ check: "x", detail: "y" }] }],
  ] as const) {
    it(`leaves the member not ready when ${name}`, async () => {
      const office = recordingOfficeHost();
      setOfficeAgentHost(office.host);
      recordMemberOsUser("u-alice", { name: NAME, uid: UID });
      startMemberRunner(memberRunnerSocketPath(NAME));
      deps(over);
      expect(await connectMemberHost("u-alice")).toBe(false);
      const host = hostFor("u-alice");
      expect(host).not.toBe(office.host);
      expect(host).not.toBeInstanceOf(RunnerAgentHost);
      expect(await codeOf(host.run(["true"]))).toBe(NOT_READY);
      expect(office.calls).toEqual([]);
    });
  }

  // Task 39ec1276: a refusal names the first failures and counts the rest,
  // and the log has it once while the reason stays the same.
  it("caps a refusal's failures, and logs a repeated reason once", async () => {
    recordMemberOsUser("u-alice", { name: NAME, uid: UID });
    startMemberRunner(memberRunnerSocketPath(NAME));
    const many = (prefix: string) =>
      Array.from({ length: 200 }, (_, i) => ({
        check: "private-agent-write",
        path: `/code/${prefix}${i}.js`,
        detail: "the agent user can write it",
      }));
    let failures = many("a");
    setMemberHostDeps({
      readPeerUid: () => UID,
      lookupUser: () => ({ uid: UID, gid: 4242, groups: [4242] }),
      checks: async () => failures as never,
      ...TEST_RUNTIME_DEPS,
      retryMs: 60_000,
    });
    const logged: string[] = [];
    const spy = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      },
    );
    try {
      const naming = (path: string) =>
        logged.filter((line) => line.includes(path)).length;
      for (let i = 0; i < 3; i++)
        expect(await connectMemberHost("u-alice")).toBe(false);
      const reason = memberHostRefusal("u-alice") ?? "";
      expect(reason).toContain("/code/a0.js");
      expect(reason).toContain("/code/a4.js");
      expect(reason).not.toContain("/code/a5.js");
      expect(reason).toContain("195");
      expect(naming("/code/a0.js")).toBe(1);
      expect(logged.some((line) => line.includes("/code/a5.js"))).toBe(false);
      // Another reason is logged, once.
      failures = many("b");
      for (let i = 0; i < 2; i++)
        expect(await connectMemberHost("u-alice")).toBe(false);
      expect(memberHostRefusal("u-alice")).toContain("/code/b0.js");
      expect(naming("/code/b0.js")).toBe(1);
      expect(naming("/code/a0.js")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("connects at boot and retries a runner that starts later", async () => {
    recordMemberOsUser("u-alice", { name: NAME, uid: UID });
    deps();
    await connectMemberHosts();
    expect(hostFor("u-alice")).not.toBeInstanceOf(RunnerAgentHost);
    startMemberRunner(memberRunnerSocketPath(NAME));
    const deadline = Date.now() + 3000;
    while (
      !(hostFor("u-alice") instanceof RunnerAgentHost) &&
      Date.now() < deadline
    )
      await Bun.sleep(25);
    expect(hostFor("u-alice")).toBeInstanceOf(RunnerAgentHost);
  });

  it("runs the real trusted checks at connect when none are injected", async () => {
    // The member uid is this process's uid, the office's: the default checks
    // must refuse it, which proves connect runs them.
    recordMemberOsUser("u-alice", { name: NAME, uid: UID });
    startMemberRunner(memberRunnerSocketPath(NAME));
    setMemberHostDeps({
      readPeerUid: () => UID,
      lookupUser: () => ({ uid: UID, gid: 4242, groups: [4242] }),
      ...TEST_RUNTIME_DEPS,
      retryMs: 60_000,
    });
    expect(await connectMemberHost("u-alice")).toBe(false);
    expect(hostFor("u-alice")).not.toBeInstanceOf(RunnerAgentHost);
  });
});

// Task e15a82e7: the connect asks the trusted checks to take a privileged
// group only for a record that says adopted AND rootCapable.
describe("the connect's checks for an existing OS user", () => {
  const NAME = "isomux-alice";
  let inputs: MemberCheckInput[];
  beforeEach(() => {
    inputs = [];
    setMemberHostDeps({
      readPeerUid: () => UID,
      lookupUser: () => ({ uid: UID, gid: 4242, groups: [4242] }),
      checks: (input: MemberCheckInput) => {
        inputs.push(input);
        return [];
      },
      ...TEST_RUNTIME_DEPS,
      retryMs: 60_000,
    });
    startMemberRunner(memberRunnerSocketPath(NAME));
  });
  const flag = () =>
    inputs.map((i) => (i as { rootCapable?: unknown }).rootCapable === true);

  it("passes rootCapable for an adopted, root-capable user only", async () => {
    recordMemberOsUser(
      "u-alice",
      { name: NAME, uid: UID },
      { adopted: true, rootCapable: true },
    );
    expect(await connectMemberHost("u-alice")).toBe(true);
    expect(flag()).toEqual([true]);
  });

  for (const [label, origin] of [
    ["a user the command made", {}],
    ["an adopted user that cannot become root", { adopted: true }],
  ] as const)
    it(`does not pass rootCapable for ${label}`, async () => {
      recordMemberOsUser("u-alice", { name: NAME, uid: UID }, origin);
      expect(await connectMemberHost("u-alice")).toBe(true);
      expect(flag()).toEqual([false]);
    });

  it("does not pass rootCapable for an entry that says rootCapable without adopted", async () => {
    writeFileSync(
      memberOsUsersPath(),
      JSON.stringify({
        "u-alice": { name: NAME, uid: UID, rootCapable: true },
      }),
    );
    reloadMemberOsUsers();
    await connectMemberHost("u-alice");
    // Either the entry is broken (no checks run) or the flag is off.
    expect(flag().filter(Boolean)).toEqual([]);
    if (inputs.length === 0)
      expect(hostFor("u-alice")).not.toBeInstanceOf(RunnerAgentHost);
  });
});

describe("memberTrustedChecks", () => {
  const OFFICE = 900;
  const MEMBER = { uid: 2001, gid: 2001, groups: [2001] };
  const DIR = (mode: number, uid = 0, gid = 0): FileFacts => ({
    uid,
    gid,
    mode,
    kind: "dir",
  });

  // A box where the member reaches nothing of the office: the home is 0700,
  // the code tree is root's and not writable by others.
  function clean(): {
    facts: Map<string, FileFacts>;
    acls: Map<string, AclEntry[]>;
    input: MemberCheckInput;
  } {
    const facts = new Map<string, FileFacts>([
      ["/", DIR(0o755)],
      ["/home", DIR(0o755)],
      ["/home/office", DIR(0o700, OFFICE, OFFICE)],
      ["/home/office/.isomux", DIR(0o700, OFFICE, OFFICE)],
      ["/opt", DIR(0o755)],
      ["/opt/isomux", DIR(0o755, OFFICE, OFFICE)],
      ["/opt/isomux/server", DIR(0o755, OFFICE, OFFICE)],
    ]);
    const acls = new Map<string, AclEntry[]>();
    const fs: FsProbe = {
      lstat: (path) => {
        const f = facts.get(path);
        if (!f)
          throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
        return f;
      },
      readlink: (path) => {
        throw Object.assign(new Error(`EINVAL ${path}`), { code: "EINVAL" });
      },
      readdir: (path) =>
        [...facts.keys()]
          .filter((p) => p !== path && dirname(p) === path)
          .map((p) => p.slice(path === "/" ? 1 : path.length + 1)),
      acl: (path, kind) =>
        kind === "access" ? (acls.get(path) ?? null) : null,
    };
    return {
      facts,
      acls,
      input: {
        officeUid: OFFICE,
        officeGroups: [OFFICE, 1500],
        member: MEMBER,
        privilegedGroups: [27, 999],
        officeHome: "/home/office",
        stateRoot: "/home/office/.isomux",
        codeRoot: "/opt/isomux",
        fs,
      } as MemberCheckInput,
    };
  }

  const named = (failures: { path?: string }[], path: string) =>
    failures.some((f) => f.path === path);

  it("passes a box where the member reaches nothing of the office", () => {
    expect(memberTrustedChecks(clean().input)).toEqual([]);
  });

  it("refuses root, the office uid, a shared group and a privileged group", () => {
    const { input } = clean();
    for (const member of [
      { ...MEMBER, uid: 0 },
      { ...MEMBER, uid: OFFICE },
      { ...MEMBER, groups: [2001, 1500] },
      { ...MEMBER, gid: OFFICE, groups: [OFFICE] },
      { ...MEMBER, groups: [2001, 27] },
    ]) {
      expect(memberTrustedChecks({ ...input, member }).length).toBeGreaterThan(
        0,
      );
    }
  });

  // Task e15a82e7: an adopted user that can become root (Nil, 2026-11-17:
  // accept it and warn on the page). Only the privileged-group check goes;
  // every other check stays.
  it("with rootCapable, takes a privileged group and still refuses root, the office uid, a shared group and search on the office home", () => {
    const { input } = clean();
    const capable = { ...input, rootCapable: true } as MemberCheckInput;
    const privileged = { ...MEMBER, groups: [2001, 27] };
    // The enabling condition: without the flag, the group is refused.
    expect(
      memberTrustedChecks({ ...input, member: privileged }).length,
    ).toBeGreaterThan(0);
    expect(memberTrustedChecks({ ...capable, member: privileged })).toEqual([]);
    for (const member of [
      { ...privileged, uid: 0 },
      { ...privileged, uid: OFFICE },
      { ...privileged, groups: [2001, 27, 1500] },
      { ...privileged, gid: OFFICE, groups: [OFFICE, 27] },
    ])
      expect([
        member,
        memberTrustedChecks({ ...capable, member }).length > 0,
      ]).toEqual([member, true]);
    const c = clean();
    c.facts.set("/home/office", DIR(0o701, OFFICE, OFFICE));
    expect(
      named(
        memberTrustedChecks({
          ...c.input,
          rootCapable: true,
          member: privileged,
        } as MemberCheckInput),
        "/home/office",
      ),
    ).toBe(true);
  });

  it("refuses search on the office home by other bits, by group and by a named ACL entry", () => {
    for (const change of [
      (c: ReturnType<typeof clean>) =>
        c.facts.set("/home/office", DIR(0o701, OFFICE, OFFICE)),
      (c: ReturnType<typeof clean>) =>
        c.facts.set("/home/office", DIR(0o710, OFFICE, MEMBER.gid)),
      (c: ReturnType<typeof clean>) =>
        c.acls.set("/home/office", [
          { tag: ACL_USER_OBJ, perm: 7, id: 0 },
          { tag: ACL_USER, perm: 1, id: MEMBER.uid },
          { tag: ACL_GROUP_OBJ, perm: 0, id: 0 },
          { tag: ACL_MASK, perm: 1, id: 0 },
          { tag: ACL_OTHER, perm: 0, id: 0 },
        ]),
    ]) {
      const c = clean();
      change(c);
      expect(named(memberTrustedChecks(c.input), "/home/office")).toBe(true);
    }
  });

  it("refuses write on the state root, the code tree and their ancestors", () => {
    const writable: [string, (c: ReturnType<typeof clean>) => void][] = [
      ["/opt", (c) => c.facts.set("/opt", DIR(0o777))],
      [
        "/opt/isomux",
        (c) => c.facts.set("/opt/isomux", DIR(0o775, OFFICE, MEMBER.gid)),
      ],
      [
        "/opt/isomux/server",
        (c) => c.facts.set("/opt/isomux/server", DIR(0o777, OFFICE, OFFICE)),
      ],
      // Two levels into the code tree: a dependency file left 0666.
      [
        "/opt/isomux/server/index.ts",
        (c) =>
          c.facts.set("/opt/isomux/server/index.ts", {
            uid: OFFICE,
            gid: OFFICE,
            mode: 0o666,
            kind: "file",
          }),
      ],
      [
        "/home/office/.isomux",
        (c) =>
          c.acls.set("/home/office/.isomux", [
            { tag: ACL_USER_OBJ, perm: 7, id: 0 },
            { tag: ACL_USER, perm: 7, id: MEMBER.uid },
            { tag: ACL_GROUP_OBJ, perm: 0, id: 0 },
            { tag: ACL_MASK, perm: 7, id: 0 },
            { tag: ACL_OTHER, perm: 0, id: 0 },
          ]),
      ],
    ];
    for (const [path, change] of writable) {
      const c = clean();
      change(c);
      expect(named(memberTrustedChecks(c.input), path)).toBe(true);
    }
  });

  it("refuses read or search on the state root, not only write", () => {
    const c = clean();
    c.acls.set("/home/office/.isomux", [
      { tag: ACL_USER_OBJ, perm: 7, id: 0 },
      { tag: ACL_USER, perm: 5, id: MEMBER.uid },
      { tag: ACL_GROUP_OBJ, perm: 0, id: 0 },
      { tag: ACL_MASK, perm: 5, id: 0 },
      { tag: ACL_OTHER, perm: 0, id: 0 },
    ]);
    expect(named(memberTrustedChecks(c.input), "/home/office/.isomux")).toBe(
      true,
    );
  });

  // Task 39ec1276: a code tree under the closed office home is out of the
  // member's reach, so its modes do not count.
  it("takes a writable code tree that is under the closed office home", () => {
    const build = (homeMode: number) => {
      const c = clean();
      c.facts.set("/home/office", DIR(homeMode, OFFICE, OFFICE));
      c.facts.set("/home/office/isomux", DIR(0o755, OFFICE, OFFICE));
      c.facts.set("/home/office/isomux/site", DIR(0o777, OFFICE, OFFICE));
      c.facts.set("/home/office/isomux/site/xterm.css", {
        uid: OFFICE,
        gid: OFFICE,
        mode: 0o666,
        kind: "file",
      });
      return { ...c.input, codeRoot: "/home/office/isomux" };
    };
    expect(memberTrustedChecks(build(0o700))).toEqual([]);
    // The home opened for search: the home and the tree below it count.
    const open = memberTrustedChecks(build(0o701));
    for (const path of [
      "/home/office",
      "/home/office/isomux/site",
      "/home/office/isomux/site/xterm.css",
    ])
      expect([path, named(open, path)]).toEqual([path, true]);
  });

  it("fails closed on a path it cannot read", () => {
    const c = clean();
    c.facts.delete("/opt/isomux");
    expect(memberTrustedChecks(c.input).length).toBeGreaterThan(0);
    const d = clean();
    const probe = d.input.fs as FsProbe;
    d.input = {
      ...d.input,
      fs: {
        ...probe,
        acl: (path, kind) => {
          if (path === "/home/office") throw new Error("EIO");
          return probe.acl(path, kind);
        },
      },
    } as MemberCheckInput;
    expect(memberTrustedChecks(d.input).length).toBeGreaterThan(0);
  });
});

describe("the code walk of the connect", () => {
  // A real tree on disk, walked by the child process the connect uses. This
  // box's /tmp is writable by every user, so the ancestors fail too; the
  // property here is that a file deep in the tree is named, and that the
  // verdict is kept per member identity until reset.
  it("names a file the member can write deep in the tree, and keeps the verdict", async () => {
    const code = join(dir, "code");
    const deep = join(code, "node_modules", "dep", "index.js");
    // The member reaches the tree by name: the checks count only what it
    // can reach (task 39ec1276).
    chmodSync(dir, 0o755);
    mkdirSync(dirname(deep), { recursive: true, mode: 0o755 });
    writeFileSync(deep, "x");
    chmodSync(deep, 0o666);
    const input = {
      officeUid: UID,
      officeGroups: [],
      member: { uid: 2001, gid: 2001, groups: [2001] },
      privilegedGroups: [],
      officeHome: dir,
      stateRoot: dir,
      codeRoot: code,
    } as MemberCheckInput;
    const first = await memberCodeTreeChecks(input);
    expect(first.some((f) => f.path === deep)).toBe(true);
    // Fixed on disk: the kept verdict still names it, until a reset.
    chmodSync(deep, 0o644);
    const kept = await memberCodeTreeChecks(input);
    expect(kept.some((f) => f.path === deep)).toBe(true);
    resetMemberHosts();
    const fresh = await memberCodeTreeChecks(input);
    expect(fresh.some((f) => f.path === deep)).toBe(false);
    // Another identity is walked on its own.
    chmodSync(deep, 0o666);
    const other = await memberCodeTreeChecks({
      ...input,
      member: { uid: 2002, gid: 2002, groups: [2002] },
    });
    expect(other.some((f) => f.path === deep)).toBe(true);
  }, 30_000);

  // A stand-in for the child, through the codeCheck seam.
  function codeInput(): MemberCheckInput {
    return {
      officeUid: UID,
      officeGroups: [],
      member: { uid: 2001, gid: 2001, groups: [2001] },
      privilegedGroups: [],
      officeHome: dir,
      stateRoot: dir,
      codeRoot: join(dir, "code-standin"),
    } as MemberCheckInput;
  }
  const clean = ["sh", "-c", "cat > /dev/null; echo '[]'"];
  function useChild(command: string[], timeoutMs = 300): void {
    setMemberHostDeps({ codeCheck: { command, timeoutMs } });
  }

  it("fails closed on a child that never answers, ends it, and does not keep that", async () => {
    const pidFile = join(dir, "child.pid");
    useChild(["sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`]);
    const started = Date.now();
    const hung = await memberCodeTreeChecks(codeInput());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(hung.length).toBeGreaterThan(0);
    const pid = Number(await Bun.file(pidFile).text());
    const deadline = Date.now() + 2000;
    while (existsSync(`/proc/${pid}`) && Date.now() < deadline)
      await Bun.sleep(25);
    expect(existsSync(`/proc/${pid}`)).toBe(false);
    // Not kept: the next connect asks again, and a clean answer is kept.
    useChild(clean);
    expect(await memberCodeTreeChecks(codeInput())).toEqual([]);
    useChild(["sh", "-c", "exit 1"]);
    expect(await memberCodeTreeChecks(codeInput())).toEqual([]);
  }, 15_000);

  it("fails closed and keeps nothing when the child cannot start, crashes or answers no list", async () => {
    for (const bad of [
      ["/nonexistent/isomux-code-check"],
      // An argv spawn refuses before it starts (a synchronous throw).
      [""],
      ["sh", "-c", "cat > /dev/null; exit 3"],
      ["sh", "-c", "cat > /dev/null; echo not-json"],
      ["sh", "-c", "cat > /dev/null; echo '{}'"],
    ]) {
      resetMemberHosts();
      useChild(bad, 5000);
      const answer = await memberCodeTreeChecks(codeInput());
      expect({ bad, failed: answer.length > 0 }).toEqual({ bad, failed: true });
      useChild(clean, 5000);
      expect({ bad, next: await memberCodeTreeChecks(codeInput()) }).toEqual({
        bad,
        next: [],
      });
    }
  }, 30_000);
});

// Keep the record path inside the test state root (never the office's).
it("the record lives under the test state root", () => {
  expect(memberOsUsersPath().startsWith(STATE_ROOT)).toBe(true);
  expect(officeAgentHost()).toBe(localAgentHost);
});
