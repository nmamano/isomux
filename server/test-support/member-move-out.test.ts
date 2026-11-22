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
// the purge removes the member's trees through their runner. A move whose
// request would pass a runner frame is asked for in requests that each fit
// one, read one stream at a time, with every bound (totals of the request's
// own sources, the move's total, the free space) held across them, and
// placed only after the last.
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
import { encodeJson, MAX_FRAME_BYTES } from "../agent-runner/frames.ts";
import {
  moveOutRequests,
  planAgentMoveOut,
  planMemberMoveOut,
  purgeMemberAgentSpace,
  setMemberMoveOutDeps,
  undoMoveOut,
  writeMoveOut,
  type MemberMoveOutPlan,
} from "../member-move-out.ts";
import {
  removeSent,
  sendFiles,
  spaceNeeded,
  type MoveOutInput,
} from "../member-move-receive.ts";
import { MOVE_FILE_MAX, type MemberMoveAgent } from "../member-move.ts";
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
import { removeManagedUserEnv, writeManagedUserEnv } from "../user-env.ts";
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

// The runner's files-out stream for one request, run in process.
async function sent(input: MoveOutInput): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  await sendFiles(input, (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  return chunks;
}

// The office's side of files-out: each request encoded as the runner client
// sends it (agent-runner/client.ts), so a request past a runner frame fails
// here as in production; `stream` gives the chunks of each (call counts from
// 0). `overlaps` counts the requests opened while an earlier stream had not
// been read to its last chunk; `closed` the streams that ended (read to
// done, or ended by the office).
function runner(
  stream: (
    input: MoveOutInput,
    call: number,
  ) => Buffer[] | Promise<Buffer[]> = sent,
) {
  const inputs: MoveOutInput[] = [];
  let read = 0;
  const state = {
    inputs,
    overlaps: 0,
    closed: 0,
    open: (input: MoveOutInput): AsyncIterable<Uint8Array> => {
      encodeJson({ op: "entry", name: "files-out", input });
      const call = inputs.length;
      if (read < call) state.overlaps++;
      inputs.push(input);
      return (async function* () {
        try {
          const chunks = await stream(input, call);
          for (const [i, chunk] of chunks.entries()) {
            if (i === chunks.length - 1) read++;
            yield chunk;
          }
        } finally {
          state.closed++;
        }
      })();
    },
  };
  return state;
}

// The source indices of one request.
const indicesOf = (input: MoveOutInput) =>
  [...input.trees, ...input.files, ...input.codex].map((e) => e.index);

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
  return writeMoveOut(p, runner().open, NONCE, agentRoot());
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
      moveOutRequests(plan(), NONCE, agentRoot())[0]!,
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
      expect(
        await outcome(writeMoveOut(p, () => of(body), NONCE, agentRoot())),
      ).toBe("refused");
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
    expect(
      await outcome(writeMoveOut(p, () => of(body), NONCE, agentRoot())),
    ).toBe("refused");
    expect(officeFiles()).toEqual([]);
    // And a source the totals do not name.
    setMemberMoveOutDeps({ log: (l) => logs.push(l) });
    const unnamed = forged({ 0: 0 }, [
      { index: fileIndex, rel: "", data: "abc" },
    ]);
    expect(
      await outcome(writeMoveOut(p, () => of(unnamed), NONCE, agentRoot())),
    ).toBe("refused");
    expect(officeFiles()).toEqual([]);
    // The control: the same file, declared, is written.
    const declared = forged({ 0: data.length }, [
      { index: 0, rel: "claude/big.bin", data },
    ]);
    const written = await writeMoveOut(
      p,
      () => of(declared),
      NONCE,
      agentRoot(),
    );
    expect(officeFiles()).toHaveLength(1);
    written.staging.remove();
  });

  it("refuses ENOSPC before it writes a byte", async () => {
    setMemberMoveOutDeps({ log: (l) => logs.push(l), freeBytes: () => 1024 });
    const body = forged({ 0: 4 }, [
      { index: 0, rel: "claude/a.txt", data: "abcd" },
    ]);
    expect(
      await outcome(writeMoveOut(p, () => of(body), NONCE, agentRoot())),
    ).toBe("refused");
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
    expect(
      await outcome(writeMoveOut(p, () => of(body), NONCE, agentRoot())),
    ).toBe("refused");
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
    expect(
      await outcome(writeMoveOut(p, () => of(body), NONCE, agentRoot())),
    ).toBe("refused");
    expect(existsSync(join(outside, `${SESSION}.jsonl`))).toBe(false);
  });
});

