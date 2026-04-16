/**
 * Safety hooks for isomux agents.
 *
 * Injected as PreToolUse hooks into every agent's SDK session. Three concerns:
 *
 *   1. Git safety — block destructive git commands (checkout --, reset --hard, etc.)
 *   2. Filesystem safety — block rm -rf and similar
 *   3. Isomux config protection — block all writes to ~/.isomux/
 *   4. Secrets protection — block reads of .env, private keys, credentials, etc.
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

const ISOMUX_DIR = resolve(homedir(), ".isomux");

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
    `permission and have them run the command manually.`
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
  [
    /git\s+reset\s+--merge/,
    "git reset --merge can lose uncommitted changes.",
  ],
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
  /git\s+checkout\s+-b\s+/,                                          // Creating new branch
  /git\s+checkout\s+--orphan\s+/,                                    // Creating orphan branch
  /git\s+restore\s+--staged\s+(?!.*--worktree)(?!.*-W\b)/,          // Unstaging only (safe)
  /git\s+restore\s+-S\s+(?!.*--worktree)(?!.*-W\b)/,                // Unstaging short form (safe)
  /git\s+clean\s+-[a-z]*n[a-z]*/,                                   // Dry run (-n, -fn, -nf, etc.)
  /git\s+clean\s+--dry-run/,                                        // Dry run (long form)
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

// Commands that only read — safe to run against ~/.isomux/
const READ_ONLY_COMMANDS = [
  "cat", "ls", "head", "tail", "less", "grep", "rg", "find",
  "stat", "wc", "file", "diff", "bat", "jq", "tree",
];

// Copy-like commands where only the last argument (destination) is a write target.
// Reading from ~/.isomux/ via these is fine; only writing to it should be blocked.
const COPY_COMMANDS = ["cp", "rsync", "scp", "install"];

// Commands that can modify files — if these target ~/.isomux/, block them
const WRITE_COMMANDS = [
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown",
  "tee", "dd", "install", "rsync", "scp", "ln",
  "sed", "awk", "perl", "python", "python3", "ruby", "node", "bun",
];

function commandWritesToIsomux(command: string): boolean {
  // Check 1: Redirection (> or >>) targeting ~/.isomux/
  // Match: > ~/.isomux/ or >> ~/.isomux/ or > /home/user/.isomux/
  const redirectPattern = new RegExp(
    `>>?\\s*(?:~\\/\\.isomux|${ISOMUX_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`
  );
  if (redirectPattern.test(command)) return true;

  // Check 2: Write commands with ~/.isomux/ as an argument
  // Split on pipe/semicolon/&&/|| to get individual sub-commands
  const subCommands = command.split(/[|;&]+/).map(s => s.trim());
  for (const sub of subCommands) {
    if (!sub.includes(ISOMUX_DIR) && !sub.includes("~/.isomux")) continue;
    const firstToken = sub.split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
    if (!WRITE_COMMANDS.includes(firstToken)) continue;

    // For copy-like commands, only the destination (last arg) is a write target.
    // Reading *from* ~/.isomux/ is fine — only block if writing *to* it.
    if (COPY_COMMANDS.includes(firstToken)) {
      const args = sub.split(/\s+/).filter(a => !a.startsWith("-"));
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
  /^\.env\./,                    // .env.local, .env.production, .env.development, etc.
  /\.pem$/,                      // TLS/SSH private keys
  /\.key$/,                      // private key files
  /\.p12$/,                      // PKCS#12 keystores
  /\.pfx$/,                      // PKCS#12 (Windows naming)
  /\.jks$/,                      // Java keystores
  /^id_rsa/,                     // SSH private keys (id_rsa, id_rsa.pub is harmless but block anyway)
  /^id_ed25519/,                 // SSH ed25519 keys
  /^id_ecdsa/,                   // SSH ECDSA keys
  /^id_dsa/,                     // SSH DSA keys
];

/** Bash commands that read file contents */
const FILE_READ_COMMANDS = [
  "cat", "head", "tail", "less", "more", "bat", "batcat",
  "strings", "xxd", "hexdump", "od", "base64",
];

/** Suffixes that indicate a template/example file, not real secrets */
const SAFE_SUFFIXES = [".example", ".template", ".sample", ".dist"];

function isSensitiveFile(filePath: string): boolean {
  const name = basename(filePath);
  // Allow .env.example, .env.template, etc.
  if (SAFE_SUFFIXES.some(s => name.endsWith(s))) return false;
  if (SENSITIVE_EXACT.has(name)) return true;
  return SENSITIVE_PATTERNS.some(p => p.test(name));
}

function denySecretRead(target: string, tool: string): HookJSONOutput {
  return deny(
    `BLOCKED by isomux safety hooks\n\n` +
    `Reason: "${basename(target)}" may contain secrets. Agents are not allowed ` +
    `to read sensitive files (.env, private keys, credentials, etc.).\n\n` +
    `${tool} target: ${target}\n\n` +
    `If you need a value from this file, ask the user to provide it.`
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

  // Check sensitive file reads via shell commands (cat .env, head key.pem, etc.)
  const subCommands = normalized.split(/[|;&]+/).map(s => s.trim());
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
  const filePath = (tool_input as { file_path?: string })?.file_path;
  if (typeof filePath !== "string" || !filePath) return allow();

  // Resolve ~ and relative paths
  const resolved = filePath.startsWith("~/")
    ? resolve(homedir(), filePath.slice(2))
    : filePath.startsWith("~")
      ? homedir()
      : resolve(filePath);

  if (resolved === ISOMUX_DIR || resolved.startsWith(ISOMUX_DIR + "/")) {
    return deny(
      `BLOCKED by isomux safety hooks\n\n` +
      `Reason: Writing to ~/.isomux/ is not allowed. This directory is managed by the isomux server.\n\n` +
      `${tool_name} target: ${filePath}\n\n` +
      `If this operation is truly needed, ask the user for explicit ` +
      `permission and have them run the command manually.`
    );
  }

  return allow();
};

const checkSensitiveFileRead: HookCallback = async (input) => {
  const { tool_name, tool_input } = input as PreToolUseHookInput;
  const filePath = (tool_input as { file_path?: string })?.file_path;
  if (typeof filePath !== "string" || !filePath) return allow();

  if (isSensitiveFile(filePath)) {
    return denySecretRead(filePath, tool_name);
  }

  return allow();
};

// ---------------------------------------------------------------------------
// Export — wire into SDKSessionOptions.hooks
// ---------------------------------------------------------------------------

export function createSafetyHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      { matcher: "Bash", hooks: [checkBashSafety] },
      { matcher: "Read", hooks: [checkSensitiveFileRead] },
      { matcher: "Write", hooks: [checkWriteEditSafety] },
      { matcher: "Edit", hooks: [checkWriteEditSafety] },
    ],
  };
}
