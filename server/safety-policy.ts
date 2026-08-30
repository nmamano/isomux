/**
 * Provider-neutral safety policy for isomux agents.
 *
 * Evaluates provider-neutral proposed actions. Six concerns:
 *
 *   1. Git safety - block destructive git commands (checkout --, reset --hard, etc.)
 *   2. Filesystem safety - block rm -rf and similar
 *   3. Isomux config protection - block all writes to ~/.isomux/
 *   4. Secrets protection - block reads of .env, private keys, credentials, etc.
 *   5. Network safety - block recognized outbound tunnel launch commands
 *   6. Process safety - block killing processes by name pattern (pkill/killall)
 *
 * Read operations on ~/.isomux/ are always allowed (agents need discovery/logs).
 */

import { homedir } from "os";
import { basename, isAbsolute, normalize, resolve } from "path";
import { STATE_ROOT } from "./config.ts";

// The write-protection root follows the active state root, so a test that
// redirects ISOMUX_HOME protects its temp dir rather than the real one.
// NOTE: the literal "~/.isomux" patterns in the command-text checks below are
// deliberately NOT derived from this - they match what an agent literally
// typed, not resolved app state. Do not replace those literals with STATE_ROOT.
const ISOMUX_DIR = STATE_ROOT;

// ---------------------------------------------------------------------------
// Deny / Allow helpers
// ---------------------------------------------------------------------------

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

export type ProposedAction =
  | { kind: "shell"; command: unknown }
  | { kind: "read-files"; toolName: string; input: unknown }
  | { kind: "write-files"; toolName: string; input: unknown }
  | { kind: "read-and-write-files"; toolName: string; input: unknown }
  | { kind: "patch-files"; toolName: string; patch: unknown }
  | { kind: "uncovered-tool"; toolName: string; input: unknown };

export type PolicyContext = { cwd?: unknown };

const ALLOW: PolicyDecision = Object.freeze({ decision: "allow" });

function deny(reason: string): PolicyDecision {
  return { decision: "deny", reason };
}

function allow(): PolicyDecision {
  return ALLOW;
}

function denyMessage(reason: string, command: string): PolicyDecision {
  return deny(
    `BLOCKED by isomux safety hooks\n\n` +
      `Reason: ${reason}\n\n` +
      `Command: ${command}\n\n` +
      `If this operation is truly needed, ask the user for explicit ` +
      `permission and have them run the command manually.`,
  );
}

// ---------------------------------------------------------------------------
// 1. Git safety - destructive command patterns
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
  // 2. Filesystem safety - destructive rm commands
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
// Path normalization - handles /bin/rm, /usr/bin/git, etc.
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

// ---------------------------------------------------------------------------
// Heredoc bodies
//
// A heredoc body is data on a command's stdin, not command text, so nothing in
// it should ever be matched as a command. Getting that wrong is not theoretical:
// an agent sending a report with `jq -Rs '{text: .}' <<'EOF' … EOF | curl …`
// had it blocked as a write to ~/.isomux/, because the report's prose was read
// as commands.
//
// The shape that got through is the ordinary one: bash starts the body on the
// line AFTER the operator's line, so the operator can be followed by the rest
// of the pipeline. A regex that expects a newline right after the delimiter
// misses exactly that. Bodies are therefore found the way bash finds them -
// per line, with the delimiter matched on a line of its own.
// ---------------------------------------------------------------------------

/**
 * A heredoc opened on a line: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`.
 * `expand` follows bash's rule - quoting any part of the delimiter makes the
 * body literal; an unquoted delimiter leaves substitutions in it live.
 */
type Heredoc = { delimiter: string; stripTabs: boolean; expand: boolean };

/**
 * The heredocs opened on one line, in the order their bodies follow it.
 *
 * Everything here exists to avoid a phantom: a `<<` read as an operator when
 * it is not one takes the lines below it out of view as though they were data.
 * So quotes are tracked (`echo "see <<EOF"`), a comment ends the scan, `<<<`
 * is a here-string with no body, and an arithmetic span is skipped whole
 * because `<<` inside it is a bit shift.
 */
function heredocsOpenedOn(line: string): Heredoc[] {
  const found: Heredoc[] = [];
  let quote: string | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 2;
      else {
        if (ch === quote) quote = null;
        i++;
      }
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) {
      break; // a comment: `# heredocs are written <<EOF` opens nothing
    }
    if (ch === "(" && line[i + 1] === "(") {
      // Arithmetic, where `<<` is a bit shift, in both spellings: `$((1 << 20))`
      // and the bare `(( x << 2 ))`. Skipping the span keeps either from
      // opening a heredoc named `20`.
      i = matchParen(line, i) + 1;
      continue;
    }
    if (ch !== "<" || line[i + 1] !== "<") {
      i++;
      continue;
    }
    if (line[i + 2] === "<") {
      i += 3; // here-string: its word is data on the same line, not a body
      continue;
    }
    i += 2;
    let stripTabs = false;
    if (line[i] === "-") {
      stripTabs = true;
      i++;
    }
    while (line[i] === " " || line[i] === "\t") i++;
    // The delimiter word, which may be quoted in whole or in part.
    let delimiter = "";
    let expand = true;
    let inner: string | null = null;
    while (i < line.length) {
      const c = line[i];
      if (inner) {
        if (c === inner) inner = null;
        else delimiter += c;
        i++;
        continue;
      }
      if (c === "'" || c === '"') {
        inner = c;
        expand = false;
        i++;
        continue;
      }
      if (c === "\\") {
        expand = false;
        if (i + 1 < line.length) delimiter += line[i + 1];
        i += 2;
        continue;
      }
      if (/[\s;&|<>()]/.test(c)) break;
      delimiter += c;
      i++;
    }
    if (delimiter) found.push({ delimiter, stripTabs, expand });
  }
  return found;
}

/**
 * The command substitutions inside a string - the only part of an unquoted
 * heredoc body that still runs. `matchParen` lives with the command parser
 * below; the two share the same idea of where a `$( … )` ends.
 *
 * A backslash escapes `$`, a backtick, and itself in an unquoted body, so
 * `\$(pkill …)` is text an agent is quoting, not a command (Reviewer1). `\\`
 * consumes itself and leaves the substitution after it live.
 */
