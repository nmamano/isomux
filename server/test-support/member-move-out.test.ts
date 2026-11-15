// The move back on disable (server/member-move-out.ts, office side, and
// sendFiles / removeSent in server/member-move-receive.ts, the runner side
// run in process here; internal-docs/member-os-user-design.md 2.3; slice
// 1c-ii-b of task b94dfd25). The properties: what the member's runner sends
// lands where the office picks, with the pins of the transcripts that came;
// the runner never sends a link, a hard link or a linked folder; the stream
// is untrusted, so a record that names no requested source, a Codex record
// that is not the requested thread's rollout, a second record for one file,
// a transcript record with a path, a tree path that is not normalised, or
// bytes beyond the totals the runner declared each refuse the stream and
// place nothing; the office never replaces a file and never writes through
// a linked folder; the staging is outside the folders the office scans and
// goes at the end; the member's copy goes, and a file that changed stays;
// the purge removes the member's trees through their runner.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
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
import { join, resolve } from "path";
import type { AgentHost } from "../agent-host.ts";
import {
  moveOutRequest,
  planMemberMoveOut,
  purgeMemberAgentSpace,
  setMemberMoveOutDeps,
  writeMoveOut,
  type MemberMoveOutPlan,
} from "../member-move-out.ts";
import {
  removeSent,
  sendFiles,
  spaceNeeded,
  type MoveOutInput,
} from "../member-move-receive.ts";
import type { MemberMoveAgent } from "../member-move.ts";
import { hostFor } from "../member-hosts.ts";
import { officePersonalProviderHome } from "../provider-homes.ts";
import { claudeConfigRoot } from "../claude-session-root.ts";
import { buildOfficeEnv } from "../env-loader.ts";
import { claudeProjectDirIn } from "../claude-session-files.ts";
import { ISOMUX_CODEX_HOME } from "../backends/codex/native-bin.ts";
import { STATE_ROOT } from "../config.ts";
import { AGENT_ROOT } from "../split/roots.ts";
import { setSessionClaudeConfigDir } from "../persistence.ts";
import { createMember, deleteUserById } from "../users.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";

const SESSION = "5e551011-bbbb-4ccc-8ddd-0123456789ab";
const THREAD = "019e0000-2222-7333-8444-555566667777";
const OTHER_THREAD = "019e0000-9999-7999-8999-999999999999";
const CWD = "/tmp/member-move-out-cwd";
const NONCE = "00112233445566778899aabbccddeeff";

let iso: IsolatedMember;
let alice: string;
let outside: string;
let logs: string[];
let agentId: string;
const created: string[] = [];
const scratch: string[] = [];

