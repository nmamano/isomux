/**
 * Safety hooks for isomux agents.
 *
 * Injected as PreToolUse hooks into every agent's SDK session. Five concerns:
 *
 *   1. Git safety — block destructive git commands (checkout --, reset --hard, etc.)
 *   2. Filesystem safety — block rm -rf and similar
 *   3. Isomux config protection — block all writes to ~/.isomux/
 *   4. Secrets protection — block reads of .env, private keys, credentials, etc.
 *   5. Process safety — block killing processes by name pattern (pkill/killall)
 *
 * Read operations on ~/.isomux/ are always allowed (agents need discovery/logs).
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "os";
import { basename, resolve } from "path";
import { STATE_ROOT } from "./config.ts";

// The write-protection root follows the active state root, so a test that
// redirects ISOMUX_HOME protects its temp dir rather than the real one.
// NOTE: the literal "~/.isomux" patterns in the command-text checks below are
// deliberately NOT derived from this — they match what an agent literally
// typed, not resolved app state. Do not replace those literals with STATE_ROOT.
const ISOMUX_DIR = STATE_ROOT;

// ---------------------------------------------------------------------------
// Deny / Allow helpers
// ---------------------------------------------------------------------------

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

function allow(): HookJSONOutput {
  return {};
}

function denyMessage(reason: string, command: string): HookJSONOutput {
  return deny(
    `BLOCKED by isomux safety hooks\n\n` +
      `Reason: ${reason}\n\n` +
      `Command: ${command}\n\n` +
      `If this operation is truly needed, ask the user for explicit ` +
      `permission and have them run the command manually.`,
  );
}

// ---------------------------------------------------------------------------
// 1. Git safety — destructive command patterns
//    Ported from wallgame/.claude/hooks/git_safety_guard.py
// ---------------------------------------------------------------------------

const DESTRUCTIVE_PATTERNS: [RegExp, string][] = [
  // Git commands that discard uncommitted changes
  [
    /git\s+checkout\s+--\s+/,
    "git checkout -- discards uncommitted changes permanently. Use 'git stash' first.",
  ],
  [
    /git\s+checkout\s+(?!-b\b)(?!--orphan\b)[^\s]+\s+--\s+/,
    "git checkout <ref> -- <path> overwrites working tree. Use 'git stash' first.",
  ],
  [
    /git\s+restore\s+(?!--staged\b)(?!-S\b)/,
    "git restore discards uncommitted changes. Use 'git stash' or 'git diff' first.",
  ],
  [
    /git\s+restore\s+.*(?:--worktree|-W\b)/,
    "git restore --worktree/-W discards uncommitted changes permanently.",
  ],
  // Git reset variants
  [
    /git\s+reset\s+--hard/,
    "git reset --hard destroys uncommitted changes. Use 'git stash' first.",
  ],
  [/git\s+reset\s+--merge/, "git reset --merge can lose uncommitted changes."],
  // Git clean
  [
    /git\s+clean\s+-[a-z]*f/,
    "git clean -f removes untracked files permanently. Review with 'git clean -n' first.",
  ],
  // Force operations
  // Note: (?![-a-z]) ensures we only block bare --force, not --force-with-lease
  [
    /git\s+push\s+.*--force(?![-a-z])/,
    "Force push can destroy remote history. Use --force-with-lease if necessary.",
  ],
  [
    /git\s+push\s+.*-f\b/,
    "Force push (-f) can destroy remote history. Use --force-with-lease if necessary.",
  ],
  [
    /git\s+branch\s+-D\b/,
    "git branch -D force-deletes without merge check. Use -d for safety.",
  ],
  // 2. Filesystem safety — destructive rm commands
  // Note: [rR] because both -r and -R mean recursive in GNU coreutils
  // Specific root/home pattern MUST come before generic pattern
  [
    /rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*\s+[/~]|rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*\s+[/~]/,
    "rm -rf on root or home paths is EXTREMELY DANGEROUS. This command will NOT be executed. Ask the user to run it manually if truly needed.",
  ],
  [
    /rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    "rm -rf is destructive and requires human approval. Explain what you want to delete and why, then ask the user to run the command manually.",
  ],
  // Catch rm with separate -r and -f flags (e.g., rm -r -f, rm -f -r)
  [
    /rm\s+(-[a-zA-Z]+\s+)*-[rR]\s+(-[a-zA-Z]+\s+)*-f|rm\s+(-[a-zA-Z]+\s+)*-f\s+(-[a-zA-Z]+\s+)*-[rR]/,
    "rm with separate -r -f flags is destructive and requires human approval.",
  ],
  // Catch rm with long options (--recursive, --force)
  [
    /rm\s+.*--recursive.*--force|rm\s+.*--force.*--recursive/,
    "rm --recursive --force is destructive and requires human approval.",
  ],
  // Git stash drop/clear
  [
    /git\s+stash\s+drop/,
    "git stash drop permanently deletes stashed changes. List stashes first.",
  ],
  [
    /git\s+stash\s+clear/,
    "git stash clear permanently deletes ALL stashed changes.",
  ],
];

// Patterns that are safe even if they match above (allowlist)
const SAFE_PATTERNS: RegExp[] = [
  /git\s+checkout\s+-b\s+/, // Creating new branch
  /git\s+checkout\s+--orphan\s+/, // Creating orphan branch
  /git\s+restore\s+--staged\s+(?!.*--worktree)(?!.*-W\b)/, // Unstaging only (safe)
  /git\s+restore\s+-S\s+(?!.*--worktree)(?!.*-W\b)/, // Unstaging short form (safe)
  /git\s+clean\s+-[a-z]*n[a-z]*/, // Dry run (-n, -fn, -nf, etc.)
  /git\s+clean\s+--dry-run/, // Dry run (long form)
  // Allow rm -rf on temp directories (-rf/-Rf and -fr/-fR flag orderings)
  /rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*\s+\/tmp\//,
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*\s+\/tmp\//,
  /rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*\s+\/var\/tmp\//,
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*\s+\/var\/tmp\//,
  /rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*\s+\$TMPDIR\//,
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*\s+\$TMPDIR\//,
  /rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*\s+\$\{TMPDIR/,
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*\s+\$\{TMPDIR/,
  /rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*\s+"\$TMPDIR\//,
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*\s+"\$TMPDIR\//,
  /rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*\s+"\$\{TMPDIR/,
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*\s+"\$\{TMPDIR/,
  // Separate flags on temp directories
  /rm\s+(-[a-zA-Z]+\s+)*-[rR]\s+(-[a-zA-Z]+\s+)*-f\s+\/tmp\//,
  /rm\s+(-[a-zA-Z]+\s+)*-f\s+(-[a-zA-Z]+\s+)*-[rR]\s+\/tmp\//,
  /rm\s+(-[a-zA-Z]+\s+)*-[rR]\s+(-[a-zA-Z]+\s+)*-f\s+\/var\/tmp\//,
  /rm\s+(-[a-zA-Z]+\s+)*-f\s+(-[a-zA-Z]+\s+)*-[rR]\s+\/var\/tmp\//,
  // Long options on temp directories
  /rm\s+.*--recursive.*--force\s+\/tmp\//,
  /rm\s+.*--force.*--recursive\s+\/tmp\//,
  /rm\s+.*--recursive.*--force\s+\/var\/tmp\//,
  /rm\s+.*--force.*--recursive\s+\/var\/tmp\//,
];

// ---------------------------------------------------------------------------
// Path normalization — handles /bin/rm, /usr/bin/git, etc.
// Ported from wallgame's _normalize_absolute_paths()
// ---------------------------------------------------------------------------

function normalizeAbsolutePaths(cmd: string): string {
  if (!cmd) return cmd;
  // Normalize /bin/rm, /usr/bin/rm, /usr/local/bin/rm etc. to bare "rm"
  let result = cmd.replace(/^\/(?:\S*\/)*s?bin\/rm(?=\s|$)/, "rm");
  // Same for git
  result = result.replace(/^\/(?:\S*\/)*s?bin\/git(?=\s|$)/, "git");
  return result;
}

/**
 * Strip quoted strings and heredocs from a command so that pattern matching
 * only applies to actual command structure, not to message content.
 * Replaces quoted content with empty strings to preserve command structure.
 */
function stripQuotedStrings(cmd: string): string {
  let result = cmd;
  // Remove heredoc bodies: <<'EOF' ... EOF, <<"EOF" ... EOF, <<EOF ... EOF
  result = result.replace(/<<-?\s*'([^']+)'\s*\n[\s\S]*?\n\s*\1/g, "");
  result = result.replace(/<<-?\s*"([^"]+)"\s*\n[\s\S]*?\n\s*\1/g, "");
  result = result.replace(/<<-?\s*(\w+)\s*\n[\s\S]*?\n\s*\1/g, "");
  // Remove double-quoted strings (handling escaped quotes)
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Remove single-quoted strings (no escaping in single quotes)
  result = result.replace(/'[^']*'/g, "''");
  // Remove $'...' ANSI-C quoting
  result = result.replace(/\$'(?:[^'\\]|\\.)*'/g, "''");
  return result;
}