function extractSubstitutions(text: string): string {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++; // whatever follows is literal
      continue;
    }
    if (text[i] === "$" && text[i + 1] === "(") {
      const end = matchParen(text, i + 1);
      parts.push(text.slice(i, end + 1));
      i = end;
    } else if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      const stop = end === -1 ? text.length - 1 : end;
      parts.push(text.slice(i, stop + 1));
      i = stop;
    }
  }
  return parts.join("\n");
}

/**
 * Drop every heredoc body, keeping the command lines around it.
 *
 * A quoted delimiter (`<<'EOF'`) makes the body wholly literal, so it goes.
 * An unquoted one (`<<EOF`) still expands the body, so `$(pkill …)` inside it
 * really does run - those substitutions are kept and only the prose around
 * them is dropped.
 *
 * A body with no terminator ends at the end of the input, which is what bash
 * does: it warns, closes the heredoc there, and runs the command anyway. The
 * lines below an unterminated `<<` are body, never commands, so keeping them
 * would only invent denials. Not opening a phantom heredoc in the first place
 * is `heredocsOpenedOn`'s job (Reviewer1).
 */
function stripHeredocBodies(cmd: string): string {
  if (!cmd.includes("<<")) return cmd;
  const lines = cmd.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    for (const doc of heredocsOpenedOn(lines[i])) {
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const line = doc.stripTabs ? lines[j].replace(/^\t+/, "") : lines[j];
        if (line === doc.delimiter) {
          end = j;
          break;
        }
      }
      const bodyEnd = end === -1 ? lines.length : end;
      if (doc.expand) {
        const live = extractSubstitutions(
          lines.slice(i + 1, bodyEnd).join("\n"),
        );
        if (live) kept.push(live);
      }
      i = bodyEnd; // body and terminator both drop out
      if (end === -1) break; // nothing after an unterminated body
    }
  }
  return kept.join("\n");
}

/**
 * Strip quoted strings and heredocs from a command so that pattern matching
 * only applies to actual command structure, not to message content.
 * Replaces quoted content with empty strings to preserve command structure.
 */
function stripQuotedStrings(cmd: string): string {
  let result = stripHeredocBodies(cmd);
  // Remove double-quoted strings (handling escaped quotes)
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Remove single-quoted strings (no escaping in single quotes)
  result = result.replace(/'[^']*'/g, "''");
  // Remove $'...' ANSI-C quoting
  result = result.replace(/\$'(?:[^'\\]|\\.)*'/g, "''");
  return result;
}

// ---------------------------------------------------------------------------
// 3. Isomux config protection - block writes to ~/.isomux/
// ---------------------------------------------------------------------------

// Copy-like commands where only the last argument (destination) is a write target.
// Reading from ~/.isomux/ via these is fine; only writing to it should be blocked.
const COPY_COMMANDS = ["cp", "rsync", "scp", "install"];

// Commands that can modify files - if these target ~/.isomux/, block them
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

// ---------------------------------------------------------------------------
// 4. Secrets protection - block reads of sensitive files
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

/** Bash commands that read file contents. Every bare operand is a path. */
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
  "nl",
  "tac",
  "cut",
];

// ---------------------------------------------------------------------------
// 4b. Per-command grammar for the Bash-side readers (task 137c6684)
//
// `cat .env` is easy: every bare operand is a path. `grep`, `rg`, `sed` and
// `awk` are not - their FIRST bare operand is the pattern or the script, so the
// naive "check every non-flag word" rule denies `grep id_rsa ~/.ssh/config` for
// something the agent was searching FOR, not reading.
//
// Telling the two apart needs to know, per command, which flags eat the next
// token: `rg -r id_rsa KEY notes.txt` names no path at all (`-r` is rg's
// --replace), while `grep -r id_rsa notes.txt` does (grep's -r is boolean
// --recursive). The same letter, opposite arity, which is why this is keyed by
// command name - the same reasoning as WRAPPER_FLAGS above.
//
// A flag in no set is UNKNOWN and treated as consuming NOTHING. That direction
// is deliberate: guessing "consumes a value" would step over a real path and
// miss a secret read, while guessing "stands alone" at worst checks a flag's
// value as if it were a path, which can only over-block.
// ---------------------------------------------------------------------------

type ReaderGrammar = {
  /** Flags that consume the next token as their value. */
  value: Set<string>;
  /** Value flags whose value names a file the command reads - a pattern file
   *  (`grep -f patterns`) or a file SELECTOR (`grep --include=.env`, which is
   *  the same request as naming the file, and the same thing isSensitiveFile
   *  already checks for the Grep tool's `glob` field). */
  pathValue: Set<string>;
  /** True when the first bare operand is a pattern/script rather than a path. */
  firstOperandIsPattern: boolean;
  /** Flags that SUPPLY the pattern/script, so every bare operand is a path. */
  patternFlags: Set<string>;
  /** pathValue flags whose value is a GLOB with rg's negation grammar, where a
   *  leading `!` means "exclude". Only these: everywhere else a leading `!` is
   *  an ordinary first character of a filename (`grep -f '!patterns.pem'`). */
  negatableGlobs: Set<string>;
};

function plainReader(): ReaderGrammar {
  // Deliberately empty flag sets: with no first-operand ambiguity to resolve,
  // every non-flag token is a path candidate, exactly as it was before this
  // table existed. A value that is not a path (`head -n 5 .env`: the `5`) gets
  // checked and simply isn't sensitive.
  return {
    value: new Set(),
    pathValue: new Set(),
    firstOperandIsPattern: false,
    patternFlags: new Set(),
    negatableGlobs: new Set(),
  };
}

const GREP_GRAMMAR: ReaderGrammar = {
  value: new Set([
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-m",
    "--max-count",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "-d",
    "--directories",
    "-D",
    "--devices",
    "--include",
    "--exclude",
    "--exclude-from",
    "--exclude-dir",
    "--label",
    "--binary-files",
    "--group-separator",
  ]),
  pathValue: new Set(["-f", "--file", "--exclude-from", "--include"]),
  firstOperandIsPattern: true,
  patternFlags: new Set(["-e", "--regexp", "-f", "--file"]),
  // grep's --include has no negation grammar; --exclude is the negative form
  // and is not a pathValue at all.
  negatableGlobs: new Set(),
};

