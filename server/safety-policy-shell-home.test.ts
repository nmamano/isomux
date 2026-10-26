// An OpenCode agent's shell runs with the agents' OS user's HOME and TMPDIR,
// as a Claude or Codex shell does (task 956b994b). The policy context carries
// them as shellHome and shellTmpDir, and the shell write check resolves ~,
// $HOME and $TMPDIR the way that shell does. The profile folders under the
// state root are not the agent's own space any more: every path under the
// state root refuses, also through ~. Without the fields (Claude, Codex)
// nothing changes.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { STATE_ROOT } from "./config.ts";
import {
  evaluateProposedAction,
  type PolicyContext,
  type PolicyDecision,
} from "./safety-policy.ts";

// These commands are classified only; none of them execute.
const cwd = "/tmp/safety-shell-home";
const profiles = join(STATE_ROOT, "opencode", "profiles");
const profile = join(profiles, "k");
// The OS user's folders, as the context carries them: outside the state
// root, and equal to the process home, as in a running office. A shell
// without TMPDIR is the common case.
const openCode: PolicyContext = { cwd, shellHome: homedir() };
const openCodeTmp: PolicyContext = {
  cwd,
  shellHome: homedir(),
  shellTmpDir: "/tmp/agent-shell-tmp",
};
const noShell: PolicyContext = { cwd };

const shell = (command: string, context: PolicyContext): PolicyDecision =>
  evaluateProposedAction({ kind: "shell", command }, context);
const write = (path: string, context: PolicyContext): PolicyDecision =>
  evaluateProposedAction(
    { kind: "write-files", toolName: "Write", input: { file_path: path } },
    context,
  );