// ---------------------------------------------------------------------------
// 3. Isomux config protection — block writes to ~/.isomux/
// ---------------------------------------------------------------------------

// Copy-like commands where only the last argument (destination) is a write target.
// Reading from ~/.isomux/ via these is fine; only writing to it should be blocked.
const COPY_COMMANDS = ["cp", "rsync", "scp", "install"];

// Commands that can modify files — if these target ~/.isomux/, block them
const WRITE_COMMANDS = [
  "cp",
  "mv",
  "rm",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "tee",
  "dd",
  "install",
  "rsync",
  "scp",
  "ln",
  "sed",
  "awk",
  "perl",
  "python",
  "python3",
  "ruby",
  "node",
  "bun",
];

function commandWritesToIsomux(command: string): boolean {
  // Check 1: Redirection (> or >>) targeting ~/.isomux/
  // Match: > ~/.isomux/ or >> ~/.isomux/ or > /home/user/.isomux/
  const redirectPattern = new RegExp(
    `>>?\\s*(?:~\\/\\.isomux|${ISOMUX_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
  );
  if (redirectPattern.test(command)) return true;

  // Check 2: Write commands with ~/.isomux/ as an argument
  // Split on pipe/semicolon/&&/|| to get individual sub-commands
  const subCommands = command.split(/[|;&]+/).map((s) => s.trim());
  for (const sub of subCommands) {
    if (!sub.includes(ISOMUX_DIR) && !sub.includes("~/.isomux")) continue;
    const firstToken = sub.split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
    if (!WRITE_COMMANDS.includes(firstToken)) continue;

    // For copy-like commands, only the destination (last arg) is a write target.
    // Reading *from* ~/.isomux/ is fine — only block if writing *to* it.
    if (COPY_COMMANDS.includes(firstToken)) {
      const args = sub.split(/\s+/).filter((a) => !a.startsWith("-"));
      const dest = args[args.length - 1] ?? "";
      if (dest.includes(ISOMUX_DIR) || dest.includes("~/.isomux")) return true;
      continue;
    }

    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// 4. Secrets protection — block reads of sensitive files
// ---------------------------------------------------------------------------

/** Exact basenames that are always sensitive */
const SENSITIVE_EXACT: Set<string> = new Set([
  ".env",
  ".netrc",
  ".pgpass",
  ".my.cnf",
  "credentials.json",
  "service-account.json",
  "service_account.json",
]);

/** Patterns matched against the basename */
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env\./, // .env.local, .env.production, .env.development, etc.
  /\.pem$/, // TLS/SSH private keys
  /\.key$/, // private key files
  /\.p12$/, // PKCS#12 keystores
  /\.pfx$/, // PKCS#12 (Windows naming)
  /\.jks$/, // Java keystores
  /^id_rsa/, // SSH private keys (id_rsa, id_rsa.pub is harmless but block anyway)
  /^id_ed25519/, // SSH ed25519 keys
  /^id_ecdsa/, // SSH ECDSA keys
  /^id_dsa/, // SSH DSA keys
];

/** Bash commands that read file contents */
const FILE_READ_COMMANDS = [
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "batcat",
  "strings",
  "xxd",
  "hexdump",
  "od",
  "base64",
];

/** Suffixes that indicate a template/example file, not real secrets */
const SAFE_SUFFIXES = [".example", ".template", ".sample", ".dist"];

function isSensitiveFile(filePath: string): boolean {
  const name = basename(filePath);
  // Allow .env.example, .env.template, etc.
  if (SAFE_SUFFIXES.some((s) => name.endsWith(s))) return false;
  if (SENSITIVE_EXACT.has(name)) return true;
  return SENSITIVE_PATTERNS.some((p) => p.test(name));
}

function denySecretRead(target: string, tool: string): HookJSONOutput {
  return deny(
    `BLOCKED by isomux safety hooks\n\n` +
      `Reason: "${basename(target)}" may contain secrets. Agents are not allowed ` +
      `to read sensitive files (.env, private keys, credentials, etc.).\n\n` +
      `${tool} target: ${target}\n\n` +
      `If you need a value from this file, ask the user to provide it.`,
  );
}

// ---------------------------------------------------------------------------
// 5. Process safety — block killing processes by name pattern
//
// Every agent backend on the box runs under a generic command line (`bun`,
// `node`, `claude`). A pattern aimed at one project's dev server therefore
// matches the office and every other agent too — that is not hypothetical, it
// is how the office has been taken down, by a `pkill -f "server/index.ts"`
// meant for an unrelated project.
//
// This rule is deliberately pattern-independent: it denies name-matching kills
// whatever they are searching for, so it protects offices booted under the old
// `server/index.ts` command line and the current `server/isomux-office.ts` one
// alike, with no list to keep in sync. Kills that name a PID or a port are left
// alone; only the name-matching forms are blocked.
// ---------------------------------------------------------------------------

/** Commands that select their victims by name/pattern rather than by PID */
const PATTERN_KILL_COMMANDS = ["pkill", "killall", "killall5"];

/** Commands that turn a name into PIDs, laundering a pattern kill */
const NAME_LOOKUP_COMMANDS = ["pgrep", "pidof"];

/** Wrappers and shell keywords that stand in front of the command that runs */
const COMMAND_WRAPPERS = [
  "sudo",
  "doas",
  "env",
  "xargs",
  "time",
  "nohup",
  "command",
  "exec",
  // shell keywords that occupy command position inside loops and conditionals
  "do",
  "then",
  "else",
  "elif",
  "{",
  "}",
  "!",
];

/** Interpreters whose `-c` argument is a command line, not an ordinary string */
const SHELL_COMMANDS = ["bash", "sh", "zsh", "dash", "ksh"];

/**
 * Per-wrapper flag grammar: which flags consume the next token, and which stand
 * alone. Both halves matter, and for opposite reasons.
 *
 * `value` stops `sudo -u nil pkill …` from reading `nil` as the command.
 * `boolean` stops the ambiguity fallback in commandCandidates() from firing on
 * an ordinary flag — without it, `xargs -r grep -l killall` would go on to read
 * `killall` as a second candidate and deny a plain search.
 *
 * Keyed by wrapper because the same letter differs between them: `-r` takes a
 * value for sudo (role) but stands alone for xargs (no-run-if-empty).
 *
 * A flag in neither set is UNKNOWN, which is what the conservative fallback is
 * for — better an extra candidate than a missed kill.
 */
type FlagGrammar = { value: Set<string>; boolean: Set<string> };

const WRAPPER_FLAGS: Record<string, FlagGrammar> = {
  sudo: {
    value: new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-U",
      "-p",
      "--prompt",
      "-C",
      "-h",
      "--host",
      "-r",
      "--role",
      "-t",
      "--type",
      "-D",
      "--chdir",
      "-R",
      "--chroot",
      "-T",
      "--command-timeout",
      "-c",
      "--class",
    ]),
    boolean: new Set([
      "-n",
      "--non-interactive",
      "-k",
      "--reset-timestamp",
      "-K",
      "--remove-timestamp",
      "-b",
      "--background",
      "-E",
      "--preserve-env",
      "-H",
      "--set-home",
      "-i",
      "--login",
      "-l",
      "--list",
      "-P",
      "--preserve-groups",
      "-S",
      "--stdin",
      "-s",
      "--shell",
      "-v",
      "--validate",
      "-A",
      "--askpass",
      "-e",
      "--edit",
    ]),
  },
  doas: {
    value: new Set(["-u", "-C"]),
    boolean: new Set(["-n", "-s", "-L"]),
  },
  env: {
    value: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
    boolean: new Set(["-i", "--ignore-environment", "-0", "--null", "-v"]),
  },
  time: {
    value: new Set(["-o", "--output", "-f", "--format"]),
    boolean: new Set([
      "-v",
      "--verbose",
      "-p",
      "--portability",
      "-a",
      "--append",
      "-q",
      "--quiet",
    ]),
  },
  xargs: {
    value: new Set([
      "-I",
      "--replace",
      "-n",
      "--max-args",
      "-P",
      "--max-procs",
      "-d",
      "--delimiter",
      "-a",
      "--arg-file",
      "-s",
      "--max-chars",
      "-L",
      "--max-lines",
    ]),
    // `-i` and `-e` take an OPTIONAL argument, which GNU xargs only accepts
    // attached (`-i{}`), so on their own they consume nothing.
    boolean: new Set([
      "-r",
      "--no-run-if-empty",
      "-0",
      "--null",
      "-t",
      "--verbose",
      "-p",
      "--interactive",
      "-x",
      "--exit",
      "-i",
      "-e",
      "--eof",
    ]),
  },
  command: { value: new Set(), boolean: new Set(["-p", "-v", "-V"]) },
  exec: { value: new Set(["-a"]), boolean: new Set(["-c", "-l"]) },
  nohup: { value: new Set(), boolean: new Set() },
};

// Shells: `-c`'s value is the payload. shellPayloads() reads it separately, so
// classifying it here just keeps the payload out of command position.
const SHELL_FLAGS: FlagGrammar = {
  value: new Set(["-c", "-o", "--rcfile", "--init-file"]),
  boolean: new Set([
    "-l",
    "--login",
    "-i",
    "-s",
    "-e",
    "-x",
    "-u",
    "-v",
    "-n",
    "--norc",
    "--noprofile",
    "--posix",
  ]),
};

/** Does this flag take the next token, stand alone, or is it unrecognized? */
function classifyFlag(
  flag: string,
  grammar: FlagGrammar | undefined,
): "value" | "boolean" | "unknown" {
  if (!grammar) return "unknown";
  if (grammar.value.has(flag)) return "value";
  if (grammar.boolean.has(flag)) return "boolean";
  // `--user=nil` carries its own value.
  if (flag.startsWith("--")) return flag.includes("=") ? "boolean" : "unknown";
  // A short cluster (`-rt`, `-lc`) is every letter at once. Only the last
  // letter can take a value; anything unrecognized makes the whole thing so.
  const letters = flag.slice(1);
  if (!/^[A-Za-z0-9]+$/.test(letters)) return "unknown";
  for (let i = 0; i < letters.length; i++) {
    const single = `-${letters[i]}`;
    if (grammar.boolean.has(single)) continue;
    if (grammar.value.has(single))
      return i === letters.length - 1 ? "value" : "unknown";
    return "unknown";
  }
  return "boolean";
}

const PATTERN_KILL_REASON =
  "Killing processes by name pattern also hits processes you don't own. " +
  "Target what you started instead: by port or PID.";

/** Heredoc bodies are data and never reach command position. */
function stripHeredocs(cmd: string): string {
  return cmd
    .replace(/<<-?\s*'([^']+)'\s*\n[\s\S]*?\n\s*\1/g, "")
    .replace(/<<-?\s*"([^"]+)"\s*\n[\s\S]*?\n\s*\1/g, "")
    .replace(/<<-?\s*(\w+)\s*\n[\s\S]*?\n\s*\1/g, "");
}

/** One shell word, plus whether any of it arrived inside quotes. */
type ShellWord = { text: string; quoted: boolean };

/** A resolved command: the program being run, and the words after it. */
type EffectiveCommand = { name: string; args: ShellWord[] };

/** Index of the `)` matching the `(` at `open`, or the end of the string. */
function matchParen(cmd: string, open: number): number {
  let depth = 0;
  for (let i = open; i < cmd.length; i++) {
    if (cmd[i] === "(") depth++;
    else if (cmd[i] === ")" && --depth === 0) return i;
  }
  return cmd.length;
}

/**
 * Parse a command line into the words of each command it runs, honoring quotes.
 *
 * Quoting is the whole point: a separator inside quotes is DATA, so
 * `echo "prose; pkill -f bun"` must stay one `echo` with one argument, while
 * `bash -c 'pkill -f bun'` really does execute pkill. Deleting quote characters
 * globally cannot tell those apart, so instead quoted spans are consumed into a
 * single word and only `bash -c`-style payloads are re-parsed (by the caller,
 * which knows it is looking at an interpreter).
 *
 * Command substitutions are parsed as commands in their own right — they run.
 * Inside single quotes they don't, which falls out of consuming those spans
 * whole. The substitution leaves a `$()` placeholder in the surrounding word so
 * it still reads as "not a literal PID".
 */
function parseCommands(cmd: string): ShellWord[][] {
  const commands: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let cur = "";
  let curQuoted = false;
  let dropWord = false; // set after a redirection operator: its target is noise

  const endWord = () => {
    if (!cur) return;
    if (!dropWord) words.push({ text: cur, quoted: curQuoted });
    dropWord = false;
    cur = "";
    curQuoted = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };

  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];

    if (ch === "$" && cmd[i + 1] === "(") {
      const end = matchParen(cmd, i + 1);
      commands.push(...parseCommands(cmd.slice(i + 2, end)));
      cur += "$()";
      i = end + 1;
      continue;
    }
    if (ch === "`") {
      const end = cmd.indexOf("`", i + 1);
      const stop = end === -1 ? cmd.length : end;
      commands.push(...parseCommands(cmd.slice(i + 1, stop)));
      cur += "``";
      i = stop + 1;
      continue;
    }
    if (ch === "'") {
      // Single quotes are literal all the way to the closing quote.
      const end = cmd.indexOf("'", i + 1);
      const stop = end === -1 ? cmd.length : end;
      cur += cmd.slice(i + 1, stop);
      curQuoted = true;
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      // Double quotes keep substitutions live, so walk them rather than slice.
      curQuoted = true;
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === "\\") {
          if (i + 1 < cmd.length) cur += cmd[i + 1];
          i += 2;
          continue;
        }
        if (cmd[i] === "$" && cmd[i + 1] === "(") {
          const end = matchParen(cmd, i + 1);
          commands.push(...parseCommands(cmd.slice(i + 2, end)));
          cur += "$()";
          i = end + 1;
          continue;
        }
        if (cmd[i] === "`") {
          const end = cmd.indexOf("`", i + 1);
          const stop = end === -1 ? cmd.length : end;
          commands.push(...parseCommands(cmd.slice(i + 1, stop)));
          cur += "``";
          i = stop + 1;
          continue;
        }
        cur += cmd[i];
        i++;
      }
      i++;
      continue;
    }
    if (ch === "\\") {
      // An escape only protects the next character; `p\kill` runs pkill.
      if (i + 1 < cmd.length && cmd[i + 1] !== "\n") cur += cmd[i + 1];
      i += 2;
      continue;
    }
    if (ch === ">" || ch === "<") {
      // Skip the operator (`>`, `>>`, `2>&1`, `&>`) and drop its target.
      endWord();
      i++;
      while (i < cmd.length && (cmd[i] === ">" || cmd[i] === "&")) i++;
      dropWord = true;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      endCommand();
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      endCommand();
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  endCommand();
  return commands;
}

