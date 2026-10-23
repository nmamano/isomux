// Another process's environment can hold other agents' office tokens and
// secret placeholders (all agents run as one OS user). The hooks refuse
// /proc/<pid>/environ reads and the ps forms that print environments, for
// every engine; the agent's own environment stays readable. Honest-agent
// layer: an interpreter one-liner or a script still reads it.
//
// Every denied case here is allowed by the policy before the environ rule
// (212a05ab), so a deny can come from no older guard.

import { describe, expect, it } from "bun:test";

import { evaluateProposedAction } from "./safety-policy.ts";

const OUTSIDE = "/tmp/probe-project";

const bash = (command: string, cwd: string = OUTSIDE) =>
  evaluateProposedAction({ kind: "shell", command }, { cwd }).decision;
const read = (
  toolName: string,
  input: Record<string, unknown>,
  cwd: string = OUTSIDE,
) =>
  evaluateProposedAction({ kind: "read-files", toolName, input }, { cwd })
    .decision;

function expectAll(
  cases: string[],
  decision: "allow" | "deny",
  cwd: string = OUTSIDE,
) {
  // Every case that misses, so one red run lists them all.
  expect(cases.filter((command) => bash(command, cwd) !== decision)).toEqual(
    [],
  );
}

describe("a shell read of another process's environment", () => {
  it("is refused for a pid, and allowed for the same read of the agent's own", () => {
    const pairs: [string, string][] = [
      ["cat /proc/1/environ", "cat /proc/self/environ"],
      ["cat /proc/1/task/1/environ", "cat /proc/self/task/1/environ"],
      [
        "cat /proc/self/root/proc/1/environ",
        "cat /proc/self/root/proc/self/environ",
      ],
      [
        "tr '\\0' '\\n' < /proc/1/environ",
        "tr '\\0' '\\n' < /proc/self/environ",
      ],
      [
        "< /proc/1/environ tr '\\0' '\\n'",
        "< /proc/self/environ tr '\\0' '\\n'",
      ],
      ["xargs -0 -a /proc/1/environ", "xargs -0 -a /proc/self/environ"],
      ["dd if=/proc/1/environ", "dd if=/proc/self/environ"],
    ];
    expectAll(
      pairs.map(([denied]) => denied),
      "deny",
    );
    expectAll(
      pairs.map(([, own]) => own),
      "allow",
    );
  });

  it("allows the spellings of the agent's own process", () => {
    expectAll(
      [
        "cat /proc/thread-self/environ",
        "cat /proc/$$/environ",
        "cat /proc/${$}/environ",
        "cat /proc/$BASHPID/environ",
        "sleep 9 & cat /proc/$!/environ",
      ],
      "allow",
    );
  });

  it("is refused when the pid is another variable or a substitution", () => {
    expectAll(
      [
        "cat /proc/$PPID/environ",
        "cat /proc/$pid/environ",
        'cat "/proc/${pid}/environ"',
        "cat /proc/$(pgrep -o sshd)/environ",
        "cat /proc/`pgrep -o sshd`/environ",
      ],
      "deny",
    );
  });

  it("is refused for a glob or brace that expands to one", () => {
    expectAll(
      [
        "cat /proc/*/environ",
        "cat /proc/[0-9]*/environ",
        "cat /proc/1[0-9]/environ",
        "cat /proc/{1,2}/environ",
        "cat /proc/*/task/*/environ",
        "cat /**/environ",
        "strings /proc/*/environ",
        "cat /proc/1/env*",
        "cat /proc/1/e?viron",
        "cat /proc/1/*",
        "cat /p*/1/environ",
        "cat /proc/1/{environ,status}",
        "cat /proc/{1/environ,self/status}",
      ],
      "deny",
    );
  });

  it("is refused however the path is spelled", () => {
    expectAll(
      [
        "cat /proc//1/./environ",
        "cat /proc/self/../1/environ",
        "cat /proc/1/task/../environ",
        'cat "/proc/1/environ"',
        'cat /proc/1/env""iron',
        "cat /proc/1/envi\\ron",
        "cat $'/proc/1/environ'",
        "cat ../../proc/1/environ",
        "cat /proc/1/root/proc/2/environ",
      ],
      "deny",
    );
    expect(bash("cat proc/1/environ", "/")).toBe("deny");
    expect(bash("cat 1/environ", "/proc")).toBe("deny");
  });

  it("is refused behind a wrapper, a shell payload or a variable", () => {
    expectAll(
      [
        "sudo cat /proc/1/environ",
        "bash -c 'cat /proc/1/environ'",
        "eval 'cat /proc/1/environ'",
        'echo "$(cat /proc/1/environ)"',
        "while IFS= read -r -d '' v; do echo \"$v\"; done < /proc/1/environ",
        'f=/proc/1/environ; cat "$f"',
        'F=/proc/1/environ cat "$F"',
        "export f=/proc/1/environ",
        "grep --file=/proc/1/environ x",
        "grep -f/proc/1/environ x",
        "xargs -0a/proc/1/environ",
        "cp /proc/1/environ /tmp/probe-project/e",
        "ln -s /proc/1/environ /tmp/probe-project/e",
      ],
      "deny",
    );
  });

  it("allows other /proc files and text that only mentions the path", () => {
    expectAll(
      [
        "cat /proc/1/cmdline",
        "cat /proc/1/status",
        "ls /proc",
        "ls /proc/1",
        "env",
        "printenv HOME",
        "cat /tmp/probe-project/proc/1/environ",
        'git commit -m "guard /proc/1/environ reads"',
        "cat > /tmp/probe-project/notes.md <<'EOF'\nread /proc/1/environ\nEOF",
        "grep -n environ server/safety-policy.ts",
      ],
      "allow",
    );
    // An expansion stands for one path segment, not many, so a variable alone
    // does not deny even at the root; the word that sets it does.
    expect(bash('cat "$f"', "/")).toBe("allow");
  });
});

