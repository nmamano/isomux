// Enforcement probes for the PreToolUse safety hooks. Everything runs through
// createSafetyHooks(), the public interface, rather than the private callbacks.
//
// The write-protection root is STATE_ROOT, which the bun test preload has
// already pointed at a throwaway temp dir (bunfig.toml -> test-support/preload.ts).
// The guard at the top of this file re-asserts that, so a denial test can never
// be aimed at the real ~/.isomux.
import { describe, it, expect } from "bun:test";
import type {
  HookCallback,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "os";
import { join, sep } from "path";
import { STATE_ROOT } from "./config.ts";
import { createSafetyHooks } from "./safety-hooks.ts";

const realStateRoot = join(homedir(), ".isomux");
if (
  STATE_ROOT === realStateRoot ||
  STATE_ROOT.startsWith(realStateRoot + sep)
) {
  throw new Error(
    `safety-hooks.test.ts refuses to run against the real state root (${STATE_ROOT}).`,
  );
}

const PROTECTED_FILE = join(STATE_ROOT, "agents.json");

function hooksFor(toolName: string): HookCallback[] {
  const matchers = createSafetyHooks().PreToolUse ?? [];
  return matchers.filter((m) => m.matcher === toolName).flatMap((m) => m.hooks);
}

/** Run every hook registered for a tool; the first one that objects wins. */
async function decide(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<{ denied: boolean; reason: string }> {
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  } as unknown as Parameters<HookCallback>[0];

  for (const hook of hooksFor(toolName)) {
    const out: HookJSONOutput = await hook(input, undefined, {
      signal: new AbortController().signal,
    });
    const specific = (out as { hookSpecificOutput?: Record<string, unknown> })
      .hookSpecificOutput;
    if (specific?.permissionDecision === "deny") {
      return {
        denied: true,
        reason: String(specific.permissionDecisionReason),
      };
    }
  }
  return { denied: false, reason: "" };
}

const bash = (command: string) => decide("Bash", { command });

describe("outbound-tunnel guard", () => {
  const denied = [
    [
      "cloudflared tunnel --url http://127.0.0.1:4000",
      "cloudflared tunnel --url",
    ],
    [
      "/home/nil/bin/cloudflared tunnel --url=http://127.0.0.1:4000",
      "cloudflared tunnel --url",
    ],
    [
      "cloudflared tunnel --config tunnel.yml run office",
      "cloudflared tunnel run",
    ],
    ["ngrok http 4000", "ngrok http"],
    ["ngrok --log stdout http 4000", "ngrok http"],
    ["ngrok --config /tmp/n.yml http 4000", "ngrok http"],
    ["ngrok tcp 22", "ngrok tcp"],
    ["ngrok tls 443", "ngrok tls"],
    ["ngrok start office", "ngrok start"],
    ["ngrok service start", "ngrok service start"],
    ["ngrok service restart", "ngrok service restart"],
    ["npx --yes ngrok http 4000", "ngrok http"],
    [
      "bunx cloudflared tunnel --url http://127.0.0.1:4000",
      "cloudflared tunnel --url",
    ],
    ["ssh -R 8080:localhost:4000 user@host", "ssh -R remote forwarding"],
    ["ssh -R 8080 user@host", "ssh -R remote forwarding"],
    ["ssh -R8080:localhost:4000 user@host", "ssh -R remote forwarding"],
    ["ssh -fNR 80:localhost:4000 user@host", "ssh -R remote forwarding"],
    ["ssh -NR 8080:127.0.0.1:4000 user@host", "ssh -R remote forwarding"],
    ["ssh -o RemoteForward=8080:localhost:4000 user@host", "ssh RemoteForward"],
    [
      'ssh -o "RemoteForward 8080 localhost:4000" user@host',
      "ssh RemoteForward",
    ],
    ["ssh -oRemoteForward=8080:localhost:4000 user@host", "ssh RemoteForward"],
    ["tailscale serve --bg http://localhost:4000", "tailscale serve"],
    [
      "tailscale --socket /var/run/tailscale.sock serve --bg http://localhost:4000",
      "tailscale serve",
    ],
    ["tailscale funnel --bg http://localhost:4000", "tailscale funnel"],
    ["tailscale serve advertise svc:http", "tailscale serve"],
    ["tailscale serve set-config config.json", "tailscale serve"],
    [
      "git clean -n && cloudflared tunnel --url http://127.0.0.1:4000",
      "cloudflared tunnel --url",
    ],
    [
      "bash -c 'cloudflared tunnel --url http://127.0.0.1:4000'",
      "cloudflared tunnel --url",
    ],
  ] as const;

  for (const [command, form] of denied) {
    it(`denies ${command}`, async () => {
      const decision = await bash(command);
      expect(decision.denied).toBe(true);
      expect(decision.reason).toContain(
        `Refused: \`${form}\` (an agent may not open a tunnel).`,
      );
      expect(decision.reason).toContain(
        "This text check covers recognized command forms only; a renamed binary or interpreter can bypass it.",
      );
      expect(decision.reason).toContain(`Command: ${command}`);
      expect(decision.reason).toContain("have them run the command manually");
    });
  }

  const allowed = [
    "cloudflared tunnel list",
    "cloudflared tunnel info office",
    "cloudflared tunnel cleanup office",
    "cloudflared tunnel delete office",
    "cloudflared tunnel --help",
    "ngrok config check",
    "ngrok version",
    "ngrok service stop",
    "ssh user@host",
    "ssh -L 4000:localhost:4000 user@box",
    "ssh -fNL 4000:localhost:4000 user@box",
    "ssh user@host ls -R /var/log",
    "ssh user@host grep -R needle /etc",
    "ssh -p 22 user@host ls -R /var/log",
    "ssh -o StrictHostKeyChecking=no user@host grep -R needle /etc",
    "tailscale serve status",
    "tailscale funnel status --json",
    "tailscale serve reset",
    "tailscale funnel reset",
    "tailscale serve get-config",
    "tailscale serve drain svc",
    "tailscale serve --https=443 off",
    "tailscale funnel --https=443 http://localhost:4000 off",
    "cloudflared-helper tunnel --url http://127.0.0.1:4000",
    "echo 'cloudflared tunnel --url http://127.0.0.1:4000'",
    "grep -R 'tailscale funnel --bg' docs",
    "awk 'BEGIN { print \"ngrok http 4000\" }' README.md",
    [
      "jq -Rs '{text: .}' <<'EOF'",
      "cloudflared tunnel --url http://127.0.0.1:4000",
      "EOF",
    ].join("\n"),
  ];

  for (const command of allowed) {
    it(`allows ${command.split("\n")[0]}`, async () => {
      expect((await bash(command)).denied).toBe(false);
    });
  }
});

describe("process-kill guard", () => {
  describe("denies name-pattern kills", () => {
    const denied = [
      // The incident that motivated this rule: the office server runs as
      // `bun run server/index.ts`, so a pattern aimed at any other project's
      // dev server takes the office with it.
      [
        'pkill -f "server/index.ts"',
        "quoted pattern (survives quote stripping)",
      ],
      ["pkill -f server/index.ts", "unquoted pattern"],
      ["pkill -f 'bun run server'", "single-quoted pattern"],
      ["pkill bun", "bare name match"],
      ["pkill -9 node", "signal plus name match"],
      ["killall node", "killall"],
      ["killall -9 claude", "killall with a signal"],
      ["killall5", "killall5"],
      ["sudo pkill -f claude", "behind sudo"],
      ["/usr/bin/pkill -f bun", "absolute path"],
      ["xargs pkill -f bun", "behind xargs"],
      ["pkill -u nil", "user-scoped is still every process of that user"],
      ["pkill -P 123 node", "parent-scoped but still name-matching"],
    ] as const;

    for (const [command, why] of denied) {
      it(`${command} - ${why}`, async () => {
        const { denied: isDenied } = await bash(command);
        expect(isDenied).toBe(true);
      });
    }
  });

  describe("denies a name lookup laundered into a kill", () => {
    const denied = [
      'pgrep -f "server/index.ts" | xargs kill',
      "pgrep -f bun | xargs -r kill -9",
      "kill $(pgrep -f server/index.ts)",
      "kill -9 $(pidof bun)",
      "kill `pgrep -f bun`",
      "ps aux | grep vite | awk '{print $2}' | xargs kill -9",
    ];

    for (const command of denied) {
      it(command, async () => {
        expect((await bash(command)).denied).toBe(true);
      });
    }
  });

  describe("denies the spellings that get past a naive command-word match", () => {
    const denied = [
      ["bash -c 'pkill -f bun'", "command word hidden inside a quoted payload"],
      ['sh -c "kill $(pgrep -f bun)"', "quoted payload with a substitution"],
      ["sudo -u nil pkill -f bun", "a wrapper flag that eats its own value"],
      ["\\pkill -f bun", "backslash-escaped to skip alias expansion"],
      [
        "for i in 1; do pkill -f bun; done",
        "command position inside a loop body",
      ],
      [
        "if true; then killall bun; fi",
        "command position inside a conditional",
      ],
      ["{ pkill -f bun; }", "command position inside a group"],
      ["(pkill -f bun)", "command position inside a subshell"],
      [
        "pgrep -f bun | while read p; do kill $p; done",
        "lookup and kill split across a read loop",
      ],
      ["  pkill   -f   bun  ", "extra whitespace"],
      ["pkill --full bun", "long-form pattern flag"],
      // Reviewer1 regressions.
      [
        'pkill -P "$(pgrep -f bun)"',
        "a lookup smuggled through the -P carve-out",
      ],
      ["sudo --user nil pkill -f bun", "long-form wrapper flag with a value"],
      ['"pkill" -f bun', "quoted command word"],
      ['/usr/bin/"pkill" -f bun', "quoted command word inside a path"],
      ["p\\kill -f bun", "backslash inside the command word"],
      ["pgrep -f bun 2>&1 | xargs kill", "a redirection inside the pipeline"],
      [
        "ps aux 2>&1 | grep vite | awk '{print $2}' | xargs kill",
        "a redirection inside the ps/grep pipeline",
      ],
      ["xargs -I {} pkill -f bun", "xargs replace-string flag"],
      // Reviewer1 round 2: clustered shell flags, and wrapper options whose
      // value would otherwise be read as the command.
      ['bash -lc "pkill -f bun"', "clustered shell flag"],
      ['sh -ec "killall bun"', "clustered shell flag, other order"],
      ['env bash -lc "pkill -f bun"', "clustered shell flag behind a wrapper"],
      ["time -o /tmp/t pkill -f bun", "a wrapper option that takes a value"],
      ["sudo -D /tmp pkill -f bun", "a sudo option that takes a value"],
      // The same standalone flags, now in front of a real kill.
      ["sudo -n pkill -f bun", "behind a standalone sudo flag"],
      ["xargs -r pkill -f bun", "behind a standalone xargs flag"],
      ["time -v pkill -f bun", "behind a standalone time flag"],
    ] as const;

    for (const [command, why] of denied) {
      it(`${command} - ${why}`, async () => {
        expect((await bash(command)).denied).toBe(true);
      });
    }
  });

  describe("allows kills that name a PID or a port", () => {
    const allowed = [
      ["kill 12345", "a PID the agent has in hand"],
      ["kill -9 12345", "a PID with a signal"],
      ["kill $(lsof -ti:5173)", "by port via lsof"],
      ["fuser -k 5173/tcp", "by port via fuser"],
      ["kill -s TERM 12345", "a named signal"],
      ["pkill -P 12345", "children of one known process"],
      ["pkill -P12345", "the same, flag and value joined"],
      ["xargs -P 4 kill < pids", "PIDs read from a file, not matched by name"],
      ["pgrep -f 'server/index.ts'", "a lookup on its own is read-only"],
      ["ps aux | grep bun", "inspecting processes is read-only"],
      ["ps aux | head -20", "inspecting processes is read-only"],
      // `ps` only counts as a name lookup next to `grep`, the step that turns
      // it into name matching. Listing processes then killing a known PID is
      // the ordinary thing an agent does.
      ["ps aux | head; kill 12345", "listing then killing a known PID"],
      // A kill that names literal PIDs is not a name match, however the rest of
      // the line reads (Reviewer1 regression).
      ["ps aux | kill 12345", "a literal PID beside an unrelated lookup"],
      ["pgrep -f bun | head; kill 12345", "a literal PID after a lookup"],
      ["kill -9 111 222", "several literal PIDs"],
      ["kill $$", "the shell's own PID"],
      ["pgrep -af bun; kill 12345", "a lookup then a literal-PID kill"],
      // The pattern argument lives inside quotes, so the guard has to key off
      // the command word rather than the text - and must not fire on prose.
      [
        'git commit -m "pkill the stray dev server"',
        "the word inside a message",
      ],
      ['echo "run killall node to clean up"', "the word inside an echo"],
    ] as const;

    for (const [command, why] of allowed) {
      it(`${command} - ${why}`, async () => {
        const { denied, reason } = await bash(command);
        expect({ command, denied, reason }).toEqual({
          command,
          denied: false,
          reason: "",
        });
      });
    }
  });

  describe("tells quoted data apart from an executed payload", () => {
    // A separator inside quotes is data. Deleting quote characters would
    // promote it to command structure and deny ordinary prose (Reviewer1).
    const allowed = [
      'echo "safe prose; pkill -f bun"',
      "echo 'safe prose; pkill -f bun'",
      'git commit -m "document this; killall node is unsafe"',
      'git commit -m "fix: pkill -f && killall cleanup"',
      'echo "a | pkill -f bun | b"',
      "echo 'kill $(pgrep -f bun)'",
      'grep -rn "killall" server/',
      'sed -i "s/pkill/x/" f.ts',
      // An ordinary command's arguments are never candidates, even behind a
      // wrapper - the extra-candidate rule only fires right after an unknown
      // flag, so this must not read `killall` as a command.
      "find . -name '*.ts' | xargs grep -l killall",
      "sudo -D /tmp grep -rn killall src/",
      // A wrapper flag that stands alone must not turn the command's own
      // arguments into candidates (Reviewer1 round 3).
      "sudo -n grep -rn killall src/",
      "xargs -r grep -l killall < files",
      "time -v grep -n pkill README.md",
      "xargs -rt grep -l killall",
      "sudo --non-interactive grep -rn pkill .",
      "cat <<'EOF'\npkill -f bun\nEOF",
      "kill 123 > /dev/null 2>&1",
    ];
    for (const command of allowed) {
      it(`allows ${JSON.stringify(command)}`, async () => {
        expect((await bash(command)).denied).toBe(false);
      });
    }

    // `bash -c` really does execute its argument, so that one quoted word is
    // structure. Same for a substitution, which runs even inside double quotes.
    const denied = [
      'bash -c "pkill -f bun"',
      "bash -c 'pkill -f bun'",
      'sh -c "kill $(pgrep -f bun)"',
      'kill "$(pgrep -f bun)"',
      "bash -c \"bash -c 'pkill -f bun'\"",
    ];
    for (const command of denied) {
      it(`denies ${JSON.stringify(command)}`, async () => {
        expect((await bash(command)).denied).toBe(true);
      });
    }
  });

  it("teaches the port and PID alternatives in the denial", async () => {
    const { reason } = await bash('pkill -f "server/index.ts"');
    expect(reason).toContain("processes you don't own");
    expect(reason).toContain("by port or PID");
  });

  it("echoes the original command, quotes intact, so the agent can see what was blocked", async () => {
    const { reason } = await bash('pkill -f "server/index.ts"');
    expect(reason).toContain('pkill -f "server/index.ts"');
  });
});

describe("heredoc bodies are data, not commands", () => {
  // The shape that regressed in practice: an agent posting a report through
  // `jq -Rs … <<'EOF' | curl …`. The body starts on the NEXT line, so the
  // operator is followed by the rest of the pipeline - and the report's prose
  // was being read as commands and blocked.
  const report = [
    "jq -Rs '{text: .}' <<'EOF' | curl -s -X POST localhost:4000/api/agents/a1/messages -d @-",
    "Report: I could not write ~/.isomux/agents.json, the guard blocked it.",
    "It also blocked `rm -rf ~/.isomux/logs` and a tee into ~/.isomux/state.",
    "Next: pkill -f bun was rejected too, so I killed the PID instead.",
    "EOF",
  ].join("\n");

  it("allows a report whose body discusses ~/.isomux and write verbs", async () => {
    expect(await bash(report)).toEqual({ denied: false, reason: "" });
  });

  it("allows the same body under a double-quoted delimiter", async () => {
    expect((await bash(report.replace(/'EOF'/, '"EOF"'))).denied).toBe(false);
  });

  it("allows a bare-delimiter body that expands to nothing", async () => {
    // `<<EOF` still expands its body, so this body carries no backticked line:
    // in a bare heredoc that one really would run rm.
    const command = [
      "jq -Rs '{text: .}' <<EOF | curl -s -d @- localhost:4000/x",
      "Report: I could not write ~/.isomux/agents.json, the guard blocked it.",
      "Next: pkill -f bun was rejected too, so I killed the PID instead.",
      "EOF",
    ].join("\n");
    expect((await bash(command)).denied).toBe(false);
  });

  it("denies a backticked command in a bare-delimiter body, which runs", async () => {
    const command = ["cat <<EOF", "now: `pkill -f bun`", "EOF"].join("\n");
    expect((await bash(command)).denied).toBe(true);
  });

  it("allows a tab-stripped heredoc with an indented terminator", async () => {
    const command = [
      "\tcat <<-'EOF' > /tmp/note.txt",
      "\tI removed it with rm -rf and wrote ~/.isomux/agents.json.",
      "\tEOF",
    ].join("\n");
    expect((await bash(command)).denied).toBe(false);
  });

  it("allows two heredocs opened on one line", async () => {
    const command = [
      "diff <(cat <<'A'",
      "rm -rf ~/.isomux",
      "A",
      ") <(cat <<'B'",
      "git reset --hard",
      "B",
      ")",
    ].join("\n");
    expect((await bash(command)).denied).toBe(false);
  });

  it("reads an unterminated body as data, the way bash does", async () => {
    // Verified against bash: it warns, ends the heredoc at end of input, and
    // runs the command - the last line is cat's input, not a command.
    const command = ["cat <<'EOF'", "some prose", "pkill -f bun"].join("\n");
    expect((await bash(command)).denied).toBe(false);
  });

  const notOperators = [
    // A bit shift, in both arithmetic spellings.
    ["echo $((1 << 20))", "pkill -f bun"],
    ["(( total << 2 ))", "pkill -f bun"],
    // A comment that mentions the operator.
    ["echo hi # bodies are written <<EOF", "pkill -f bun"],
    // A quoted mention of the operator.
    ['echo "see <<EOF in the docs"', "pkill -f bun"],
    // A here-string, which has no body.
    ["cat <<< 'just prose'", "pkill -f bun"],
  ];
  for (const lines of notOperators) {
    it(`does not let ${JSON.stringify(lines[0])} swallow the line below it`, async () => {
      expect((await bash(lines.join("\n"))).denied).toBe(true);
    });
  }

  const escaped = [
    // Verified against bash: `\$(…)` and an escaped backtick are literal text
    // in an unquoted body, which is how a report quotes a command.
    ["cat <<EOF", "literal: \\$(pkill -f bun)", "EOF"],
    ["cat <<EOF", "literal: \\`pkill -f bun\\`", "EOF"],
  ];
  for (const lines of escaped) {
    it(`allows the escaped substitution in ${JSON.stringify(lines[1])}`, async () => {
      expect((await bash(lines.join("\n"))).denied).toBe(false);
    });
  }

  it("denies a substitution behind an escaped backslash, which still runs", async () => {
    // `\\` is the escape consuming itself; the substitution after it is live.
    const command = ["cat <<EOF", "path: \\\\$(pkill -f bun)", "EOF"].join(
      "\n",
    );
    expect((await bash(command)).denied).toBe(true);
  });

  it("still denies a substitution inside an unquoted heredoc, which runs", async () => {
    const command = ["cat <<EOF", "now: $(pkill -f bun)", "EOF"].join("\n");
    expect((await bash(command)).denied).toBe(true);
  });

  it("does not let a quoted delimiter launder a substitution", async () => {
    // `<<'EOF'` really is literal - the substitution below does not run, so
    // there is nothing to deny.
    const command = ["cat <<'EOF'", "now: $(pkill -f bun)", "EOF"].join("\n");
    expect((await bash(command)).denied).toBe(false);
  });

  it("still checks the command the heredoc feeds", async () => {
    const command = ["tee ~/.isomux/agents.json <<'EOF'", "{}", "EOF"].join(
      "\n",
    );
    const { denied, reason } = await bash(command);
    expect(denied).toBe(true);
    expect(reason).toContain("Writing to ~/.isomux/ is not allowed");
  });
});

describe("sensitive-read guard covers Grep", () => {
  it("registers a matcher for Grep", () => {
    expect(hooksFor("Grep").length).toBeGreaterThan(0);
  });

  const denied: Record<string, unknown>[] = [
    { pattern: "KEY", path: "/tmp/isomux-safety-probe/.env" },
    { pattern: "KEY", path: "~/.ssh/id_rsa" },
    { pattern: "KEY", path: "/tmp/isomux-safety-probe/server.pem" },
    { pattern: "KEY", glob: "*.pem" },
    { pattern: "KEY", glob: ".env*" },
    { pattern: "KEY", path: "/tmp/isomux-safety-probe", glob: "**/.env" },
    // A renamed path field still gets checked rather than read as "no target".
    { pattern: "KEY", search_path: "/tmp/isomux-safety-probe/.env" },
  ];
  for (const input of denied) {
    it(`denies Grep ${JSON.stringify(input)}`, async () => {
      const { denied: blocked, reason } = await decide("Grep", input);
      expect(blocked).toBe(true);
      expect(reason).toContain("may contain secrets");
    });
  }

  const allowed: Record<string, unknown>[] = [
    // No path and no glob: a search of the working directory, which a
    // name-based rule cannot judge. Must not fail closed on it.
    { pattern: "KEY" },
    { pattern: "KEY", path: "/tmp/isomux-safety-probe/server" },
    { pattern: "KEY", glob: "**/*.ts" },
    { pattern: "KEY", path: "/tmp/isomux-safety-probe/.env.example" },
    { pattern: "KEY", output_mode: "content", "-n": true },
  ];
  for (const input of allowed) {
    it(`allows Grep ${JSON.stringify(input)}`, async () => {
      expect(await decide("Grep", input)).toEqual({
        denied: false,
        reason: "",
      });
    });
  }

  it("still fails closed for a read tool with no optional-target rule", async () => {
    expect((await decide("Read", { limit: 10 })).denied).toBe(true);
  });
});

describe("NotebookEdit coverage", () => {
  it("registers a matcher for NotebookEdit", () => {
    expect(hooksFor("NotebookEdit").length).toBeGreaterThan(0);
  });

  it("denies a notebook_path write into the protected state root", async () => {
    const { denied, reason } = await decide("NotebookEdit", {
      notebook_path: join(STATE_ROOT, "notes.ipynb"),
      new_source: "print(1)",
    });
    expect(denied).toBe(true);
    expect(reason).toContain("Writing to ~/.isomux/ is not allowed");
  });

  it("denies a notebook_path pointing at a sensitive file", async () => {
    const { denied, reason } = await decide("NotebookEdit", {
      notebook_path: "/tmp/isomux-safety-probe/.env",
      new_source: "print(1)",
    });
    expect(denied).toBe(true);
    expect(reason).toContain("may contain secrets");
  });

  // Isomux causes all three files to exist. A bare auth.json stays allowed:
  // only the exact backend-owned locations are credentials.
  it("denies reading the Claude login", async () => {
    const { denied, reason } = await decide("Read", {
      file_path: "/home/someone/.claude/.credentials.json",
    });
    expect(denied).toBe(true);
    expect(reason).toContain("may contain secrets");
  });

  it("denies reading the Codex login, in the default and per-user homes", async () => {
    for (const file_path of [
      "/home/someone/.isomux/codex-home/auth.json",
      "/home/someone/.codex/auth.json",
    ]) {
      const { denied } = await decide("Read", { file_path });
      expect({ file_path, denied }).toEqual({ file_path, denied: true });
    }
  });

  it("denies reading the default and per-user OpenCode logins", async () => {
    for (const file_path of [
      "/home/someone/.isomux/opencode/profiles/0123456789abcdef/data/opencode/auth.json",
      "/srv/isomux-user/opencode/profiles/fedcba9876543210/data/opencode/auth.json",
    ]) {
      const { denied } = await decide("Read", { file_path });
      expect({ file_path, denied }).toEqual({ file_path, denied: true });
    }
  });

  it("denies reading the native OpenCode login", async () => {
    const { denied, reason } = await decide("Read", {
      file_path: "/home/someone/.local/share/opencode/auth.json",
    });
    expect(denied).toBe(true);
    expect(reason).toContain("may contain secrets");
  });

  it("still allows an unrelated auth.json, which is too generic to block", async () => {
    for (const file_path of [
      "/tmp/some-project/auth.json",
      "/tmp/some-project/opencode/auth.json",
    ]) {
      const { denied } = await decide("Read", { file_path });
      expect({ file_path, denied }).toEqual({ file_path, denied: false });
    }
  });

  it("denies a NotebookRead of a sensitive file", async () => {
    const { denied, reason } = await decide("NotebookRead", {
      notebook_path: "/tmp/isomux-safety-probe/id_rsa",
    });
    expect(denied).toBe(true);
    expect(reason).toContain("may contain secrets");
  });

  it("allows an ordinary notebook edit", async () => {
    expect(
      await decide("NotebookEdit", {
        notebook_path: "/tmp/isomux-safety-probe/analysis.ipynb",
        new_source: "print(1)",
      }),
    ).toEqual({ denied: false, reason: "" });
  });
});

describe("path extraction fails closed", () => {
  it("denies a guarded write whose input names no path at all", async () => {
    const { denied, reason } = await decide("Write", { content: "hello" });
    expect(denied).toBe(true);
    expect(reason).toContain("could not tell which file");
  });

  it("denies a guarded read whose input names no path at all", async () => {
    expect((await decide("Read", { offset: 3 })).denied).toBe(true);
  });

  it("names the rule each guard could not apply, not the other guard's rule", async () => {
    // Reads of ~/.isomux/ are allowed, so the read guard must not claim it was
    // checking for them.
    const write = await decide("Write", { content: "x" });
    expect(write.reason).toContain("the protected ~/.isomux/ directory");

    const read = await decide("Read", { offset: 3 });
    expect(read.reason).toContain("sensitive-file rules");
    expect(read.reason).not.toContain("~/.isomux/");
  });

  it("denies an empty input object", async () => {
    expect((await decide("Write", {})).denied).toBe(true);
  });

  it("still checks a novel path key rather than waving it through", async () => {
    const { denied, reason } = await decide("Write", {
      output_path: PROTECTED_FILE,
      content: "x",
    });
    expect(denied).toBe(true);
    expect(reason).toContain("Writing to ~/.isomux/ is not allowed");
  });

  it("does not mine the content field for paths", async () => {
    // Documentation that merely mentions the protected directory is a normal
    // write; only path-bearing fields decide.
    expect(
      await decide("Write", {
        file_path: "/tmp/isomux-safety-probe/README.md",
        content: `State lives in ${PROTECTED_FILE}.`,
      }),
    ).toEqual({ denied: false, reason: "" });
  });
});

describe("existing guards still hold", () => {
  it("denies a Write into the protected state root", async () => {
    expect((await decide("Write", { file_path: PROTECTED_FILE })).denied).toBe(
      true,
    );
  });

  it("denies a Read of a .env file", async () => {
    const { denied, reason } = await decide("Read", {
      file_path: "/tmp/isomux-safety-probe/.env",
    });
    expect(denied).toBe(true);
    expect(reason).toContain("may contain secrets");
  });

  it("allows a Read of .env.example", async () => {
    expect(
      await decide("Read", {
        file_path: "/tmp/isomux-safety-probe/.env.example",
      }),
    ).toEqual({ denied: false, reason: "" });
  });

  it("denies rm -rf", async () => {
    expect((await bash("rm -rf /home/nil/nil")).denied).toBe(true);
  });

  it("denies git reset --hard", async () => {
    expect((await bash("git reset --hard HEAD~1")).denied).toBe(true);
  });

  it("allows an ordinary command", async () => {
    expect(await bash("ls -la /tmp")).toEqual({ denied: false, reason: "" });
  });
});

// ---------------------------------------------------------------------------
// Bash-side sensitive-read grammar (task 137c6684)
//
// The Grep TOOL was already covered; Bash-side readers were not. The trap this
// pins down is that grep's first bare operand is the PATTERN, so a naive
// path check denies what the agent was searching FOR.
// ---------------------------------------------------------------------------

describe("sensitive-read guard covers Bash readers", () => {
  const denies = (cmd: string) =>
    it(`denies: ${cmd}`, async () => {
      const { denied, reason } = await bash(cmd);
      expect(denied).toBe(true);
      expect(reason).toContain("may contain secrets");
    });
  const allows = (cmd: string) =>
    it(`allows: ${cmd}`, async () => {
      expect(await bash(cmd)).toEqual({ denied: false, reason: "" });
    });

  describe("the first operand is a pattern, not a path", () => {
    allows("grep id_rsa ~/.ssh/config");
    allows("grep -rn AWS_SECRET .");
    allows("grep .env ~/notes.md");
    allows("rg id_rsa src/");
    allows("rg '\\.pem$' docs/");
    allows("sed -n 's/id_rsa/x/p' notes.txt");
    allows("awk '/id_rsa/ {print}' notes.txt");
    // rg's -r is --replace and eats its value, so `id_rsa` is the replacement
    // and `KEY` is the pattern - no path named here at all.
    allows("rg -r id_rsa KEY notes.txt");
    // grep's -r is boolean, so the same shape really does name a path. Not
    // sensitive here, but it proves the two are parsed differently.
    allows("grep -r id_rsa notes.txt");
  });

  describe("but the path operands still get checked", () => {
    denies("grep AWS_SECRET .env");
    denies("grep -rn AWS_SECRET .env.production");
    denies("grep -e KEY .env");
    denies("grep --regexp=KEY .env");
    denies("rg KEY ~/.ssh/id_rsa");
    denies("rg -n KEY secrets.pem");
    denies("sed -n 1p .env");
    denies("sed -e 's/a/b/' server.key");
    denies("awk '{print}' secrets.pem");
    denies("awk -F: '{print $2}' .env");
    denies("cut -d= -f2 .env");
    // Option permutation: GNU grep accepts the file before the -e pattern.
    denies("grep .env -e KEY");
    // A pattern FILE is read too.
    denies("grep -f .env notes.txt");
    // After `--` everything is an operand, but the pattern still comes first.
    denies("grep -- KEY .env");
  });

  describe("a file SELECTOR names the file too", () => {
    // `grep --include=.env -r KEY ~/` prints .env contents just as surely as
    // naming the file. Same shape isSensitiveFile already checks for the Grep
    // tool's `glob` field.
    denies("grep --include=.env -r KEY .");
    denies("rg -g '*.pem' KEY .");
    denies("rg --iglob '.env*' KEY .");
    // Excluding a file is not reading it - rg spells that with a leading `!`.
    allows("rg -g '!*.pem' KEY .");
    allows("rg --iglob '!.env*' KEY .");
    allows("grep --exclude=*.pem -r KEY .");
    // ...but that grammar belongs to rg's glob flags alone. Everywhere else a
    // leading `!` is just the first character of a filename.
    denies("grep -f '!patterns.pem' notes.txt");
    denies("rg -f '!patterns.pem' src/");
    denies("awk -f '!prog.key' notes.txt");
    denies("cat < '!secrets.pem'");
  });

  describe("quoted paths are paths", () => {
    // stripQuotedStrings() blanks a quoted word, which used to hide the path
    // from this check entirely - including for plain `cat`.
    denies("grep AWS_SECRET '.env'");
    denies('cat ".env"');
    denies("cat '/tmp/isomux-safety-probe/id_rsa'");
  });

  describe("plain readers keep checking every operand", () => {
    denies("cat .env");
    denies("head -n 5 .env");
    denies("tail -f server.key");
    denies("xxd id_ed25519");
    denies("base64 .env");
    denies("cat notes.txt .env");
    allows("cat notes.txt README.md");
    allows("head -n 5 package.json");
  });

  describe("the template/example carve-out still applies", () => {
    allows("grep KEY .env.example");
    allows("cat .env.template");
    allows("sed -n 1p .env.sample");
  });

  describe("through pipes, redirections and substitutions", () => {
    denies("ls | grep KEY .env");
    denies("cat notes.txt && grep KEY .env");
    denies("echo hi; cat $(ls) .env");
    // A reader inside a command substitution is its own sub-command - including
    // inside DOUBLE quotes, where the substitution still runs.
    denies("wc -l $(cat .env)");
    denies('echo "$(cat .env)"');
    denies("echo `cat .env`");
    // Single quotes really are literal, so nothing runs in there.
    allows("echo '$(cat .env)'");
  });

  describe("readers hidden behind a wrapper or an interpreter", () => {
    denies("sudo cat .env");
    denies("sudo -u nil cat .env");
    denies("xargs grep KEY .env");
    denies("env cat .env");
    denies("bash -c 'cat .env'");
    denies('sh -lc "grep KEY .env"');
    // An assignment prefix is not the command.
    denies("X=1 cat .env");
  });

  describe("input redirection is a read; here-strings and writes are not", () => {
    denies("cat < .env");
    denies("grep KEY <.env");
    denies("sed -n 1p < server.key");
    // A redirection may come BEFORE the command; the shell still opens the file.
    denies("< .env cat");
    denies("2<.env cat");
    denies("< .env grep KEY");
    // `<<<` is a here-string: the word is DATA, not a file to open.
    allows("cat <<< '.env'");
    // A redirect target is never the pattern slot, so this still resolves
    // KEY as the pattern and .env as a path.
    denies("grep KEY < .env");
  });

  describe("a quoted word is data, not option syntax", () => {
    // `-v` here is grep's pattern, not its invert-match flag, so the file
    // operand is still the one after it.
    denies("grep -- '-v' .env");
    allows("sed 's/-n/x/' notes.txt");
  });

  describe("a heredoc body is still data, not a command", () => {
    allows("jq -Rs '{text: .}' <<'EOF'\ncat .env is just prose here\nEOF");
  });
});