/**
 * The commands a word list may actually run, looking past flags and wrappers.
 *
 * Usually one. A second is reported when the first candidate followed a flag
 * this table doesn't know: `sudo -D /tmp pkill …` would otherwise resolve to
 * `tmp`, because `-D` silently ate its own value. Rather than chase every
 * option of every wrapper, an unrecognized flag makes the scan keep looking —
 * so a missing table entry costs an extra candidate instead of a bypass. That
 * only happens behind a wrapper and only right after an unknown flag, so an
 * ordinary command's arguments are never mistaken for commands: `xargs grep -l
 * killall` still resolves to `grep` alone.
 */
function commandCandidates(words: ShellWord[]): EffectiveCommand[] {
  const found: EffectiveCommand[] = [];
  let grammar: FlagGrammar | undefined;
  let inWrapper = false;
  let afterUnknownFlag = false;
  for (let i = 0; i < words.length; i++) {
    const raw = words[i].text;
    if (raw === "--") {
      afterUnknownFlag = false;
      continue;
    }
    if (raw.startsWith("-") && raw !== "-") {
      const kind = classifyFlag(raw, grammar);
      if (kind === "value") i++; // its value is not the command
      afterUnknownFlag = kind === "unknown";
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue; // VAR=value prefix
    const name = raw.replace(/^.*\//, "");
    if (!name) continue; // a bare directory prefix, e.g. `/usr/bin/ pkill`
    const command = { name, args: words.slice(i + 1) };
    if (COMMAND_WRAPPERS.includes(name) || SHELL_COMMANDS.includes(name)) {
      // A shell is reported as well as walked past: shellPayloads() reads its
      // `-c` argument, while anything after it still needs scanning.
      if (SHELL_COMMANDS.includes(name)) found.push(command);
      inWrapper = true;
      grammar = SHELL_COMMANDS.includes(name)
        ? SHELL_FLAGS
        : WRAPPER_FLAGS[name];
      afterUnknownFlag = false;
      continue;
    }
    found.push(command);
    if (!(inWrapper && afterUnknownFlag)) break;
    afterUnknownFlag = false;
  }
  return found;
}

/** A short-option cluster carrying `c`, e.g. `-c`, `-lc`, `-ec`. */
const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

/**
 * The command lines an interpreter invocation runs: `bash -c '<payload>'`
 * executes its argument, so that one quoted word is structure rather than data.
 * Shells accept clustered flags (`bash -lc '…'`), so match the cluster, not a
 * literal `-c`. A `--` ends option parsing.
 */
function shellPayloads(cmd: EffectiveCommand): string[] {
  if (!SHELL_COMMANDS.includes(cmd.name)) return [];
  const payloads: string[] = [];
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i].text;
    if (arg === "--") break;
    if (!SHELL_COMMAND_FLAG.test(arg)) continue;
    const payload = cmd.args[i + 1];
    if (payload) payloads.push(payload.text);
  }
  return payloads;
}

