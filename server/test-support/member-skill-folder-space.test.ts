// An isolated member's skill folder (part 2d-iii-a of task b94dfd25): their
// runner builds it in their agent space from strings and the bundled skills
// as bytes. The properties:
// - a session gets the path only after a build for its input answered, one
//   build per input runs at a time, and a reply other than the expected path
//   is no path;
// - the bundle is checked before the call and again in the runner, and the
//   runner writes only below <agentRoot>/skill-folders;
// - the folder links only to the bundled copy and the member's own folders;
//   the runner keeps the current bundled copy and the one before it.
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import type { AgentHost } from "../agent-host.ts";
import {
  createMemberSkillFolders,
  engineSkillPath,
  readSkillBundle,
  SKILL_FOLDER_TIMEOUT_MS,
  type MemberSkillFolderInput,
} from "../member-skill-folder-host.ts";
import {
  buildSkillFolderAsMember,
  skillBundleHash,
  skillBundleProblem,
  skillFolderRequest,
  type SkillBundleFile,
} from "../skill-folder-runner.ts";

const scratch: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const b64 = (text: string) => Buffer.from(text).toString("base64");
const BUNDLE: SkillBundleFile[] = [
  { path: "wrap-up/SKILL.md", base64: b64("---\nname: wrap-up\n---\nWrap.") },
];

function inputAt(agentRoot: string, engine: "claude" | "codex" = "claude") {
  return {
    engine,
    agentRoot,
    folder: join(agentRoot, "skill-folders", engine, "0123abcd"),
    userFolders: [] as { skills: string; commands?: string }[],
    nativeDirs: [] as string[],
  } satisfies MemberSkillFolderInput;
}

describe("the office's side of the build", () => {
  function host(answer: (input: Record<string, unknown>) => Promise<unknown>) {
    const calls: { input: Record<string, unknown>; timeoutMs: unknown }[] = [];
    return {
      calls,
      host: {
        member: "u-alice",
        runEntry: (
          _name: string,
          input: Record<string, unknown>,
          timeoutMs?: number,
        ) => {
          calls.push({ input, timeoutMs });
          return answer(input);
        },
      } as unknown as AgentHost,
    };
  }

  it("gives no path before the build answered, then the expected path; one build per input", async () => {
    const input = inputAt("/home/alice/.isomux-agent");
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = host(async () => {
      await gate;
      return { path: engineSkillPath(input) };
    });
    const folders = createMemberSkillFolders({ bundle: () => BUNDLE });
    expect(folders.pathFor(h.host, "u-alice", input)).toBeNull();
    expect(folders.pathFor(h.host, "u-alice", input)).toBeNull();
    const joined = folders.build(h.host, "u-alice", input);
    expect(h.calls).toHaveLength(1);
    release();
    expect(await joined).toBe(input.folder);
    expect(folders.pathFor(h.host, "u-alice", input)).toBe(input.folder);
    // The call had a time bound and carried the bundle as bytes.
    expect(typeof h.calls[0].timeoutMs).toBe("number");
    expect(h.calls[0].timeoutMs as number).toBeLessThanOrEqual(
      SKILL_FOLDER_TIMEOUT_MS,
    );
    expect(h.calls[0].input.bundle).toEqual(BUNDLE);
  });

  it("gives the folder's skills/ for Codex", async () => {
    const input = inputAt("/home/alice/.isomux-agent", "codex");
    const h = host(async () => ({ path: join(input.folder, "skills") }));
    const folders = createMemberSkillFolders({ bundle: () => BUNDLE });
    expect(await folders.build(h.host, "u-alice", input)).toBe(
      join(input.folder, "skills"),
    );
  });

  const replies: [string, unknown][] = [
    ["another path", { path: "/home/alice/elsewhere" }],
    [
      "an extra key",
      {
        path: "/home/alice/.isomux-agent/skill-folders/claude/0123abcd",
        extra: 1,
      },
    ],
    ["no record", "/home/alice/.isomux-agent/skill-folders/claude/0123abcd"],
  ];
  for (const [what, reply] of replies)
    it(`gives no path for a reply with ${what}`, async () => {
      const input = inputAt("/home/alice/.isomux-agent");
      const h = host(async () => reply);
      const folders = createMemberSkillFolders({ bundle: () => BUNDLE });
      expect(await folders.build(h.host, "u-alice", input)).toBeNull();
      expect(folders.pathFor(h.host, "u-alice", input)).toBeNull();
    });

  it("gives no path after a failed or silent call", async () => {
    const input = inputAt("/home/alice/.isomux-agent");
    const h = host(() => Promise.reject(new Error("timed out")));
    const folders = createMemberSkillFolders({ bundle: () => BUNDLE });
    expect(await folders.build(h.host, "u-alice", input)).toBeNull();
    expect(folders.pathFor(h.host, "u-alice", input)).toBeNull();
  });

  it("makes no call with a bundle out of bounds", async () => {
    const input = inputAt("/home/alice/.isomux-agent");
    const h = host(async () => ({ path: input.folder }));
    for (const bundle of [
      [{ path: "../x", base64: b64("x") }],
      [{ path: "a/../../x", base64: b64("x") }],
      [{ path: ".hidden/SKILL.md", base64: b64("x") }],
      [{ path: "/abs/SKILL.md", base64: b64("x") }],
      [
        {
          path: "big",
          base64: Buffer.alloc(256 * 1024 + 1).toString("base64"),
        },
      ],
    ]) {
      const folders = createMemberSkillFolders({ bundle: () => bundle });
      expect(await folders.build(h.host, "u-alice", input)).toBeNull();
    }
    expect(h.calls).toEqual([]);
  });

  it("reads the real bundled skills within the bounds", () => {
    const bundle = readSkillBundle();
    expect(bundle.length).toBeGreaterThan(0);
    expect(skillBundleProblem(bundle)).toBeNull();
  });
});

