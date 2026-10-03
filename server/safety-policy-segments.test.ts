import { describe, expect, it } from "bun:test";
import { evaluateProposedAction } from "./safety-policy.ts";

// These commands are classified only; none of them execute.
function decision(command: string): "allow" | "deny" {
  return evaluateProposedAction(
    { kind: "shell", command },
    { cwd: "/tmp/safety-segments" },
  ).decision;
}

// The denial with the echoed command taken out, so two lines can be compared.
function reason(command: string): string {
  const result = evaluateProposedAction(
    { kind: "shell", command },
    { cwd: "/tmp/safety-segments" },
  );
  return result.decision === "deny" ? result.reason.replace(command, "") : "";
}

describe("a safe fragment does not allow the rest of the line (F11)", () => {
  it.each([
    "git checkout -b x && git reset --hard HEAD~3",
    "rm -rf /tmp/a && rm -rf ./src",
    "git checkout -b x; git clean -fd",
    "git checkout -b x || git reset --hard",
    "git checkout -b x | git reset --hard",
    "git checkout -b x & git reset --hard",
    "git checkout -b x\ngit reset --hard",
    "git checkout -b x && (git reset --hard)",
    "git checkout -b x $(git reset --hard)",
    "git checkout -b x `git reset --hard`",
    "git clean -n && git clean -fd",
    "git restore --staged a; git restore b",
    "/usr/bin/git checkout -b x && /usr/bin/git reset --hard",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it("denies with the reason of the destructive segment", () => {
    expect(reason("git checkout -b x && git reset --hard HEAD~3")).toBe(
      reason("git reset --hard HEAD~3"),
    );
  });

  it.each([
    "git checkout -b x",
    "git checkout -b x && git status",
    "rm -rf /tmp/a && ls",
    "git clean -n && git status",
    "git restore --staged a; git diff",
  ])("still allows safe and neutral segments: %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  it("keeps the & of a redirection inside its segment", () => {
    expect(decision("git push origin main 2>&1 --force")).toBe("deny");
    expect(decision("git checkout -b x 2>&1 && git status")).toBe("allow");
  });

  it("keeps an escaped separator as data", () => {
    // `\;` is an argument of the one git command, not a second command.
    expect(decision("git checkout -b x \\; git reset --hard")).toBe("allow");
    expect(decision("git checkout -b x ; git reset --hard")).toBe("deny");
  });

  it("keeps quoted prose out of the segments", () => {
    expect(
      decision("git commit -m 'git reset --hard' && git checkout -b x"),
    ).toBe("allow");
    // A separator inside quotes does not start a segment.
    expect(decision("git commit -m 'wip; git reset --hard' && git status")).toBe(
      "allow",
    );
  });
});

describe("a descriptor number is not an operand", () => {
  it("finds the write target behind 2>/dev/null", () => {
    expect(decision("cp /tmp/x ~/.isomux/agents.json 2>/dev/null")).toBe(
      "deny",
    );
    expect(decision("cp /tmp/x /tmp/y 2>/dev/null")).toBe("allow");
  });

  it("keeps a quoted number as a word", () => {
    expect(decision("cp /tmp/x ~/.isomux/agents.json '2'>/dev/null")).toBe(
      "allow",
    );
  });
});

describe("rm is safe in a temp root only when every operand is there", () => {
  it.each([
    "rm -rf /tmp/a ./src",
    "rm -rf ./src /tmp/a",
    "rm -rf /tmp/a -- ./src",
    "rm -r -f /tmp/a ./src",
    "rm --recursive --force /tmp/a ./src",
    "sudo /bin/rm -rf /tmp/a ./src",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "rm -rf /tmp/a",
    "rm -rf /tmp/a /var/tmp/b",
    "rm -rf /tmp/a 2>/dev/null",
    "rm -rf /tmp/a 2> /dev/null",
    "rm -rf /tmp/a 2>&1",
    "rm -rf /tmp/a*",
    "rm -rf /var/tmp/a.b",
  ])("allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  // rm on /tmp/<name> removes that entry and never follows a symlink there.
  // Anything deeper can pass through a link, which the policy does not stat:
  // the link can come from earlier in the same command.
  it.each([
    "rm -rf /tmp/link/",
    "rm -rf /tmp/a/b",
    "rm -rf /tmp/a/*",
    "rm -rf /tmp/a/./b",
    "rm -rf /tmp/a /tmp/b/../c",
    "rm -rf /tmp/a /tmp/../home/data",
    "rm -rf /tmp/",
    "rm -rf /tmp/.",
    "rm -rf /tmp/..",
    "rm -rf /tmp/{a,..}",
    "rm -rf /tmp/a /tmp/.*",
    "rm -rf /var/tmp/c/",
    "ln -s ~ /tmp/l && rm -rf /tmp/l/",
  ])("allows only a direct child of a temp root: denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  // TMPDIR is usually unset, so `$TMPDIR/home` can be `/home`.
  it.each([
    "rm -rf $TMPDIR/home",
    "rm -rf ${TMPDIR}/etc",
    'rm -rf "$TMPDIR/home"',
    'rm -rf "${TMPDIR}/etc"',
    "rm -rf /tmp/a $TMPDIR/src",
    "rm -r -f $TMPDIR/home",
  ])("gives $TMPDIR no temp exception: denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it("does not let another expansion qualify by its prefix", () => {
    expect(decision("rm -rf /tmp/a /tmp/b")).toBe("allow");
    expect(decision("rm -rf /tmp/a /tmp/$name")).toBe("deny");
    expect(decision("rm -rf /tmp/a /tmp/$(pwd)")).toBe("deny");
  });

  it("reads a quoted operand by its content", () => {
    expect(decision('rm -rf /tmp/a "/tmp/b"')).toBe("allow");
    expect(decision("rm -rf /tmp/a '/var/tmp/b c'")).toBe("allow");
    expect(decision('rm -rf /tmp/a "./src"')).toBe("deny");
    expect(decision("rm -rf /tmp/a '/home/u'")).toBe("deny");
  });

  it("does not give a temp operand the root-or-home reason", () => {
    expect(reason("rm -rf /tmp/a ./src")).toBe(reason("rm -rf ./src"));
    expect(reason("rm -rf ./src /tmp/a")).toBe(reason("rm -rf ./src"));
    expect(reason("rm -rf /tmp/a/b ./src")).toBe(reason("rm -rf ./src"));
    expect(reason("rm -rf /tmp/a /home/u")).toBe(reason("rm -rf /home/u"));
    expect(reason("rm -rf /tmp/a /")).toBe(reason("rm -rf /"));
    expect(reason("rm -rf /home/u")).not.toBe(reason("rm -rf ./src"));
  });
});

describe("destructive commands in quoted payloads (a447b095)", () => {
  it.each([
    "bash -c 'git reset --hard'",
    'sh -c "git reset --hard"',
    "bash -lc 'cd x && git clean -fd'",
    "sudo bash -c 'rm -rf ./src'",
    `bash -c "bash -c 'git reset --hard'"`,
    "eval 'git reset --hard'",
    'echo "$(git reset --hard)"',
    'echo "`git reset --hard`"',
    'git checkout -b x "$(git reset --hard)"',
    'git reset "--hard"',
    "git reset '--hard'",
    'git re"set" --hard',
    '"git" reset --hard',
    "git reset \\--hard",
    'rm "-rf" ./src',
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "echo '$(git reset --hard)'",
    "git commit -m 'git reset --hard'",
    'git commit -m "rm -rf /"',
    "bash -c 'git status'",
  ])("allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  it("keeps a word that holds whitespace opaque, quoted or escaped", () => {
    // Read as tokens, the argument would be the SAFE `git clean -n`.
    expect(decision("git clean -fd 'git clean -n'")).toBe("deny");
    expect(decision("git clean -fd git\\ clean\\ -n")).toBe("deny");
    expect(decision("git checkout -b x git\\ reset\\ --hard")).toBe("allow");
  });

  it.each([
    "git restore --worktree -- 'git' 'clean' '-n'",
    "git restore --worktree -- git clean -n",
    "git reset --hard 'git' 'checkout' '-b' x",
    "git clean -fd -- git clean -n",
    "git push --force origin 'git' 'clean' '-n'",
  ])("takes no SAFE exception from operands: denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "git clean -n",
    'git clean "-n"',
    "sudo git clean -n",
    "env A=1 git checkout -b x",
    "/usr/bin/git checkout -b x",
    "git restore --staged 'a b'",
  ])("keeps the SAFE exception of the command itself: allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  it("judges each command a payload runs on its own", () => {
    expect(
      reason("bash -c 'git checkout -b x && git reset --hard HEAD~3'"),
    ).toBe(reason("git reset --hard HEAD~3"));
  });

  it("follows a payload into a reader behind an input redirect", () => {
    expect(decision("bash -c '< .env cat'")).toBe("deny");
    expect(decision("bash -c '< README.md cat'")).toBe("allow");
  });
});