/** A literal PID, a `%1` job spec, or `$$`/`$!` — a target already in hand. */
const LITERAL_PID = /^(?:\d+|%\d*|\$\$|\$!)$/;

/**
 * `pkill -P <pid>` targets the children of one process the agent already has a
 * PID for, so it carries none of the name-matching risk. The PID has to be a
 * literal: `pkill -P "$(pgrep -f bun)"` is a name match wearing the carve-out's
 * clothes. Any other flag (-f, -u, …) or a bare pattern operand also puts it
 * back in scope.
 */
function isParentScopedPkill(cmd: EffectiveCommand): boolean {
  if (cmd.name !== "pkill") return false;
  let sawParent = false;
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i].text;
    if (arg === "-P") {
      const pid = cmd.args[i + 1]?.text;
      if (pid === undefined || !LITERAL_PID.test(pid)) return false;
      sawParent = true;
      i++; // the PID operand belongs to -P
      continue;
    }
    if (/^-P\d+$/.test(arg)) {
      sawParent = true;
      continue;
    }
    return false; // another flag, or a name pattern
  }
  return sawParent;
}

/**
 * A kill whose every operand is a literal PID or job spec already names its
 * target, so an unrelated process lookup elsewhere in the line does not make it
 * a name match. `kill` with no operands (`… | xargs kill`, `kill $(pgrep …)`)
 * is taking its targets from somewhere else and does not qualify.
 */
