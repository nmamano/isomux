// Task b1d7ef93: the member skill folder. One folder per member, engine and
// provider root holds the skills of the member's Sk menu that the engine does
// not read by itself, so the engine's own skill tool lists what the menu
// lists. These cases pin the builder, the folder path, the native folders it
// leaves out, the removal paths and the one-time cleanup of the links the old
// session-start passes wrote into provider homes.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  buildMemberSkillFolder,
  cleanupLegacySkillLinks,
  engineNativeSkillDirs,
  memberSkillFolderPath,
  removeMemberSkillFolders,
  sweepMemberSkillFolders,
} from "./member-skill-folder.ts";
import { ISOMUX_CODEX_HOME } from "./backends/codex/native-bin.ts";

const made: string[] = [];
function root(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `isomux-msf-${label}-`));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function skill(dir: string, name: string, text = `skill ${name}`): string {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), text);
  return join(dir, name);
}
function command(dir: string, name: string, text = `command ${name}`): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), text);
  return join(dir, `${name}.md`);
}
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};
const names = (dir: string) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
// The frontmatter of a SKILL.md, parsed as the engines do (strict YAML), and
// the body after it.
function parseSkill(path: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const text = readFileSync(path, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  expect([path, match !== null]).toEqual([path, true]);
  return {
    frontmatter: Bun.YAML.parse(match![1]) as Record<string, unknown>,
    body: match![2],
  };
}

// The menu's user folders and a bundled folder, as a session start passes
// them: the state skills first, then the box Claude root (skills and
// commands), then the box Codex root (skills only).
function fixture() {
  const state = root("state");
  const claude = root("claude");
  const codex = root("codex");
  const bundled = root("bundled");
  const folder = join(root("folder"), "variant");
  const userFolders = [
    { skills: join(state, "skills") },
    { skills: join(claude, "skills"), commands: join(claude, "commands") },
    { skills: join(codex, "skills") },
  ];
  for (const name of ["grill-me", "wrap-session"])
    skill(bundled, name, `bundled ${name}`);
  return { state, claude, codex, bundled, folder, userFolders };
}

describe("memberSkillFolderPath", () => {
  it("names one folder per member, engine and resolved provider root", () => {
    const state = root("path-state");
    const providerRoot = root("provider");
    const path = memberSkillFolderPath(
      "0a0b0c0d",
      "codex",
      providerRoot,
      state,
    );
    expect(dirname(dirname(path))).toBe(
      join(state, "member-skills", "0a0b0c0d"),
    );
    expect(basename(dirname(path))).toBe("codex");
    expect(basename(path)).toMatch(/^[0-9a-f]{8}$/);
    // The same root spelled another way is the same folder.
    expect(
      memberSkillFolderPath("0a0b0c0d", "codex", `${providerRoot}/`, state),
    ).toBe(path);
    expect(
      memberSkillFolderPath(
        "0a0b0c0d",
        "codex",
        join(providerRoot, "x", ".."),
        state,
      ),
    ).toBe(path);
    // Another root, engine or member is another folder.
    const others = [
      memberSkillFolderPath("0a0b0c0d", "codex", root("other"), state),
      memberSkillFolderPath("0a0b0c0d", "claude", providerRoot, state),
      memberSkillFolderPath("0a0b0c0e", "codex", providerRoot, state),
    ];
    expect(new Set([path, ...others]).size).toBe(4);
  });

  it("puts an agent with no member under .office", () => {
    const state = root("path-office");
    for (const userId of [null, undefined])
      expect(
        dirname(dirname(memberSkillFolderPath(userId, "claude", "/r", state))),
      ).toBe(join(state, "member-skills", ".office"));
  });
});

describe("engineNativeSkillDirs", () => {
  const sorted = (dirs: string[]) => [...dirs].sort();
  it("Claude: the skills and commands of its config dir", () => {
    expect(
      sorted(
        engineNativeSkillDirs("claude", { CLAUDE_CONFIG_DIR: "/c" }, "/h"),
      ),
    ).toEqual(["/c/commands", "/c/skills"]);
    expect(sorted(engineNativeSkillDirs("claude", {}, "/h"))).toEqual([
      "/h/.claude/commands",
      "/h/.claude/skills",
    ]);
  });

  it("Codex: its home's skills, the office Codex home without CODEX_HOME, and ~/.agents/skills", () => {
    expect(
      sorted(engineNativeSkillDirs("codex", { CODEX_HOME: "/x" }, "/h")),
    ).toEqual(["/h/.agents/skills", "/x/skills"]);
    expect(sorted(engineNativeSkillDirs("codex", {}, "/h"))).toEqual(
      sorted(["/h/.agents/skills", join(ISOMUX_CODEX_HOME, "skills")]),
    );
  });

  it("OpenCode: ~/.claude/skills unless its Claude Code flags are set, and ~/.agents/skills", () => {
    const plain = engineNativeSkillDirs("opencode", {}, "/h");
    expect(plain).toContain("/h/.claude/skills");
    expect(plain).toContain("/h/.agents/skills");
    for (const flag of [
      "OPENCODE_DISABLE_CLAUDE_CODE",
      "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
    ]) {
      const dirs = engineNativeSkillDirs("opencode", { [flag]: "true" }, "/h");
      expect([flag, dirs.includes("/h/.claude/skills")]).toEqual([flag, false]);
      expect([flag, dirs.includes("/h/.agents/skills")]).toEqual([flag, true]);
    }
  });
});

describe("buildMemberSkillFolder", () => {
  it("Claude: links the menu's skills, commands and bundled skills, the first name winning, and a member command over the bundled skill", () => {
    const f = fixture();
    const own = skill(join(f.state, "skills"), "shared", "state shared");
    skill(join(f.claude, "skills"), "shared", "claude shared");
    const fromClaude = skill(join(f.claude, "skills"), "claude-only");
    const fromCodex = skill(join(f.codex, "skills"), "codex-only");
    const cmd = command(join(f.claude, "commands"), "my-command");
    // A member's Claude command named like a bundled skill.
    const wrap = command(join(f.claude, "commands"), "wrap-session");

    const given = buildMemberSkillFolder({
      engine: "claude",
      folder: f.folder,
      userFolders: f.userFolders,
      bundledDir: f.bundled,
      nativeDirs: [],
    });

    expect(given).toBe(f.folder);
    const skills = join(f.folder, ".claude", "skills");
    const commands = join(f.folder, ".claude", "commands");
    expect(names(skills)).toEqual([
      "claude-only",
      "codex-only",
      "grill-me",
      "shared",
    ]);
    expect(names(commands)).toEqual(["my-command.md", "wrap-session.md"]);
    for (const [entry, source] of [
      [join(skills, "shared"), own],
      [join(skills, "claude-only"), fromClaude],
      [join(skills, "codex-only"), fromCodex],
      [join(skills, "grill-me"), join(f.bundled, "grill-me")],
      [join(commands, "my-command.md"), cmd],
      [join(commands, "wrap-session.md"), wrap],
    ])
      expect([entry, isLink(entry), real(entry)]).toEqual([
        entry,
        true,
        real(source),
      ]);
  });

  for (const engine of ["codex", "opencode"] as const) {
    it(`${engine}: links the skills under skills/ and turns a command into a generated skill at a stable path`, () => {
      const f = fixture();
      const own = skill(join(f.state, "skills"), "shared", "state shared");
      skill(join(f.claude, "skills"), "shared", "claude shared");
      const fromCodex = skill(join(f.codex, "skills"), "codex-only");
      command(
        join(f.claude, "commands"),
        "wrap-session",
        [
          "---",
          'description: "Ends: the session, with # and \\"quotes\\""',
          "allowed-tools: Bash",
          "---",
          "Wrap up the session. Focus: $ARGUMENTS",
          "",
        ].join("\n"),
      );
      command(join(f.claude, "commands"), "bare", "Do the bare thing.\n");

      const given = buildMemberSkillFolder({
        engine,
        folder: f.folder,
        userFolders: f.userFolders,
        bundledDir: f.bundled,
        nativeDirs: [],
      });

      const skills = join(f.folder, "skills");
      expect(given).toBe(skills);
      expect(names(skills)).toEqual([
        "bare",
        "codex-only",
        "grill-me",
        "shared",
        "wrap-session",
      ]);
      expect(real(join(skills, "shared"))).toBe(real(own));
      expect(real(join(skills, "codex-only"))).toBe(real(fromCodex));
      expect(real(join(skills, "grill-me"))).toBe(
        real(join(f.bundled, "grill-me")),
      );
      // The member's command wins over the bundled wrap-session, as a
      // generated skill whose path does not change with its content.
      expect(real(join(skills, "wrap-session"))).toBe(
        real(join(f.folder, "generated", "wrap-session")),
      );
      const wrap = parseSkill(join(skills, "wrap-session", "SKILL.md"));
      expect(wrap.frontmatter).toEqual({
        name: "wrap-session",
        description: 'Ends: the session, with # and "quotes"',
      });
      expect(wrap.body.trim()).toBe("Wrap up the session. Focus: $ARGUMENTS");
      // No frontmatter: the description falls back to the name.
      const bare = parseSkill(join(skills, "bare", "SKILL.md"));
      expect(bare.frontmatter).toEqual({ name: "bare", description: "bare" });
      expect(bare.body.trim()).toBe("Do the bare thing.");
    });

    it(`${engine}: leaves out what it cannot load: a command name it rejects, and skills and commands that opt out of model use`, () => {
      const f = fixture();
      const optOut =
        "---\ndescription: x\ndisable-model-invocation: true\n---\nbody\n";
      skill(join(f.claude, "skills"), "menu-only-skill", optOut);
      command(join(f.claude, "commands"), "menu-only-command", optOut);
      command(join(f.claude, "commands"), "Bad_Name");
      command(join(f.claude, "commands"), "a".repeat(65));
      command(join(f.claude, "commands"), "a".repeat(64));
      skill(join(f.claude, "skills"), ".hidden");

      buildMemberSkillFolder({
        engine,
        folder: f.folder,
        userFolders: f.userFolders,
        bundledDir: f.bundled,
        nativeDirs: [],
      });

      expect(names(join(f.folder, "skills"))).toEqual(
        ["a".repeat(64), "grill-me", "wrap-session"].sort(),
      );
    });
  }

  it("Claude: links the skills and commands that opt out of model use, which Claude honours itself, and never a dot name", () => {
    const f = fixture();
    const optOut =
      "---\ndescription: x\ndisable-model-invocation: true\n---\nbody\n";
    skill(join(f.claude, "skills"), "menu-only-skill", optOut);
    command(join(f.claude, "commands"), "menu-only-command", optOut);
    skill(join(f.claude, "skills"), ".hidden");

    buildMemberSkillFolder({
      engine: "claude",
      folder: f.folder,
      userFolders: f.userFolders,
      bundledDir: f.bundled,
      nativeDirs: [],
    });

    expect(names(join(f.folder, ".claude", "skills"))).toEqual([
      "grill-me",
      "menu-only-skill",
      "wrap-session",
    ]);
    expect(names(join(f.folder, ".claude", "commands"))).toEqual([
      "menu-only-command.md",
    ]);
  });

  for (const engine of ["claude", "codex"] as const) {
    it(`${engine}: leaves out every name the engine reads by itself, a bundled name included, and no name it cannot load`, () => {
      const f = fixture();
      const native = root("native");
      skill(join(f.claude, "skills"), "mine");
      command(join(f.claude, "commands"), "my-command");
      skill(join(f.claude, "skills"), "kept");
      skill(join(f.claude, "skills"), "dead");
      skill(join(f.claude, "skills"), "empty");
      // The engine's own copies: a skill, a command file and a bundled name.
      skill(join(native, "skills"), "mine");
      command(join(native, "commands"), "my-command");
      skill(join(native, "skills"), "grill-me");
      // Entries the engine loads nothing from: a dead link and a folder
      // without SKILL.md. The member's skills of those names stay.
      symlinkSync(join(native, "gone"), join(native, "skills", "dead"));
      mkdirSync(join(native, "skills", "empty"));

      buildMemberSkillFolder({
        engine,
        folder: f.folder,
        userFolders: f.userFolders,
        bundledDir: f.bundled,
        nativeDirs: [join(native, "skills"), join(native, "commands")],
      });

      const listed =
        engine === "claude"
          ? [
              ...names(join(f.folder, ".claude", "skills")),
              ...names(join(f.folder, ".claude", "commands")),
            ]
          : names(join(f.folder, "skills"));
      expect(listed.sort()).toEqual(["dead", "empty", "kept", "wrap-session"]);
    });
  }

  it("counts an old isomux link to the bundled skill as the bundled skill, so a member skill further down keeps the name", () => {
    const f = fixture();
    // A session start before this task linked the bundled skills into the
    // first user folder.
    mkdirSync(join(f.state, "skills"), { recursive: true });
    for (const name of ["grill-me", "wrap-session"])
      symlinkSync(join(f.bundled, name), join(f.state, "skills", name));
    const member = skill(join(f.codex, "skills"), "wrap-session", "member");

    buildMemberSkillFolder({
      engine: "codex",
      folder: f.folder,
      userFolders: f.userFolders,
      bundledDir: f.bundled,
      nativeDirs: [],
    });

    const skills = join(f.folder, "skills");
    expect(real(join(skills, "wrap-session"))).toBe(real(member));
    expect(real(join(skills, "grill-me"))).toBe(
      real(join(f.bundled, "grill-me")),
    );
  });

  it("rebuilds in place: a changed entry is replaced, a gone one removed, and the folders keep their identity", () => {
    const f = fixture();
    skill(join(f.claude, "skills"), "moves");
    skill(join(f.claude, "skills"), "goes");
    const cmd = command(join(f.claude, "commands"), "cmd", "first body\n");
    const build = () =>
      buildMemberSkillFolder({
        engine: "codex",
        folder: f.folder,
        userFolders: f.userFolders,
        bundledDir: f.bundled,
        nativeDirs: [],
      });
    const skills = join(f.folder, "skills");
    build();
    const ids = [f.folder, skills].map((dir) => statSync(dir).ino);
    expect(names(skills)).toEqual([
      "cmd",
      "goes",
      "grill-me",
      "moves",
      "wrap-session",
    ]);

    rmSync(join(f.claude, "skills", "goes"), { recursive: true });
    const moved = skill(join(f.state, "skills"), "moves", "now first");
    writeFileSync(cmd, "second body\n");
    build();

    expect(names(skills)).toEqual(["cmd", "grill-me", "moves", "wrap-session"]);
    expect(real(join(skills, "moves"))).toBe(real(moved));
    expect(readFileSync(join(skills, "cmd", "SKILL.md"), "utf8")).toContain(
      "second body",
    );
    expect(names(join(f.folder, "generated"))).toEqual(["cmd"]);
    expect([f.folder, skills].map((dir) => statSync(dir).ino)).toEqual(ids);

    rmSync(cmd);
    build();
    expect(names(skills)).toEqual(["grill-me", "moves", "wrap-session"]);
    expect(names(join(f.folder, "generated"))).toEqual([]);
  });

  // A scan by the engine (or Claude's skill watcher) runs while a rebuild
  // swaps entries: it must never find an entry or a folder missing.
  for (const engine of ["claude", "codex"] as const) {
    it(`${engine}: a scan that runs during rebuilds never misses an entry`, async () => {
      const f = fixture();
      const claudeSwing = skill(
        join(f.claude, "skills"),
        "swing",
        "claude swing",
      );
      const stateSwing = skill(join(f.state, "skills"), "swing", "state swing");
      command(join(f.claude, "commands"), "cmd", "body one\n");
      // Swapping the first two user folders moves swing between two sources
      // that both stay on disk, so only the builder can make it go missing.
      const [first, second, ...rest] = f.userFolders;
      const build = (flipped: boolean) =>
        buildMemberSkillFolder({
          engine,
          folder: f.folder,
          userFolders: flipped
            ? [second, first, ...rest]
            : [first, second, ...rest],
          bundledDir: f.bundled,
          nativeDirs: [],
        });
      expect(build(false)).not.toBeNull();
      const watched =
        engine === "claude"
          ? [
              join(f.folder, ".claude", "skills", "swing", "SKILL.md"),
              join(f.folder, ".claude", "commands", "cmd.md"),
              join(f.folder, ".claude", "skills", "grill-me", "SKILL.md"),
            ]
          : [
              join(f.folder, "skills", "swing", "SKILL.md"),
              join(f.folder, "skills", "cmd", "SKILL.md"),
              join(f.folder, "skills", "grill-me", "SKILL.md"),
            ];
      const stop = join(root("stop"), "stop");
      const observer = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const fs = require("node:fs");
           const [stop, ...paths] = JSON.parse(process.argv[1]);
           let scans = 0;
           const misses = paths.map(() => 0);
           console.log("ready");
           while (!fs.existsSync(stop)) {
             paths.forEach((p, i) => {
               try { fs.readFileSync(p); } catch { misses[i]++; }
             });
             scans++;
           }
           console.log(JSON.stringify({ scans, misses }));`,
          JSON.stringify([stop, ...watched]),
        ],
        { stdout: "pipe", stderr: "inherit" },
      );
      const reader = observer.stdout.getReader();
      const decoder = new TextDecoder();
      let out = "";
      while (!out.includes("ready")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        out += decoder.decode(chunk.value);
      }
      // Each round moves swing to the other source and changes the
      // command's body, so every rebuild replaces those entries.
      const swingPath = join(watched[0], "..");
      const wrong: string[] = [];
      for (let i = 0; i < 300; i++) {
        const flipped = i % 2 === 0;
        writeFileSync(join(f.claude, "commands", "cmd.md"), `body ${i}\n`);
        build(flipped);
        const expected = real(flipped ? claudeSwing : stateSwing);
        if (real(swingPath) !== expected) wrong.push(`round ${i}`);
        if (i % 50 === 0) await Bun.sleep(1);
      }
      // After every build swing is the source the folder order ranks first.
      expect(wrong).toEqual([]);
      writeFileSync(stop, "");
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        out += decoder.decode(chunk.value);
      }
      await observer.exited;
      const result = JSON.parse(out.split("\n").filter(Boolean).at(-1)!) as {
        scans: number;
        misses: [number, number, number];
      };
      // The scan ran alongside the rebuilds, so a miss had a chance to show.
      expect(result.scans).toBeGreaterThan(20);
      const [swing, cmd, grillMe] = result.misses;
      // cmd and grill-me never move: a miss there is the builder's.
      expect({ cmd, grillMe }).toEqual({ cmd: 0, grillMe: 0 });
      // swing's link is replaced by a rename every round, and on ext4 a reader
      // that follows a link being renamed over sometimes gets ENOENT from the
      // kernel itself. Measured on this case (2026-10-27): 0-2 misses in 10
      // runs for rename-over, 637 and 685 for unlink-then-symlink.
      expect(swing).toBeLessThanOrEqual(5);
    });
  }

  it("returns null and logs when the folder cannot be built, and never throws", () => {
    const f = fixture();
    const blocker = join(root("blocked"), "file");
    writeFileSync(blocker, "not a folder");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        buildMemberSkillFolder({
          engine: "codex",
          folder: join(blocker, "variant"),
          userFolders: f.userFolders,
          bundledDir: f.bundled,
          nativeDirs: [],
        }),
      ).toBeNull();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe("removing member skill folders", () => {
  it("removes every folder of one member, and the boot sweep the folders of members that are gone, keeping .office", () => {
    const state = root("remove-state");
    const folders = {
      a1: memberSkillFolderPath("0a0a0a0a", "claude", "/r1", state),
      a2: memberSkillFolderPath("0a0a0a0a", "codex", "/r2", state),
      b: memberSkillFolderPath("0b0b0b0b", "codex", "/r1", state),
      c: memberSkillFolderPath("0c0c0c0c", "opencode", "/r1", state),
      office: memberSkillFolderPath(null, "codex", "/r1", state),
    };
    for (const dir of Object.values(folders))
      mkdirSync(join(dir, "skills"), { recursive: true });

    removeMemberSkillFolders("0a0a0a0a", state);
    expect(existsSync(join(state, "member-skills", "0a0a0a0a"))).toBe(false);
    expect(existsSync(folders.b)).toBe(true);

    sweepMemberSkillFolders(["0b0b0b0b"], state);
    expect(names(join(state, "member-skills"))).toEqual([
      ".office",
      "0b0b0b0b",
    ]);
  });
});

describe("cleanupLegacySkillLinks", () => {
  it("removes only isomux's bundled links and the old personal-home links to the box root of the same name, once", () => {
    const bundled = root("legacy-bundled");
    for (const name of ["grill-me", "wrap-session"]) skill(bundled, name);
    const codexHome = root("legacy-codex-home");
    const boxClaude = root("legacy-box-claude");
    const boxCodex = root("legacy-box-codex");
    const personalClaude = root("legacy-personal-claude");
    const personalCodex = root("legacy-personal-codex");
    const marker = join(
      root("legacy-state"),
      "member-skills",
      ".legacy-cleaned",
    );
    const link = (to: string, at: string) => {
      mkdirSync(dirname(at), { recursive: true });
      symlinkSync(to, at);
      return at;
    };

    const gone = [
      // Bundled links in the office Codex home, the box Claude root and a
      // personal home.
      link(
        join(bundled, "wrap-session"),
        join(codexHome, "skills", "wrap-session"),
      ),
      link(join(bundled, "grill-me"), join(boxClaude, "skills", "grill-me")),
      link(
        join(bundled, "grill-me"),
        join(personalCodex, "skills", "grill-me"),
      ),
      // The old personal-home links to the same name in the box root.
      link(
        skill(join(boxClaude, "skills"), "box-skill"),
        join(personalClaude, "skills", "box-skill"),
      ),
      link(
        command(join(boxClaude, "commands"), "box-command"),
        join(personalClaude, "commands", "box-command.md"),
      ),
      link(
        skill(join(boxCodex, "skills"), "box-codex-skill"),
        join(personalCodex, "skills", "box-codex-skill"),
      ),
    ];
    const kept = [
      // Codex's own skills and a member's link to a bundled skill under
      // another name.
      skill(join(codexHome, "skills"), ".system"),
      link(join(bundled, "wrap-session"), join(codexHome, "skills", "my-wrap")),
      skill(join(codexHome, "skills"), "own-codex"),
      // The member's own skills in the box root.
      join(boxClaude, "skills", "box-skill"),
      skill(join(boxClaude, "skills"), "box-own"),
      // Personal-home entries of another shape: a link to another name in
      // the box root, a link to another engine's box root, a link elsewhere
      // and a folder.
      link(
        join(boxClaude, "skills", "box-own"),
        join(personalClaude, "skills", "renamed"),
      ),
      link(
        join(boxClaude, "skills", "box-own"),
        join(personalCodex, "skills", "box-own"),
      ),
      link(
        skill(root("legacy-elsewhere"), "elsewhere"),
        join(personalClaude, "skills", "elsewhere"),
      ),
      skill(join(personalClaude, "skills"), "personal-own"),
      command(join(personalClaude, "commands"), "personal-command"),
    ];

    const run = () =>
      cleanupLegacySkillLinks({
        codexHome,
        boxClaudeRoot: boxClaude,
        personalHomes: [
          { provider: "claude", root: personalClaude },
          { provider: "codex", root: personalCodex },
        ],
        sourceRoots: { claude: boxClaude, codex: boxCodex },
        bundledDir: bundled,
        marker,
      });
    run();

    for (const path of gone)
      expect([path, isLink(path) || existsSync(path)]).toEqual([path, false]);
    for (const path of kept)
      expect([path, isLink(path) || existsSync(path)]).toEqual([path, true]);
    expect(existsSync(marker)).toBe(true);

    // Once only: a bundled link made after the cleanup stays.
    const later = link(
      join(bundled, "wrap-session"),
      join(codexHome, "skills", "wrap-session"),
    );
    run();
    expect(isLink(later)).toBe(true);
  });
});
