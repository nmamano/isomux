// An OpenCode agent's shell runs with HOME and TMPDIR in its profile folder,
// under the state root (task fc942b38). The policy context carries them as
// shellHome and shellTmpDir, and the shell write check resolves ~, $HOME and
// $TMPDIR the way that shell does. The two folders stay writable: they are
// the agent's own space. The profile's other folders, and every other path
// under the state root, stay refused. Without the fields (Claude, Codex)
// nothing changes.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
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
const openCode: PolicyContext = {
  cwd,
  shellHome: join(profile, "home"),
  shellTmpDir: join(profile, "tmp"),
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

describe("an OpenCode shell's home and tmp folders", () => {
  it("are what ~, $HOME and $TMPDIR resolve to, and are writable", () => {
    const commands = [
      "touch ~/x",
      "echo hi > ~/.gitconfig",
      "echo hi > $HOME/.gitconfig",
      'echo hi > "${HOME}/.cache/a"',
      "echo hi > $TMPDIR/x",
      "cd ~; mkdir -p .npm/a; cp a .npm/a/b",
      `echo hi > ${join(profile, "home", "x")}`,
      `echo hi > ${join(profile, "tmp", "x")}`,
    ];
    // One comparison, so a red run names every case that was refused.
    expect(commands.map((c) => [c, verdict(shell(c, openCode))])).toEqual(
      commands.map((c) => [c, "allow"]),
    );
  });

  it("are writable through the file tools", () => {
    const paths = [join(profile, "home", "x"), join(profile, "tmp", "x")];
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

describe("the rest of an OpenCode profile", () => {
  it("is refused from the shell, through .. from ~, $HOME, $TMPDIR and cd", () => {
    const commands = [
      "touch ~/../data/x",
      "echo hi > $HOME/../data/x",
      "echo hi > ${HOME}/../config/x",
      'echo hi > "$TMPDIR/../state/x"',
      "cp a ~/../opencode.json",
      "cd ~/..; echo hi > data/x",
      // The starting home counts too: the assignment may not run.
      "false && HOME=/tmp/elsewhere; touch ~/../data/x",
      // Another profile's home is not this agent's.
      `echo hi > ${join(profiles, "other", "home", "x")}`,
      "touch ~/../../other/home/x",
    ];
    expect(commands.map((c) => [c, verdict(shell(c, openCode))])).toEqual(
      commands.map((c) => [c, shellStateRoot]),
    );
  });

  it("stays refused after a cd the hook does not follow", () => {
    // A bare cd and a cd to a variable leave the directory unresolved on
    // every engine; following them is allowed, opening them is not.
    const commands = ["cd; echo hi > ../data/x", "cd $HOME/..; touch data/x"];
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

  it("keeps a literal ~/.isomux refused", () => {
    // In this shell ~/.isomux is inside the profile home, but an agent that
    // types it means office state.
    expect(verdict(shell("cp a ~/.isomux/x", openCode))).toBe(shellStateRoot);
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
  it("keeps a dynamic target in the home and tmp folders writable", () => {
    // The test state root has no .isomux segment. An office's has, and so
    // does every profile path under it: only a process with that layout
    // sees a check that reads the folder's own path as a written .isomux.
    const home = mkdtempSync(join(tmpdir(), "shell-home-layout-"));
    try {
      const stateRoot = join(home, ".isomux");
      const profile = join(stateRoot, "opencode", "profiles", "k");
      const commands = [
        "echo hi > $TMPDIR/out-$$.txt",
        'echo hi > "$TMPDIR/$name"',
        "cp a $TMPDIR/*.txt",
        'echo hi > "$HOME/$name"',
        "touch ~/x",
        `touch ${join(profile, "home", "x")}`,
        "touch ~/../data/x",
        "echo hi > $TMPDIR/../data/$f",
        "echo hi > ~/.isomux/x",
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
              shellHome: join(profile, "home"),
              shellTmpDir: join(profile, "tmp"),
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
        [`touch ${join(profile, "home", "x")}`, "allow"],
        ["touch ~/../data/x", "deny"],
        ["echo hi > $TMPDIR/../data/$f", "deny"],
        ["echo hi > ~/.isomux/x", "deny"],
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