function killsOnlyLiteralPids(cmd: EffectiveCommand): boolean {
  const operands: string[] = [];
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i].text;
    if (arg.startsWith("-")) {
      if (arg === "-s" || arg === "-n") i++; // the signal is not a target
      continue;
    }
    operands.push(arg);
  }
  return operands.length > 0 && operands.every((a) => LITERAL_PID.test(a));
}

/**
 * Every command a line runs, following `bash -c` payloads into the command
 * lines they execute. Depth-limited because a payload can nest.
 */
function collectCommands(command: string, depth = 0): EffectiveCommand[] {
  const commands = parseCommands(stripHeredocs(command)).flatMap(
    commandCandidates,
  );
  if (depth >= 4) return commands;
  return commands.flatMap((cmd) => [
    cmd,
    ...shellPayloads(cmd).flatMap((p) => collectCommands(p, depth + 1)),
  ]);
}

/** Returns a denial reason, or null if the command kills nothing by name. */
function checkProcessKill(command: string): string | null {
  const commands = collectCommands(command);

  for (const cmd of commands) {
    if (PATTERN_KILL_COMMANDS.includes(cmd.name) && !isParentScopedPkill(cmd))
      return PATTERN_KILL_REASON;
  }

  // `pgrep -f X | xargs kill`, `kill $(pidof bun)`, and the read-loop spelling
  // are the same kill with the name matching moved one step upstream. Judged
  // across the whole command rather than per statement: shell loops and `;`
  // scatter the two halves into separate statements, so a tighter window only
  // moves the hole. Two things keep that width honest — `ps` counts as a lookup
  // only alongside `grep`, the step that turns it into a name match; and a kill
  // that names literal PIDs is left alone however the line reads.
  const names = new Set(commands.map((c) => c.name));
  const kills = commands.filter(
    (c) => c.name === "kill" || PATTERN_KILL_COMMANDS.includes(c.name),
  );
  const lookups =
    NAME_LOOKUP_COMMANDS.some((n) => names.has(n)) ||
    (names.has("ps") && names.has("grep"));
  if (lookups && kills.some((c) => !killsOnlyLiteralPids(c)))
    return PATTERN_KILL_REASON;

  return null;
}

