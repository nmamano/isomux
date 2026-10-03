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
    "rm -rf $TMPDIR/a",
    "rm -rf ${TMPDIR}/a",
    "rm -rf /tmp/a/./b /var/tmp/c/",
    "rm -rf /tmp/a/*",
  ])("allows %p", (command) => {
    expect(decision(command)).toBe("allow");
  });

  it("judges containment on the normalized path, not a prefix", () => {
    expect(decision("rm -rf /tmp/a /tmp/b/../c")).toBe("allow");
    expect(decision("rm -rf /tmp/a /tmp/../home/data")).toBe("deny");
    expect(decision("rm -rf /tmp/")).toBe("deny");
    expect(decision("rm -rf /tmp/a /tmp/.*")).toBe("deny");
  });

  it("accepts $TMPDIR by its exact name only", () => {
    expect(decision("rm -rf /tmp/a ${TMPDIR}/src")).toBe("allow");
    expect(decision("rm -rf /tmp/a ${TMPDIR_OTHER}/src")).toBe("deny");
    expect(decision("rm -rf /tmp/a $TMPDIRX/src")).toBe("deny");
    expect(decision("rm -rf $TMPDIR/../src")).toBe("deny");
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