const RG_GRAMMAR: ReaderGrammar = {
  value: new Set([
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-g",
    "--glob",
    "--iglob",
    "-t",
    "--type",
    "-T",
    "--type-not",
    "--type-add",
    "-m",
    "--max-count",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "-M",
    "--max-columns",
    // rg's -r is --replace and takes a value; grep's -r is boolean --recursive.
    "-r",
    "--replace",
    "-d",
    "--max-depth",
    "--max-filesize",
    "--ignore-file",
    "--path-separator",
    "--sort",
    "--sortr",
    "--pre",
    "--colors",
    "-j",
    "--threads",
    "-E",
    "--encoding",
    "--context-separator",
    "--field-match-separator",
  ]),
  pathValue: new Set([
    "-f",
    "--file",
    "--ignore-file",
    "-g",
    "--glob",
    "--iglob",
  ]),
  firstOperandIsPattern: true,
  patternFlags: new Set(["-e", "--regexp", "-f", "--file"]),
  negatableGlobs: new Set(["-g", "--glob", "--iglob"]),
};

const AG_GRAMMAR: ReaderGrammar = {
  value: new Set([
    "-A",
    "--after",
    "-B",
    "--before",
    "-C",
    "--context",
    "-m",
    "--max-count",
    "-G",
    "--file-search-regex",
    "--ignore",
    "--path-to-ignore",
    "--workers",
  ]),
  pathValue: new Set(["--path-to-ignore"]),
  firstOperandIsPattern: true,
  patternFlags: new Set(),
  negatableGlobs: new Set(),
};

const SED_GRAMMAR: ReaderGrammar = {
  // `-i` takes an OPTIONAL suffix that GNU sed only accepts attached (`-i.bak`),
  // so on its own it consumes nothing and stays out of `value`.
  value: new Set(["-e", "--expression", "-f", "--file", "-l", "--line-length"]),
  pathValue: new Set(["-f", "--file"]),
  firstOperandIsPattern: true,
  patternFlags: new Set(["-e", "--expression", "-f", "--file"]),
  negatableGlobs: new Set(),
};

const AWK_GRAMMAR: ReaderGrammar = {
  value: new Set([
    "-F",
    "--field-separator",
    "-v",
    "--assign",
    "-f",
    "--file",
    "--source",
    "-e",
    "--include",
    "-i",
  ]),
  pathValue: new Set(["-f", "--file", "--include"]),
  firstOperandIsPattern: true,
  patternFlags: new Set(["-f", "--file", "--source", "-e"]),
  negatableGlobs: new Set(),
};

const READER_GRAMMAR: Record<string, ReaderGrammar> = {
  ...Object.fromEntries(FILE_READ_COMMANDS.map((c) => [c, plainReader()])),
  grep: GREP_GRAMMAR,
  egrep: GREP_GRAMMAR,
  fgrep: GREP_GRAMMAR,
  rgrep: GREP_GRAMMAR,
  rg: RG_GRAMMAR,
  ag: AG_GRAMMAR,
  sed: SED_GRAMMAR,
  awk: AWK_GRAMMAR,
  gawk: AWK_GRAMMAR,
  mawk: AWK_GRAMMAR,
  nawk: AWK_GRAMMAR,
};

/**
 * The path-valued arguments of one reader invocation.
 *
 * `args` comes from the shared shell parser (parseCommands -> commandCandidates),
 * so quoting, wrappers, assignment prefixes, command substitutions and `bash -c`
 * payloads are already resolved before we get here.
 *
 * One left-to-right pass collects operands and notes whether a pattern-supplying
 * flag appeared; the first-operand drop happens at the END so it survives GNU's
 * option permutation (`grep .env -e KEY` really does read .env).
 */
function readerPathOperands(args: ShellWord[], g: ReaderGrammar): string[] {
  const operands: string[] = [];
  const paths: string[] = [];
  // rg spells an EXCLUSION as `-g '!*.pem'`. Excluding a file is not reading
  // it, and treating it as a path would deny the safest form of the command.
  // Scoped to the flags that actually have that grammar: for anything else a
  // leading `!` is just the first character of a filename, and a redirect
  // target (no flag) is never a glob.
  const pushPath = (v: string, flag?: string) => {
    if (flag && g.negatableGlobs.has(flag) && v.startsWith("!")) return;
    paths.push(v);
  };
  let sawPatternFlag = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // `cat < .env`: a file the command reads, but never a positional operand,
    // so it must not be mistaken for the pattern slot.
    if (arg.redirect) {
      pushPath(arg.text);
      continue;
    }
    const tok = arg.text;
    if (!endOfOptions && tok === "--") {
      endOfOptions = true;
      continue;
    }
    // A quoted word is data the shell handed over whole, never option syntax:
    // `grep -- '-v'` and `sed 's/-x/y/'` are operands even though they start
    // with a dash.
    if (!endOfOptions && !arg.quoted && tok.length > 1 && tok.startsWith("-")) {
      if (tok.startsWith("--")) {
        const eq = tok.indexOf("=");
        const name = eq === -1 ? tok : tok.slice(0, eq);
        if (g.patternFlags.has(name)) sawPatternFlag = true;
        if (eq !== -1) {
          if (g.pathValue.has(name)) pushPath(tok.slice(eq + 1), name);
        } else if (g.value.has(name)) {
          const v = args[++i];
          if (v !== undefined && g.pathValue.has(name)) pushPath(v.text, name);
        }
        continue;
      }
      // Short-option cluster: `-rn`, `-ie`, `-A3`. The first value-taking letter
      // takes the rest of the cluster if non-empty, else the next token - GNU
      // behaviour, and what makes `-ne PATTERN` read PATTERN as -e's value.
      for (let j = 1; j < tok.length; j++) {
        const f = `-${tok[j]}`;
        if (g.patternFlags.has(f)) sawPatternFlag = true;
        if (!g.value.has(f)) continue;
        const attached = tok.slice(j + 1);
        const v = attached.length ? attached : args[++i]?.text;
        if (v !== undefined && g.pathValue.has(f)) pushPath(v, f);
        break;
      }
      continue;
    }
    operands.push(tok);
  }
  if (g.firstOperandIsPattern && !sawPatternFlag) operands.shift();
  return [...paths, ...operands];
}