// ---------------------------------------------------------------------------
// Tool input path extraction
//
// Tool inputs name their file under different keys: Read/Write/Edit use
// `file_path`, NotebookEdit uses `notebook_path`. The published SDK types offer
// no tool-name -> input-shape registry (`ToolInputSchemas` is an untagged union
// of shape-named interfaces), so the table below is maintained by hand — and
// because a hand-maintained table goes stale, extraction falls back to a
// key-name heuristic and finally fails CLOSED. A guarded tool whose path we
// cannot find is denied, not waved through.
// ---------------------------------------------------------------------------

const TOOL_PATH_KEYS: Record<string, readonly string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookRead: ["notebook_path"],
  NotebookEdit: ["notebook_path"],
};

/** Key names that carry a filesystem path, for tools not in the table above */
const PATH_KEY_PATTERN = /path|file|dir/i;

/**
 * Every path a tool call would touch, or null when the input shape gives no
 * answer — callers must treat null as "cannot verify" and deny.
 */
function collectToolPaths(
  toolName: string,
  toolInput: unknown,
): string[] | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const record = toolInput as Record<string, unknown>;

  const paths: string[] = [];
  for (const key of TOOL_PATH_KEYS[toolName] ?? []) {
    const value = record[key];
    if (typeof value === "string" && value) paths.push(value);
  }
  if (paths.length > 0) return paths;

  // Unrecognized shape: take any string under a path-shaped key, so a tool that
  // renames or adds a path field is still checked.
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || !value) continue;
    if (PATH_KEY_PATTERN.test(key)) paths.push(value);
  }
  return paths.length > 0 ? paths : null;
}