beforeEach(async () => {
  outside = mkdtempSync(join(tmpdir(), "move-out-outside-"));
  writeFileSync(join(outside, "secret"), "NOT-THEIRS");
  const made = createMember(`OutAlice${created.length}`, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  alice = made.user.id;
  created.push(alice);
  iso = await isolateMember(alice);
  logs = [];
  setMemberMoveOutDeps({ log: (line) => logs.push(line) });
  agentId = `agent-${crypto.randomUUID()}`;
});

afterEach(() => {
  setMemberMoveOutDeps(null);
  iso.dispose();
  rmSync(join(officePersonalProviderHome(alice, "claude"), ".."), {
    recursive: true,
    force: true,
  });
  for (const p of scratch.splice(0))
    rmSync(p, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  for (const id of created.splice(0)) deleteUserById(id);
});

const agentRoot = () => join(iso.home, ".isomux-agent");
const memberHome = () => join(agentRoot(), "provider-homes", alice, "claude");
const memberClaude = () => join(iso.home, ".claude");
const officeClaude = () => resolve(claudeConfigRoot(buildOfficeEnv()));
const transcriptIn = (root: string) =>
  join(claudeProjectDirIn(root, CWD), `${SESSION}.jsonl`);
const rolloutRel = (thread: string) =>
  `sessions/2026/11/15/rollout-2026-11-15T10-00-00-${thread}.jsonl`;
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const agents = (type: string): MemberMoveAgent[] => [
  { id: agentId, agentType: type, cwd: CWD },
];

// The runner's stream for a plan, run in process.
async function runnerStream(plan: MemberMoveOutPlan): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  await sendFiles(
    moveOutRequest(plan, NONCE, agentRoot()) as MoveOutInput,
    (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
  );
  return chunks;
}

async function* of(chunks: Buffer[]) {
  for (const chunk of chunks) yield chunk;
}

const plan = (type = "claude") =>
  planMemberMoveOut(alice, agents(type), hostFor(alice));

async function move(type = "claude") {
  const p = plan(type);
  scratch.push(
    transcriptIn(officeClaude()),
    join(claudeProjectDirIn(officeClaude(), CWD), SESSION),
  );
  return writeMoveOut(p, of(await runnerStream(p)), NONCE);
}

// A forged stream: the totals line, then records, then the end.
function forged(
  totals: Record<number, number>,
  records: { index: number; rel: string; data: string | Buffer }[],
): Buffer[] {
  const parts: Buffer[] = [Buffer.from(`${JSON.stringify({ totals })}\n`)];
  for (const r of records) {
    const data = Buffer.from(r.data);
    const header = Buffer.from(
      JSON.stringify({
        index: r.index,
        rel: r.rel,
        size: data.length,
        mode: 0o600,
      }),
    );
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    parts.push(len, header, data);
  }
  parts.push(Buffer.alloc(4));
  return parts;
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "written",
    () => "refused",
  );

// Every file under the office's destinations of this member, by path.
function officeFiles(): string[] {
  const roots = [
    join(officePersonalProviderHome(alice, "claude"), ".."),
    join(ISOMUX_CODEX_HOME, "sessions"),
    claudeProjectDirIn(officeClaude(), CWD),
  ];
  return roots.flatMap((root) =>
    existsSync(root)
      ? readdirSync(root, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => join(e.parentPath, e.name))
      : [],
  );
}

// No staging is left, and none was ever inside a folder the office scans.
function expectNoStaging(): void {
  for (const base of [STATE_ROOT, AGENT_ROOT, officeClaude()]) {
    const mine = join(base, ".member-move-out", alice);
    expect([base, existsSync(mine) ? readdirSync(mine) : []]).toEqual([
      base,
      [],
    ]);
  }
  for (const scanned of [
    join(STATE_ROOT, "provider-homes"),
    join(AGENT_ROOT, "opencode", "profiles"),
  ])
    expect(
      existsSync(scanned)
        ? readdirSync(scanned).filter((n) => n.startsWith("."))
        : [],
    ).toEqual([]);
}

describe("what comes back", () => {
  it("puts the transcript, its folder, the personal home and the rollout where the office picks, with the pins", async () => {
    put(transcriptIn(memberClaude()), "TRANSCRIPT");
    put(
      join(
        claudeProjectDirIn(memberClaude(), CWD),
        SESSION,
        "tool-results",
        "r.txt",
      ),
      "RESULT",
    );
    put(join(memberHome(), "settings.json"), "HOME");
    setSessionClaudeConfigDir(agentId, SESSION, memberClaude());
    const written = await move();
    expect(readFileSync(transcriptIn(officeClaude()), "utf8")).toBe(
      "TRANSCRIPT",
    );
    expect(
      readFileSync(
        join(
          claudeProjectDirIn(officeClaude(), CWD),
          SESSION,
          "tool-results",
          "r.txt",
        ),
        "utf8",
      ),
    ).toBe("RESULT");
    expect(
      readFileSync(
        join(officePersonalProviderHome(alice, "claude"), "settings.json"),
        "utf8",
      ),
    ).toBe("HOME");
    expect(written.pins).toEqual([
      { agentId, sessionId: SESSION, root: officeClaude() },
    ]);
    written.staging.remove();
    expectNoStaging();
  });

  it("pins a session of the personal home to the office's personal home", async () => {
    put(transcriptIn(memberHome()), "IN-HOME");
    setSessionClaudeConfigDir(agentId, SESSION, memberHome());
    const written = await move();
    expect(
      readFileSync(
        transcriptIn(resolve(officePersonalProviderHome(alice, "claude"))),
        "utf8",
      ),
    ).toBe("IN-HOME");
    expect(written.pins).toEqual([
      {
        agentId,
        sessionId: SESSION,
        root: resolve(officePersonalProviderHome(alice, "claude")),
      },
    ]);
    written.staging.remove();
  });

  it("brings the rollout of the thread back to the office Codex home", async () => {
    setSessionClaudeConfigDir(agentId, THREAD, null);
    put(join(agentRoot(), "codex-home", rolloutRel(THREAD)), "ROLLOUT");
    scratch.push(join(ISOMUX_CODEX_HOME, rolloutRel(THREAD)));
    const written = await move("codex");
    expect(
      readFileSync(join(ISOMUX_CODEX_HOME, rolloutRel(THREAD)), "utf8"),
    ).toBe("ROLLOUT");
    written.staging.remove();
  });

  it("writes no pin for a transcript that did not come, and logs nothing fatal", async () => {
    setSessionClaudeConfigDir(agentId, SESSION, memberClaude());
    const written = await move();
    expect(written.pins).toEqual([]);
    expect(written.missing.length).toBeGreaterThan(0);
    written.staging.remove();
  });

  it("sends no link, hard link or linked folder from the member's home", async () => {
    put(join(memberHome(), "kept.txt"), "MINE");
    symlinkSync(join(outside, "secret"), join(memberHome(), "link"));
    linkSync(join(outside, "secret"), join(memberHome(), "hard"));
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "inner"), "NOT-THEIRS");
    symlinkSync(join(outside, "dir"), join(memberHome(), "dirlink"));
    const written = await move();
    const home = officePersonalProviderHome(alice, "claude");
    expect(readFileSync(join(home, "kept.txt"), "utf8")).toBe("MINE");
    expect(officeFiles().map((f) => readFileSync(f, "utf8"))).not.toContain(
      "NOT-THEIRS",
    );
    written.staging.remove();
  });

  it("stops the stream when a file grew after its total was sent", async () => {
    const path = join(memberHome(), "settings.json");
    put(path, "HOME");
    const chunks: Buffer[] = [];
    const sent = sendFiles(
      moveOutRequest(plan(), NONCE, agentRoot()) as MoveOutInput,
      (chunk) => {
        // The totals line goes first; the file grows after it.
        if (chunks.length === 0) appendFileSync(path, "MORE");
        chunks.push(Buffer.from(chunk));
      },
    );
    expect(await outcome(sent)).toBe("refused");
    // The condition: the totals counted the file at its walked size.
    expect(Object.values(JSON.parse(chunks[0]!.toString()).totals)).toContain(
      4,
    );
    expect(chunks).toHaveLength(1);
  });
});