/** The first sensitive file a bash line would read, or null.
 *
 *  Runs over collectCommands(), the same resolution the process-kill guard
 *  uses, so a reader hidden behind a wrapper (`sudo cat .env`), an assignment
 *  prefix (`X=1 cat .env`), a substitution inside double quotes
 *  (`echo "$(cat .env)"`) or a `bash -c` payload is still seen. Input
 *  redirections are kept here (`cat < .env`) and only here - the kill guard has
 *  no use for them, so its call keeps the parser's default behaviour. */
function bashSensitiveReadTarget(command: string): string | null {
  for (const cmd of collectCommands(command, 0, true)) {
    const grammar = READER_GRAMMAR[cmd.name];
    if (!grammar) continue;
    for (const path of readerPathOperands(cmd.args, grammar)) {
      if (isSensitiveFile(path)) return path;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Outbound tunnel safety
//
// This is deliberately a text tripwire, not complete enforcement. It inspects
// parsed command words so quoted prose, heredoc data, and ordinary arguments do
// not trigger it. A renamed binary, a non-shell interpreter, a package runner
// other than the direct npx/bunx forms below, or an indirect service start can
// still bypass it.
// ---------------------------------------------------------------------------

type TunnelMatch = { form: string };

function cloudflaredTunnel(cmd: EffectiveCommand): TunnelMatch | null {
  if (cmd.name !== "cloudflared") return null;
  const tunnel = cmd.args.findIndex((arg) => arg.text === "tunnel");
  if (tunnel === -1) return null;
  const rest = cmd.args.slice(tunnel + 1).map((arg) => arg.text);
  if (rest.some((arg) => arg === "--url" || arg.startsWith("--url=")))
    return { form: "cloudflared tunnel --url" };
  if (rest.includes("run")) return { form: "cloudflared tunnel run" };
  return null;
}

function firstOperandIndex(
  cmd: EffectiveCommand,
  grammar: FlagGrammar,
): number {
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i].text;
    if (arg === "--") return i + 1;
    if (!arg.startsWith("-") || arg === "-") return i;
    if (classifyFlag(arg, grammar) === "value") i++;
  }
  return -1;
}

function ngrokTunnel(cmd: EffectiveCommand): TunnelMatch | null {
  if (cmd.name !== "ngrok") return null;
  const index = firstOperandIndex(cmd, NGROK_FLAGS);
  const subcommand = cmd.args[index]?.text;
  if (["http", "tcp", "tls", "start"].includes(subcommand ?? ""))
    return { form: `ngrok ${subcommand}` };
  if (
    subcommand === "service" &&
    ["start", "restart"].includes(cmd.args[index + 1]?.text ?? "")
  )
    return { form: `ngrok service ${cmd.args[index + 1].text}` };
  return null;
}

function looksLikeRemoteForward(value: string | undefined): boolean {
  const listen = value?.trim().split(/\s+/, 1)[0];
  return listen !== undefined && (/^\d+$/.test(listen) || listen.includes(":"));
}

function sshRemoteForward(cmd: EffectiveCommand): TunnelMatch | null {
  if (cmd.name !== "ssh") return null;
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i].text;
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") return null;

    if (arg === "-o") {
      const option = cmd.args[i + 1]?.text ?? "";
      const spec = /^RemoteForward(?:=|\s+)(.+)$/i.exec(option)?.[1];
      if (looksLikeRemoteForward(spec)) return { form: "ssh RemoteForward" };
    } else {
      const option = /^-oRemoteForward(?:=|\s+)(.+)$/i.exec(arg)?.[1];
      if (looksLikeRemoteForward(option)) return { form: "ssh RemoteForward" };
    }

    const remote = /^-([A-Za-z0-9]*)R(.*)$/.exec(arg);
    if (
      remote &&
      [...remote[1]].every((flag) => SSH_FLAGS.boolean.has(`-${flag}`))
    ) {
      const spec = remote[2] || cmd.args[i + 1]?.text;
      if (looksLikeRemoteForward(spec))
        return { form: "ssh -R remote forwarding" };
    }

    if (classifyFlag(arg, SSH_FLAGS) === "value") i++;
  }
  return null;
}

const TAILSCALE_READ_OR_CLOSE = new Set([
  "status",
  "reset",
  "get-config",
  "drain",
]);

function tailscaleTunnel(cmd: EffectiveCommand): TunnelMatch | null {
  if (cmd.name !== "tailscale") return null;
  const index = firstOperandIndex(cmd, TAILSCALE_FLAGS);
  const kind = cmd.args[index]?.text;
  if (kind !== "funnel" && kind !== "serve") return null;
  const rest = cmd.args.slice(index + 1).map((arg) => arg.text);
  if (rest.length === 0 || rest.includes("--help") || rest.includes("-h"))
    return null;
  if (TAILSCALE_READ_OR_CLOSE.has(rest[0]) || rest.at(-1) === "off")
    return null;
  return { form: `tailscale ${kind}` };
}

function directPackageRunnerCommand(
  cmd: EffectiveCommand,
): EffectiveCommand | null {
  if (cmd.name !== "npx" && cmd.name !== "bunx") return null;
  let i = 0;
  while (["-y", "--yes", "--no-install"].includes(cmd.args[i]?.text ?? "")) i++;
  const name = cmd.args[i]?.text;
  if (name !== "cloudflared" && name !== "ngrok") return null;
  return { name, args: cmd.args.slice(i + 1) };
}

/** The first recognized command form that opens an outbound tunnel. */
function checkOutboundTunnel(command: string): TunnelMatch | null {
  for (const parsed of collectCommands(command)) {
    const cmd = directPackageRunnerCommand(parsed) ?? parsed;
    const match =
      cloudflaredTunnel(cmd) ??
      ngrokTunnel(cmd) ??
      sshRemoteForward(cmd) ??
      tailscaleTunnel(cmd);
    if (match) return match;
  }
  return null;
}

/** Suffixes that indicate a template/example file, not real secrets */
const SAFE_SUFFIXES = [".example", ".template", ".sample", ".dist"];

