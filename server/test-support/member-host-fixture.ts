// An isolated member for tests (internal-docs/member-os-user-design.md, slice
// 1a): an entry in the record and a recording stand-in for their runner host,
// registered through the real connectMemberHost path. The stand-in runs
// nothing as the member: process calls are recorded and answered with a
// failing local child; file calls go to the local file system so a session
// can start. Every process call is recorded with its argv and env, and the
// office host is wrapped the same way, so a test can assert both where a call
// went and what it carried.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  localAgentFs,
  localAgentHost,
  officeAgentHost,
  setOfficeAgentHost,
  type AgentHost,
} from "../agent-host.ts";
import {
  connectMemberHost,
  resetMemberHosts,
  setMemberHostDeps,
} from "../member-hosts.ts";
import { forgetMemberOsUser, recordMemberOsUser } from "../member-os-users.ts";

export interface HostCall {
  op: string;
  argv: string[];
  env: Record<string | symbol, string | undefined> | undefined;
  // The JSON written to the stdin of a spawnPipe (the terminal sidecar's
  // start message carries the shell's env).
  stdin: string[];
}

export interface RecordingHost {
  host: AgentHost & { readonly member?: string };
  calls: HostCall[];
  // Process calls only: spawnPipe, spawnChild, run, runEntry, isomuxDiff.
  processCalls(): HostCall[];
}

const PROCESS_OPS = new Set([
  "spawnPipe",
  "spawnChild",
  "run",
  "runEntry",
  "isomuxDiff",
]);

function recording(
  base: AgentHost,
  shape: {
    kind: "local" | "runner";
    member?: string;
    baseEnv?: Record<string, string | undefined>;
    home?: string;
    username?: string;
  },
): RecordingHost {
  const calls: HostCall[] = [];
  const record = (
    op: string,
    argv: string[],
    env?: Record<string, string | undefined>,
  ): HostCall => {
    const call: HostCall = { op, argv, env, stdin: [] };
    calls.push(call);
    return call;
  };
  const host = {
    kind: shape.kind,
    member: shape.member,
    baseEnv: () => shape.baseEnv ?? base.baseEnv(),
    home: () => shape.home ?? base.home(),
    username: () => shape.username ?? base.username(),
    bunPath: () => base.bunPath(),
    spawnPipe: (argv: string[]) => {
      const call = record("spawnPipe", argv);
      const proc = localAgentHost.spawnPipe(["false"]);
      return {
        get pid() {
          return proc.pid;
        },
        stdin: {
          write: (data: string | Uint8Array) => {
            call.stdin.push(
              typeof data === "string" ? data : Buffer.from(data).toString(),
            );
            return 0;
          },
          end: () => undefined,
        },
        stdout: proc.stdout,
        exited: proc.exited,
        kill: (signal?: NodeJS.Signals) => proc.kill(signal),
      };
    },
    spawnChild: (
      argv: string[],
      options: { env?: Record<string, string | undefined> } = {},
    ) => {
      record("spawnChild", argv, options.env);
      return localAgentHost.spawnChild(["false"]);
    },
    run: async (
      argv: string[],
      options: { env?: Record<string, string | undefined> } = {},
    ) => {
      record("run", argv, options.env);
      return { exitCode: 1, stdout: "", stderr: "recording host" };
    },
    fs: localAgentFs,
    isomuxDiff: async (req: { agentCwd: string; dir?: string }) => {
      record("isomuxDiff", [req.dir ?? req.agentCwd]);
      return { kind: "clean", cwd: req.dir ?? req.agentCwd } as never;
    },
    runEntry: async (name: string) => {
      record("runEntry", [name]);
      throw new Error("recording host runs no entries");
    },
  } as unknown as AgentHost & { readonly member?: string };
  return {
    host,
    calls,
    processCalls: () => calls.filter((c) => PROCESS_OPS.has(c.op)),
  };
}

export interface IsolatedMember {
  userId: string;
  home: string;
  member: RecordingHost;
  office: RecordingHost;
  // Undo: the record entry, the hosts, the office host.
  dispose(): void;
}

// Makes `userId` an isolated member whose runner is the recording stand-in,
// and wraps the office host in a recorder. The member's base env holds only
// what a runner reports: no value of this process's env but PATH.
export async function isolateMember(userId: string): Promise<IsolatedMember> {
  const home = mkdtempSync(join(tmpdir(), "member-home-"));
  const previousOffice = officeAgentHost();
  const office = recording(previousOffice, { kind: previousOffice.kind });
  setOfficeAgentHost(office.host);
  const member = recording(localAgentHost, {
    kind: "runner",
    member: userId,
    baseEnv: {
      PATH: process.env.PATH,
      HOME: home,
      USER: "isomux-test-member",
      SHELL: "/bin/sh",
    },
    home,
    username: "isomux-test-member",
  });
  const uid = process.getuid!();
  recordMemberOsUser(userId, { name: "isomux-test-member", uid });
  setMemberHostDeps({
    readPeerUid: () => uid,
    lookupUser: () => ({ uid, gid: 4242, groups: [4242] }),
    checks: () => [],
    connectRunner: async () => member.host,
    retryMs: 60_000,
  } as Parameters<typeof setMemberHostDeps>[0]);
  if (!(await connectMemberHost(userId)))
    throw new Error("the recording member host did not connect");
  return {
    userId,
    home,
    member,
    office,
    dispose() {
      resetMemberHosts();
      setMemberHostDeps(null);
      forgetMemberOsUser(userId);
      setOfficeAgentHost(previousOffice);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// Every string a call carried: argv, env values and stdin, for a canary scan.
export function carried(calls: HostCall[]): string {
  return calls
    .map((c) =>
      [...c.argv, ...Object.values(c.env ?? {}).map(String), ...c.stdin].join(
        "\n",
      ),
    )
    .join("\n");
}