/** Resolve ~ and relative paths to an absolute path. */
function resolvePath(filePath: string): string {
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  if (filePath === "~") return homedir();
  return resolve(filePath);
}

function denyUnverifiablePath(toolName: string, rule: string): HookJSONOutput {
  return deny(
    `BLOCKED by isomux safety hooks\n\n` +
      `Reason: isomux could not tell which file ${toolName} would touch, so it could not check ` +
      `it against ${rule}. Guarded tools are denied rather than waved through when their input ` +
      `shape isn't recognized.\n\n` +
      `Tell the user which tool and which input fields hit this, so the guard can be updated.`,
  );
}

// ---------------------------------------------------------------------------
// Hook callbacks
// ---------------------------------------------------------------------------

const checkBashSafety: HookCallback = async (input) => {
  const { tool_input } = input as PreToolUseHookInput;
  const command = (tool_input as { command?: string })?.command;
  if (typeof command !== "string" || !command) return allow();

  // Strip quoted strings so patterns don't match commit messages, echo args, etc.
  const stripped = stripQuotedStrings(command);
  const normalized = normalizeAbsolutePaths(stripped);

  // Check ~/.isomux/ write protection first
  if (commandWritesToIsomux(stripped)) {
    return denyMessage(
      "Writing to ~/.isomux/ is not allowed. This directory is managed by the isomux server. " +
        "Read operations (cat, ls, grep, etc.) are permitted.",
      command,
    );
  }

  // Check process kills. This one gets the raw command: it does its own
  // quote handling (quoted payloads hide a command word, quoted prose does not
  // reach command position), which the blanket stripping above would defeat.
  const killReason = checkProcessKill(command);
  if (killReason) return denyMessage(killReason, command);

  // Check sensitive file reads via shell commands (cat .env, head key.pem, etc.)
  const subCommands = normalized.split(/[|;&]+/).map((s) => s.trim());
  for (const sub of subCommands) {
    const tokens = sub.split(/\s+/);
    const cmd = tokens[0]?.replace(/^.*\//, "") ?? "";
    if (!FILE_READ_COMMANDS.includes(cmd)) continue;
    // Check all non-flag arguments as potential file paths
    for (const arg of tokens.slice(1)) {
      if (arg.startsWith("-")) continue;
      if (isSensitiveFile(arg)) {
        return denyMessage(
          `"${basename(arg)}" may contain secrets. Agents are not allowed ` +
            `to read sensitive files (.env, private keys, credentials, etc.). ` +
            `If you need a value from this file, ask the user to provide it.`,
          command,
        );
      }
    }
  }

  // Check safe patterns first (allowlist)
  for (const pattern of SAFE_PATTERNS) {
    if (pattern.test(normalized)) return allow();
  }

  // Check destructive patterns (blocklist)
  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(normalized)) {
      return denyMessage(reason, command);
    }
  }

  return allow();
};