const patch = (path: string, context: PolicyContext): PolicyDecision =>
  evaluateProposedAction(
    {
      kind: "patch-files",
      toolName: "apply_patch",
      patch: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`,
    },
    context,
  );

// The reason paragraph of a denial, without the echoed command or target;
// "allow" when the action is allowed.
function verdict(decision: PolicyDecision): string {
  return decision.decision === "deny"
    ? decision.reason.split("\n\n")[1]
    : "allow";
}

// Reference denials: a literal write to office state, from each surface.
const shellStateRoot = verdict(shell("cp a ~/.isomux/x", noShell));
const writeStateRoot = verdict(write(join(STATE_ROOT, "x"), noShell));
const patchStateRoot = verdict(patch(join(STATE_ROOT, "x"), noShell));
// A relative write after a cd the hook cannot follow.
const unresolvedCd = verdict(shell("cd; echo hi > x", noShell));

// The condition every comparison below depends on: the references are
// refusals, so a case that matches one is refused.
it("compares against refusals", () => {
  expect([
    shellStateRoot,
    writeStateRoot,
    patchStateRoot,
    unresolvedCd,
  ]).not.toContain("allow");
});

describe("an OpenCode shell's real home and tmp", () => {
  it("are what ~, $HOME and $TMPDIR resolve to, and are writable", () => {
    const commands = [
      "touch ~/x",
      "echo hi > ~/.gitconfig",
      "echo hi > $HOME/.gitconfig",
      'echo hi > "${HOME}/.cache/a"',
      "echo hi > $TMPDIR/x",
      "cd ~; mkdir -p .npm/a; cp a .npm/a/b",
      // Past the home: the folder above it is not office state.
      "touch ~/../x",
      "cd ~/..; echo hi > x",
    ];
    // One comparison, so a red run names every case that was refused.
    expect(commands.map((c) => [c, verdict(shell(c, openCodeTmp))])).toEqual(
      commands.map((c) => [c, "allow"]),
    );
  });

  it("without TMPDIR, a $TMPDIR target stays allowed", () => {
    // The shell expands $TMPDIR to nothing; the check does not open a
    // state path with it.
    expect(verdict(shell("echo hi > $TMPDIR/x", openCode))).toBe("allow");
  });

  it("are writable through the file tools", () => {
    const paths = [
      join(homedir(), "x"),
      join(homedir(), ".gitconfig"),
      "/tmp/agent-shell-tmp/x",
    ];
    expect(
      paths.flatMap((p) => [
        [`write ${p}`, verdict(write(p, openCode))],
        [`patch ${p}`, verdict(patch(p, openCode))],
      ]),
    ).toEqual(
      paths.flatMap((p) => [
        [`write ${p}`, "allow"],
        [`patch ${p}`, "allow"],
      ]),
    );
  });
});

describe("an OpenCode profile under the state root", () => {
  it("is refused from the shell, also through ~ and $HOME", () => {
    const commands = [
      `echo hi > ${join(profile, "home", "x")}`,
      `echo hi > ${join(profile, "tmp", "x")}`,
      `touch ${join(profile, "data", "x")}`,
      // Another profile's home is not this agent's.
      `echo hi > ${join(profiles, "other", "home", "x")}`,
      // The office state an agent types, from the real home.
      "cp a ~/.isomux/x",
      "echo hi > $HOME/.isomux/x",
      "HOME=~/.isomux; touch ~/x",
    ];
    expect(commands.map((c) => [c, verdict(shell(c, openCode))])).toEqual(
      commands.map((c) => [c, shellStateRoot]),
    );
  });

  it("stays refused after a cd the hook does not follow", () => {
    // A bare cd leaves the directory unresolved on every engine; following
    // it is allowed, opening the state root is not.
    const commands = ["cd; echo hi > ../data/x"];
    const opened = commands.filter(
      (c) =>
        ![shellStateRoot, unresolvedCd].includes(verdict(shell(c, openCode))),
    );
    expect(opened).toEqual([]);
  });

  it("is refused through the file tools, also by a path that leaves home", () => {
    const paths = [
      join(profile, "data", "x"),
      `${join(profile, "home")}/../data/x`,
      `${join(profile, "tmp")}/../state/x`,
      join(profiles, "other", "home", "x"),
    ];
    expect(
      paths.flatMap((p) => [
        [`write ${p}`, verdict(write(p, openCode))],
        [`patch ${p}`, verdict(patch(p, openCode))],
      ]),
    ).toEqual(
      paths.flatMap((p) => [
        [`write ${p}`, writeStateRoot],
        [`patch ${p}`, patchStateRoot],
      ]),
    );
  });
});

describe("a context that still names the profile folders", () => {
  // No production shell runs with these any more: the plugin passes the OS
  // user's values. The policy gives no own space for a home under the state
  // root; the profile's home and tmp were writable through this context
  // before task 956b994b removed the agent space.
  const profileContext: PolicyContext = {
    cwd,
    shellHome: join(profile, "home"),
    shellTmpDir: join(profile, "tmp"),
  };
  it("opens nothing from the shell, also through ~ and $TMPDIR", () => {
    const commands = [
      "touch ~/x",
      "echo hi > $TMPDIR/x",
      "touch ~/../data/x",
      `echo hi > ${join(profile, "home", "x")}`,
    ];
    expect(commands.map((c) => [c, verdict(shell(c, profileContext))])).toEqual(
      commands.map((c) => [c, shellStateRoot]),
    );
  });

  it("refuses the file tools", () => {
    const paths = [join(profile, "home", "x"), join(profile, "tmp", "x")];
    expect(
      paths.flatMap((p) => [
        [`write ${p}`, verdict(write(p, profileContext))],
        [`patch ${p}`, verdict(patch(p, profileContext))],
      ]),
    ).toEqual(
      paths.flatMap((p) => [
        [`write ${p}`, writeStateRoot],
        [`patch ${p}`, patchStateRoot],
      ]),
    );
  });
});

describe("a shell home or tmp folder that is not below the state root", () => {
  it("opens nothing when it is the state root or above it", () => {
    const atRoot: PolicyContext = {
      cwd,
      shellHome: STATE_ROOT,
      shellTmpDir: STATE_ROOT,
    };
    const above: PolicyContext = {
      cwd,
      shellHome: dirname(STATE_ROOT),
      shellTmpDir: dirname(STATE_ROOT),
    };
    expect([
      verdict(shell("touch ~/agents.json", atRoot)),
      verdict(shell("echo hi > $TMPDIR/agents.json", atRoot)),
      verdict(write(join(STATE_ROOT, "agents.json"), atRoot)),
      verdict(write(join(STATE_ROOT, "agents.json"), above)),
      verdict(shell(`echo hi > ${join(STATE_ROOT, "agents.json")}`, above)),
    ]).toEqual([
      shellStateRoot,
      shellStateRoot,
      writeStateRoot,
      writeStateRoot,
      shellStateRoot,
    ]);
  });
});

describe("reads in an OpenCode shell", () => {
  it("keep resolving ~ to the real home", () => {
    // Fail closed: the hook does not know which home a read means.
    const secret = "cat ~/.ssh/id_rsa";
    const refused = verdict(shell(secret, noShell));
    // The condition this test depends on: the read is refused today.
    expect(refused).not.toBe("allow");
    expect(verdict(shell(secret, openCode))).toBe(refused);
  });
});

describe("a shell without the fields (Claude, Codex)", () => {
  it("keeps today's outcomes", () => {
    expect([
      verdict(shell("touch ~/x", noShell)),
      verdict(shell("echo hi > $HOME/../x", noShell)),
      verdict(shell("echo hi > $TMPDIR/x", noShell)),
      verdict(shell(`echo hi > ${join(profile, "home", "x")}`, noShell)),
      verdict(write(join(profile, "home", "x"), noShell)),
      verdict(patch(join(profile, "tmp", "x"), noShell)),
    ]).toEqual([
      "allow",
      "allow",
      "allow",
      shellStateRoot,
      writeStateRoot,
      patchStateRoot,
    ]);
  });
});

describe("an office's own layout, with the state root at ~/.isomux", () => {
  it("keeps the real home and tmp writable, and refuses the office state in them", () => {
    // The test state root has no .isomux segment. An office's has: the real
    // home holds it, so a dynamic target that names the office state
    // refuses even though the home itself stays writable.
    const home = mkdtempSync(join(tmpdir(), "shell-home-layout-"));
    try {
      const stateRoot = join(home, ".isomux");
      const commands = [
        "echo hi > $TMPDIR/out-$$.txt",
        'echo hi > "$TMPDIR/$name"',
        "cp a $TMPDIR/*.txt",
        'echo hi > "$HOME/$name"',
        "touch ~/x",
        "touch ~/../x",
        "echo hi > $TMPDIR/../data/x",
        "echo hi > ~/.isomux/x",
        "echo hi > $HOME/.isomux/$f",
        `echo hi > ${join(stateRoot, "x")}`,
      ];
      const script = `
        const { STATE_ROOT } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
        const { evaluateProposedAction } = await import(${JSON.stringify(join(import.meta.dir, "safety-policy.ts"))});
        const input = JSON.parse(process.env.LAYOUT_INPUT);
        console.log(JSON.stringify({
          stateRoot: STATE_ROOT,
          verdicts: input.commands.map((command) => [
            command,
            evaluateProposedAction({ kind: "shell", command }, input.context).decision,
          ]),
        }));
      `;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          ISOMUX_HOME: stateRoot,
          LAYOUT_INPUT: JSON.stringify({
            commands,
            context: {
              cwd: join(home, "project"),
              shellHome: home,
              shellTmpDir: "/tmp/agent-shell-layout-tmp",
            },
          }),
        },
      });
      expect(child.stderr.toString()).toBe("");
      const output = JSON.parse(child.stdout.toString()) as {
        stateRoot: string;
        verdicts: [string, string][];
      };
      // The condition this test depends on: the child has the layout.
      expect(output.stateRoot).toBe(stateRoot);
      expect(output.verdicts).toEqual([
        ["echo hi > $TMPDIR/out-$$.txt", "allow"],
        ['echo hi > "$TMPDIR/$name"', "allow"],
        ["cp a $TMPDIR/*.txt", "allow"],
        ['echo hi > "$HOME/$name"', "allow"],
        ["touch ~/x", "allow"],
        ["touch ~/../x", "allow"],
        ["echo hi > $TMPDIR/../data/x", "allow"],
        ["echo hi > ~/.isomux/x", "deny"],
        ["echo hi > $HOME/.isomux/$f", "deny"],
        [`echo hi > ${join(stateRoot, "x")}`, "deny"],
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