// The two backends' own logins. Isomux causes these files to exist, so they
// are the one class of secret we can name by location rather than by a guessed
// filename. `auth.json` is far too generic to sit in SENSITIVE_EXACT - plenty
// of projects have one and none of them are this - so it counts only inside a
// codex home. `.credentials.json` is specific enough to match anywhere, and
// note it is NOT covered by the `credentials.json` entry above: the match is
// exact and the leading dot defeats it.
const BACKEND_CREDENTIAL_PATHS: RegExp[] = [
  /(^|\/)\.credentials\.json$/, // Claude Code
  /(^|\/)(\.codex|codex-home)\/auth\.json$/, // Codex, default and per-user homes
  /(^|\/)\.local\/share\/opencode\/auth\.json$/, // OpenCode native home
  /(^|\/)opencode\/profiles\/[^/]+\/data\/opencode\/auth\.json$/, // OpenCode profiles
];

function isSensitiveFile(filePath: string): boolean {
  // A glob arrives here too (Grep's `glob: "*.pem"` selects the same files a
  // path would). A trailing wildcard is not part of any real name, so drop it
  // and match what is left: `.env*` is a request for `.env`. This is still
  // name matching and not glob analysis - a brace or character-class pattern
  // can name a sensitive file without looking like one (Reviewer1).
  const name = basename(filePath).replace(/\*+$/, "");
  const path = filePath.replace(/\*+$/, "");
  // Checked before SAFE_SUFFIXES: a backend login is never a template, and the
  // suffix check returns early, so anything it matched could never be reached.
  if (BACKEND_CREDENTIAL_PATHS.some((p) => p.test(path))) return true;
  // Allow .env.example, .env.template, etc.
  if (SAFE_SUFFIXES.some((s) => name.endsWith(s))) return false;
  if (SENSITIVE_EXACT.has(name)) return true;
  return SENSITIVE_PATTERNS.some((p) => p.test(name));
}

function denySecretRead(target: string, tool: string): PolicyDecision {
  return deny(
    `BLOCKED by isomux safety hooks\n\n` +
      `Reason: "${basename(target)}" may contain secrets. Agents are not allowed ` +
      `to read sensitive files (.env, private keys, credentials, etc.).\n\n` +
      `${tool} target: ${target}\n\n` +
      `If you need a value from this file, ask the user to provide it.`,
  );
}

// ---------------------------------------------------------------------------
// 6. Process safety - block killing processes by name pattern
//
// Every agent backend on the box runs under a generic command line (`bun`,
// `node`, `claude`). A pattern aimed at one project's dev server therefore
// matches the office and every other agent too - that is not hypothetical, it
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
 * an ordinary flag - without it, `xargs -r grep -l killall` would go on to read
 * `killall` as a second candidate and deny a plain search.
 *
 * Keyed by wrapper because the same letter differs between them: `-r` takes a
 * value for sudo (role) but stands alone for xargs (no-run-if-empty).
 *
 * A flag in neither set is UNKNOWN, which is what the conservative fallback is
 * for - better an extra candidate than a missed kill.
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

// These grammars delimit each binary's own options from its first operand.
// They are local to the tunnel guard and do not make the binaries wrappers for
// the process-kill parser.
const NGROK_FLAGS: FlagGrammar = {
  value: new Set(["--config", "--log", "--log-format", "--log-level"]),
  boolean: new Set(["--help", "--version"]),
};

const TAILSCALE_FLAGS: FlagGrammar = {
  value: new Set(["--socket", "--timeout"]),
  boolean: new Set(),
};

