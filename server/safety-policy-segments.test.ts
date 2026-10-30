import { afterAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { evaluateProposedAction } from "./safety-policy.ts";

// These commands are classified only; none of them execute.
function decision(command: string): "allow" | "deny" {
  return evaluateProposedAction(
    { kind: "shell", command },
    { cwd: "/tmp/safety-segments" },
  ).decision;
}

// The denial with the echoed command taken out, so two lines can be compared.
// Only for a command that is denied: two allows would compare equal.
function reason(command: string): string {
  const result = evaluateProposedAction(
    { kind: "shell", command },
    { cwd: "/tmp/safety-segments" },
  );
  if (result.decision !== "deny") throw new Error(`not denied: ${command}`);
  return result.reason.replace(command, "");
}

describe("a safe fragment does not allow the rest of the line (F11)", () => {
  it.each([
    "git checkout -b x && git reset --hard HEAD~3",
    "rm -rf /tmp/a && rm -rf ./src",
    "git checkout -b x; git clean -fd",
    "git checkout -b x | git reset --hard",
    "git checkout -b x & git reset --hard",
    "git checkout -b x\ngit reset --hard",
    "git checkout -b x && (git reset --hard)",
    "git checkout -b x $(git reset --hard)",
    "git checkout -b x `git reset --hard`",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it("denies with the reason of the destructive segment", () => {
    expect(reason("git checkout -b x && git reset --hard HEAD~3")).toBe(
      reason("git reset --hard HEAD~3"),
    );
  });

  it.each(["git checkout -b x && git status", "rm -rf /tmp/a && ls"])(
    "still allows safe and neutral segments: %p",
    (command) => {
      expect(decision(command)).toBe("allow");
    },
  );

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
    expect(
      decision("git commit -m 'wip; git reset --hard' && git status"),
    ).toBe("allow");
  });
});

describe("git commands that throw away work", () => {
  it.each([
    "git restore README.md",
    "git stash drop",
    // checkout <ref> -- <path> overwrites the path from the ref.
    "git checkout HEAD -- README.md",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });
});

describe("a descriptor number is not an operand", () => {
  it("finds the write target behind 2>/dev/null", () => {
    expect(decision("cp /tmp/x ~/.isomux/agents.json 2>/dev/null")).toBe(
      "deny",
    );
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
    "rm -rf /tmp/a -- ./src",
    "rm -r -f /tmp/a ./src",
    // Flag spellings: a cluster in either order, separate flags in either
    // order, long options in either order, upper-case R, a verbose flag.
    "rm -fr /",
    "rm -fr ./build",
    "rm -f -r ./build",
    "rm -Rvf ./build",
    "rm --recursive --force /tmp/a ./src",
    "rm --force --recursive ./build",
    "sudo /bin/rm -rf /tmp/a ./src",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "rm -rf /tmp/a",
    "rm -rf /tmp/a /var/tmp/b",
    "rm -fr /tmp/x",
    "rm -f -r /tmp/x",
    "rm --force --recursive /tmp/x",
    "rm -Rvf /var/tmp/x",
    "rm -rf /tmp/a 2>/dev/null",
    "rm -rf /tmp/a 2>&1",
    "rm -rf /tmp/a*",
  ])("allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  // rm on /tmp/<name> removes that entry and never follows a symlink there.
  // A deeper path is checked on disk (the next describe); these deny on text.
  it.each([
    "rm -rf /tmp/",
    "rm -rf /tmp/.",
    "rm -rf /tmp/..",
    "rm -rf /tmp/{a,..}",
    "rm -rf /tmp/a /tmp/.*",
  ])("allows only a direct child of a temp root: denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  // TMPDIR is usually unset, so `$TMPDIR/home` can be `/home`.
  it.each(["rm -rf $TMPDIR/home", "rm -rf /tmp/a $TMPDIR/src"])(
    "gives $TMPDIR no temp exception: denies %p",
    (command) => {
      expect(decision(command)).toBe("deny");
    },
  );

  it("does not let another expansion qualify by its prefix", () => {
    expect(decision("rm -rf /tmp/a /tmp/$name")).toBe("deny");
  });

  it("reads a quoted operand by its content", () => {
    expect(decision('rm -rf /tmp/a "/tmp/b"')).toBe("allow");
    expect(decision("rm -rf /tmp/a '/var/tmp/b c'")).toBe("allow");
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

// A path deeper in a temp root can pass through a symlink, so every directory
// above the entry rm removes is checked on disk: a real directory or a missing
// one qualifies, a link does not. A line that runs ln can make the link before
// rm runs, so there only a direct child of the temp root qualifies (4b35d2a1).
describe("rm deeper in a temp root", () => {
  // The literal /tmp, not os.tmpdir(): the exception names /tmp itself.
  const R = mkdtempSync("/tmp/safety-rm-");
  const elsewhere = mkdtempSync("/tmp/safety-rm-target-");
  mkdirSync(`${R}/real/sub/deep`, { recursive: true });
  mkdirSync(`${R}/locked/sub`, { recursive: true });
  symlinkSync(elsewhere, `${R}/link`);
  symlinkSync(elsewhere, `${R}/real/inner`);
  writeFileSync(`${elsewhere}/keep`, "");
  chmodSync(`${R}/locked`, 0o000);
  afterAll(() => {
    chmodSync(`${R}/locked`, 0o755);
    rmSync(R, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });
  const rmReason = () => reason("rm -rf ./build");

  it("starts from the fixture it describes", () => {
    expect(lstatSync(`${R}/real`).isDirectory()).toBe(true);
    expect(lstatSync(`${R}/link`).isSymbolicLink()).toBe(true);
    expect(lstatSync(`${R}/real/inner`).isSymbolicLink()).toBe(true);
    expect(() => lstatSync(`${R}/missing`)).toThrow();
  });

  it.each([
    [`rm -rf ${R}/real/x`, "a real parent"],
    [`rm -rf ${R}/real/*`, "a glob in the last component"],
    [`rm -rf ${R}/real/sub/deep/*`, "every parent real, three deep"],
    [`rm -rf ${R}/real/`, "a trailing slash on a real directory"],
    [`rm -rf ${R}/`, "a trailing slash on a real direct child"],
    [`rm -rf ${R}/real/inner`, "a link as the entry removed, not followed"],
    [`rm -rf ${R}/missing/data2/x`, "a parent that does not exist"],
    [
      `mkdir -p ${R}/missing/data2 && rm -rf ${R}/missing/data2/*`,
      "made by mkdir -p on the same line",
    ],
    [`rm -rf ${R}/real/x ${R}/real/sub/y`, "two deep operands"],
    [`ln -s ~ ${R}/new && rm -rf ${R}`, "a direct child beside ln"],
  ])("allows %p (%s)", (command) => {
    expect(decision(command)).toBe("allow");
  });

  it("allows the reported clean-up line", () => {
    // Antifeed Worker 2, 2026-10-29, with its scratch directory moved to R.
    const line =
      `ss -ltn | grep -c ':21068 '; mkdir -p ${R}/data2 && rm -rf ${R}/data2/* && ` +
      `cd ~/nil/antifeed-wt-2 && (PORT=21068 ISOMUX_APP_DATA_DIR=${R}/data2 ` +
      `ANTIFEED_WALKTHROUGH=1 setsid nohup bun run src/main.ts > ${R}/app2.log ` +
      `2>&1 < /dev/null &); sleep 4; timeout 900 bun tools/card-checks.ts ` +
      `http://localhost:21068 2>&1 | grep -v "^PASS" | tail -4; ` +
      `grep -c "^PASS" <(timeout 1 true) ; pid=$(ss -ltnp | grep ':21068 ' | ` +
      `grep -o 'pid=[0-9]*' | cut -d= -f2); kill $pid`;
    expect(decision(line)).toBe("allow");
  });

  it.each([
    [`rm -rf ${R}/link/x`, "a link as a parent"],
    [`rm -rf ${R}/link/*`, "a glob under a link"],
    [`rm -rf ${R}/link/`, "a trailing slash on a link"],
    [`rm -rf ${R}/real/inner/x`, "a link two levels down"],
    [`rm -rf ${R}/real/inner/`, "a trailing slash on a link two levels down"],
    [`rm -rf ${R}/re*/x`, "a glob in a parent"],
    [`rm -rf ${R}/real/*/`, "a glob that a trailing slash makes a parent"],
    [`rm -rf ${R}/real/../x`, "a .. component"],
    [`rm -rf ${R}/real/./x`, "a . component"],
    [`rm -rf ${R}//real/x`, "an empty component"],
    [`rm -rf ${R}/$x/y`, "an expansion in a parent"],
    [`rm -rf ${R}/real/.*`, "a glob that can match .."],
    [`rm -rf ${R}/locked/sub/x`, "a parent the hook cannot read"],
    [`rm -rf ${R}/real/x ${R}/link/x`, "one good operand, one through a link"],
    [`ln -s ~ ${R}/fresh && rm -rf ${R}/fresh/x`, "ln makes the parent first"],
    [`ln -s ~ ${R}/other; rm -rf ${R}/real/x`, "ln anywhere on the line"],
    [`bash -c "ln -s ~ ${R}/fresh" && rm -rf ${R}/fresh/x`, "ln in bash -c"],
    [`sudo ln -s ~ ${R}/fresh && rm -rf ${R}/fresh/x`, "ln behind a wrapper"],
    [
      `find ${R}/real -maxdepth 0 -exec ln -s ~ ${R}/fresh \\; ; rm -rf ${R}/fresh/x`,
      "ln in a find -exec list",
    ],
  ])("denies %p (%s) with the rm reason", (command) => {
    expect(reason(command)).toBe(rmReason());
  });

  it("cannot read a parent it has no permission for", () => {
    // The enabling condition of the case above: the walk meets EACCES, not
    // ENOENT. Running as root would make this case meaningless.
    expect(() => lstatSync(`${R}/locked/sub`)).toThrow(/EACCES/);
  });

  it("gives a temp operand next to a real path the reason of the real path", () => {
    expect(reason(`rm -rf ${R}/real/x ./src`)).toBe(reason("rm -rf ./src"));
    expect(reason(`rm -rf ${R}/real/x /home/u`)).toBe(reason("rm -rf /home/u"));
  });

  it("reads the disk at each check, not once", () => {
    const command = `rm -rf ${R}/later/x`;
    expect(decision(command)).toBe("allow");
    symlinkSync(elsewhere, `${R}/later`);
    expect(decision(command)).toBe("deny");
  });
});

describe("destructive commands in quoted payloads (a447b095)", () => {
  it.each([
    "bash -c 'git reset --hard'",
    "bash -lc 'cd x && git clean -fd'",
    "sudo bash -c 'rm -rf ./src'",
    `bash -c "bash -c 'git reset --hard'"`,
    "eval 'git reset --hard'",
    'echo "$(git reset --hard)"',
    'echo "`git reset --hard`"',
    'git reset "--hard"',
    "git reset '--hard'",
    "git reset \\--hard",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "echo '$(git reset --hard)'",
    "git commit -m 'git reset --hard'",
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
    "git reset $'\\x2d-hard'",
    "git reset $'\\055-hard'",
    "git reset $'\\u002d-hard'",
    "git commit -m $'it\\'s' && git reset --hard",
    "cat $'.env'",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "echo $'$(git reset --hard)'",
    "git commit -m $'it\\'s; git reset --hard'",
    "cat $'.env.example\\0'",
  ])("allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  // Bash ends the value at a decoded NUL and still consumes the span.
  it.each([
    "git $'reset\\c@ignored' --hard",
    "git $'re\\0x'set --hard",
    "cat $'.env\\0.example'",
  ])("ends the word at NUL: denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });
});

describe("the admin socket is not for agents (F6 guardrail)", () => {
  const sock = "/home/u/.isomux/admin.sock";

  it.each([
    `curl --unix-socket ${sock} -X POST http://localhost/admin/owner-login`,
    `curl --unix-socket="${sock}" http://localhost/`,
    `bash -c 'curl --unix-socket ${sock} http://localhost/'`,
    `nc -U ${sock}`,
    `socat - UNIX-CONNECT:${sock}`,
    "bun server/admin-cli.ts owner-login --name Nil",
    "bun run server/isomux-office.ts owner-login --name Nil",
    `curl --un ${sock} http://localhost/`,
    `curl --abstract-unix-socket ${sock} http://localhost/`,
    `curl -d '{"a":1}' --unix-socket ${sock} http://localhost/admin/owner-login`,
    "node server/admin-cli.ts",
    "npx tsx server/admin-cli.ts owner-login --name Nil",
    "bunx --bun tsx server/admin-cli.ts",
    "bun x tsx server/admin-cli.ts",
    "npx -p eslint tsx server/admin-cli.ts",
    "bunx admin-cli owner-login",
    "npx tsx@4 server/admin-cli.ts owner-login --name Nil",
    "npx --package=eslint tsx server/admin-cli.ts",
    `curl --data-ra "--unix-socket" --unix-socket ${sock} http://localhost/`,
    `curl --head --unix-socket ${sock} http://localhost/`,
    "npx --registry r tsx server/admin-cli.ts",
    "npx --some-flag tsx server/isomux-office.ts owner-login --name Nil",
    "npx -c 'tsx server/admin-cli.ts'",
    "npx --call='node server/admin-cli.ts owner-login'",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    "curl --unix-socket /run/docker.sock http://localhost/",
    "grep -rn admin.sock docs",
    "bun run server/isomux-office.ts",
  ])("allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  // A mention is not a use (task 6079230f): a message body that names the
  // socket, and a package that takes admin-cli as a file to read.
  const body = JSON.stringify({
    text: `curl --unix-socket ${sock} http://localhost/admin/owner-login`,
  });
  it.each([
    `curl -s -X POST localhost:4000/api/agents/a1/messages -H "Content-Type: application/json" -d '${body}'`,
    `curl -s localhost:4000/x --data-raw '${body}' -o admin.sock.log`,
    `bash -c "curl -s localhost:4000/x -d 'bun server/admin-cli.ts owner-login ${sock}'"`,
    "bunx eslint server/admin-cli.ts",
    "bunx eslint tsx server/admin-cli.ts",
    `curl -d "--unix-socket" http://example.com/admin.sock`,
    `curl -sd --unix-socket http://example.com/admin.sock`,
    `curl -- --unix-socket ${sock}`,
    "npx -c 'cat server/admin-cli.ts'",
  ])("allows the mention %p", (command) => {
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
    'git -C "/a b" stash clear',
    "sudo git -C /x reset --hard",
    "/usr/bin/git -C /x reset --hard",
    "git -C '' reset --hard",
  ])("denies %p", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each(["git -C /x clean -n", "git -C /x clean -nf"])(
    "allows %p",
    (command) => {
      expect(decision(command)).toBe("allow");
    },
  );

  it("takes the next word as the value of -C and -c", () => {
    // A directory named `clean` is not the subcommand.
    expect(decision("git -C clean reset --hard")).toBe("deny");
    // A directory named `push` is not the subcommand either.
    expect(decision("git -C push status --force")).toBe("allow");
  });

  it.each([
    "git restore --staged git --worktree f",
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
