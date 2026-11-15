// The member file move on enable (server/member-move.ts, office side, and
// server/member-move-receive.ts, the runner side run in process here;
// internal-docs/member-os-user-design.md 2.2; slice 1c-ii-a of task
// b94dfd25). The plan is made from the office's paths before the member is
// isolated, and staged after, as go-on does. The properties: a link, a hard
// link, a linked folder, a FIFO, an oversize file or a file swapped after
// the walk never carries content across, and each skip names its path; the
// total cap stops the move before the runner gets a byte; a Claude session
// is taken by exact id from the pinned root first, with its <id>/ folder,
// and its new pin is where it lands; a session in the personal home moves
// with that tree; a Codex rollout lands at the same path in the member's
// Codex home, and one whose dest is outside the member's home is skipped;
// the office copies of what moved are deleted, and nothing that did not move
// is deleted; a connect while an office copy is left names it.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import type { AgentHost } from "../agent-host.ts";
import {
  planMemberMove,
  setMemberMoveDeps,
  stageMemberMove,
  type MemberMoveAgent,
} from "../member-move.ts";
import {
  doneFiles,
  placeFiles,
  receiveFiles,
  undoFiles,
  type MoveInInput,
  type MoveStepInput,
} from "../member-move-receive.ts";
import {
  clearMemberMoving,
  connectMemberHost,
  forgetMemberHost,
  hostFor,
  markMemberMoving,
  memberMoveHost,
} from "../member-hosts.ts";
import { setMemberMoveWiring } from "../member-user-admin.ts";
import { officePersonalProviderHome } from "../provider-homes.ts";
import { claudeConfigRoot } from "../claude-session-root.ts";
import { buildOfficeEnv } from "../env-loader.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { ISOMUX_CODEX_HOME } from "../backends/codex/native-bin.ts";
import { setSessionClaudeConfigDir } from "../persistence.ts";
import { createMember, deleteUserById } from "../users.ts";
import { removeManagedUserEnv, writeManagedUserEnv } from "../user-env.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";

const SESSION = "5e551011-aaaa-4bbb-8ccc-0123456789ab";
const THREAD = "019e0000-1111-7222-8333-444455556666";
const CWD = "/tmp/member-move-cwd";

let alice: string;
let iso: IsolatedMember | null;
let outside: string;
let logs: string[];
const created: string[] = [];
const scratch: string[] = [];

