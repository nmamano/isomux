// Each backup copy also holds every isolated member's agent space
// (internal-docs/member-os-user-design.md, slice 3c; member-backup.ts). The
// properties, through the office's backup run:
// - the copy's top level is the state root, members/, the manifest and the
//   marker, and her bytes count in the copy's totals;
// - nothing of a member fails the office's copy: a runner that is not
//   ready, a stream that breaks, a copy that does not fit (D1), a part that
//   throws;
// - the marker and the status name every member not copied in the run;
// - her space survives the retention while she is not copied (E1).
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentHost } from "./agent-host.ts";
import {
  backupStatusForTest,
  runBackupOnceForTest,
  setBackupMemberSources,
  type BackupDeps,
} from "./backup.ts";
import {
  listSpace,
  sendSpaceFiles,
  type SpaceFilesInput,
} from "./member-backup-send.ts";
import type { MemberBackupSource } from "./member-backup.ts";

const roots: string[] = [];
afterEach(() => {
  setBackupMemberSources(null);
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const BASE = Date.UTC(2026, 7, 13, 12);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-members-"));
  roots.push(root);
  const state = path.join(root, ".isomux");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "state.txt"), "state");
  const space = path.join(root, "alice-space");
  fs.mkdirSync(path.join(space, "provider-homes/u1/claude"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(space, "provider-homes/u1/claude/s.jsonl"),
    "HERS",
  );
  return { root, state, space, backupDir: path.join(root, "backups") };
}
type Fixture = ReturnType<typeof fixture>;

function config(f: Fixture, over: object = {}) {
  return {
    backupDir: f.backupDir,
    stateRootParent: f.root,
    stateRootName: ".isomux",
    retention: 7,
    minHeadroomBytes: 10,
    ...over,
  };
}

function clock(start = BASE) {
  let t = start - 1000;
  return () => (t += 1000);
}
const deps = (extra: Partial<BackupDeps> = {}): BackupDeps => ({
  now: clock(),
  availableBytes: () => 1e12,
  ...extra,
});

// Her runner's side, in process, over her real space.
function treeHost(space: string): AgentHost {
  return {
    agentRoot: () => space,
    runEntryOut: (name: string, input: unknown) => {
      const out: Buffer[] = [];
      const write = (chunk: Uint8Array) => {
        out.push(Buffer.from(chunk));
      };
      return (async function* () {
        if (name === "backup-list")
          await listSpace(input as { agentRoot: string }, write);
        else await sendSpaceFiles(input as SpaceFilesInput, write);
        yield* out;
      })();
    },
  } as unknown as AgentHost;
}
// A runner whose listing breaks after one line.
const breakingHost = {
  agentRoot: () => "/s",
  runEntryOut: () =>
    (async function* () {
      yield Buffer.from('{"p":"a","k":"d"');
      throw new Error("the runner went away");
    })(),
} as unknown as AgentHost;

const member = (
  userId: string,
  host: AgentHost | null,
): MemberBackupSource => ({
  userId,
  osUser: { name: `isomux-${userId}`, uid: 5000 },
  host,
});
function sources(list: () => MemberBackupSource[]) {
  setBackupMemberSources({
    list,
    name: (userId) => `Name of ${userId}`,
  });
}

const read = (file: string) => fs.readFileSync(file, "utf8");
const markerOf = (f: Fixture, name: string) =>
  JSON.parse(read(path.join(f.backupDir, name, "backup.json"))) as {
    files: number;
    membersSkipped?: string[];
  };
const memberOf = (f: Fixture, name: string, userId: string) =>
  JSON.parse(
    read(path.join(f.backupDir, name, "members", userId, "member.json")),
  ) as {
    state: string;
    carriedFrom?: string;
  };

describe("a backup with isolated members", () => {
  it("holds her space beside the state root, and counts her files", async () => {
    const f = fixture();
    sources(() => [member("alice", treeHost(f.space))]);
    const name = await runBackupOnceForTest(config(f), deps());
    const copy = path.join(f.backupDir, name);
    expect({
      top: fs.readdirSync(copy).sort(),
      hers: read(
        path.join(copy, "members/alice/space/provider-homes/u1/claude/s.jsonl"),
      ),
      inState: fs.existsSync(path.join(copy, ".isomux", "members")),
      files: markerOf(f, name).files,
      skipped: markerOf(f, name).membersSkipped,
    }).toEqual({
      top: [".isomux", "backup.json", "manifest.jsonl.gz", "members"],
      hers: "HERS",
      inState: false,
      files: 2,
      skipped: undefined,
    });
  });

  it("publishes the office's copy whatever her part does, and names who was not copied", async () => {
    const f = fixture();
    sources(() => [
      member("alice", treeHost(f.space)),
      member("bob", null),
      member("carol", breakingHost),
    ]);
    const name = await runBackupOnceForTest(config(f), deps());
    expect({
      office: read(path.join(f.backupDir, name, ".isomux", "state.txt")),
      states: ["alice", "bob", "carol"].map(
        (id) => memberOf(f, name, id).state,
      ),
      marker: markerOf(f, name).membersSkipped,
      status: backupStatusForTest(config(f), BASE + 60_000).membersSkipped,
    }).toEqual({
      office: "state",
      states: ["copied", "skipped", "skipped"],
      marker: ["bob", "carol"],
      status: ["Name of bob", "Name of carol"],
    });
  });

  // D1: the office's copy is checked alone, then her copy on its own.
  it("skips her when her copy does not fit, and the office's copy is made", async () => {
    const f = fixture();
    // Her copy needs more than the free space; the office's does not.
    fs.writeFileSync(path.join(f.space, "big.bin"), Buffer.alloc(2e6));
    sources(() => [member("alice", treeHost(f.space))]);
    const name = await runBackupOnceForTest(
      config(f),
      deps({ availableBytes: () => 1e6 }),
    );
    expect([
      read(path.join(f.backupDir, name, ".isomux", "state.txt")),
      memberOf(f, name, "alice").state,
      markerOf(f, name).membersSkipped,
    ]).toEqual(["state", "skipped", ["alice"]]);
  });

  it("publishes the office's copy when her part throws", async () => {
    const f = fixture();
    // The same member twice: her folder exists at the second.
    sources(() => [member("alice", treeHost(f.space)), member("alice", null)]);
    const name = await runBackupOnceForTest(config(f), deps());
    expect(read(path.join(f.backupDir, name, ".isomux", "state.txt"))).toBe(
      "state",
    );
  });

  it("keeps her space through the retention while she is not copied (E1)", async () => {
    const f = fixture();
    let host: AgentHost | null = treeHost(f.space);
    sources(() => [member("alice", host)]);
    const cfg = config(f, { retention: 2 });
    const now = clock();
    const first = await runBackupOnceForTest(cfg, deps({ now }));
    host = null;
    await runBackupOnceForTest(cfg, deps({ now }));
    const third = await runBackupOnceForTest(cfg, deps({ now }));
    const listed = fs
      .readdirSync(f.backupDir)
      .filter((n) => n.startsWith("isomux-"));
    expect({
      first: listed.includes(first),
      hers: read(
        path.join(
          f.backupDir,
          third,
          "members/alice/space/provider-homes/u1/claude/s.jsonl",
        ),
      ),
      marker: memberOf(f, third, "alice"),
      skipped: markerOf(f, third).membersSkipped,
    }).toEqual({
      first: false,
      hers: "HERS",
      marker: expect.objectContaining({ state: "carried", carriedFrom: first }),
      skipped: ["alice"],
    });
  });
});