describe("the untrusted stream", () => {
  // Index 0 is the personal-home tree; a Codex source and a Claude
  // transcript follow.
  let p: MemberMoveOutPlan;
  let codexIndex: number;
  let fileIndex: number;
  beforeEach(() => {
    setSessionClaudeConfigDir(agentId, THREAD, null);
    const claudeAgent = `agent-${crypto.randomUUID()}`;
    setSessionClaudeConfigDir(claudeAgent, SESSION, memberClaude());
    p = planMemberMoveOut(
      alice,
      [
        { id: agentId, agentType: "codex", cwd: CWD },
        { id: claudeAgent, agentType: "claude", cwd: CWD },
      ],
      hostFor(alice),
    );
    codexIndex = p.sources.find((s) => s.kind === "codex")!.index;
    fileIndex = p.sources.find((s) => s.kind === "claude-file")!.index;
    scratch.push(
      join(ISOMUX_CODEX_HOME, "sessions"),
      join(ISOMUX_CODEX_HOME, "config.toml"),
    );
  });

  const refusedCases: [string, () => Buffer[]][] = [
    [
      "a Codex record that is not a rollout",
      () =>
        forged({ [codexIndex]: 3 }, [
          { index: codexIndex, rel: "config.toml", data: "x=1" },
        ]),
    ],
    [
      "the rollout of a thread that was not asked for",
      () =>
        forged({ [codexIndex]: 3 }, [
          { index: codexIndex, rel: rolloutRel(OTHER_THREAD), data: "abc" },
        ]),
    ],
    [
      "a second record for one rollout",
      () =>
        forged({ [codexIndex]: 6 }, [
          { index: codexIndex, rel: rolloutRel(THREAD), data: "abc" },
          {
            index: codexIndex,
            rel: rolloutRel(THREAD).replace("10-00-00", "11-00-00"),
            data: "def",
          },
        ]),
    ],
    [
      "a transcript record with a path",
      () =>
        forged({ [fileIndex]: 3 }, [
          { index: fileIndex, rel: "x.jsonl", data: "abc" },
        ]),
    ],
    [
      "a tree path with ..",
      () =>
        forged({ 0: 3 }, [
          { index: 0, rel: "claude/../../escape", data: "abc" },
        ]),
    ],
    [
      "a tree path that starts with ..",
      () => forged({ 0: 3 }, [{ index: 0, rel: "../escape", data: "abc" }]),
    ],
    [
      "an absolute tree path",
      () =>
        forged({ 0: 3 }, [
          { index: 0, rel: join(outside, "abs"), data: "abc" },
        ]),
    ],
    [
      "a record for no requested source",
      () => forged({ 0: 3 }, [{ index: 999, rel: "x", data: "abc" }]),
    ],
  ];
  for (const [name, stream] of refusedCases)
    it(`refuses ${name}, and places nothing`, async () => {
      // A good record first: the refusal places it neither.
      const good = forged({}, [
        { index: 0, rel: "claude/good.txt", data: "GOOD" },
      ]);
      const bad = stream();
      const totals = JSON.parse(bad[0].toString()) as {
        totals: Record<string, number>;
      };
      totals.totals[0] = (totals.totals[0] ?? 0) + 4;
      const body = [
        Buffer.from(`${JSON.stringify(totals)}\n`),
        ...good.slice(1, -1),
        ...bad.slice(1),
      ];
      expect(await outcome(writeMoveOut(p, of(body), NONCE))).toBe("refused");
      expect(officeFiles()).toEqual([]);
      expect(existsSync(join(ISOMUX_CODEX_HOME, "config.toml"))).toBe(false);
      expect(existsSync(join(outside, "abs"))).toBe(false);
      expect(existsSync(join(STATE_ROOT, "provider-homes", "escape"))).toBe(
        false,
      );
      expectNoStaging();
    });

  it("refuses bytes beyond the totals the runner declared, before the space they need is checked", async () => {
    const data = Buffer.alloc(64 * 1024, 1);
    // The declared total fits the free space; the real one does not.
    setMemberMoveOutDeps({
      log: (l) => logs.push(l),
      freeBytes: () => spaceNeeded(16),
    });
    const body = forged({ 0: 16 }, [{ index: 0, rel: "claude/big.bin", data }]);
    expect(await outcome(writeMoveOut(p, of(body), NONCE))).toBe("refused");
    expect(officeFiles()).toEqual([]);
    // And a source the totals do not name.
    setMemberMoveOutDeps({ log: (l) => logs.push(l) });
    const unnamed = forged({ 0: 0 }, [
      { index: fileIndex, rel: "", data: "abc" },
    ]);
    expect(await outcome(writeMoveOut(p, of(unnamed), NONCE))).toBe("refused");
    expect(officeFiles()).toEqual([]);
    // The control: the same file, declared, is written.
    const declared = forged({ 0: data.length }, [
      { index: 0, rel: "claude/big.bin", data },
    ]);
    const written = await writeMoveOut(p, of(declared), NONCE);
    expect(officeFiles()).toHaveLength(1);
    written.staging.remove();
  });

  it("refuses ENOSPC before it writes a byte", async () => {
    setMemberMoveOutDeps({ log: (l) => logs.push(l), freeBytes: () => 1024 });
    const body = forged({ 0: 4 }, [
      { index: 0, rel: "claude/a.txt", data: "abcd" },
    ]);
    expect(await outcome(writeMoveOut(p, of(body), NONCE))).toBe("refused");
    expect(officeFiles()).toEqual([]);
    expectNoStaging();
  });

  it("never replaces an office file, takes an identical one, and undoes its own on a conflict", async () => {
    const home = officePersonalProviderHome(alice, "claude");
    put(join(home, "same.txt"), "SAME");
    put(join(home, "taken.txt"), "OFFICE");
    const body = forged({ 0: 12 }, [
      { index: 0, rel: "claude/same.txt", data: "SAME" },
      { index: 0, rel: "claude/new.txt", data: "NEW!" },
      { index: 0, rel: "claude/taken.txt", data: "THEM" },
    ]);
    expect(await outcome(writeMoveOut(p, of(body), NONCE))).toBe("refused");
    expect(readFileSync(join(home, "taken.txt"), "utf8")).toBe("OFFICE");
    expect(readFileSync(join(home, "same.txt"), "utf8")).toBe("SAME");
    expect(existsSync(join(home, "new.txt"))).toBe(false);
  });

  it("never writes through a linked folder at the destination", async () => {
    const projects = join(officeClaude(), "projects");
    mkdirSync(projects, { recursive: true });
    const linked = claudeProjectDirIn(officeClaude(), CWD);
    rmSync(linked, { recursive: true, force: true });
    symlinkSync(outside, linked);
    scratch.push(linked);
    const body = forged({ [fileIndex]: 3 }, [
      { index: fileIndex, rel: "", data: "abc" },
    ]);
    expect(await outcome(writeMoveOut(p, of(body), NONCE))).toBe("refused");
    expect(existsSync(join(outside, `${SESSION}.jsonl`))).toBe(false);
  });
});