describe("ps forms that print environments", () => {
  it("are refused", () => {
    expectAll(
      [
        "ps e",
        "ps eww",
        "ps auxe",
        "ps axeww",
        "ps e -p 123",
        "ps -p 123 e",
        "ps ewwo pid,args",
        "ps -E",
        "/bin/ps e",
        "sudo ps e",
        "bash -c 'ps e'",
      ],
      "deny",
    );
  });

  it("are allowed without the environment flag, including option values that hold an e", () => {
    expectAll(
      [
        "ps",
        "ps -e",
        "ps -ef",
        "ps aux",
        "ps -eo pid,user,args",
        "ps --sort=-pcpu aux",
        "ps --sort etime",
        "ps -p 1 -o pid=",
        "ps axo etime",
        "ps -o ruser -p 1",
        "ps -C sleeper",
        "ps -U steve",
        "echo ps e",
        "pgrep -a sleep",
      ],
      "allow",
    );
  });
});

describe("a recursive search that reads every environment below it", () => {
  it("is refused when rooted at /proc, below it, or at /", () => {
    expectAll(
      [
        "grep -r TOKEN /proc",
        "grep -R TOKEN /proc/self",
        "grep -r TOKEN /proc/1/task",
        "rg TOKEN /proc",
        "ag TOKEN /proc/1",
        "grep -rn --exclude-dir=secrets TOKEN /",
        "rg -g '!secrets/**' TOKEN /",
      ],
      "deny",
    );
    expect(bash("rg TOKEN", "/proc")).toBe("deny");
  });

  it("is refused for the Grep tool rooted there", () => {
    for (const input of [
      { pattern: "TOKEN", path: "/proc" },
      { pattern: "TOKEN", path: "/proc/1" },
      { pattern: "TOKEN", path: "/proc/1/environ" },
      { pattern: "TOKEN", path: "/", glob: "!**/secrets/**" },
    ])
      expect(read("Grep", input), JSON.stringify(input)).toBe("deny");
    expect(read("Grep", { pattern: "TOKEN" }, "/proc")).toBe("deny");
  });

  it("is allowed elsewhere, and a plain grep of another /proc file is allowed", () => {
    expectAll(
      [
        "grep -r TOKEN /tmp/probe-project",
        "rg TOKEN src",
        "grep TOKEN /proc/1/status",
      ],
      "allow",
    );
    expect(read("Grep", { pattern: "TOKEN", path: OUTSIDE })).toBe("allow");
  });
});

describe("a file-read tool", () => {
  // Claude Read and NotebookRead, OpenCode read (filePath). Codex reads files
  // only through its shell.
  it("is refused for another process's environment", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["Read", { file_path: "/proc/1/environ" }],
      ["Read", { file_path: "/proc/1/task/1/environ" }],
      ["Read", { file_path: "/proc/self/root/proc/1/environ" }],
      ["Read", { file_path: "../../proc/1/environ" }],
      ["NotebookRead", { notebook_path: "/proc/1/environ" }],
      ["read", { filePath: "/proc/1/environ" }],
    ];
    for (const [tool, input] of cases)
      expect(read(tool, input), `${tool} ${JSON.stringify(input)}`).toBe(
        "deny",
      );
  });

  it("is allowed for the agent's own environment and other files", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["Read", { file_path: "/proc/self/environ" }],
      ["Read", { file_path: "/proc/1/status" }],
      ["Read", { file_path: "/tmp/probe-project/proc/1/environ" }],
      ["read", { filePath: "/proc/self/environ" }],
    ];
    for (const [tool, input] of cases)
      expect(read(tool, input), `${tool} ${JSON.stringify(input)}`).toBe(
        "allow",
      );
  });
});