describe("the runner's side of the build", () => {
  it("refuses a folder outside <agentRoot>/skill-folders/<engine>/<key>", () => {
    const req = (folder: string) => ({
      ...inputAt("/home/a/.isomux-agent"),
      folder,
      bundle: BUNDLE,
    });
    skillFolderRequest(
      req("/home/a/.isomux-agent/skill-folders/claude/0123abcd"),
    );
    for (const folder of [
      "/home/a/.isomux-agent/skill-folders/codex/0123abcd",
      "/home/a/.isomux-agent/skill-folders/claude/bundled",
      "/home/a/.isomux-agent/skill-folders/claude/0123abcd/x",
      "/home/a/.isomux-agent/skill-folders/claude/../claude/0123abcd",
      "/home/a/.ssh",
    ])
      expect(() => skillFolderRequest(req(folder))).toThrow();
  });

  it("checks the bundle again before it writes", () => {
    const agentRoot = tmp("member-space-");
    const req = {
      ...inputAt(agentRoot),
      bundle: [{ path: "../escape", base64: b64("x") }],
    };
    expect(() => skillFolderRequest(req)).toThrow();
    expect(readdirSync(agentRoot)).toEqual([]);
  });

  it("builds a folder that links only to the bundled copy and the member's own folders", () => {
    const agentRoot = tmp("member-space-");
    const own = tmp("member-claude-");
    mkdirSync(join(own, "skills", "mine"), { recursive: true });
    writeFileSync(
      join(own, "skills", "mine", "SKILL.md"),
      "---\nname: mine\n---\nMine.",
    );
    const req = skillFolderRequest({
      ...inputAt(agentRoot),
      userFolders: [{ skills: join(own, "skills") }],
      bundle: BUNDLE,
    });
    const path = buildSkillFolderAsMember(req);
    expect(path).toBe(req.folder);
    const copy = join(
      agentRoot,
      "skill-folders",
      "bundled",
      skillBundleHash(BUNDLE),
    );
    expect(statSync(copy).mode & 0o777).toBe(0o700);
    expect(statSync(join(copy, "wrap-up", "SKILL.md")).mode & 0o777).toBe(
      0o600,
    );
    // Claude reads <folder>/.claude/skills.
    const skills = join(path, ".claude", "skills");
    const names = readdirSync(skills).sort();
    expect(names).toEqual(["mine", "wrap-up"]);
    for (const name of names) {
      const real = realpathSync(join(skills, name));
      const allowed = [copy, own].some(
        (dir) =>
          real === realpathSync(dir) ||
          real.startsWith(realpathSync(dir) + sep),
      );
      expect([name, allowed]).toEqual([name, true]);
    }
  });

  it("keeps the current bundled copy and the one before it, and removes older ones", () => {
    const agentRoot = tmp("member-space-");
    const bundled = join(agentRoot, "skill-folders", "bundled");
    const old = (name: string, ageS: number) => {
      mkdirSync(join(bundled, name), { recursive: true });
      const t = Date.now() / 1000 - ageS;
      utimesSync(join(bundled, name), t, t);
    };
    old("a".repeat(64), 300);
    old("b".repeat(64), 200);
    old("c".repeat(64), 100);
    // Temp copies: one of a build that stopped long ago, one of a build
    // that may still run.
    old(".tmp-1-dead", 3600);
    old(".tmp-2-live", 5);
    buildSkillFolderAsMember(
      skillFolderRequest({ ...inputAt(agentRoot), bundle: BUNDLE }),
    );
    expect(readdirSync(bundled).sort()).toEqual(
      [".tmp-2-live", "c".repeat(64), skillBundleHash(BUNDLE)].sort(),
    );
  });

  it("writes nothing outside <agentRoot>/skill-folders", () => {
    const agentRoot = tmp("member-space-");
    buildSkillFolderAsMember(
      skillFolderRequest({ ...inputAt(agentRoot), bundle: BUNDLE }),
    );
    expect(readdirSync(agentRoot)).toEqual(["skill-folders"]);
    expect(lstatSync(join(agentRoot, "skill-folders")).isDirectory()).toBe(
      true,
    );
    expect(existsSync(resolve(agentRoot, "..", "bundled"))).toBe(false);
  });
});