describe("the member's copy", () => {
  it("goes after the move, but a file that changed since it was sent stays", async () => {
    put(join(memberHome(), "a.txt"), "A");
    put(join(memberHome(), "sub", "b.txt"), "B");
    symlinkSync(join(outside, "secret"), join(memberHome(), "link"));
    const p = plan();
    const written = await writeMoveOut(p, runner().open, NONCE, agentRoot());
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

describe("the runner's .move-out", () => {
  // MUTANT: the entries of .move-out listed and removed through a link
  // (dies on the file outside).
  it("clears what another move left, never through a link, and keeps this move's journal", async () => {
    const OTHER = "ffeeddccbbaa99887766554433221100";
    const out = join(agentRoot(), ".move-out");
    put(join(out, OTHER, "sent.jsonl"), "{}\n");
    const input = moveOutRequests(plan(), NONCE, agentRoot())[0]!;
    await sent(input);
    // The condition: this move's journal is there after a request.
    expect(readdirSync(out)).toEqual([NONCE]);
    await sent(input);
    expect(readdirSync(out)).toEqual([NONCE]);
    // A .move-out that is a link to a folder: the link goes, not what is
    // in the folder.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(outside, "linked"));
    writeFileSync(join(outside, "linked", "keep"), "KEEP");
    symlinkSync(join(outside, "linked"), out);
    await sent(input);
    expect(readFileSync(join(outside, "linked", "keep"), "utf8")).toBe("KEEP");
    expect(lstatSync(out).isDirectory()).toBe(true);
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

// Task abdb452b: one agent leaves the isolated member for a manager on the
// office's host. Only its sessions come back, each as a single file and
// folder with an office destination (a session in the member's personal
// home too); the member's trees and the other agent's session stay.
describe("one agent's files on a manager change", () => {
  const SESSION_A2 = "5e551011-cccc-4ccc-8ddd-0123456789ab";
  const SESSION_B = "5e551011-dddd-4ccc-8ddd-0123456789ab";
  const transcriptOf = (root: string, session: string) =>
    join(claudeProjectDirIn(root, CWD), `${session}.jsonl`);

  // MUTANT: the whole-member plan (dies on the personal-home tree and the
  // other agent's session); a session of the personal home left to a tree
  // (dies on A2, which then does not come).
  it("brings back only this agent's sessions, to the office Claude root, and the member keeps the rest", async () => {
    const agentB = `agent-${crypto.randomUUID()}`;
    put(transcriptOf(memberClaude(), SESSION), "A-ONE");
    put(
      join(claudeProjectDirIn(memberClaude(), CWD), SESSION, "r.txt"),
      "A-ONE-RESULT",
    );
    put(transcriptOf(memberHome(), SESSION_A2), "A-TWO");
    put(transcriptOf(memberClaude(), SESSION_B), "B-ONE");
    put(join(memberHome(), "settings.json"), "HERS");
    setSessionClaudeConfigDir(agentId, SESSION, memberClaude());
    setSessionClaudeConfigDir(agentId, SESSION_A2, memberHome());
    setSessionClaudeConfigDir(agentB, SESSION_B, memberClaude());
    for (const session of [SESSION, SESSION_A2, SESSION_B])
      scratch.push(
        transcriptOf(officeClaude(), session),
        join(claudeProjectDirIn(officeClaude(), CWD), session),
      );
    const p = planAgentMoveOut(
      { id: agentId, agentType: "claude", cwd: CWD },
      alice,
      hostFor(alice),
      [],
    );
    expect(p.sources.filter((s) => s.kind === "tree")).toEqual([]);
    const written = await writeMoveOut(p, runner().open, NONCE, agentRoot());
    written.staging.remove();
    expect(readFileSync(transcriptOf(officeClaude(), SESSION), "utf8")).toBe(
      "A-ONE",
    );
    expect(
      readFileSync(
        join(claudeProjectDirIn(officeClaude(), CWD), SESSION, "r.txt"),
        "utf8",
      ),
    ).toBe("A-ONE-RESULT");
    expect(readFileSync(transcriptOf(officeClaude(), SESSION_A2), "utf8")).toBe(
      "A-TWO",
    );
    const contents = officeFiles().map((f) => readFileSync(f, "utf8"));
    expect(contents).not.toContain("B-ONE");
    expect(contents).not.toContain("HERS");
    expect(
      [...written.pins].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    ).toEqual([
      { agentId, sessionId: SESSION, root: officeClaude() },
      { agentId, sessionId: SESSION_A2, root: officeClaude() },
    ]);
    // The member's copy of what came goes; the rest stays.
    removeSent({ nonce: NONCE, agentRoot: agentRoot() });
    expect(existsSync(transcriptOf(memberClaude(), SESSION))).toBe(false);
    expect(existsSync(transcriptOf(memberHome(), SESSION_A2))).toBe(false);
    expect(readFileSync(transcriptOf(memberClaude(), SESSION_B), "utf8")).toBe(
      "B-ONE",
    );
    expect(readFileSync(join(memberHome(), "settings.json"), "utf8")).toBe(
      "HERS",
    );
  });

  // MUTANT: the rollout skipped when the member's Codex home is in their
  // personal home (the whole-member rule: a tree carries it).
  it("brings back this agent's rollout only, also from a Codex home in the personal home", async () => {
    const agentB = `agent-${crypto.randomUUID()}`;
    const codexHome = join(memberHome(), "..", "codex");
    writeManagedUserEnv(alice, { CODEX_HOME: codexHome });
    try {
      setSessionClaudeConfigDir(agentId, THREAD, null);
      setSessionClaudeConfigDir(agentB, OTHER_THREAD, null);
      put(join(codexHome, rolloutRel(THREAD)), "A-ROLLOUT");
      put(join(codexHome, rolloutRel(OTHER_THREAD)), "B-ROLLOUT");
      scratch.push(
        join(ISOMUX_CODEX_HOME, rolloutRel(THREAD)),
        join(ISOMUX_CODEX_HOME, rolloutRel(OTHER_THREAD)),
      );
      const p = planAgentMoveOut(
        { id: agentId, agentType: "codex", cwd: CWD },
        alice,
        hostFor(alice),
        [],
      );
      const written = await writeMoveOut(p, runner().open, NONCE, agentRoot());
      written.staging.remove();
      expect(
        readFileSync(join(ISOMUX_CODEX_HOME, rolloutRel(THREAD)), "utf8"),
      ).toBe("A-ROLLOUT");
      expect(
        existsSync(join(ISOMUX_CODEX_HOME, rolloutRel(OTHER_THREAD))),
      ).toBe(false);
    } finally {
      removeManagedUserEnv(alice);
    }
  });
});

describe("a move whose request would pass a runner frame", () => {
  const LONG = "d".repeat(200);
  // Trees with long paths (index order), then a Claude transcript, its
  // folder and a Codex thread: past one frame as one request. With `pad`
  // "", the tree entries are short.
  function bigPlan(count = 4000, pad = LONG): MemberMoveOutPlan {
    const homes = join(officePersonalProviderHome(alice, "claude"), "..");
    const sources: MemberMoveOutPlan["sources"] = [];
    for (let i = 0; i < count; i++)
      sources.push({
        index: i,
        kind: "tree",
        path: join(agentRoot(), "bulk", pad, String(i)),
        destRoot: join(homes, "bulk", String(i)),
      });
    const projectDir = claudeProjectDirIn(memberClaude(), CWD);
    const officeDir = claudeProjectDirIn(officeClaude(), CWD);
    sources.push(
      {
        index: count,
        kind: "claude-file",
        path: join(projectDir, `${SESSION}.jsonl`),
        dest: join(officeDir, `${SESSION}.jsonl`),
        session: { agentId, sessionId: SESSION, root: officeClaude() },
      },
      {
        index: count + 1,
        kind: "claude-dir",
        path: join(projectDir, SESSION),
        destRoot: join(officeDir, SESSION),
      },
      {
        index: count + 2,
        kind: "codex",
        home: join(agentRoot(), "codex-home"),
        threadId: THREAD,
        destRoot: ISOMUX_CODEX_HOME,
      },
    );
    scratch.push(
      transcriptIn(officeClaude()),
      join(officeDir, SESSION),
      join(ISOMUX_CODEX_HOME, rolloutRel(THREAD)),
    );
    return { userId: alice, sources, personal: [] };
  }

  // A good record for the first tree of each request, as `call` asks.
  const goodFor = (input: MoveOutInput, rel = "f.txt") => {
    const index = input.trees[0]?.index;
    return index === undefined
      ? forged({}, [])
      : forged({ [index]: 4 }, [{ index, rel, data: "GOOD" }]);
  };

  // MUTANT: one request for the whole plan (dies on the count); the batch
  // bound at a frame with no room for the request around it (dies on
  // encodeJson: the entries are short, so a request fills to within one
  // entry of the bound, and the rest of the request takes more).
  it("asks in requests that each fit a runner frame, every source in exactly one", () => {
    const p = bigPlan(30000, "");
    const requests = moveOutRequests(p, NONCE, agentRoot());
    // The condition: as one request, the sources pass a frame.
    expect(
      requests.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0),
    ).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(requests.length).toBeGreaterThan(1);
    for (const input of requests) {
      // Throws past a frame, as the runner client does.
      encodeJson({ op: "entry", name: "files-out", input });
      expect([input.nonce, input.agentRoot, input.fileMax]).toEqual([
        NONCE,
        agentRoot(),
        MOVE_FILE_MAX,
      ]);
    }
    const byIndex = <T extends { index: number }>(list: T[]) =>
      [...list].sort((a, b) => a.index - b.index);
    const asked = (kinds: string[]) =>
      p.sources.filter((s) => kinds.includes(s.kind));
    expect(byIndex(requests.flatMap((r) => r.trees))).toEqual(
      asked(["tree", "claude-dir"]).map((s) => ({
        index: s.index,
        path: (s as { path: string }).path,
      })),
    );
    expect(byIndex(requests.flatMap((r) => r.files))).toEqual(
      asked(["claude-file"]).map((s) => ({
        index: s.index,
        path: (s as { path: string }).path,
      })),
    );
    expect(byIndex(requests.flatMap((r) => r.codex))).toEqual(
      asked(["codex"]).map((s) => ({
        index: s.index,
        home: (s as { home: string }).home,
        threadId: (s as { threadId: string }).threadId,
      })),
    );
    // An empty plan still asks once (the runner clears what an earlier
    // move left).
    expect(
      moveOutRequests(
        { userId: alice, sources: [], personal: [] },
        NONCE,
        agentRoot(),
      ),
    ).toEqual([
      {
        nonce: NONCE,
        agentRoot: agentRoot(),
        fileMax: MOVE_FILE_MAX,
        trees: [],
        files: [],
        codex: [],
      },
    ]);
  });

  // MUTANT: sendFiles clears all of .move-out on each request (dies on the
  // first tree's member copy, whose journal line the next request removed);
  // every stream opened before the first is read (dies on overlaps).
  it("brings every file back, one stream at a time, and the member's copies of every request go after it", async () => {
    const p = bigPlan();
    const trees = p.sources.filter((s) => s.kind === "tree");
    const picks = [trees[0]!, trees[trees.length - 1]!];
    for (const [n, s] of picks.entries())
      put(join(s.path, "sub", "f.txt"), `TREE-${n}`);
    put(transcriptIn(memberClaude()), "TRANSCRIPT");
    put(join(agentRoot(), "codex-home", rolloutRel(THREAD)), "ROLLOUT");
    const r = runner();
    const written = await writeMoveOut(p, r.open, NONCE, agentRoot());
    written.staging.remove();
    // The condition: the first and last tree came in different requests.
    const requestOf = (index: number) =>
      r.inputs.findIndex((input) => indicesOf(input).includes(index));
    expect(requestOf(picks[0]!.index)).not.toBe(requestOf(picks[1]!.index));
    expect(r.overlaps).toBe(0);
    expect(r.closed).toBe(r.inputs.length);
    for (const [n, s] of picks.entries())
      expect(
        readFileSync(
          join((s as { destRoot: string }).destRoot, "sub", "f.txt"),
          "utf8",
        ),
      ).toBe(`TREE-${n}`);
    expect(readFileSync(transcriptIn(officeClaude()), "utf8")).toBe(
      "TRANSCRIPT",
    );
    expect(
      readFileSync(join(ISOMUX_CODEX_HOME, rolloutRel(THREAD)), "utf8"),
    ).toBe("ROLLOUT");
    expect(written.pins).toEqual([
      { agentId, sessionId: SESSION, root: officeClaude() },
    ]);
    removeSent({ nonce: NONCE, agentRoot: agentRoot() });
    for (const s of picks)
      expect(
        existsSync(join((s as { path: string }).path, "sub", "f.txt")),
      ).toBe(false);
    expect(existsSync(transcriptIn(memberClaude()))).toBe(false);
    expect(
      existsSync(join(agentRoot(), "codex-home", rolloutRel(THREAD))),
    ).toBe(false);
  });

  // MUTANT: totals and records checked against the whole plan (both cases
  // are then written); a refused stream left open (dies on closed).
  for (const [name, at, from] of [
    ["the first request names a source of the last", 0, -1],
    ["the last request names a source of the first", -1, 0],
  ] as const)
    it(`refuses the move when ${name}, and places nothing`, async () => {
      const p = bigPlan();
      const requests = moveOutRequests(p, NONCE, agentRoot());
      const pick = (n: number) => (n < 0 ? requests.length + n : n);
      const other = requests[pick(from)]!.trees[0]!.index;
      // The condition: the source is not one of that request's.
      expect(indicesOf(requests[pick(at)]!)).not.toContain(other);
      const r = runner((input, call) =>
        call === pick(at)
          ? forged({ [other]: 4 }, [
              { index: other, rel: "g.txt", data: "THEM" },
            ])
          : goodFor(input),
      );
      expect(await outcome(writeMoveOut(p, r.open, NONCE, agentRoot()))).toBe(
        "refused",
      );
      expect(r.inputs).toHaveLength(pick(at) + 1);
      // The refused stream is ended too (the runner stops reading files).
      expect(r.closed).toBe(r.inputs.length);
      expect(officeFiles()).toEqual([]);
      expectNoStaging();
    });

  // MUTANT: the next stream opened at the zero length, without reading
  // the stream to its end (then written).
  it("refuses the move when an entry fails after its last record", async () => {
    const p = bigPlan();
    const r = runner((input) => goodFor(input));
    const failing = (input: MoveOutInput) =>
      (async function* () {
        yield* r.open(input);
        throw new Error("agent runner entry files-out failed: exit 1");
      })();
    expect(await outcome(writeMoveOut(p, failing, NONCE, agentRoot()))).toBe(
      "refused",
    );
    // The condition: the first stream was read to its zero length.
    expect(r.inputs).toHaveLength(1);
    expect(officeFiles()).toEqual([]);
    expectNoStaging();
  });

  // MUTANT: each stream placed when it ends (dies on the files seen when
  // the last opens); the undo of only the last stream (dies after it).
  it("places nothing before the last stream, and a refusal in it undoes the earlier ones", async () => {
    const p = bigPlan();
    const count = moveOutRequests(p, NONCE, agentRoot()).length;
    // The control: every request with a good record is written.
    const ok = runner((input) => goodFor(input));
    const written = await writeMoveOut(p, ok.open, NONCE, agentRoot());
    expect(ok.inputs).toHaveLength(count);
    expect(officeFiles().length).toBeGreaterThan(1);
    undoMoveOut(written);
    expect(officeFiles()).toEqual([]);

    const seenAtLast: string[][] = [];
    const r = runner((input, call) => {
      if (call < count - 1) return goodFor(input);
      seenAtLast.push(officeFiles());
      return goodFor(input, "../escape");
    });
    expect(await outcome(writeMoveOut(p, r.open, NONCE, agentRoot()))).toBe(
      "refused",
    );
    expect(r.inputs).toHaveLength(count);
    expect(r.closed).toBe(count);
    expect(seenAtLast).toEqual([[]]);
    expect(officeFiles()).toEqual([]);
    expectNoStaging();
  });

  // MUTANT: the move's total checked per stream (then written).
  it("holds the move's total across its requests", async () => {
    const p = bigPlan();
    // Six bytes in each of the first two requests: each under ten, the
    // move over.
    const six = (input: MoveOutInput, call: number) => {
      const index = input.trees[0]!.index;
      return call < 2
        ? forged({ [index]: 6 }, [{ index, rel: "f.txt", data: "SIXSIX" }])
        : forged({}, []);
    };
    setMemberMoveOutDeps({ log: (l) => logs.push(l), totalMax: 12 });
    const ok = runner(six);
    const written = await writeMoveOut(p, ok.open, NONCE, agentRoot());
    expect(officeFiles()).toHaveLength(2);
    undoMoveOut(written);
    setMemberMoveOutDeps({ log: (l) => logs.push(l), totalMax: 10 });
    const r = runner(six);
    expect(await outcome(writeMoveOut(p, r.open, NONCE, agentRoot()))).toBe(
      "refused",
    );
    expect(r.inputs).toHaveLength(2);
    expect(officeFiles()).toEqual([]);
    expectNoStaging();
  });

  // MUTANT: the free space checked for the first stream only (then
  // written).
  it("checks the free space again for each request", async () => {
    const p = bigPlan();
    let low = false;
    setMemberMoveOutDeps({
      log: (l) => logs.push(l),
      freeBytes: () => (low ? 1024 : 1e15),
    });
    const r = runner((input, call) => {
      low = call >= 1;
      return goodFor(input);
    });
    expect(await outcome(writeMoveOut(p, r.open, NONCE, agentRoot()))).toBe(
      "refused",
    );
    // The condition: the first stream passed its check; the second failed.
    expect(r.inputs).toHaveLength(2);
    expect(officeFiles()).toEqual([]);
    expectNoStaging();
  });
});