describe("the member's copy", () => {
  it("goes after the move, but a file that changed since it was sent stays", async () => {
    put(join(memberHome(), "a.txt"), "A");
    put(join(memberHome(), "sub", "b.txt"), "B");
    symlinkSync(join(outside, "secret"), join(memberHome(), "link"));
    const p = plan();
    const written = await writeMoveOut(p, of(await runnerStream(p)), NONCE);
    written.staging.remove();
    // A new file over b.txt, made while the old one exists (another inode).
    writeFileSync(join(memberHome(), "sub", "b.new"), "CHANGED");
    renameSync(
      join(memberHome(), "sub", "b.new"),
      join(memberHome(), "sub", "b.txt"),
    );
    const { kept } = removeSent({ nonce: NONCE, agentRoot: agentRoot() });
    expect(existsSync(join(memberHome(), "a.txt"))).toBe(false);
    expect(readFileSync(join(memberHome(), "sub", "b.txt"), "utf8")).toBe(
      "CHANGED",
    );
    expect(kept).toEqual([join(memberHome(), "sub", "b.txt")]);
    // A link that was never sent is not removed either.
    expect(lstatSync(join(memberHome(), "link")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(agentRoot(), ".move-out", NONCE))).toBe(false);
  });
});

describe("the purge of a removed member", () => {
  it("removes their trees through their runner, and logs a runner that cannot be reached", async () => {
    put(join(memberHome(), "a.txt"), "A");
    const calls: unknown[] = [];
    const runner = {
      member: alice,
      agentRoot: () => agentRoot(),
      runEntry: async (name: string, input: unknown) => {
        calls.push(name);
        return removeSent(input as { agentRoot: string; trees: string[] });
      },
    } as unknown as AgentHost;
    await purgeMemberAgentSpace(alice, runner);
    expect(calls).toEqual(["files-remove"]);
    expect(existsSync(join(agentRoot(), "provider-homes", alice))).toBe(false);

    const down = {
      member: alice,
      agentRoot: () => agentRoot(),
      runEntry: async () => {
        throw new Error("the member's OS user is not ready");
      },
    } as unknown as AgentHost;
    await purgeMemberAgentSpace(alice, down);
    expect(logs.filter((l) => l.includes(alice))).toHaveLength(1);
  });

  it("refuses a tree outside the member's agent space", () => {
    expect(() =>
      removeSent({ agentRoot: agentRoot(), trees: [outside] }),
    ).toThrow();
    expect(existsSync(join(outside, "secret"))).toBe(true);
  });
});