const checkWriteEditSafety: HookCallback = async (input) => {
  const { tool_name, tool_input } = input as PreToolUseHookInput;
  const filePaths = collectToolPaths(tool_name, tool_input);
  if (filePaths === null)
    return denyUnverifiablePath(
      tool_name,
      "the protected ~/.isomux/ directory",
    );

  for (const filePath of filePaths) {
    const resolved = resolvePath(filePath);
    if (resolved === ISOMUX_DIR || resolved.startsWith(ISOMUX_DIR + "/")) {
      return deny(
        `BLOCKED by isomux safety hooks\n\n` +
          `Reason: Writing to ~/.isomux/ is not allowed. This directory is managed by the isomux server.\n\n` +
          `${tool_name} target: ${filePath}\n\n` +
          `If this operation is truly needed, ask the user for explicit ` +
          `permission and have them run the command manually.`,
      );
    }
  }

  return allow();
};

const checkSensitiveFileRead: HookCallback = async (input) => {
  const { tool_name, tool_input } = input as PreToolUseHookInput;
  const filePaths = collectToolPaths(tool_name, tool_input);
  if (filePaths === null)
    return denyUnverifiablePath(
      tool_name,
      "the sensitive-file rules (.env, private keys, credentials)",
    );

  for (const filePath of filePaths) {
    if (isSensitiveFile(filePath)) return denySecretRead(filePath, tool_name);
  }

  return allow();
};

// ---------------------------------------------------------------------------
// Export — wire into SDKSessionOptions.hooks
// ---------------------------------------------------------------------------

export function createSafetyHooks(): Partial<
  Record<HookEvent, HookCallbackMatcher[]>
> {
  return {
    // One entry per tool name — a matcher is a plain tool name, not a regex, so
    // every guarded tool has to be listed. Notebook tools carry their path
    // under `notebook_path`; `collectToolPaths` is what makes that work.
    PreToolUse: [
      { matcher: "Bash", hooks: [checkBashSafety] },
      { matcher: "Read", hooks: [checkSensitiveFileRead] },
      { matcher: "NotebookRead", hooks: [checkSensitiveFileRead] },
      { matcher: "Write", hooks: [checkWriteEditSafety] },
      { matcher: "Edit", hooks: [checkWriteEditSafety] },
      { matcher: "MultiEdit", hooks: [checkWriteEditSafety] },
      {
        matcher: "NotebookEdit",
        hooks: [checkWriteEditSafety, checkSensitiveFileRead],
      },
    ],
  };
}