describe("ANSI-C quoting reads as its decoded word", () => {
  it.each([
    "git reset $'--hard'",
    "git reset --$'ha'rd",
    "git reset $'\\x2d-hard'",
    "git reset $'\\055-hard'",
    "git reset $'\\u002d-hard'",
    "git commit -m $'it\\'s' && git reset --hard",
    "cat $'.env'",
    "cat $'.e'nv",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "echo $'$(git reset --hard)'",
    "echo $'`git reset --hard`'",
    "git commit -m $'it\\'s; git reset --hard'",
    "cat $'.env.example'",
    "cat $'.env.example\\0'",
  ])("allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  // Bash ends the value at a decoded NUL and still consumes the span.
  it.each([
    "git $'reset\\0ignored' --hard",
    "git $'reset\\x00ignored' --hard",
    "git $'reset\\c@ignored' --hard",
    "git $'re\\0x'set --hard",
    "cat $'.env\\0.example'",
    "cat $'.env\\u0000.example'",
  ])("ends the word at NUL: denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });
});

describe("the admin socket is not for agents (F6 guardrail)", () => {
  const sock = "/home/u/.isomux/admin.sock";

  it.each([
    `curl --unix-socket ${sock} -X POST http://localhost/admin/owner-login`,
    `curl --unix-socket="${sock}" http://localhost/`,
    `curl -s --unix-socket "$HOME/.isomux/admin.sock" http://localhost/`,
    `bash -c 'curl --unix-socket ${sock} http://localhost/'`,
    `nc -U ${sock}`,
    `socat - UNIX-CONNECT:${sock}`,
    "bun server/admin-cli.ts owner-login --name Nil",
    "bun run server/isomux-office.ts owner-login --name Nil",
    "sudo -u isomux bun run server/index.ts owner-login --name Nil",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "curl --unix-socket /run/docker.sock http://localhost/",
    "grep -rn admin.sock docs",
    "ls -la ~/.isomux/admin.sock",
    "bun run server/isomux-office.ts",
    "bun test server/safety-policy-segments.test.ts",
  ])("allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });
});

describe("git global options before the subcommand (d90b99a9)", () => {
  it.each([
    "git -C /x reset --hard",
    "git -C /x clean -fd",
    "git -C /x push --force",
    "git -c a=b reset --hard",
    "git -C /x -c a=b reset --merge",
    "git --git-dir=/x/.git reset --hard",
    "git --git-dir /x/.git --work-tree /x reset --hard",
    "git --work-tree=/x checkout -- f",
    "git --namespace=n push -f origin main",
    "git --no-pager -P --bare branch -D topic",
    "git --no-optional-locks restore f",
    'git -C "/a b" stash clear',
    "git -C '/x' reset '--hard'",
    "sudo git -C /x reset --hard",
    "/usr/bin/git -C /x reset --hard",
    "bash -c 'git -C /x reset --hard'",
    "git -C /x checkout -b y && git -C /x reset --hard",
    "git -C /x reset --hard 'git' 'clean' '-n'",
    "git -C '' reset --hard",
    'git -C "" clean -fd',
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "git -C /x status",
    "git -C /x clean -n",
    "git -C /x clean -nf",
    "git -C /x checkout -b y",
    "git -C /x restore --staged f",
    "git -c core.pager=cat log",
    "git --no-pager diff",
    "git -C '' status",
    'git -C "" clean -n',
  ])("allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  it("takes the next word as the value of -C and -c", () => {
    // A directory named `clean` is not the subcommand.
    expect(decision("git -C clean reset --hard")).toBe("deny");
    // A directory named `push` is not the subcommand either.
    expect(decision("git -C push status --force")).toBe("allow");
    expect(decision("git -c push status --force")).toBe("allow");
  });

  it.each([
    "git restore --staged git --worktree f",
    "git -C /x restore --staged git --worktree f",
    "git push origin git --force",
    "git -C /x push origin git --force",
  ])("keeps the flags after an operand named git: denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it("keeps an explicit empty word as an argument", () => {
    // Dropped, the empty value would let the flag take the next word.
    expect(decision('sudo -u "" pkill -f bun')).toBe("deny");
    expect(decision("cd '' && git status")).toBe("allow");
  });

  it("denies with the reason of the plain command", () => {
    expect(reason("git -C /x reset --hard HEAD~3")).toBe(
      reason("git reset --hard HEAD~3"),
    );
  });
});
