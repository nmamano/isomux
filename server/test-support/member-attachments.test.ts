// A member's uploads and screenshots (internal-docs/member-os-user-design.md,
// slice 2d-ii-b of task b94dfd25). The member cannot read LOGS_DIR, so:
// - the office copies each file to <share>/files/<agentId>/<name>, in folders
//   that keep the setgid bit (02750), as files of 0640, never through a link;
// - a member's agent at folder and web gets the copy in its own folder from
//   their runner (the attachment-copy entry, file to file, as the member),
//   and its sends keep their order while a copy is made;
// - a screenshot names the share copy, and a failed copy is an error, never
//   the office path.
// The runner cases use a real runner in this process (one user); the member
// rig proves the same with two users.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunnerAgentHost } from "../agent-runner/client.ts";
import { startRunner } from "../agent-runner/runner.ts";
import type { AgentHost } from "../agent-host.ts";
import {
  createSendOrder,
  deliveredNotices,
  folderDelivery,
  prepareMemberCopies,
  resolveAttachmentNotices,
} from "../attachment-prompt.ts";
import { createAgentAffordances } from "../agent-affordances.ts";
import { createClaudeBackend } from "../backends/claude.ts";
import { STATE_ROOT } from "../config.ts";
import { buildEnvForUserId } from "../env-loader.ts";
import {
  copyToMemberShare,
  memberShareFilesDir,
  removeMemberShareFiles,
  setAgentShareResolver,
} from "../member-share-files.ts";
import { chmodShare } from "../split/share-mode.ts";
import { createMember, deleteUserById } from "../users.ts";
import { forgetMemberHost } from "../member-hosts.ts";
import { FakeSdkClient } from "./fake-sdk-client.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import { removeStateDir } from "./temp-state.ts";

const AGENT = `member-att-${process.pid}-${Date.now()}`;
const FILES = join(STATE_ROOT, "logs", AGENT, "files");
// Not UTF-8: a copy that passes through a string changes these bytes.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80,
]);

const scratch: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
const modeOf = (path: string) => statSync(path).mode & 0o7777;
const att = (filename: string, mediaType: string, size = 1) => ({
  filename,
  originalName: filename,
  mediaType,
  size,
});

let share: string;
let errors: string[];
const realError = console.error;