beforeEach(() => {
  iso = null;
  outside = mkdtempSync(join(tmpdir(), "member-move-outside-"));
  writeFileSync(join(outside, "secret"), "OFFICE-ONLY");
  const made = createMember(`MoveAlice${created.length}`, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  alice = made.user.id;
  created.push(alice);
  logs = [];
  setMemberMoveDeps({ log: (line) => logs.push(line) });
  // A file that booted the production office before this one leaves the
  // connect check set.
  setMemberMoveWiring(null);
});

afterEach(() => {
  setMemberMoveDeps(null);
  setMemberMoveWiring(null);
  clearMemberMoving(alice);
  iso?.dispose();
  rmSync(join(officePersonalProviderHome(alice, "claude"), ".."), {
    recursive: true,
    force: true,
  });
  for (const p of scratch.splice(0))
    rmSync(p, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  for (const id of created.splice(0)) {
    removeManagedUserEnv(id);
    deleteUserById(id);
  }
});

const home = () => iso!.home;
const agentRoot = () => join(iso!.home, ".isomux-agent");

// The member's runner, in process: the entries call the receive side.
function runnerHost(): AgentHost {
  const steps: Record<string, (input: MoveStepInput) => unknown> = {
    "files-place": placeFiles,
    "files-undo": undoFiles,
    "files-done": doneFiles,
  };
  return {
    home: () => home(),
    agentRoot: () => agentRoot(),
    runEntry: async (name: string, input: unknown) =>
      steps[name](input as MoveStepInput),
    runEntryStream: (
      _name: string,
      input: unknown,
      body: AsyncIterable<Uint8Array>,
    ) => receiveFiles(input as MoveInInput, body, { freeBytes: () => 2 ** 50 }),
  } as unknown as AgentHost;
}

// go-on's order: plan from the office's paths, isolate, mark moving, stage.
async function move(agents: MemberMoveAgent[] = [], before?: () => void) {
  const plan = planMemberMove(alice, agents);
  iso = await isolateMember(alice);
  before?.();
  markMemberMoving(alice);
  return stageMemberMove(plan, runnerHost());
}

// Every file in the member's home but the staging, by path from home.
function landed(): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(home(), {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(e.parentPath, e.name);
    const rel = relative(home(), path);
    if (e.isFile() && !rel.startsWith(".isomux-agent/.move-in"))
      out.set(rel, readFileSync(path, "utf8"));
  }
  return out;
}

const officeHome = () => officePersonalProviderHome(alice, "claude");
const landedHome = (rel: string) =>
  join(".isomux-agent", "provider-homes", alice, "claude", rel);
const skipped = (path: string) =>
  logs.filter((l) => l.includes(alice) && l.includes(path));

describe("the M1 read side, over the member's personal home", () => {
  beforeEach(() => {
    mkdirSync(join(officeHome(), "sub"), { recursive: true });
    writeFileSync(join(officeHome(), "sub", "kept.txt"), "MINE");
  });

  it("carries a plain file in a plain folder", async () => {
    await move();
    expect(landed().get(landedHome("sub/kept.txt"))).toBe("MINE");
    expect(logs).toEqual([]);
  });

  it("skips a link, a hard link and a linked folder to office files, and names each", async () => {
    symlinkSync(join(outside, "secret"), join(officeHome(), "link"));
    linkSync(join(outside, "secret"), join(officeHome(), "hard"));
    // A folder whose file has one link: only the walk's lstat keeps it out.
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "inner"), "OFFICE-ONLY");
    symlinkSync(join(outside, "dir"), join(officeHome(), "dirlink"));
    await move();
    const got = landed();
    expect([...got.values()].filter((v) => v === "OFFICE-ONLY")).toEqual([]);
    expect(got.get(landedHome("sub/kept.txt"))).toBe("MINE");
    for (const name of ["link", "hard", "dirlink"])
      expect([name, skipped(join(officeHome(), name)).length]).toEqual([
        name,
        1,
      ]);
  });

  it("skips a FIFO without blocking on it", async () => {
    const fifo = join(officeHome(), "fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    await move();
    expect(landed().get(landedHome("sub/kept.txt"))).toBe("MINE");
    expect(skipped(fifo)).toHaveLength(1);
  }, 5000);

  it("skips a file whose size changed between the walk and the open, and keeps the office copy", async () => {
    const target = join(officeHome(), "sub", "kept.txt");
    setMemberMoveDeps({
      log: (line) => logs.push(line),
      // The same inode, one byte longer: an append.
      afterWalkBeforeOpen: (path) => {
        if (path === target) writeFileSync(target, "MINE!");
      },
    });
    const staged = await move();
    expect(landed().has(landedHome("sub/kept.txt"))).toBe(false);
    expect(skipped(target)).toHaveLength(1);
    staged.deleteOfficeCopies();
    expect(readFileSync(target, "utf8")).toBe("MINE!");
  });

  it("skips a file over the file bound", async () => {
    writeFileSync(join(officeHome(), "big"), "x".repeat(64));
    setMemberMoveDeps({ fileMax: 32, log: (line) => logs.push(line) });
    await move();
    expect(landed().has(landedHome("big"))).toBe(false);
    expect(landed().get(landedHome("sub/kept.txt"))).toBe("MINE");
    expect(skipped(join(officeHome(), "big"))).toHaveLength(1);
  });

  it("skips a file replaced by another between the walk and the open", async () => {
    const target = join(officeHome(), "sub", "kept.txt");
    let swapped = 0;
    setMemberMoveDeps({
      log: (line) => logs.push(line),
      afterWalkBeforeOpen: (path) => {
        if (path !== target) return;
        swapped++;
        // A new inode at the same path; the parent stays a real folder, so
        // only the ino check sees it.
        writeFileSync(`${target}.new`, "EVIL");
        renameSync(`${target}.new`, target);
      },
    });
    await move();
    expect(swapped).toBe(1);
    // Same size as the walked file: only the ino check can tell.
    expect(landed().has(landedHome("sub/kept.txt"))).toBe(false);
    expect(skipped(target)).toHaveLength(1);
  });

  it("skips a file whose parent folder became a link between the walk and the open", async () => {
    const sub = join(officeHome(), "sub");
    const target = join(sub, "kept.txt");
    // Same size as the walked file.
    writeFileSync(join(outside, "kept.txt"), "EVIL");
    let swapped = 0;
    setMemberMoveDeps({
      log: (line) => logs.push(line),
      afterWalkBeforeOpen: (path) => {
        if (path !== target) return;
        swapped++;
        renameSync(sub, `${sub}.gone`);
        symlinkSync(outside, sub);
      },
    });
    await move();
    expect(swapped).toBe(1);
    expect([...landed().values()]).not.toContain("EVIL");
    expect(skipped(target)).toHaveLength(1);
  });

  it("stops over the total cap before the runner gets a byte", async () => {
    writeFileSync(join(officeHome(), "a"), "x".repeat(40));
    setMemberMoveDeps({ totalMax: 16, log: (line) => logs.push(line) });
    expect(
      await move().then(
        () => "moved",
        () => "stopped",
      ),
    ).toBe("stopped");
    expect(existsSync(join(agentRoot(), ".move-in"))).toBe(false);
    expect(
      [...landed().keys()].filter((k) => k.includes("provider-homes")),
    ).toEqual([]);
  });
});

describe("a Claude session of the member", () => {
  // A fresh agent per test: a pin written by one test stays in the store.
  let agentId = "";
  beforeEach(() => {
    agentId = `agent-${crypto.randomUUID()}`;
    // A sessions-map entry with no pin.
    setSessionClaudeConfigDir(agentId, SESSION, null);
  });
  const agents = (): MemberMoveAgent[] => [
    { id: agentId, agentType: "claude", cwd: CWD },
  ];
  const officeRoot = () => resolve(claudeConfigRoot(buildOfficeEnv()));
  const projectDir = (root: string) =>
    claudeProjectDir(CWD, { CLAUDE_CONFIG_DIR: root });
  const file = (root: string) => join(projectDir(root), `${SESSION}.jsonl`);
  const folder = (root: string) => join(projectDir(root), SESSION);
  const put = (root: string, text: string) => {
    mkdirSync(projectDir(root), { recursive: true });
    writeFileSync(file(root), text);
    scratch.push(file(root), folder(root));
  };
  const memberRoot = () => join(home(), ".claude");

  it("moves the transcript from the office root with its <id>/ folder, and pins where it lands", async () => {
    put(officeRoot(), "TRANSCRIPT");
    mkdirSync(join(folder(officeRoot()), "tool-results"), { recursive: true });
    writeFileSync(
      join(folder(officeRoot()), "tool-results", "r.txt"),
      "RESULT",
    );
    symlinkSync(
      join(outside, "secret"),
      join(folder(officeRoot()), "tool-results", "leak"),
    );
    const staged = await move(agents());
    expect(readFileSync(file(memberRoot()), "utf8")).toBe("TRANSCRIPT");
    expect(
      readFileSync(join(folder(memberRoot()), "tool-results", "r.txt"), "utf8"),
    ).toBe("RESULT");
    expect(existsSync(join(folder(memberRoot()), "tool-results", "leak"))).toBe(
      false,
    );
    expect(
      skipped(join(folder(officeRoot()), "tool-results", "leak")),
    ).toHaveLength(1);
    expect(staged.pins).toEqual([
      { agentId, sessionId: SESSION, root: memberRoot() },
    ]);
  });

  it("takes the session from the pinned root first", async () => {
    const pinned = mkdtempSync(join(tmpdir(), "member-move-pin-"));
    scratch.push(pinned);
    put(pinned, "PINNED");
    put(officeRoot(), "OFFICE");
    setSessionClaudeConfigDir(agentId, SESSION, pinned);
    await move(agents());
    expect(readFileSync(file(memberRoot()), "utf8")).toBe("PINNED");
  });

  it("moves a session in the personal home with that tree, and pins the personal home in the agent space", async () => {
    put(officeHome(), "IN-HOME");
    const staged = await move(agents());
    const personal = join(agentRoot(), "provider-homes", alice, "claude");
    expect(readFileSync(file(personal), "utf8")).toBe("IN-HOME");
    expect(existsSync(file(memberRoot()))).toBe(false);
    expect(staged.pins).toEqual([
      { agentId, sessionId: SESSION, root: personal },
    ]);
  });

  it("skips a session whose project folder is a link, and deletes nothing through it", async () => {
    rmSync(projectDir(officeRoot()), { recursive: true, force: true });
    mkdirSync(join(projectDir(officeRoot()), ".."), { recursive: true });
    mkdirSync(join(outside, "proj", SESSION), { recursive: true });
    writeFileSync(join(outside, "proj", `${SESSION}.jsonl`), "OFFICE-ONLY");
    writeFileSync(join(outside, "proj", SESSION, "r.txt"), "OFFICE-ONLY");
    symlinkSync(join(outside, "proj"), projectDir(officeRoot()));
    scratch.push(projectDir(officeRoot()));
    const staged = await move(agents());
    expect([...landed().values()]).not.toContain("OFFICE-ONLY");
    expect(skipped(file(officeRoot()))).not.toEqual([]);
    // No pin for a session whose transcript did not move.
    expect(staged.pins).toEqual([]);
    staged.deleteOfficeCopies();
    expect(
      readFileSync(join(outside, "proj", `${SESSION}.jsonl`), "utf8"),
    ).toBe("OFFICE-ONLY");
    expect(readFileSync(join(outside, "proj", SESSION, "r.txt"), "utf8")).toBe(
      "OFFICE-ONLY",
    );
  });

  it("deletes the office copies of what moved, without following a link inside them", async () => {
    put(officeRoot(), "TRANSCRIPT");
    mkdirSync(folder(officeRoot()), { recursive: true });
    symlinkSync(outside, join(folder(officeRoot()), "out"));
    mkdirSync(officeHome(), { recursive: true });
    symlinkSync(outside, join(officeHome(), "out"));
    writeFileSync(join(officeHome(), "kept.txt"), "MINE");
    const staged = await move(agents());
    staged.deleteOfficeCopies();
    expect(existsSync(file(officeRoot()))).toBe(false);
    expect(existsSync(folder(officeRoot()))).toBe(false);
    expect(existsSync(join(officeHome(), "kept.txt"))).toBe(false);
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("OFFICE-ONLY");
  });
});

describe("what the move keeps in the office", () => {
  it("keeps a file of the personal home that did not move", async () => {
    mkdirSync(officeHome(), { recursive: true });
    writeFileSync(join(officeHome(), "big"), "x".repeat(64));
    writeFileSync(join(officeHome(), "small"), "y");
    setMemberMoveDeps({ fileMax: 32, log: (line) => logs.push(line) });
    const staged = await move();
    staged.deleteOfficeCopies();
    expect(existsSync(join(officeHome(), "small"))).toBe(false);
    expect(readFileSync(join(officeHome(), "big"), "utf8")).toBe(
      "x".repeat(64),
    );
  });
});

describe("a Codex session of the member", () => {
  let agentId = "";
  beforeEach(() => {
    agentId = `agent-${crypto.randomUUID()}`;
    setSessionClaudeConfigDir(agentId, THREAD, null);
  });
  const agents = (): MemberMoveAgent[] => [
    { id: agentId, agentType: "codex", cwd: CWD },
  ];
  const rollout = (codexHome: string) =>
    join(
      codexHome,
      "sessions",
      "2026",
      "11",
      "15",
      `rollout-2026-11-15T10-00-00-${THREAD}.jsonl`,
    );
  const putRollout = () => {
    mkdirSync(join(rollout(ISOMUX_CODEX_HOME), ".."), { recursive: true });
    writeFileSync(rollout(ISOMUX_CODEX_HOME), "ROLLOUT");
    scratch.push(rollout(ISOMUX_CODEX_HOME));
  };

  it("moves the rollout from the office Codex home to the same path in the member's", async () => {
    putRollout();
    await move(agents());
    expect(readFileSync(rollout(join(agentRoot(), "codex-home")), "utf8")).toBe(
      "ROLLOUT",
    );
  });

  it("skips a rollout whose dest is outside the member's home, and moves the rest", async () => {
    putRollout();
    mkdirSync(officeHome(), { recursive: true });
    writeFileSync(join(officeHome(), "kept.txt"), "MINE");
    const elsewhere = mkdtempSync(join(tmpdir(), "member-move-codex-"));
    scratch.push(elsewhere);
    await move(agents(), () =>
      writeManagedUserEnv(alice, { CODEX_HOME: elsewhere }),
    );
    expect(existsSync(rollout(elsewhere))).toBe(false);
    expect(landed().get(landedHome("kept.txt"))).toBe("MINE");
    expect(skipped(rollout(ISOMUX_CODEX_HOME))).toHaveLength(1);
  });
});

describe("a move that a server stop cut", () => {
  it("is named in the log at the member's connect while the office copy is there, and not otherwise", async () => {
    iso = await isolateMember(alice);
    setMemberMoveWiring({
      holdMember: async () => {},
      releaseMember: () => {},
      memberAgents: () => [],
    });
    forgetMemberHost(alice);
    expect(await connectMemberHost(alice)).toBe(true);
    expect(logs.filter((l) => l.includes(alice))).toEqual([]);

    mkdirSync(officeHome(), { recursive: true });
    writeFileSync(join(officeHome(), "left.txt"), "x");
    forgetMemberHost(alice);
    expect(await connectMemberHost(alice)).toBe(true);
    expect(logs.filter((l) => l.includes(alice))).toHaveLength(1);
  });

  const connectWith = async (agents: MemberMoveAgent[]) => {
    setMemberMoveWiring({
      holdMember: async () => {},
      releaseMember: () => {},
      memberAgents: () => agents,
    });
    forgetMemberHost(alice);
    expect(await connectMemberHost(alice)).toBe(true);
    return logs.filter((l) => l.includes(alice));
  };

  it("is not named for an office copy that a move would skip", async () => {
    iso = await isolateMember(alice);
    mkdirSync(officeHome(), { recursive: true });
    writeFileSync(join(officeHome(), "big"), "x".repeat(64));
    // The enabling condition: the same file under the bound is named.
    expect(await connectWith([])).toHaveLength(1);
    logs.length = 0;
    setMemberMoveDeps({ fileMax: 32, log: (line) => logs.push(line) });
    expect(await connectWith([])).toEqual([]);
  });

  it("is not named for a conversation already in the member's home, pinned there or not", async () => {
    iso = await isolateMember(alice);
    const agentId = `agent-${crypto.randomUUID()}`;
    const memberRoot = join(home(), ".claude");
    const transcript = join(
      claudeProjectDir(CWD, { CLAUDE_CONFIG_DIR: memberRoot }),
      `${SESSION}.jsonl`,
    );
    mkdirSync(join(transcript, ".."), { recursive: true });
    writeFileSync(transcript, "MOVED");
    const agents: MemberMoveAgent[] = [
      { id: agentId, agentType: "claude", cwd: CWD },
    ];
    setSessionClaudeConfigDir(agentId, SESSION, null);
    expect(await connectWith(agents)).toEqual([]);
    setSessionClaudeConfigDir(agentId, SESSION, memberRoot);
    expect(await connectWith(agents)).toEqual([]);
    // The enabling condition: the same transcript in the office root is named.
    const officeTranscript = join(
      claudeProjectDir(CWD, {
        CLAUDE_CONFIG_DIR: claudeConfigRoot(buildOfficeEnv()),
      }),
      `${SESSION}.jsonl`,
    );
    mkdirSync(join(officeTranscript, ".."), { recursive: true });
    writeFileSync(officeTranscript, "LEFT");
    scratch.push(officeTranscript);
    expect(await connectWith(agents)).toHaveLength(1);
  });
});

describe("a member whose files move", () => {
  it("gets a host with their paths that starts nothing and reads no file, and only the move gets the runner", async () => {
    iso = await isolateMember(alice);
    const runner = hostFor(alice);
    const outcome = (p: Promise<unknown>) =>
      p.then(
        () => "done",
        () => "refused",
      );
    expect(memberMoveHost(alice) === undefined).toBe(true);
    markMemberMoving(alice);
    const moving = hostFor(alice);
    expect([moving.home(), moving.agentRoot()]).toEqual([home(), agentRoot()]);
    expect(await outcome(moving.fs.readText(join(home(), "x")))).toBe(
      "refused",
    );
    expect(await outcome(moving.run(["true"], {}))).toBe("refused");
    expect(await outcome(moving.runEntry("files-done", {}))).toBe("refused");
    expect(memberMoveHost(alice) === runner).toBe(true);
    clearMemberMoving(alice);
    expect(hostFor(alice) === runner).toBe(true);
  });
});