const SSH_FLAGS: FlagGrammar = {
  value: new Set([
    "-B",
    "-b",
    "-c",
    "-D",
    "-E",
    "-e",
    "-F",
    "-I",
    "-i",
    "-J",
    "-L",
    "-l",
    "-m",
    "-O",
    "-o",
    "-P",
    "-p",
    "-Q",
    "-R",
    "-S",
    "-W",
    "-w",
  ]),
  boolean: new Set([
    "-4",
    "-6",
    "-A",
    "-a",
    "-C",
    "-f",
    "-G",
    "-g",
    "-K",
    "-k",
    "-M",
    "-N",
    "-n",
    "-q",
    "-s",
    "-T",
    "-t",
    "-V",
    "-v",
    "-X",
    "-x",
    "-Y",
    "-y",
  ]),
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

/** One shell word, plus whether any of it arrived inside quotes.
 *
 *  `redirect` marks the target of an input redirection (`< file`), which is a
 *  file the command READS but never a positional operand. Only produced when a
 *  caller opts in (see parseCommands' `keepInputTargets`); the process-kill
 *  guard has no use for it and keeps the default. */
type ShellWord = {
  text: string;
  quoted: boolean;
  redirect?: "input" | "output";
};

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
 * Command substitutions are parsed as commands in their own right - they run.
 * Inside single quotes they don't, which falls out of consuming those spans
 * whole. The substitution leaves a `$()` placeholder in the surrounding word so
 * it still reads as "not a literal PID".
 */
function parseCommands(
  cmd: string,
  keepInputTargets = false,
  keepOutputTargets = false,
): ShellWord[][] {
  const commands: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let cur = "";
  let curQuoted = false;
  let dropWord = false; // set after a redirection operator: its target is noise
  let keepAsRedirect: false | "input" | "output" = false;

  const endWord = () => {
    if (!cur) return;
    if (!dropWord) words.push({ text: cur, quoted: curQuoted });
    else if (keepAsRedirect)
      words.push({ text: cur, quoted: curQuoted, redirect: keepAsRedirect });
    dropWord = false;
    keepAsRedirect = false;
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
      commands.push(
        ...parseCommands(
          cmd.slice(i + 2, end),
          keepInputTargets,
          keepOutputTargets,
        ),
      );
      cur += "$()";
      i = end + 1;
      continue;
    }
    if (ch === "`") {
      const end = cmd.indexOf("`", i + 1);
      const stop = end === -1 ? cmd.length : end;
      commands.push(
        ...parseCommands(
          cmd.slice(i + 1, stop),
          keepInputTargets,
          keepOutputTargets,
        ),
      );
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
          commands.push(
            ...parseCommands(
              cmd.slice(i + 2, end),
              keepInputTargets,
              keepOutputTargets,
            ),
          );
          cur += "$()";
          i = end + 1;
          continue;
        }
        if (cmd[i] === "`") {
          const end = cmd.indexOf("`", i + 1);
          const stop = end === -1 ? cmd.length : end;
          commands.push(
            ...parseCommands(
              cmd.slice(i + 1, stop),
              keepInputTargets,
              keepOutputTargets,
            ),
          );
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
      // A lone `<` is the exception a reader check cares about: its target is a
      // file being read. `<<` / `<<<` are heredoc and here-string, whose bodies
      // are DATA (`cat <<< '.env'` reads no file), and `<&3` names a descriptor.
      endWord();
      // Consume the whole run of the operator character first, so `<<<` is one
      // here-string operator rather than three input redirections.
      let run = 0;
      while (i < cmd.length && cmd[i] === ch) {
        run++;
        i++;
      }
      let toDescriptor = false;
      while (i < cmd.length && (cmd[i] === ">" || cmd[i] === "&")) {
        toDescriptor = true;
        i++;
      }
      dropWord = true;
      keepAsRedirect =
        keepInputTargets && ch === "<" && run === 1 && !toDescriptor
          ? "input"
          : keepOutputTargets && ch === ">" && !toDescriptor
            ? "output"
            : false;
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
 * option of every wrapper, an unrecognized flag makes the scan keep looking -
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

/** A literal PID, a `%1` job spec, or `$$`/`$!` - a target already in hand. */
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
 * commandCandidates, with input-redirection targets lifted out of the word
 * stream first and re-attached to whatever command resolves.
 *
 * A redirection may PRECEDE the command - `< .env cat` and `2<.env cat` both
 * open the file and then run `cat` - so leaving the target in the stream would
 * put it (or the bare fd number in front of it) in command position and lose
 * the reader entirely. Only used by the reader check, which is the only caller
 * that asks parseCommands for redirect targets at all.
 */
function candidatesWithRedirects(words: ShellWord[]): EffectiveCommand[] {
  const redirects = words.filter((w) => w.redirect === "input");
  if (redirects.length === 0) return commandCandidates(words);
  const rest = words.filter((w) => w.redirect !== "input");
  // `2<.env cat` leaves the descriptor number as a word of its own, in command
  // position. Only stripped ahead of a redirect, so an ordinary operand that
  // happens to be a number is untouched.
  while (rest.length > 0 && /^\d+$/.test(rest[0].text)) rest.shift();
  return commandCandidates(rest).map((cmd) => ({
    name: cmd.name,
    args: [...cmd.args, ...redirects],
  }));
}

/**
 * Every command a line runs, following `bash -c` payloads into the command
 * lines they execute. Depth-limited because a payload can nest.
 */
function collectCommands(
  command: string,
  depth = 0,
  keepInputTargets = false,
): EffectiveCommand[] {
  const commands = parseCommands(
    stripHeredocBodies(command),
    keepInputTargets,
  ).flatMap(keepInputTargets ? candidatesWithRedirects : commandCandidates);
  if (depth >= 4) return commands;
  return commands.flatMap((cmd) => [
    cmd,
    ...shellPayloads(cmd).flatMap((p) =>
      collectCommands(p, depth + 1, keepInputTargets),
    ),
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
  // moves the hole. Two things keep that width honest - `ps` counts as a lookup
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
// `file_path`, NotebookEdit uses `notebook_path`, Grep uses `path` and `glob`.
// The published SDK types offer
// no tool-name -> input-shape registry (`ToolInputSchemas` is an untagged union
// of shape-named interfaces), so the table below is maintained by hand - and
// because a hand-maintained table goes stale, extraction falls back to a
// key-name heuristic and finally fails CLOSED. A guarded tool whose path we
// cannot find is denied, not waved through.
// ---------------------------------------------------------------------------

type ToolPathSpec = {
  /** Input keys naming what the call would touch, in check order. */
  keys: readonly string[];
  /**
   * True for a tool whose target is optional and defaults to the working
   * directory. An input with none of `keys` set is then "no particular file",
   * which is a shape we DO recognize, so it is allowed rather than denied -
   * fail-closed still covers every tool and every input we cannot read.
   */
  targetOptional?: boolean;
};

const TOOL_PATH_SPECS: Record<string, ToolPathSpec> = {
  Read: { keys: ["file_path"] },
  Write: { keys: ["file_path"] },
  Edit: { keys: ["file_path"] },
  MultiEdit: { keys: ["file_path"] },
  NotebookRead: { keys: ["notebook_path"] },
  NotebookEdit: { keys: ["notebook_path"] },
  // Grep returns file contents, so it reads secrets as surely as Read does.
  // `glob` counts alongside `path`: `glob: "*.pem"` picks out the same files.
  // Both are optional - a Grep with neither is a search of the working
  // directory, which this name-based rule has nothing to say about.
  Grep: { keys: ["path", "glob"], targetOptional: true },
};

/** Key names that carry a filesystem path, for tools not in the table above */
const PATH_KEY_PATTERN = /path|file|dir/i;

/**
 * Every path a tool call would touch, or null when the input shape gives no
 * answer - callers must treat null as "cannot verify" and deny. An empty array
 * means the opposite: a recognized input that names no particular file.
 */
function collectToolPaths(
  toolName: string,
  toolInput: unknown,
): string[] | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const record = toolInput as Record<string, unknown>;
  const spec = TOOL_PATH_SPECS[toolName];

  const paths: string[] = [];
  for (const key of spec?.keys ?? []) {
    const value = record[key];
    if (typeof value === "string" && value) paths.push(value);
  }
  if (paths.length > 0) return paths;

  // Unrecognized shape: take any string under a path-shaped key, so a tool that
  // renames or adds a path field is still checked. This runs for an
  // optional-target tool too, so a renamed `path` is caught rather than read as
  // "no target given".
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || !value) continue;
    if (PATH_KEY_PATTERN.test(key)) paths.push(value);
  }
  if (paths.length > 0) return paths;

  return spec?.targetOptional ? [] : null;
}

function policyCwd(value: unknown): string | null {
  if (typeof value !== "string" || !value || !isAbsolute(value)) return null;
  return resolve(value);
}

/** Resolve ~ and absolute paths without cwd; relative paths require agent cwd. */
function resolvePath(filePath: string, cwd: unknown): string | null {
  if (filePath === "~/.isomux") return ISOMUX_DIR;
  if (filePath.startsWith("~/.isomux/")) {
    return resolve(ISOMUX_DIR, filePath.slice("~/.isomux/".length));
  }
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  if (filePath === "~") return homedir();
  if (isAbsolute(filePath)) return resolve(filePath);
  const base = policyCwd(cwd);
  if (!base) return null;
  const resolvedPath = resolve(base, filePath);
  const literalStateRoot = resolve(homedir(), ".isomux");
  if (isAtOrBelow(resolvedPath, literalStateRoot)) {
    return resolve(ISOMUX_DIR, resolvedPath.slice(literalStateRoot.length + 1));
  }
  return resolvedPath;
}

function isAtOrBelow(filePath: string, root: string): boolean {
  return filePath === root || filePath.startsWith(root + "/");
}

function isAtOrBelowStateRoot(filePath: string): boolean {
  return isAtOrBelow(filePath, ISOMUX_DIR);
}

function isProtectedRelativeCandidate(filePath: string): boolean {
  if (isAbsolute(filePath) || filePath.startsWith("~/") || filePath === "~") {
    return false;
  }
  return normalize(filePath)
    .split("/")
    .some((segment) => segment === ".isomux");
}

function denyMissingCwd(toolName: string, filePath: string): PolicyDecision {
  return deny(
    `BLOCKED by isomux safety hooks\n\n` +
      `Reason: isomux could not resolve the relative path because the tool call ` +
      `did not include a non-empty absolute agent cwd.\n\n` +
      `${toolName} target: ${filePath}\n\n` +
      `Tell the user that the safety hook received a missing or invalid cwd, ` +
      `and use an absolute write target.`,
  );
}

function denyUnverifiablePath(toolName: string, rule: string): PolicyDecision {
  return deny(
    `BLOCKED by isomux safety hooks\n\n` +
      `Reason: isomux could not tell which file ${toolName} would touch, so it could not check ` +
      `it against ${rule}. Guarded tools are denied rather than waved through when their input ` +
      `shape isn't recognized.\n\n` +
      `Tell the user which tool and which input fields hit this, so the guard can be updated.`,
  );
}

/**
 * Paths named by Codex's apply_patch envelope.
 *
 * Patch content is data, not shell text. Only control headers at the start of
 * a line name files. A move touches both its Update source and destination.
 * Null means the envelope does not identify a complete, supported path set;
 * the caller denies that as unverifiable rather than treating it as a runtime
 * checker fault.
 */
export function extractApplyPatchPaths(patch: unknown): string[] | null {
  if (typeof patch !== "string") return null;
  const lines = patch.split("\n");
  if (lines[0] !== "*** Begin Patch") return null;
  if (lines.at(-1) !== "*** End Patch") return null;
  const paths: string[] = [];
  let section: "add" | "delete" | "update" | null = null;
  let movedCurrentUpdate = false;
  for (const line of lines.slice(1, -1)) {
    const header = line.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
    if (header) {
      const path = header[2].trim();
      if (!path || path.includes("\0")) return null;
      const operation = header[1];
      if (operation === "Add") section = "add";
      else if (operation === "Delete") section = "delete";
      else if (operation === "Update") section = "update";
      else return null;
      movedCurrentUpdate = false;
      paths.push(path);
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move) {
      const path = move[1].trim();
      if (
        section !== "update" ||
        movedCurrentUpdate ||
        !path ||
        path.includes("\0")
      ) {
        return null;
      }
      movedCurrentUpdate = true;
      paths.push(path);
      continue;
    }
    if (line.startsWith("*** ") && line !== "*** End of File") return null;
  }
  return paths.length > 0 ? paths : null;
}

// ---------------------------------------------------------------------------
// Hook callbacks
// ---------------------------------------------------------------------------

function writeTargets(command: EffectiveCommand): ShellWord[] {
  const redirects = command.args.filter((word) => word.redirect === "output");
  const args = command.args.filter((word) => !word.redirect);
  if (COPY_COMMANDS.includes(command.name)) {
    const operands = args.filter((word) => !word.text.startsWith("-"));
    return [...redirects, ...(operands.length ? [operands.at(-1)!] : [])];
  }
  if (!WRITE_COMMANDS.includes(command.name)) return redirects;
  return [...redirects, ...args.filter((word) => !word.text.startsWith("-"))];
}

function dynamicDirectoryTarget(target: ShellWord | undefined): boolean {
  return (
    !target ||
    target.text === "-" ||
    target.text.includes("$") ||
    target.text.includes("``")
  );
}

function shellWriteDecision(
  command: string,
  initialCwd: unknown,
  depth = 0,
): PolicyDecision | null {
  let effectiveCwd = policyCwd(initialCwd);
  let directoryChangeMadeCwdUnknown = false;
  const uncertainControl =
    /(?:^|[;&|()\s])(?:cd|pushd|popd)(?:\s|$)/.test(command) &&
    /\|\||(^|[^&])&([^&]|$)|[()]/.test(command);
  if (uncertainControl) {
    effectiveCwd = null;
    directoryChangeMadeCwdUnknown = true;
  }

  const commandWords = parseCommands(stripHeredocBodies(command), false, true);
  for (const words of commandWords) {
    const redirects = words.filter((word) => word.redirect === "output");
    const candidates = commandCandidates(
      words.filter((word) => word.redirect !== "output"),
    );
    if (candidates.length === 0) {
      for (const target of redirects) {
        const resolved = resolvePath(target.text, effectiveCwd);
        if (
          resolved === null &&
          (directoryChangeMadeCwdUnknown ||
            isProtectedRelativeCandidate(target.text))
        ) {
          return denyMissingCwd("Bash", target.text);
        }
        if (resolved !== null && isAtOrBelowStateRoot(resolved)) {
          return denyMessage(
            "Writing to ~/.isomux/ is not allowed. This directory is managed by the isomux server. " +
              "Read operations (cat, ls, grep, etc.) are permitted.",
            command,
          );
        }
      }
    }
    for (const candidate of candidates) {
      const commandWithRedirects = {
        ...candidate,
        args: [...candidate.args, ...redirects],
      };
      for (const target of writeTargets(commandWithRedirects)) {
        const resolved = resolvePath(target.text, effectiveCwd);
        if (
          resolved === null &&
          (directoryChangeMadeCwdUnknown ||
            isProtectedRelativeCandidate(target.text))
        ) {
          return denyMissingCwd("Bash", target.text);
        }
        if (resolved === null) continue;
        if (isAtOrBelowStateRoot(resolved)) {
          return denyMessage(
            "Writing to ~/.isomux/ is not allowed. This directory is managed by the isomux server. " +
              "Read operations (cat, ls, grep, etc.) are permitted.",
            command,
          );
        }
      }

      if (candidate.name === "popd" || candidate.name === "pushd") {
        effectiveCwd = null;
        directoryChangeMadeCwdUnknown = true;
      } else if (candidate.name === "cd") {
        const target = candidate.args.find(
          (word) => !word.text.startsWith("-"),
        );
        if (uncertainControl || dynamicDirectoryTarget(target)) {
          effectiveCwd = null;
          directoryChangeMadeCwdUnknown = true;
        } else {
          effectiveCwd = resolvePath(target!.text, effectiveCwd);
          directoryChangeMadeCwdUnknown = effectiveCwd === null;
        }
      }

      if (depth < 4) {
        for (const payload of shellPayloads(candidate)) {
          const nested = shellWriteDecision(payload, effectiveCwd, depth + 1);
          if (nested) return nested;
        }
      }
    }
  }
  return null;
}

function checkBashSafety(commandValue: unknown, cwd: unknown): PolicyDecision {
  const command = commandValue;
  if (typeof command !== "string" || !command) return allow();

  // Strip quoted strings so patterns don't match commit messages, echo args, etc.
  const stripped = stripQuotedStrings(command);
  const normalized = normalizeAbsolutePaths(stripped);

  // Check ~/.isomux/ write protection first
  const protectedWrite = shellWriteDecision(command, cwd);
  if (protectedWrite) return protectedWrite;

  // Check process kills. This one gets the raw command: it does its own
  // quote handling (quoted payloads hide a command word, quoted prose does not
  // reach command position), which the blanket stripping above would defeat.
  const killReason = checkProcessKill(command);
  if (killReason) return denyMessage(killReason, command);

  // This must stay before SAFE_PATTERNS. That legacy allowlist returns for the
  // whole shell line when any safe fragment matches.
  const tunnel = checkOutboundTunnel(command);
  if (tunnel) {
    return denyMessage(
      `Refused: \`${tunnel.form}\` (an agent may not open a tunnel). ` +
        `This text check covers recognized command forms only; a renamed binary ` +
        `or interpreter can bypass it.`,
      command,
    );
  }

  // Check sensitive file reads via shell commands (cat .env, grep KEY .env,
  // sed -n 1p id_rsa, ...). Runs on the RAW command, not `normalized`: the
  // reader grammar needs the words themselves, quotes resolved rather than
  // blanked, and a wrapper or `bash -c` payload hides the reader entirely.
  const secretTarget = bashSensitiveReadTarget(command);
  if (secretTarget) {
    return denyMessage(
      `"${basename(secretTarget)}" may contain secrets. Agents are not allowed ` +
        `to read sensitive files (.env, private keys, credentials, etc.). ` +
        `If you need a value from this file, ask the user to provide it.`,
      command,
    );
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
}

function checkWritePaths(
  toolName: string,
  filePaths: string[],
  cwd: unknown,
): PolicyDecision {
  for (const filePath of filePaths) {
    const resolved = resolvePath(filePath, cwd);
    if (resolved === null) {
      if (isProtectedRelativeCandidate(filePath)) {
        return denyMissingCwd(toolName, filePath);
      }
      continue;
    }
    if (isAtOrBelowStateRoot(resolved)) {
      return deny(
        `BLOCKED by isomux safety hooks\n\n` +
          `Reason: Writing to ~/.isomux/ is not allowed. This directory is managed by the isomux server.\n\n` +
          `${toolName} target: ${filePath}\n\n` +
          `If this operation is truly needed, ask the user for explicit ` +
          `permission and have them run the command manually.`,
      );
    }
  }

  return allow();
}

function checkWriteEditSafety(
  toolName: string,
  toolInput: unknown,
  cwd: unknown,
): PolicyDecision {
  const filePaths = collectToolPaths(toolName, toolInput);
  if (filePaths === null)
    return denyUnverifiablePath(toolName, "the protected ~/.isomux/ directory");
  return checkWritePaths(toolName, filePaths, cwd);
}

function checkPatchSafety(
  toolName: string,
  patch: unknown,
  cwd: unknown,
): PolicyDecision {
  const filePaths = extractApplyPatchPaths(patch);
  if (filePaths === null)
    return denyUnverifiablePath(toolName, "the protected ~/.isomux/ directory");
  return checkWritePaths(toolName, filePaths, cwd);
}

function checkSensitiveFileRead(
  toolName: string,
  toolInput: unknown,
): PolicyDecision {
  const filePaths = collectToolPaths(toolName, toolInput);
  if (filePaths === null)
    return denyUnverifiablePath(
      toolName,
      "the sensitive-file rules (.env, private keys, credentials)",
    );

  for (const filePath of filePaths) {
    if (isSensitiveFile(filePath)) return denySecretRead(filePath, toolName);
  }

  return allow();
}

// ---------------------------------------------------------------------------
// Provider-neutral routing. Adapters translate engine tool names to these
// action kinds; the core owns which policy checks each kind runs.
// ---------------------------------------------------------------------------

export function evaluateProposedAction(
  action: ProposedAction,
  context: PolicyContext = {},
): PolicyDecision {
  switch (action.kind) {
    case "shell":
      return checkBashSafety(action.command, context.cwd);
    case "read-files":
      return checkSensitiveFileRead(action.toolName, action.input);
    case "write-files":
      return checkWriteEditSafety(action.toolName, action.input, context.cwd);
    case "read-and-write-files": {
      const writeDecision = checkWriteEditSafety(
        action.toolName,
        action.input,
        context.cwd,
      );
      return writeDecision.decision === "deny"
        ? writeDecision
        : checkSensitiveFileRead(action.toolName, action.input);
    }
    case "patch-files":
      return checkPatchSafety(action.toolName, action.patch, context.cwd);
    case "uncovered-tool":
      return allow();
  }
}