beforeEach(() => {
  mkdirSync(FILES, { recursive: true });
  writeFileSync(join(FILES, "shot.png"), PNG);
  writeFileSync(join(FILES, "notes.md"), "NOTES BODY\n");
  // A setgid share, as root makes it (this user is in its own group, so
  // the bit stays; Bun's chmodSync would drop it).
  share = tmp("member-share-");
  chmodShare(share, 0o2750);
  setAgentShareResolver((id) => (id === AGENT ? share : null));
  errors = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = realError;
  setAgentShareResolver(null);
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

afterAll(() => removeStateDir(join(STATE_ROOT, "logs", AGENT)));

describe("copyToMemberShare", () => {
  it("copies under files/<agentId>/ with setgid folders and a 0640 file, and replaces an earlier copy", () => {
    const path = copyToMemberShare(
      share,
      AGENT,
      "shot.png",
      join(FILES, "shot.png"),
    );
    expect(path).toBe(join(share, "files", AGENT, "shot.png"));
    expect(readFileSync(path)).toEqual(PNG);
    expect(modeOf(join(share, "files"))).toBe(0o2750);
    expect(modeOf(join(share, "files", AGENT))).toBe(0o2750);
    expect(modeOf(path)).toBe(0o640);
    writeFileSync(join(FILES, "shot.png"), "NEWER");
    copyToMemberShare(share, AGENT, "shot.png", join(FILES, "shot.png"));
    expect(readFileSync(path, "utf8")).toBe("NEWER");
  });

  // Round 1 F1: the office is not in the member's group, so its chmod would
  // clear the setgid bit; the bit and the group come only from mkdir in the
  // setgid share. A folder without them is made again, and a share without
  // the bit is refused.
  it("makes a folder without the setgid bit or with another mode again, and drops what was in it", () => {
    for (const mode of [0o750, 0o2770]) {
      const dir = join(share, "files", AGENT);
      mkdirSync(dir, { recursive: true });
      chmodShare(join(share, "files"), 0o2750);
      chmodShare(dir, mode);
      writeFileSync(join(dir, "stale.md"), "STALE");
      copyToMemberShare(share, AGENT, "notes.md", join(FILES, "notes.md"));
      expect([mode, modeOf(dir)]).toEqual([mode, 0o2750]);
      expect(readdirSync(dir)).toEqual(["notes.md"]);
      rmSync(join(share, "files"), { recursive: true });
    }
  });

  it("gives the folders 2750 also under the container's umask 077", () => {
    const before = process.umask(0o077);
    try {
      copyToMemberShare(share, AGENT, "notes.md", join(FILES, "notes.md"));
      // The server's own umask is not changed.
      expect(process.umask()).toBe(0o077);
    } finally {
      process.umask(before);
    }
    expect(modeOf(join(share, "files"))).toBe(0o2750);
    expect(modeOf(join(share, "files", AGENT))).toBe(0o2750);
  });

  it("refuses a share without the setgid bit, and writes no copy", () => {
    chmodSync(share, 0o750);
    expect(() =>
      copyToMemberShare(share, AGENT, "notes.md", join(FILES, "notes.md")),
    ).toThrow();
    expect(existsSync(join(share, "files", AGENT, "notes.md"))).toBe(false);
  });

  it("refuses an agent id or a name that leaves its folder, before any write", () => {
    for (const id of ["..", "../x", "a/b", ".", "", "a.b"])
      expect(() =>
        copyToMemberShare(share, id, "notes.md", join(FILES, "notes.md")),
      ).toThrow();
    for (const name of ["..", ".", "a/b", "../notes.md"])
      expect(() =>
        copyToMemberShare(share, AGENT, name, join(FILES, "notes.md")),
      ).toThrow();
    expect(readdirSync(share)).toEqual([]);
  });

  it("never writes through a link: at files/, at files/<agentId>/ or at the file", () => {
    const outside = tmp("member-share-outside-");
    writeFileSync(join(outside, "notes.md"), "OUTSIDE");
    const source = join(FILES, "notes.md");

    symlinkSync(outside, join(share, "files"));
    expect(() => copyToMemberShare(share, AGENT, "notes.md", source)).toThrow();
    rmSync(join(share, "files"));

    // A files/ the code keeps (0750 in the setgid share), so the link one
    // level down is what it meets.
    mkdirSync(join(share, "files"), { mode: 0o750 });
    expect(modeOf(join(share, "files"))).toBe(0o2750);
    symlinkSync(outside, join(share, "files", AGENT));
    expect(() => copyToMemberShare(share, AGENT, "notes.md", source)).toThrow();
    rmSync(join(share, "files", AGENT));

    mkdirSync(join(share, "files", AGENT), { mode: 0o750 });
    expect(modeOf(join(share, "files", AGENT))).toBe(0o2750);
    symlinkSync(
      join(outside, "notes.md"),
      join(share, "files", AGENT, "notes.md"),
    );
    expect(() => copyToMemberShare(share, AGENT, "notes.md", source)).toThrow();

    expect(readdirSync(outside)).toEqual(["notes.md"]);
    expect(readFileSync(join(outside, "notes.md"), "utf8")).toBe("OUTSIDE");
  });

  it("removes one agent's copies, or every agent's", () => {
    copyToMemberShare(share, AGENT, "notes.md", join(FILES, "notes.md"));
    copyToMemberShare(
      share,
      "other-agent",
      "notes.md",
      join(FILES, "notes.md"),
    );
    removeMemberShareFiles(share, AGENT);
    expect(existsSync(memberShareFilesDir(share, AGENT))).toBe(false);
    expect(existsSync(memberShareFilesDir(share, "other-agent"))).toBe(true);
    removeMemberShareFiles(share);
    expect(existsSync(join(share, "files"))).toBe(false);
  });
});

describe("the notices of a member's agent at standard", () => {
  it("name the share copy, never LOGS_DIR", () => {
    const notices = resolveAttachmentNotices(AGENT, [
      att("shot.png", "image/png"),
      att("notes.md", "text/markdown"),
    ]);
    expect(notices.map((n) => n.path)).toEqual([
      join(share, "files", AGENT, "shot.png"),
      join(share, "files", AGENT, "notes.md"),
    ]);
    expect(readFileSync(notices[0].path)).toEqual(PNG);
  });

  it("leave out a file whose copy fails, with a log line", () => {
    // files/ is a file: no copy can be made.
    writeFileSync(join(share, "files"), "");
    expect(
      resolveAttachmentNotices(AGENT, [att("notes.md", "text/markdown")]),
    ).toEqual([]);
    expect(errors.some((e) => e.includes("notes.md"))).toBe(true);
  });

  it("of an office agent keep the stored path", () => {
    setAgentShareResolver(null);
    expect(
      resolveAttachmentNotices(AGENT, [att("notes.md", "text/markdown")]).map(
        (n) => n.path,
      ),
    ).toEqual([join(FILES, "notes.md")]);
    expect(existsSync(join(share, "files"))).toBe(false);
  });
});

describe("a member's copies through their runner", () => {
  let dir: string;
  let runner: { stop(): void } | null;
  let host: AgentHost;
  let calls: { name: string; input: unknown }[];

  beforeEach(async () => {
    dir = tmp("member-att-runner-");
    const socketPath = join(dir, "runner.sock");
    runner = startRunner({
      socketPath,
      serverUid: process.getuid!(),
      readPeerUid: () => process.getuid!(),
      killGraceMs: 300,
    });
    const real = await RunnerAgentHost.connect(socketPath);
    calls = [];
    // The real runner, with each entry call recorded.
    host = Object.assign(Object.create(real) as AgentHost, {
      member: "u-alice",
      runEntry: (name: string, input: unknown) => {
        calls.push({ name, input });
        return real.runEntry(name, input);
      },
    });
  });

  afterEach(() => {
    runner?.stop();
    runner = null;
  });

  it("copies each file byte for byte into <folder>/attachments, from the share copy, and names the copy", async () => {
    const folder = tmp("member-att-folder-");
    const notices = await prepareMemberCopies(
      AGENT,
      [att("shot.png", "image/png"), att("notes.md", "text/markdown")],
      folder,
      host,
    );
    const copies = join(folder, "attachments");
    expect(notices.map((n) => n.path)).toEqual([
      join(copies, "shot.png"),
      join(copies, "notes.md"),
    ]);
    expect(readFileSync(join(copies, "shot.png"))).toEqual(PNG);
    expect(readFileSync(join(copies, "notes.md"), "utf8")).toBe("NOTES BODY\n");
    expect(modeOf(copies)).toBe(0o700);
    expect(modeOf(join(copies, "shot.png"))).toBe(0o600);
    // The runner reads the share copy, never the office's LOGS_DIR.
    expect(calls).toEqual([
      {
        name: "attachment-copy",
        input: {
          source: join(share, "files", AGENT, "shot.png"),
          folder,
          name: "shot.png",
        },
      },
      {
        name: "attachment-copy",
        input: {
          source: join(share, "files", AGENT, "notes.md"),
          folder,
          name: "notes.md",
        },
      },
    ]);
    // A second send replaces the copy.
    writeFileSync(join(FILES, "notes.md"), "SECOND\n");
    await prepareMemberCopies(
      AGENT,
      [att("notes.md", "text/markdown")],
      folder,
      host,
    );
    expect(readFileSync(join(copies, "notes.md"), "utf8")).toBe("SECOND\n");
  });

  it("refuses a link at attachments or at the file, and leaves the file out with a log line", async () => {
    const outside = tmp("member-att-outside-");
    writeFileSync(join(outside, "notes.md"), "OUTSIDE");
    const linked = tmp("member-att-folder-");
    symlinkSync(outside, join(linked, "attachments"));
    expect(
      await prepareMemberCopies(
        AGENT,
        [att("notes.md", "text/markdown")],
        linked,
        host,
      ),
    ).toEqual([]);
    const fileLink = tmp("member-att-folder-");
    mkdirSync(join(fileLink, "attachments"));
    symlinkSync(
      join(outside, "notes.md"),
      join(fileLink, "attachments", "notes.md"),
    );
    expect(
      await prepareMemberCopies(
        AGENT,
        [att("notes.md", "text/markdown")],
        fileLink,
        host,
      ),
    ).toEqual([]);
    expect(readdirSync(outside)).toEqual(["notes.md"]);
    expect(readFileSync(join(outside, "notes.md"), "utf8")).toBe("OUTSIDE");
    expect(errors.filter((e) => e.includes("notes.md"))).toHaveLength(2);
  });

  it("leaves out a file the office has not stored, or one with no share, with a log line and no runner call", async () => {
    const folder = tmp("member-att-folder-");
    expect(
      await prepareMemberCopies(
        AGENT,
        [att("gone.md", "text/markdown")],
        folder,
        host,
      ),
    ).toEqual([]);
    setAgentShareResolver(null);
    expect(
      await prepareMemberCopies(
        AGENT,
        [att("notes.md", "text/markdown")],
        folder,
        host,
      ),
    ).toEqual([]);
    expect(calls).toEqual([]);
    expect(errors).toHaveLength(2);
  });
});

describe("the delivery of a member's agent at folder and web", () => {
  it("is member-copy for a member's host and the office copy for the office's", () => {
    const member = { member: "u-alice" } as AgentHost;
    const office = { member: undefined } as unknown as AgentHost;
    expect(folderDelivery("/f", () => member).kind).toBe("member-copy");
    expect(folderDelivery("/f", () => office)).toEqual({
      kind: "copy",
      folder: "/f",
    });
  });

  it("refuses to build notices from a member-copy that was not prepared", () => {
    expect(() =>
      deliveredNotices(AGENT, [att("notes.md", "text/markdown")], {
        kind: "member-copy",
        folder: "/f",
        host: () => ({ member: "u-alice" }) as AgentHost,
      }),
    ).toThrow();
  });
});

describe("createSendOrder", () => {
  it("hands a fast send to the engine only after a slow one before it", async () => {
    const order = createSendOrder();
    const delivered: string[] = [];
    let release = () => {};
    const slow = new Promise<string>((resolve) => {
      release = () => resolve("one");
    });
    const first = order(
      () => slow,
      async (p) => {
        delivered.push(p);
      },
    );
    const second = order(
      async () => "two",
      async (p) => {
        delivered.push(p);
      },
    );
    await Bun.sleep(20);
    expect(delivered).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(delivered).toEqual(["one", "two"]);
  });

  it("does not hold the next send until a delivery resolves (a turn that runs)", async () => {
    const order = createSendOrder();
    const delivered: string[] = [];
    void order(
      async () => "one",
      (p) => {
        delivered.push(p);
        return new Promise<void>(() => {});
      },
    );
    const second = order(
      async () => "two",
      async (p) => {
        delivered.push(p);
      },
    );
    // Bounded: a send that waits for the turn before would never settle.
    await Promise.race([second, Bun.sleep(200)]);
    expect(delivered).toEqual(["one", "two"]);
  });

  it("rejects a send whose step failed and still delivers the next one", async () => {
    const order = createSendOrder();
    const delivered: string[] = [];
    const failed = order(
      async () => {
        throw new Error("copy failed");
      },
      async () => {
        delivered.push("one");
      },
    );
    const next = order(
      async () => "two",
      async (p) => {
        delivered.push(p);
      },
    );
    await expect(failed).rejects.toThrow("copy failed");
    await next;
    expect(delivered).toEqual(["two"]);
  });
});

// A Claude agent of an isolated member, below standard with a folder, through
// the session's send.
describe("a member's Claude agent at folder", () => {
  let iso: IsolatedMember;
  let alice: string;
  let entries: { name: string; input: Record<string, unknown> }[];
  let gate: Promise<void> | null;

  beforeEach(async () => {
    const made = createMember(`AttAlice${Date.now()}`, { role: "member" });
    if (!made.ok) throw new Error(made.error);
    alice = made.user.id;
    iso = await isolateMember(alice);
    entries = [];
    gate = null;
    // The member's runner: the copy done in process, after `gate`.
    (iso.member.host as { runEntry: unknown }).runEntry = async (
      name: string,
      input: Record<string, unknown>,
    ) => {
      entries.push({ name, input });
      if (gate) await gate;
      // Not the name the office's own copy would take: the notice must name
      // what the runner made.
      const dir = join(input.folder as string, "attachments");
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `runner-${input.name as string}`);
      writeFileSync(target, readFileSync(input.source as string));
      return { path: target };
    };
  });

  afterEach(() => {
    iso.dispose();
    deleteUserById(alice);
  });

  function session(cwd: string) {
    const fake = new FakeSdkClient();
    const s = createClaudeBackend(fake).createSession({
      agentId: AGENT,
      cwd,
      systemPrompt: "prompt",
      modelFamily: "haiku",
      effort: "high",
      permissionMode: "bypassPermissions",
      access: "folder",
      mcpServers: [],
      env: buildEnvForUserId(alice),
    });
    return { session: s, conv: fake.conversations.at(-1)! };
  }
  const textOf = (sent: unknown) => JSON.stringify(sent);

  it("gets the runner's copy in its folder, and no office path", async () => {
    const cwd = tmp("member-att-cwd-");
    const { session: s, conv } = session(cwd);
    await s.send("see", [att("notes.md", "text/markdown")]);
    expect(entries.map((e) => [e.name, e.input.source])).toEqual([
      ["attachment-copy", join(share, "files", AGENT, "notes.md")],
    ]);
    const text = textOf(conv.sends[0]);
    expect(text).toContain(join(cwd, "attachments", "runner-notes.md"));
    expect(text).not.toContain(join(STATE_ROOT, "logs"));
    expect(
      lstatSync(join(cwd, "attachments", "runner-notes.md")).isFile(),
    ).toBe(true);
    // The office made no copy of its own in the member's folder.
    expect(existsSync(join(cwd, "attachments", "notes.md"))).toBe(false);
    s.close();
  });

  // Round 1 F3: the host is asked at each message, not kept from the
  // session's start: a member who is no longer connected gets the not-ready
  // host, and the runner the session started with is not used.
  it("asks for the member's host at each message: after a disconnect nothing reaches the old runner", async () => {
    const cwd = tmp("member-att-cwd-");
    const { session: s, conv } = session(cwd);
    forgetMemberHost(alice);
    await s.send("see", [att("notes.md", "text/markdown")]);
    expect(entries).toEqual([]);
    expect(textOf(conv.sends[0])).not.toContain(join(cwd, "attachments"));
    expect(errors.some((e) => e.includes("notes.md"))).toBe(true);
    s.close();
  });

  it("keeps the order of its sends while a copy is made", async () => {
    const cwd = tmp("member-att-cwd-");
    const { session: s, conv } = session(cwd);
    let open = () => {};
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = s.send("FIRST", [att("notes.md", "text/markdown")]);
    const second = s.send("SECOND");
    await Bun.sleep(30);
    expect(conv.sends).toHaveLength(0);
    open();
    await Promise.all([first, second]);
    // The first send went through the runner's copy.
    expect(entries.map((e) => e.name)).toEqual(["attachment-copy"]);
    expect(
      conv.sends.map((m) => (textOf(m).includes("FIRST") ? 1 : 2)),
    ).toEqual([1, 2]);
    s.close();
  });
});

describe("a screenshot of a member's agent", () => {
  function affordances() {
    const agents = new Map([
      [AGENT, { info: { userId: "u-alice" } }],
    ]) as unknown as Parameters<typeof createAgentAffordances>[0]["agents"];
    return createAgentAffordances({
      agents,
      addLogEntry: () => undefined,
      prepareEnqueue: async () => {},
      enqueueMessage: (() => {}) as never,
      runBrowserAction: async () =>
        ({
          ok: true,
          url: "https://example.test/",
          title: "t",
          png: PNG,
          filename: "browser-shot.png",
          caption: "example.test",
        }) as never,
    });
  }

  it("names the copy in the member's share, which holds the same bytes", async () => {
    const result = (await affordances().runAgentBrowserAction(AGENT, {})) as {
      ok?: boolean;
      path?: string;
    };
    expect(result.path?.startsWith(join(share, "files", AGENT) + "/")).toBe(
      true,
    );
    expect(readFileSync(result.path!)).toEqual(PNG);
    expect(modeOf(result.path!)).toBe(0o640);
  });

  it("fails, and never names the office path, when the copy fails", async () => {
    writeFileSync(join(share, "files"), "");
    const result = (await affordances().runAgentBrowserAction(AGENT, {})) as {
      ok?: boolean;
      path?: string;
    };
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(join(STATE_ROOT, "logs"));
  });

  it("of an office agent names the stored file, as before", async () => {
    setAgentShareResolver(null);
    const result = (await affordances().runAgentBrowserAction(AGENT, {})) as {
      path?: string;
    };
    expect(result.path?.startsWith(FILES + "/")).toBe(true);
    expect(existsSync(join(share, "files"))).toBe(false);
  });
});
