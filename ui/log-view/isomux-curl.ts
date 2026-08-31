// Parser for curl commands that target the isomux server's own API.
//
// The chat transcript is full of Bash tool calls like
//   curl -s -X POST localhost:4000/api/agents/<id>/messages -H 'Content-Type:
//   application/json' -d '{"text":"..."}'
// Since we know the shape of our own API, we can render these as a structured
// card (method badge, route, key payload fields) instead of raw shell text.
//
// This module is deliberately conservative: parseIsomuxCurl() returns null for
// anything it can't FULLY understand (compound commands, command substitution,
// unknown flags, non-isomux hosts), and the caller falls back to the plain
// rendering. A false null costs nothing; a false parse would show a wrong
// summary. Five deliberate tolerances on top of that:
// - side-effect-free redirections (`2>/dev/null`, `>/dev/null`, `2>&1`) are
//   accepted and omitted from the card (see tokenize);
// - saving output to a file (`> file`, `>> file`, `-o file`) is accepted for
//   plain paths, and the path is ALWAYS surfaced on the card (outputFile) -
//   a file write is a side effect the card must not conceal;
// - a leading `jq ... |` producer stage feeding `curl -d @-` is understood,
//   resolving the body when the jq program is a simple literal template (see
//   parseJqInvocation). The producer's input may be a heredoc
//   (`jq -Rs '{text: .}' <<'EOF' | curl ... -d @-` - the standard multiline
//   message shape; quoted delimiters always, unquoted ones for
//   expansion-free bodies) or a single positional file
//   (`jq -Rs '{text: .}' file`); see extractHeredoc and the -Rs handling in
//   parseJqInvocation.
// - a heredoc feeding curl's stdin directly (`curl -d @- <<'EOF' ... EOF` - the
//   standard Codex message-POST shape) supplies the body: literal JSON becomes
//   card fields, anything else a "body from heredoc" note (see
//   resolveHeredocBody).
// - trailing `;`/`&&`-chained inspection commands (`curl ... > f; wc -c f`,
//   `curl ... >/dev/null && echo posted`) are accepted for a small allowlist of
//   display/inspection commands, and - like a pipe tail - are ALWAYS shown on
//   the card verbatim (trailingCommand); see splitStatements and
//   TRAILING_COMMANDS.

export type CurlBodyField = { key: string; value: string };

export type IsomuxCurlRequest = {
  /** Uppercased HTTP method ("GET", "POST", ...). */
  method: string;
  /** Path + query string, e.g. "/api/memory?scope=agent". Always starts with "/". */
  path: string;
  /** Human label for known routes ("Send agent message"), or null if unknown. */
  action: string | null;
  /**
   * Top-level fields of the JSON object body, stringified for display.
   * Empty array for an empty object body ("{}"); null when there is no body
   * or the body isn't a JSON object.
   */
  bodyFields: CurlBodyField[] | null;
  /** Raw body text when present but not parseable as a JSON object. */
  bodyRaw: string | null;
  /** True when an Authorization header is present (value is never surfaced). */
  hasAuth: boolean;
  /**
   * Trailing pipeline, verbatim, e.g. "| jq '.tasks'". Null if none.
   *
   * Accepted tails are shell-checked (each stage must tokenize under the same
   * conservative rules as the curl itself - no compound commands, no file
   * redirections or substitutions; safe stream redirections like
   * `2>/dev/null` are tolerated) and command-gated (see FILTER_COMMANDS).
   * They are NOT semantically validated - a `sed w` script can still write a
   * file - so the collapsed card must never show less of the tail than the raw
   * collapsed rendering would; run it through pipeTailForDisplay(), which is
   * what guarantees that. Length does not gate the parse (task c9f35c77):
   * dropping the card over a long jq program left the reader with the raw
   * summary, which shows even less.
   */
  pipeTail: string | null;
  /**
   * Short note describing a body the parser accepted but could not resolve
   * into fields, e.g. "body built with jq" for a `jq ... | curl -d @-`
   * producer pipeline whose jq program is more than a literal template.
   * Mutually exclusive with bodyFields/bodyRaw. Null otherwise.
   */
  bodyNote: string | null;
  /**
   * Filesystem path the response/output is written to, when the command saves
   * it via a stdout redirection (`> file`, `>> file`) or `-o file`. This is a
   * real side effect, so the UI MUST surface it on the card (it is rendered
   * as an "output → path" note chip); the parser never accepts an output
   * path it cannot display verbatim. Null when output goes to the terminal.
   */
  outputFile: string | null;
  /** True when outputFile is appended to (`>>`) rather than overwritten. */
  outputAppend: boolean;
  /**
   * Trailing statements chained onto the curl with `;`, `&&`, or a matching
   * Isomux-curl `||` fallback, verbatim and
   * including the separator, e.g. `; wc -c /tmp/tasks.json` or
   * `&& echo "posted"`. Null when the command is a single statement.
   *
   * Same contract as pipeTail: the statements are command-gated (see
   * TRAILING_COMMANDS) and shell-checked, but NOT semantically validated, so
   * the collapsed card must show them at least as fully as the raw collapsed
   * row would - run them through pipeTailForDisplay().
   */
  trailingCommand: string | null;
};

// --- shell tokenizer ---------------------------------------------------------

type OutputRedirect = { path: string; append: boolean };

type Tokenized = {
  tokens: string[];
  pipeTail: string | null;
  outputRedirect: OutputRedirect | null;
};

// Conservative allowlist for a redirect target path: plain path characters
// only. Anything outside (quotes, spaces, globs, braces, parens) bails to raw
// rendering. `$` is allowed - an unexpanded `$VAR` in the card is shown
// verbatim, which is honest; `$(` is unreachable because `(` is not in the
// set, so the word fails to end cleanly and the parse bails.
const REDIRECT_PATH_RE = /^[A-Za-z0-9_\-./~+%:,$]+$/;

/**
 * Tokenize a single simple shell command. Handles single/double quotes,
 * backslash escapes, and backslash-newline continuations. Returns null on any
 * shell construct beyond a simple command optionally piped into something
 * (compound commands, redirections, subshells, command substitution).
 * `$VAR` references are kept literally - they read well in a summary
 * (e.g. a path containing $AGENT_ID).
 */
function tokenize(
  command: string,
  allowFileRedirect: boolean = false,
): Tokenized | null {
  const src = command.trim();
  let outputRedirect: OutputRedirect | null = null;
  const tokens: string[] = [];
  let cur = "";
  let hasCur = false;
  // True when any part of the current token came from quotes or a backslash
  // escape. Needed at `>`: a bare `2` before `>` is an fd number in shell,
  // but a quoted/escaped one (`'2'>f`) is an argument - we bail on those.
  let curQuoted = false;
  let i = 0;
  const n = src.length;
  const push = () => {
    if (hasCur) {
      tokens.push(cur);
      cur = "";
      hasCur = false;
    }
    curQuoted = false;
  };
  while (i < n) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += src.slice(i + 1, end);
      hasCur = true;
      curQuoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const d = src[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === "\\" && i + 1 < n && '"\\$`'.includes(src[i + 1])) {
          cur += src[i + 1];
          i += 2;
          continue;
        }
        // Command substitution inside double quotes actually executes.
        if (d === "`" || (d === "$" && src[i + 1] === "(")) return null;
        cur += d;
        i++;
      }
      if (!closed) return null;
      hasCur = true;
      curQuoted = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= n) return null;
      if (src[i + 1] === "\n") {
        // line continuation
        i += 2;
        continue;
      }
      cur += src[i + 1];
      hasCur = true;
      curQuoted = true;
      i += 2;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      push();
      i++;
      continue;
    }
    // An unescaped newline separates commands - too complex, bail.
    if (c === "\n") return null;
    if (c === "|") {
      if (src[i + 1] === "|") return null; // `||` is control flow, not a pipe
      push();
      return { tokens, pipeTail: src.slice(i).trim(), outputRedirect };
    }
    if (c === ">") {
      // Tolerate the side-effect-free redirections that transcripts use
      // constantly: `2>/dev/null`, `>/dev/null`, `1>/dev/null` (with or
      // without a space before the target) and `2>&1`. They discard or merge
      // streams - no file is written, no request semantics change - so
      // silently dropping them from the card conceals nothing that matters.
      // With allowFileRedirect (the curl stage of a card-eligible command),
      // additionally accept a stdout redirection to a plain file path
      // (`> file`, `>> file`): saving long output to a file is a legitimate
      // pattern, and the captured path MUST be surfaced on the card since a
      // file write is a real side effect. Everything else (`2> file`, `<`,
      // `2>&2`, quoted fd digits, paths outside REDIRECT_PATH_RE) still
      // bails to raw rendering.
      let fd = "";
      if (hasCur) {
        // In shell an fd number before `>` must be a bare unquoted digit
        // word; anything else (`foo2>`, `'2'>`) is ambiguous - bail.
        if (curQuoted || (cur !== "1" && cur !== "2")) return null;
        fd = cur;
      }
      i++;
      let append = false;
      if (src[i] === ">") {
        append = true;
        i++;
      }
      if (src[i] === "&") {
        if (append || fd !== "2" || src[i + 1] !== "1") return null;
        i += 2;
      } else {
        while (i < n && (src[i] === " " || src[i] === "\t")) i++;
        if (!append && src.startsWith("/dev/null", i)) {
          i += "/dev/null".length;
        } else {
          // A real file target: stdout only, one per command, opt-in.
          if (!allowFileRedirect || fd === "2" || outputRedirect !== null)
            return null;
          let path = "";
          while (i < n && REDIRECT_PATH_RE.test(src[i])) {
            path += src[i];
            i++;
          }
          if (path.length === 0) return null;
          outputRedirect = { path, append };
        }
      }
      // The redirection must end the word cleanly.
      if (i < n && !" \t\r|".includes(src[i])) return null;
      // Drop the consumed fd digit; the redirection itself is not a token.
      cur = "";
      hasCur = false;
      curQuoted = false;
      continue;
    }
    if (";&<`()".includes(c)) return null;
    if (c === "$" && src[i + 1] === "(") return null;
    cur += c;
    hasCur = true;
    i++;
  }
  push();
  return { tokens, pipeTail: null, outputRedirect };
}

// --- statement splitting -----------------------------------------------------

type Statement = { sep: string; text: string };

/**
 * Split a command into top-level statements at unquoted `;` / `&&`, so a curl
 * with a trailing inspection command (`curl ... > f; wc -c f`, the shape agent
 * transcripts are full of) can still be carded. Each statement carries the
 * separator that preceded it (`""` for the first), and the statements are
 * contiguous slices of the input, so the caller can recover the remainder
 * verbatim.
 *
 * Returns null when there is nothing to split, or on a separator we don't
 * model: `;;` (case), a lone `&` (backgrounding). Every null path is
 * safe because the caller then hands the UN-split command to tokenize(), which
 * bails on the `;`/`&` it kept: a rejected shape degrades to raw rendering, not
 * to a wrong card.
 *
 * Quoting is tracked so a `;` inside an argument (`-d '{"a":"x; y"}'`) is not a
 * separator. A `;` inside `$(...)`/backticks IS treated as one, which cuts the
 * command mid-substitution - harmless, because the resulting head still carries
 * the `$(`/backtick that makes tokenize() bail.
 */
function splitStatements(command: string): Statement[] | null {
  const out: Statement[] = [];
  let sep = "";
  let start = 0;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === "\\") i++;
        i++;
      }
      if (i >= n) return null;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === ";" || c === "&" || (c === "|" && command[i + 1] === "|")) {
      let next: string;
      if (c === ";") {
        if (command[i + 1] === ";") return null;
        next = ";";
      } else if (c === "|") {
        next = "||";
      } else if (command[i + 1] === "&") {
        next = "&&";
      } else if (command[i - 1] === ">") {
        // The `&` of a stream-merging redirection (`2>&1`), not a separator.
        // Leave it in the statement and let tokenize() judge the redirection.
        i++;
        continue;
      } else {
        return null; // a lone `&` backgrounds the command
      }
      out.push({ sep, text: command.slice(start, i) });
      sep = next;
      i += next.length;
      start = i;
      continue;
    }
    i++;
  }
  if (out.length === 0) return null;
  out.push({ sep, text: command.slice(start) });
  return out;
}

// --- heredoc extraction ------------------------------------------------------

// A heredoc feeding the command: `line` is the command with the `<<DELIM`
// operator removed, `body` is the heredoc text, and `literal` is true when the
// body is what the shell actually sends verbatim (a quoted delimiter, or an
// unquoted one with no expansions). When `literal` is false the shown text
// would differ from the sent bytes, so callers must note the body, not resolve
// it into fields.
type Heredoc = { line: string; body: string; literal: boolean };

// Delimiter word for a heredoc: a plain identifier-ish token (EOF, END, MSG1).
const HEREDOC_DELIM_RE = /^[A-Za-z0-9_]+/;

/**
 * Recognize the two heredoc shapes transcripts actually use - a heredoc read
 * by the FIRST stage of the command (a `jq` producer that pipes into curl, or
 * curl itself reading its stdin body), with the body immediately after the
 * command line and nothing after the terminator:
 *
 *   jq -Rs '{text: .}' <<'EOF' | curl ... -d @-        curl ... -d @- <<'EOF'
 *   <body lines...>                                    <body lines...>
 *   EOF                                                EOF
 *
 * Returns the command line with the `<<DELIM` operator removed, the body text,
 * and whether the body is literal (see the Heredoc type). Returns null for
 * anything else - no heredoc, herestrings (`<<<`), tab-stripping heredocs
 * (`<<-`), two heredocs, a heredoc attached past the first `|`, an unterminated
 * body, or trailing commands after the terminator. Callers then tokenize the
 * untouched command, whose stray `<` / newline makes tokenize() bail, so every
 * rejected shape degrades to raw rendering rather than a wrong card.
 *
 * Unquoted delimiters (`<<EOF`) expand `$VAR`/`$(...)`/backticks and process
 * backslashes inside the body; a card would show pre-expansion text as if it
 * were the payload. Such bodies are returned with `literal: false` so callers
 * only note them; quoted delimiters (`<<'EOF'`, `<<"EOF"`), and unquoted ones
 * with no expansion characters, are literal.
 */
function extractHeredoc(command: string): Heredoc | null {
  const nl = command.indexOf("\n");
  if (nl === -1) return null;
  const head = command.slice(0, nl);
  // A trailing continuation would splice the next body line into the
  // pipeline; too entangled to model.
  if (head.endsWith("\\")) return null;

  // Quote-aware scan of the pipeline line for a single unquoted `<<` that
  // appears before the first unquoted `|`.
  let i = 0;
  const n = head.length;
  let opStart = -1;
  let opEnd = -1;
  let delim: string | null = null;
  let quoted = false;
  let sawPipe = false;
  while (i < n) {
    const c = head[i];
    if (c === "'") {
      const end = head.indexOf("'", i + 1);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && head[i] !== '"') {
        if (head[i] === "\\") i++;
        i++;
      }
      if (i >= n) return null;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "|") {
      sawPipe = true;
      i++;
      continue;
    }
    if (c === "<" && head[i + 1] === "<") {
      // Second heredoc, herestring, <<- form, heredoc past the producer
      // stage, or an fd/word glued to the operator: all beyond the grammar.
      if (opStart !== -1) return null;
      if (head[i + 2] === "<" || head[i + 2] === "-") return null;
      if (sawPipe) return null;
      if (i > 0 && head[i - 1] !== " " && head[i - 1] !== "\t") return null;
      opStart = i;
      i += 2;
      while (i < n && (head[i] === " " || head[i] === "\t")) i++;
      const q = head[i];
      if (q === "'" || q === '"') {
        const end = head.indexOf(q, i + 1);
        if (end === -1) return null;
        delim = head.slice(i + 1, end);
        if (!/^[A-Za-z0-9_]+$/.test(delim)) return null;
        quoted = true;
        i = end + 1;
      } else {
        const m = HEREDOC_DELIM_RE.exec(head.slice(i));
        if (!m) return null;
        delim = m[0];
        quoted = false;
        i += m[0].length;
      }
      // The operator must end the word cleanly.
      if (i < n && !" \t|".includes(head[i])) return null;
      opEnd = i;
      continue;
    }
    if (c === "<") return null;
    i++;
  }
  if (opStart === -1 || delim === null) return null;

  const lines = command.slice(nl + 1).split("\n");
  const di = lines.indexOf(delim);
  if (di === -1) return null;
  // The terminator must end the command - a trailing command after the
  // heredoc is a compound shape the card can't summarize.
  for (let k = di + 1; k < lines.length; k++) {
    if (lines[k].trim() !== "") return null;
  }
  const body = lines.slice(0, di).join("\n");
  // A quoted delimiter takes the body verbatim; an unquoted one expands
  // $VAR/$(...)/backticks and processes backslashes, so the shown text would
  // differ from the bytes actually sent. Mark such a body non-literal rather
  // than rejecting it - the curl-fed path can still note it (the jq-producer
  // path, where the body would seed a field value, rejects non-literal).
  const literal = quoted || !/[$`\\]/.test(body);
  return {
    line: head.slice(0, opStart) + " " + head.slice(opEnd),
    body,
    literal,
  };
}

// Commands accepted as pipeline stages after the curl. A coarse gate that
// keeps obviously-active commands (another curl, xargs, tee, sh, ...) out of
// the card. It deliberately does NOT try to prove purity: several of these
// can have side effects through their arguments (sed `w`, sort -o, ...), and
// validating each command's option grammar and mini-language would be brittle
// across implementations. Instead, the card's safety property is display, not
// validation: the collapsed card can never conceal part of the command that
// the raw collapsed rendering would have shown (see pipeTailForDisplay). awk
// is excluded because its program text is arbitrary code (system()) with no
// redeeming common use in these transcripts.
const FILTER_COMMANDS = new Set([
  "jq",
  "sed",
  "grep",
  "head",
  "tail",
  "cat",
  "cut",
  "tr",
  "sort",
  "uniq",
  "wc",
  "column",
]);

// Commands accepted as a trailing `;`/`&&` statement after the curl. A superset
// of FILTER_COMMANDS: a trailing statement reads a file or prints a word rather
// than a stdin stream, so the three additions here (`echo` - by far the most
// common shape in transcripts, `curl ... >/dev/null && echo posted` - plus the
// two file-inspection commands that pair with saving output) would be nonsense
// as pipe stages, which is why FILTER_COMMANDS stays as it is.
//
// The gate is coarse in exactly the same way (see FILTER_COMMANDS): it does not
// prove that an accepted command is read-only, and the card's safety property
// remains display, not validation - a trailing statement is always shown
// verbatim, bounded so the card can never conceal what the raw collapsed row
// would have revealed.
const TRAILING_COMMANDS = new Set([...FILTER_COMMANDS, "echo", "ls", "stat"]);

// Characters of the raw command an UNCARDED Bash row shows in its collapsed
// summary (extractToolSummary in LogEntryCard.tsx, which imports this).
// It lives here, not there, because MAX_TAIL_DISPLAY below is derived from it
// and the dependency only points this way - LogEntryCard already imports this
// module, so the reverse would be a cycle.
export const BASH_RAW_SUMMARY_CHARS = 80;

// Characters of pipe tail the collapsed card shows before eliding the rest.
//
// The floor is set by what the card replaces. Everything before the tail eats
// into BASH_RAW_SUMMARY_CHARS, and the shortest curl that parses at all -
// "curl localhost:4000" plus the space before the "|" - spends 20 of it, so
// raw rendering can never reveal more than 60 characters of tail. A card that
// shows 64 therefore always shows more, for every parseable command: the same
// non-concealment property the parse-time length cap used to provide, which is
// why lifting that cap was safe. The bound is enforced by the "displayed tail
// never shows less than the raw collapsed row would" test, not by this
// comment. Anything past this is one click away in the expanded view, exactly
// as it is for a long raw command.
const MAX_TAIL_DISPLAY = 64;

/**
 * A pipe tail - or a trailing `;`/`&&` statement, which carries the same
 * show-it-verbatim obligation - as the collapsed card renders it. Each such
 * segment is bounded independently, which preserves the property above: the raw
 * row's 80-character window starts at least 20 characters into the command, so
 * it can reveal at most 60 characters of any one segment, always as a prefix.
 * See MAX_TAIL_DISPLAY.
 */
export function pipeTailForDisplay(tail: string): string {
  return tail.length > MAX_TAIL_DISPLAY
    ? tail.slice(0, MAX_TAIL_DISPLAY) + "…"
    : tail;
}

/**
 * Validate a captured pipe tail (starting with "|"). Every stage must
 * tokenize under the same conservative rules as the curl itself (so `; rm x`,
 * file redirections, and substitutions in the tail bail out; the safe stream
 * redirections tokenize() tolerates - `2>/dev/null` and friends - are fine
 * and stay visible in the verbatim tail) and must invoke an allowed filter
 * command. `python -m json.tool` is allowed as a special case.
 * See FILTER_COMMANDS for what this does and does not guarantee.
 */
function isSafePipeTail(tail: string): boolean {
  return isSafeStage(tail.slice(1), FILTER_COMMANDS);
}

/**
 * Validate one command plus its own optional `| ...` continuation. `allowed`
 * gates only this command's name; anything past a `|` reads stdin by
 * construction, so the recursion always gates on FILTER_COMMANDS.
 */
function isSafeStage(text: string, allowed: ReadonlySet<string>): boolean {
  const stage = tokenize(text);
  if (!stage || stage.tokens.length === 0) return false;
  const [cmd, ...rest] = stage.tokens;
  const ok =
    allowed.has(cmd) ||
    ((cmd === "python" || cmd === "python3") &&
      rest[0] === "-m" &&
      rest[1] === "json.tool");
  if (!ok) return false;
  return stage.pipeTail === null || isSafePipeTail(stage.pipeTail);
}

// --- curl flag tables --------------------------------------------------------

// Boolean long options that don't change what we display. Not a blanket
// claim that they preserve request semantics: -L/--location can change the
// effective target via server redirects. It's accepted because the target is
// this trusted local service, whose redirects (if any) it controls.
const BOOLEAN_LONG = new Set([
  "--silent",
  "--show-error",
  "--fail",
  "--fail-with-body",
  "--location",
  "--insecure",
  "--include",
  "--verbose",
  "--compressed",
  "--globoff",
  "--no-buffer",
  "--no-progress-meter",
  "--http1.1",
  "--http2",
  "--get",
]);

// Single-letter boolean flags (may appear clustered, e.g. -sS or -fsSL).
const BOOLEAN_SHORT = new Set([
  "s",
  "S",
  "f",
  "L",
  "k",
  "i",
  "v",
  "g",
  "N",
  "G",
  "4",
  "6",
]);

type ArgKind =
  | "method"
  | "header"
  | "data"
  | "dataLiteral"
  | "form"
  | "url"
  | "ignore"
  | "output"
  | "dumpHeader"
  | "writeOut";

// Single-letter flags that take a value (attached or as the next token).
//
// The "ignore" kind is reserved for options that are transport/presentation
// neutral: they may not name a filesystem path, carry credentials, add
// request headers, or change the request's method/target/body - because the
// card silently omits them, an ignored option must not hide anything the raw
// rendering would reveal. Options with concealed semantics (-T/--upload-file
// changes method and body, -u/--user and -b/--cookie carry credentials,
// -A/-e add request headers) are deliberately ABSENT from these tables, so
// they reject the parse and fall back to raw rendering.
//
// Three options are admitted only under a value restriction (checked in
// applyArg):
// - "output" (-o/--output): only `/dev/null` - discarding the response
//   writes no file; any real path still rejects.
// - "dumpHeader" (-D/--dump-header): only `-` (stdout) - a file path rejects.
// - "writeOut" (-w/--write-out): rejected when the format reads a file
//   (@file) or writes one (%output{file}, curl >= 8.3.0); plain status
//   formats like '%{http_code}' are output-text-only and pass.
//
// "data" vs "dataLiteral": -d/--data/--data-binary/--data-ascii interpret a
// leading `@` as "read the body from this file" (`@-` = stdin), which is what
// lets a `jq ... | curl -d @-` producer pipeline supply the body.
// --data-raw never interprets `@`, and --data-urlencode transforms the
// content, so those are "dataLiteral" and never satisfy a producer.
const ARG_SHORT: Record<string, ArgKind> = {
  X: "method",
  H: "header",
  d: "data",
  F: "form",
  m: "ignore",
  o: "output",
  D: "dumpHeader",
  w: "writeOut",
};

const ARG_LONG: Record<string, ArgKind> = {
  "--request": "method",
  "--header": "header",
  "--data": "data",
  "--data-raw": "dataLiteral",
  "--data-binary": "data",
  "--data-ascii": "data",
  "--data-urlencode": "dataLiteral",
  "--form": "form",
  "--url": "url",
  "--max-time": "ignore",
  "--connect-timeout": "ignore",
  "--retry": "ignore",
  "--output": "output",
  "--dump-header": "dumpHeader",
  "--write-out": "writeOut",
};

// Header names the card may silently omit. Anything else (Cookie carries
// credentials, User-Agent/Referer/arbitrary headers add request semantics the
// card doesn't show) rejects the parse - otherwise generic -H would bypass
// the rejection of the dedicated credential/header flags above. Authorization
// is admitted but only surfaced as a boolean (hasAuth); its value is never
// displayed.
const ALLOWED_HEADERS = new Set(["content-type", "authorization"]);

// --- URL matching ------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/**
 * If `url` points at the isomux server (loopback host on one of `ports`),
 * return its path+query (normalized to start with "/"). Otherwise null.
 */
function matchIsomuxUrl(
  url: string,
  ports: ReadonlySet<string>,
): string | null {
  let rest = url;
  let defaultPort = "80";
  const scheme = /^(https?):\/\//i.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    if (scheme[1].toLowerCase() === "https") defaultPort = "443";
  }
  const m = /^(\[[^\]]*\]|[^/:?#]+)(?::(\d+))?([/?#].*)?$/.exec(rest);
  if (!m) return null;
  if (!LOOPBACK_HOSTS.has(m[1].toLowerCase())) return null;
  if (!ports.has(m[2] ?? defaultPort)) return null;
  const path = m[3] ?? "/";
  return path.startsWith("/") ? path : `/${path}`;
}

// --- route naming ------------------------------------------------------------

// Known isomux routes worth a human label in the card. "*" matches exactly one
// path segment. Kept to the routes agents actually hit from transcripts; an
// unknown isomux path still gets a card, just without the label.
const ROUTE_LABELS: Array<[string, string, string]> = [
  ["GET", "/api/tasks", "List tasks"],
  ["POST", "/api/tasks", "Create task"],
  ["POST", "/api/tasks/*/claim", "Claim task"],
  ["POST", "/api/tasks/*/done", "Complete task"],
  ["PATCH", "/api/tasks/*", "Update task"],
  ["DELETE", "/api/tasks/*", "Delete task"],
  // The agent-discovery manifest is exposed both at /agents and /api/agents.
  ["GET", "/agents", "List office agents"],
  ["GET", "/api/agents", "List office agents"],
  ["POST", "/api/agents/*/messages", "Send agent message"],
  ["GET", "/api/me/api-tokens", "List API tokens"],
  ["POST", "/api/me/api-tokens", "Create API token"],
  ["DELETE", "/api/me/api-tokens/*", "Revoke API token"],
  ["GET", "/api/me/provider-accounts", "Check provider accounts"],
  ["POST", "/api/me/provider-accounts/*/login", "Start provider sign-in"],
  ["POST", "/api/me/provider-accounts/*/cancel", "Cancel provider sign-in"],
  ["POST", "/api/me/provider-accounts/refresh", "Refresh provider accounts"],
  [
    "POST",
    "/api/me/provider-accounts/:provider/callback",
    "Submit provider sign-in code",
  ],
  ["POST", "/api/api-token-inboxes/*/messages", "Message remote boss"],
  ["POST", "/api/me/api-token-inbox/drain", "Drain API token inbox"],
  ["POST", "/api/agents/*/handoff", "Hand off to fresh session"],
  ["GET", "/api/agents/*/scheduled-messages", "List scheduled messages"],
  ["DELETE", "/api/agents/*/scheduled-messages/*", "Cancel scheduled message"],
  ["POST", "/api/agents/*/read-file", "Share file to chat"],
  ["POST", "/api/agents/*/preview-url", "Screenshot page to chat"],
  ["POST", "/api/agents/*/diff", "Show diff in chat"],
  ["POST", "/api/agents/*/edit-file", "Offer file in editor"],
  ["POST", "/api/agents/*/terminal-command", "Suggest terminal command"],
  ["GET", "/api/agents/*/context", "Check context usage"],
  // One route, three modes (search / retrieve / list). This static label is the
  // fallback; humanizeIsomuxRequest below reads the query and says which.
  ["GET", "/api/agents/*/logs", "Search conversation logs"],
  ["GET", "/api/agents/*/slides", "Read slides"],
  ["POST", "/api/agents/*/slides/*", "Generate slide"],
  ["GET", "/api/agents/*/instructions", "Read agent instructions"],
  ["GET", "/api/memory", "Read memory"],
  ["POST", "/api/memory", "Append memory"],
  ["PUT", "/api/memory", "Replace memory"],
  ["GET", "/api/cronjobs", "List cronjobs"],
  // Agent-built apps (internal-docs/agent-apps-design.md).
  ["GET", "/api/apps", "List apps"],
  ["POST", "/api/apps", "Register app"],
  ["GET", "/api/apps/*", "Read app"],
  ["POST", "/api/apps/*/preview", "Capture app preview"],
  ["PATCH", "/api/apps/*", "Update app"],
  ["DELETE", "/api/apps/*", "Delete app"],
  ["GET", "/api/apps/*/logs", "Read app logs"],
  ["POST", "/api/apps/*/start", "Start app"],
  ["POST", "/api/apps/*/stop", "Stop app"],
  ["POST", "/api/apps/*/restart", "Restart app"],
  // Per-user Sk-menu counters (reachable by privileged agent tokens).
  ["GET", "/api/skill-usage", "Read skill-use counts"],
  // Deployment version identity (reachable by privileged agent tokens).
  ["GET", "/api/version", "Check isomux version"],
  // Storage breakdown (reachable by privileged agent tokens); the prune is
  // owner-only but still worth a label if an owner runs it from a terminal.
  ["GET", "/api/storage/usage", "Check office disk usage"],
  ["GET", "/api/usage", "Check office token usage"],
  ["POST", "/api/storage/prune", "Prune stored history"],
];

export function describeIsomuxRoute(
  method: string,
  path: string,
): string | null {
  const cleanPath = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const segs = cleanPath.split("/").filter(Boolean);
  for (const [m, pattern, label] of ROUTE_LABELS) {
    if (m !== method) continue;
    const patSegs = pattern.split("/").filter(Boolean);
    if (patSegs.length !== segs.length) continue;
    if (patSegs.every((p, idx) => p === "*" || p === segs[idx])) return label;
  }
  return null;
}

// --- humanized labels ----------------------------------------------------------

function truncateLabel(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const MEMORY_SCOPE_PHRASES: Record<string, string> = {
  agent: "memories for this agent",
  room: "room memories",
  office: "office memories",
  boss: "boss memories",
};

/**
 * Plain-language, parameter-aware description of a parsed request, e.g.
 * "Read memories for this agent" or "Send a message to Isomuxer4". Uses query
 * params, body fields, and (when available) an agent-id -> display-name
 * resolver. Returns null when the route has no specific phrasing; callers
 * fall back to `action` (the static route label) or method + path.
 */
export function humanizeIsomuxRequest(
  req: IsomuxCurlRequest,
  resolveAgentName?: (id: string) => string | null,
): string | null {
  const [pathOnly, queryStr] = req.path.split(/[?#]/);
  const segs = (pathOnly ?? "/").split("/").filter(Boolean);
  if (segs[0] === "api") segs.shift();
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(queryStr ?? "");
  } catch {
    query = new URLSearchParams();
  }
  const field = (key: string): string | null =>
    req.bodyFields?.find((f) => f.key === key)?.value ?? null;
  const agentName = (id: string): string =>
    resolveAgentName?.(id) ?? truncateLabel(id, 18);
  const m = req.method;

  // Memory
  if (segs.length === 1 && segs[0] === "memory") {
    const scope = query.get("scope") ?? field("scope");
    const phrase = (scope && MEMORY_SCOPE_PHRASES[scope]) || "memories";
    if (m === "GET") return `Read ${phrase}`;
    if (m === "POST")
      return scope === "agent"
        ? "Save a memory for this agent"
        : scope && MEMORY_SCOPE_PHRASES[scope]
          ? `Save a ${scope} memory`
          : "Save a memory";
    if (m === "PUT") return `Rewrite ${phrase}`;
  }

  // Task board (/api/tasks; the leading `api` segment was shifted off above)
  if (segs[0] === "tasks") {
    if (segs.length === 1) {
      if (m === "GET") {
        const status = query.get("status");
        // ?roomId= narrows the board to one room ("" = office-global only). It
        // composes with ?status=, so it qualifies the same phrase rather than
        // replacing it.
        const room = query.get("roomId");
        const scope =
          room === null
            ? ""
            : room === ""
              ? " (office-global only)"
              : " in one room";
        if (status === "all") return `List all tasks${scope}`;
        if (status) return `List ${status} tasks${scope}`;
        return `List open tasks${scope}`;
      }
      if (m === "POST") {
        const title = field("title");
        return title
          ? `Create task: ${truncateLabel(title, 40)}`
          : "Create a task";
      }
    }
    if (segs.length === 2) {
      if (m === "PATCH") return `Update task ${segs[1]}`;
      if (m === "DELETE") return `Delete task ${segs[1]}`;
      if (m === "GET") return `Read task ${segs[1]}`;
    }
    if (segs.length === 3 && m === "POST") {
      if (segs[2] === "claim") {
        const assignee = field("assignee");
        return assignee
          ? `Claim task ${segs[1]} for ${assignee}`
          : `Claim task ${segs[1]}`;
      }
      if (segs[2] === "done") return `Mark task ${segs[1]} done`;
    }
  }

  // Agents
  if (segs[0] === "agents") {
    // ?killed=1 flips the roster the route answers with, so it gets its own
    // phrase rather than the live-agent one. The card mirrors the server's
    // exact-value contract: a present non-"1" value is a 400 there, so it must
    // not be labelled as listing EITHER roster - "List office agents" would be
    // just as wrong as "List killed agents", since neither came back.
    if (segs.length === 1 && m === "GET") {
      const killed = query.get("killed");
      if (killed === null) return "List office agents";
      return killed === "1"
        ? "List killed agents"
        : "List agents (invalid killed filter)";
    }
    if (segs.length === 1 && m === "POST") {
      const name = field("name");
      return name
        ? `Spawn agent ${truncateLabel(name, 24)}`
        : "Spawn a new agent";
    }
    if (segs.length === 2) {
      const who = agentName(segs[1]);
      if (m === "PATCH") return `Edit ${who}'s settings`;
      if (m === "DELETE") return `Remove agent ${who}`;
    }
    if (segs.length >= 3) {
      const who = agentName(segs[1]);
      const sub = segs[2];
      if (segs.length === 3) {
        if (sub === "messages" && m === "POST") {
          if (field("deliverAt")) return `Schedule a message to ${who}`;
          // steer:true interrupts the receiver's turn, which is a different
          // action to a reader watching the card - and "true" is matched
          // exactly so an explicit steer:false reads as the plain send it is.
          return field("steer") === "true"
            ? `Interrupt ${who} with a message`
            : `Send a message to ${who}`;
        }
        if (sub === "scheduled-messages" && m === "GET")
          return `List ${who}'s outgoing scheduled messages`;
        if (sub === "read-file" && m === "POST") return "Share a file to chat";
        if (sub === "preview-url" && m === "POST")
          return "Screenshot a page to chat";
        if (sub === "diff" && m === "POST") return "Show a diff in chat";
        if (sub === "edit-file" && m === "POST")
          return "Offer a file in the editor";
        if (sub === "terminal-command" && m === "POST")
          return "Suggest a terminal command";
        if (sub === "new-conversation" && m === "POST")
          return `Clear ${who}'s conversation`;
        if (sub === "handoff" && m === "POST")
          return `Hand off ${who} to a fresh session`;
        if (sub === "send-now" && m === "POST")
          return `Flush ${who}'s queue now`;
        if (sub === "abort" && m === "POST") return `Interrupt ${who}`;
        if (sub === "resume" && m === "POST")
          return `Resume a session for ${who}`;
        if (sub === "sessions" && m === "GET") return `List ${who}'s sessions`;
        // /logs is one route with three modes, so the label is chosen from the
        // query rather than the path - "Search" would be wrong two thirds of
        // the time.
        if (sub === "logs" && m === "GET") {
          const q = query.get("q");
          if (q) return `Search ${who}'s logs for "${truncateLabel(q, 32)}"`;
          if (query.get("around"))
            return `Read around an entry in ${who}'s logs`;
          if (query.get("session")) return `Read a session from ${who}'s logs`;
          return `List ${who}'s log sessions`;
        }
        if (sub === "slides" && m === "GET") return `Read ${who}'s slides`;
        if (sub === "move" && m === "POST") return `Move ${who}`;
        if (sub === "revive" && m === "POST") return `Revive ${who}`;
      }
      if (segs.length === 4) {
        if (sub === "scheduled-messages" && m === "DELETE")
          return `Cancel one of ${who}'s outgoing scheduled messages`;
        if (sub === "queue" && m === "DELETE")
          return `Cancel a queued message to ${who}`;
        if (sub === "messages" && m === "PATCH")
          return `Edit a message in ${who}'s chat`;
        if (sub === "slides" && m === "POST")
          return `Generate a slide for ${who}`;
      }
    }
  }

  // Rooms
  if (segs[0] === "rooms") {
    if (segs.length === 1 && m === "POST") {
      const name = field("name");
      return name ? `Create room ${truncateLabel(name, 24)}` : "Create a room";
    }
    if (segs.length === 2) {
      if (m === "PATCH") return "Update a room";
      if (m === "DELETE") return "Close a room";
    }
    if (segs.length === 3) {
      if (segs[2] === "settings" && m === "PUT") return "Update room settings";
      if (segs[2] === "swap-desks" && m === "POST")
        return "Swap desks in a room";
    }
  }

  // Cronjobs
  if (segs[0] === "cronjobs") {
    if (segs.length === 1) {
      if (m === "GET") return "List cronjobs";
      if (m === "POST") return "Create a cronjob";
    }
    if (segs.length === 2) {
      if (m === "GET") return "Read a cronjob";
      if (m === "PATCH") return "Update a cronjob";
      if (m === "DELETE") return "Delete a cronjob";
    }
    if (segs.length === 3 && segs[2] === "runs") {
      if (m === "GET") return "List cronjob runs";
      if (m === "POST") return "Trigger a cronjob run";
    }
    if (segs.length === 4 && segs[2] === "runs" && m === "GET")
      return "Read a cronjob run";
  }
  if (segs.length === 1 && segs[0] === "cron-runs" && m === "GET")
    return "List recent cron runs";

  return null;
}

// --- body formatting ---------------------------------------------------------

function displayValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "").replace(/\s+/g, " ");
}

// --- jq producer stage -------------------------------------------------------

// A request body resolved from something other than an inline `-d` flag -
// either a leading `jq ... |` producer stage or a heredoc feeding curl's
// stdin. Either concrete body fields (the source resolved to a literal object)
// or a short note for the card ("body built with jq", "body from heredoc").
type ResolvedBody =
  | { kind: "fields"; fields: CurlBodyField[] }
  | { kind: "note"; note: string };

/**
 * Read a JSON string literal starting at s[start] (which must be '"').
 * Returns the decoded value and the index just past the closing quote, or
 * null for anything that isn't a plain literal (jq `\(...)` interpolation,
 * bad escapes, unterminated).
 */
function readJsonString(
  s: string,
  start: number,
): { value: string; end: number } | null {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === '"') {
      const raw = s.slice(start, i + 1);
      // jq string interpolation executes a jq expression - not a literal.
      if (raw.includes("\\(")) return null;
      try {
        const v: unknown = JSON.parse(raw);
        return typeof v === "string" ? { value: v, end: i + 1 } : null;
      } catch {
        return null;
      }
    }
    i++;
  }
  return null;
}

/**
 * Evaluate a jq program of the restricted shape `{key: value, ...}` where
 * each key is a bare identifier or string literal and each value is a $var
 * reference (looked up in `vars`), a string/number/true/false/null literal,
 * or a bare `.` (the whole input) when `dotValue` supplies what `.` holds -
 * the heredoc body or an `@file` marker for the `-Rs` slurp shapes.
 * Anything else - nesting, pipes, functions, interpolation, undefined vars,
 * `.` without a known input, `.foo` field access - returns null and the
 * caller falls back to the "body built with jq" note (or raw rendering).
 */
function resolveJqTemplate(
  program: string,
  vars: Record<string, string>,
  dotValue: string | null = null,
): CurlBodyField[] | null {
  const m = /^\s*\{([\s\S]*)\}\s*$/.exec(program);
  if (!m) return null;
  const inner = m[1];
  const fields: CurlBodyField[] = [];
  let i = 0;
  const n = inner.length;
  const ws = () => {
    while (i < n && /\s/.test(inner[i])) i++;
  };
  ws();
  if (i === n) return fields; // "{}"
  for (;;) {
    ws();
    let key: string;
    const km = /^[A-Za-z_][A-Za-z0-9_]*/.exec(inner.slice(i));
    if (km) {
      key = km[0];
      i += km[0].length;
    } else if (inner[i] === '"') {
      const str = readJsonString(inner, i);
      if (!str) return null;
      key = str.value;
      i = str.end;
    } else return null;
    ws();
    if (inner[i] !== ":") return null;
    i++;
    ws();
    let value: string;
    let vm: RegExpExecArray | null;
    if ((vm = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(inner.slice(i)))) {
      const name = vm[0].slice(1);
      if (!(name in vars)) return null;
      value = vars[name];
      i += vm[0].length;
    } else if (inner[i] === '"') {
      const str = readJsonString(inner, i);
      if (!str) return null;
      value = str.value;
      i = str.end;
    } else if ((vm = /^-?\d+(\.\d+)?/.exec(inner.slice(i)))) {
      value = vm[0];
      i += vm[0].length;
    } else if ((vm = /^(true|false|null)\b/.exec(inner.slice(i)))) {
      value = vm[1];
      i += vm[1].length;
    } else if (inner[i] === ".") {
      // Bare `.` = the whole slurped input. Only literal when the caller
      // knows what the input is; `.foo` / `.5` / `. | f` fail the parse at
      // the following separator check, which is the conservative outcome.
      if (dotValue === null) return null;
      value = dotValue;
      i++;
    } else return null;
    fields.push({ key, value: displayValue(value) });
    ws();
    if (i === n) return fields;
    if (inner[i] !== ",") return null;
    i++;
  }
}

// jq long flags that only shape output formatting; safe to accept and omit
// from the card.
const JQ_NEUTRAL_LONG = new Set([
  "--compact-output",
  "--raw-output",
  "--join-output",
  "--sort-keys",
  "--ascii-output",
  "--tab",
]);

// The short-flag equivalents (clusterable, e.g. -nc). The input-shaping
// flags n (--null-input), R (--raw-input), and s (--slurp) are handled
// explicitly in the cluster loop, not here.
const JQ_NEUTRAL_SHORT = "crjSa";

/**
 * Parse the tokens of a leading `jq` stage. Accepts only a narrow grammar:
 * neutral output flags, the input-shaping flags -n/--null-input,
 * -R/--raw-input, and -s/--slurp, --arg/--argjson name value,
 * --rawfile name path, exactly one program argument, and (in the -Rs slurp
 * shape only) one positional input file. Returns the body as concrete fields
 * when the program is a literal template and the input is known: with -n
 * there is no input, and with -Rs (raw slurp) `.` is the whole input -
 * either the heredoc body passed in `heredocBody` or an `@file` marker for a
 * positional file. Otherwise a "body built with jq" note; the note names any
 * files read (--rawfile, positional input) so a file read is never
 * concealed. A heredoc whose body can't be shown as fields returns null -
 * the body IS the payload, and a note would conceal it. Unknown flags (e.g.
 * -f reads a program file, --slurpfile) reject the whole parse.
 */
function parseJqInvocation(
  tokens: string[],
  heredocBody: string | null = null,
): ResolvedBody | null {
  let nullInput = false;
  let rawInput = false;
  let slurp = false;
  const vars: Record<string, string> = {};
  const readFiles: string[] = [];
  const inputFiles: string[] = [];
  let program: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--null-input") {
      nullInput = true;
      continue;
    }
    if (t === "--raw-input") {
      rawInput = true;
      continue;
    }
    if (t === "--slurp") {
      slurp = true;
      continue;
    }
    if (JQ_NEUTRAL_LONG.has(t)) continue;
    if (t === "--arg") {
      const name = tokens[i + 1];
      const value = tokens[i + 2];
      if (name === undefined || value === undefined) return null;
      vars[name] = value;
      i += 2;
      continue;
    }
    if (t === "--argjson") {
      const name = tokens[i + 1];
      const value = tokens[i + 2];
      if (name === undefined || value === undefined) return null;
      // --argjson values are JSON, and jq validates them EAGERLY: one invalid
      // value fails the whole jq invocation (even if the program never
      // references it), so curl would send an empty body. A card here would
      // misrepresent the request either way - reject to raw rendering.
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return null;
      }
      // Store the interpreted value (JSON string "hi" displays as hi, an
      // object as its compact JSON), matching how -d JSON bodies display.
      vars[name] = displayValue(parsed);
      i += 2;
      continue;
    }
    if (t === "--rawfile") {
      const name = tokens[i + 1];
      const path = tokens[i + 2];
      if (name === undefined || path === undefined) return null;
      vars[name] = `@${path}`;
      readFiles.push(path);
      i += 2;
      continue;
    }
    if (/^-[a-zA-Z]+$/.test(t)) {
      for (const ch of t.slice(1)) {
        if (ch === "n") nullInput = true;
        else if (ch === "R") rawInput = true;
        else if (ch === "s") slurp = true;
        else if (!JQ_NEUTRAL_SHORT.includes(ch)) return null;
      }
      continue;
    }
    if (t.startsWith("-")) return null;
    if (program === null) {
      program = t;
      continue;
    }
    inputFiles.push(t);
  }
  if (program === null) return null;

  // -Rs (and no -n): the whole raw input becomes one JSON string bound to
  // `.` - the manager-brief producer shape. Any other combination that
  // involves real input (positional files, a heredoc) models input semantics
  // we don't understand, and rejects.
  const rawSlurp = rawInput && slurp && !nullInput;
  if (heredocBody !== null) {
    // The heredoc body IS the payload: either the card shows it as a field,
    // or the whole parse bails to raw rendering. A note would conceal it.
    if (!rawSlurp || inputFiles.length > 0) return null;
    const fields = resolveJqTemplate(program, vars, heredocBody);
    return fields ? { kind: "fields", fields } : null;
  }
  if (inputFiles.length > 0) {
    if (!rawSlurp || inputFiles.length !== 1) return null;
    const file = inputFiles[0];
    const fields = resolveJqTemplate(program, vars, `@${file}`);
    if (fields) return { kind: "fields", fields };
    // Unresolved program: fall through to the note, which names the file so
    // the read is never concealed.
    readFiles.push(file);
  } else if (nullInput) {
    const fields = resolveJqTemplate(program, vars);
    if (fields) return { kind: "fields", fields };
  }
  return {
    kind: "note",
    note:
      "body built with jq" +
      (readFiles.length > 0 ? ` (reads ${readFiles.join(", ")})` : ""),
  };
}

// --- heredoc body ------------------------------------------------------------

/**
 * Resolve a heredoc attached to curl's stdin (`curl -d @- <<'EOF' ... EOF`)
 * into a displayable body. A literal body (see the Heredoc type) is parsed as
 * JSON: a JSON object becomes card fields, mirroring the inline `-d '{...}'`
 * path. Anything else - non-object JSON, non-JSON text, or a non-literal body
 * whose shell expansions the card can't resolve - collapses to the note "body
 * from heredoc", which discloses that a body is present without claiming to
 * show its exact bytes. (A note is honest here because the whole heredoc IS the
 * body; contrast the jq-producer path, where the body seeds a field value and a
 * note would conceal which field it fills.)
 */
function resolveHeredocBody(heredoc: Heredoc): ResolvedBody {
  if (heredoc.literal) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(heredoc.body);
    } catch {
      parsed = undefined;
    }
    if (
      parsed !== undefined &&
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return {
        kind: "fields",
        fields: Object.entries(parsed as Record<string, unknown>).map(
          ([key, value]) => ({ key, value: displayValue(value) }),
        ),
      };
    }
  }
  return { kind: "note", note: "body from heredoc" };
}

// --- shell wrapper -----------------------------------------------------------

/**
 * Codex (and some other tool harnesses) run every shell command wrapped as
 *   /bin/bash -lc '<script>'
 * so the real curl sits one level down and the raw command never starts with
 * `curl`/`jq`. Recognize a bare, single-statement wrapper and return the inner
 * `<script>` so the caller can re-parse it under the SAME conservative rules.
 * Unwrapping never widens what we card: the inner command must still fully
 * parse as an isomux curl, so anything we don't understand still bails to null.
 *
 * Conservative on purpose - returns null (no unwrap) unless:
 * - the wrapper itself carries no top-level heredoc (a `<<EOF` at the OUTER
 *   level, not one tucked inside the `-c` script string; those DO survive the
 *   quoting and are re-parsed by the recursion, exactly as before);
 * - the wrapper tokenizes cleanly with no outer pipe or file redirect;
 * - the program is bash or sh;
 * - there is exactly one `-c` script operand and no trailing positional args
 *   ($0/$1/... would let the script interpolate values we can't see).
 *
 * A heredoc INSIDE the script (`bash -lc "curl -d @- <<'EOF' ... EOF"`) is left
 * to the recursion. The outer-shell expansion hazard - a double-quoted wrapper
 * expanding a bare `$VAR` in the body before curl reads it - is handled by
 * parseIsomuxCurl via outerExpandsBody, which marks such a body non-literal
 * (tokenize already bails on `$(...)`/backticks inside double quotes).
 */
function unwrapShellWrapper(command: string): string | null {
  if (extractHeredoc(command)) return null;
  const t = tokenize(command, false);
  if (!t || t.pipeTail !== null || t.outputRedirect !== null) return null;
  const toks = t.tokens;
  if (toks.length < 3) return null;
  const base = toks[0].split("/").pop() ?? "";
  if (base !== "bash" && base !== "sh") return null;
  // Walk option tokens up to the one bearing `-c`; the script is the next
  // token. ONLY `-l` (login) and `-c` (command) are allowed in a cluster -
  // any other flag bails rather than being assumed harmless. `-n` in
  // particular means "syntax-check, do NOT execute" (`bash -nc '<curl>'`
  // never runs the curl), so carding it would be a lie; value-taking and
  // behavior-changing flags are equally unsafe to wave through.
  let i = 1;
  let sawC = false;
  for (; i < toks.length; i++) {
    const tok = toks[i];
    if (!tok.startsWith("-") || tok.length < 2 || tok[1] === "-") return null;
    const flags = tok.slice(1);
    if (![...flags].every((ch) => ch === "l" || ch === "c")) return null;
    if (flags.includes("c")) {
      sawC = true;
      i++;
      break;
    }
  }
  if (!sawC) return null;
  const script = toks[i];
  // Exactly the script and nothing after it.
  if (script === undefined || i !== toks.length - 1) return null;
  if (script === command) return null; // no-op guard against a re-parse loop
  return script;
}

// --- main entry point --------------------------------------------------------

/**
 * Does the OUTER shell of a wrapped command expand a `$VAR`/`${...}`/backtick
 * inside the heredoc body before the inner curl/jq ever reads it? When it does,
 * the body tokenize extracts is the PRE-expansion spelling - the card would
 * show `$LEAKED` where curl actually sends its value - so the caller must treat
 * the body as non-literal.
 *
 * The heredoc header is a single line, so the body is everything after the
 * command's first newline. We scan the raw command's Level-0 quote state
 * (single quotes protect verbatim; double-quoted and unquoted regions expand)
 * and report ANY unescaped, expansion-active `$` or backtick in that body
 * region. "Any `$`" is deliberate - shell expands not just `$VAR`/`${...}` but
 * positional/special parameters (`$1`, `$?`, `$$`, `$@`, ...), so a narrower
 * match would let those through as exact fields. A bare literal `$` (e.g. a
 * price) also trips it; downgrading that to a note is a sound over-
 * approximation, never a wrong card. A `$` in a single-quote breakout (the
 * common Codex `"..."'$x'"..."` shape) or an escaped `\$` reads as inactive, so
 * genuinely-safe bodies keep carding their fields. Only meaningful for a
 * command we actually unwrapped; direct commands never call it.
 */
function outerExpandsBody(command: string): boolean {
  const bodyStart = command.indexOf("\n");
  if (bodyStart === -1) return false;
  let state: "U" | "S" | "D" = "U";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const active = state === "U" || state === "D";
    if (i > bodyStart && active && (c === "$" || c === "`")) return true;
    if (state === "U") {
      if (c === "'") state = "S";
      else if (c === '"') state = "D";
      else if (c === "\\") i++;
    } else if (state === "S") {
      if (c === "'") state = "U";
    } else {
      if (c === '"') state = "U";
      else if (c === "\\" && '"\\$`'.includes(command[i + 1] ?? "")) i++;
    }
  }
  return false;
}

/**
 * Parse a Bash command string; return a structured request if it is a single
 * curl invocation against the isomux server (optionally piped into a filter),
 * a `jq ... | curl ... -d @-` producer pipeline where jq builds the request
 * body - from --arg templates, a positional input file, or a heredoc
 * (`jq -Rs '{text: .}' <<'EOF' | curl ... -d @-`) - or a heredoc feeding curl
 * directly as its body (`curl ... -d @- <<'EOF'`). The curl may be followed by
 * `;`/`&&`-chained inspection commands (`> /tmp/out.json; wc -c /tmp/out.json`),
 * which are shown verbatim on the card. A single-statement
 * `bash -lc '<script>'` wrapper (how Codex issues every command) is unwrapped
 * and its script re-parsed. Null for everything else. `ports` is the set of
 * local ports the isomux server may listen on (default: the documented 4000).
 */
export function parseIsomuxCurl(
  command: string,
  ports: readonly string[] = ["4000"],
): IsomuxCurlRequest | null {
  return parseIsomuxCurlInner(command, ports, false);
}

/**
 * The recursive worker. `outerExpandedBody` is threaded through the wrapper
 * recursion: true when an outer wrapper's shell may have expanded a
 * `$`/backtick in the heredoc body (see outerExpandsBody). Kept unexported so
 * the public entry point keeps its two-argument contract.
 */
function parseIsomuxCurlInner(
  command: string,
  ports: readonly string[],
  outerExpandedBody: boolean,
): IsomuxCurlRequest | null {
  const inner = unwrapShellWrapper(command);
  if (inner !== null)
    return parseIsomuxCurlInner(
      inner,
      ports,
      outerExpandedBody || outerExpandsBody(command),
    );
  // A recognized heredoc is stripped off before tokenizing; its body feeds
  // either a jq producer stage or curl's stdin (both checked below). When
  // extractHeredoc returns null, the untouched command's `<`/newline makes
  // tokenize() bail.
  const heredoc = extractHeredoc(command);
  // Peel off any trailing `;`/`&&` statements, but only when no heredoc is in
  // play: a heredoc body is not shell-quoted and may legitimately contain a
  // `;`, so splitting there would corrupt a shape that cards correctly today.
  // (extractHeredoc already requires its terminator to end the command, so a
  // heredoc WITH a trailing statement stays raw either way.)
  let statement = command;
  let trailingCommand: string | null = null;
  if (!heredoc) {
    const statements = splitStatements(command);
    if (statements) {
      const fallbackAt = statements.findIndex((st) => st.sep === "||");
      if (fallbackAt !== -1) {
        // One fallback request is useful in transcripts, but only when both
        // arms assert the same card summary. Keep curl out of the generic
        // trailing-command allowlist so `; curl ...` remains raw.
        if (fallbackAt !== 1 || statements.length !== 2) return null;
        const primary = parseIsomuxCurlInner(
          statements[0].text,
          ports,
          outerExpandedBody,
        );
        const fallback = parseIsomuxCurlInner(
          statements[1].text,
          ports,
          outerExpandedBody,
        );
        if (!primary || !fallback || !sameAssertedSummary(primary, fallback))
          return null;
        return withTrailing(
          primary,
          command.slice(statements[0].text.length).trim(),
        );
      }
      // Every statement after the first must be an allowed inspection command;
      // one stray `&& curl ...` (a second request the card could not describe)
      // or `&& git push` takes the whole command back to raw rendering.
      for (const st of statements.slice(1)) {
        if (!isSafeStage(st.text, TRAILING_COMMANDS)) return null;
      }
      statement = statements[0].text;
      // The statements are contiguous slices, so the remainder - separator
      // included - is exactly what the user typed.
      trailingCommand = command.slice(statement.length).trim();
    }
  }
  if (
    heredoc &&
    heredoc.literal &&
    outerExpandedBody &&
    /[$`]/.test(heredoc.body)
  ) {
    // An outer wrapper's shell already had a shot at this body, so the
    // extracted text is pre-expansion and can't be trusted as the sent bytes:
    // treat it as non-literal (curl-fed path notes it; jq-fed path stays raw).
    heredoc.literal = false;
  }
  const tokenized = tokenize(heredoc ? heredoc.line : statement, true);
  if (!tokenized) return null;
  const { tokens, pipeTail } = tokenized;
  if (tokens.length === 0) return null;
  if (tokens[0] === "curl") {
    // A heredoc attached to curl feeds its stdin as the request body
    // (`curl -d @- <<'EOF'`): resolve it to fields (literal JSON object) or a
    // note. parseCurlStage then enforces the single `-d @-` stdin read, so a
    // heredoc the curl never reads still bails to raw. No heredoc -> plain
    // curl, exactly as before.
    const stdinBody = heredoc ? resolveHeredocBody(heredoc) : null;
    return withTrailing(
      parseCurlStage(
        tokens,
        pipeTail,
        ports,
        stdinBody,
        tokenized.outputRedirect,
      ),
      trailingCommand,
    );
  }
  if (tokens[0] === "jq") {
    // Producer pipeline: jq builds the JSON body, curl reads it from stdin.
    // A redirect on the jq stage itself (`jq ... > f | curl`) would starve
    // the pipe - nonsense, bail.
    if (pipeTail === null || tokenized.outputRedirect !== null) return null;
    // A non-literal heredoc would seed jq's `.` with pre-expansion text - the
    // card would misrender the field value. The producer path takes only
    // literal bodies; anything else stays raw.
    if (heredoc && !heredoc.literal) return null;
    const body = parseJqInvocation(tokens, heredoc?.body ?? null);
    if (body === null) return null;
    const next = tokenize(pipeTail.slice(1), true);
    if (!next || next.tokens[0] !== "curl") return null;
    return withTrailing(
      parseCurlStage(
        next.tokens,
        next.pipeTail,
        ports,
        body,
        next.outputRedirect,
      ),
      trailingCommand,
    );
  }
  return null;
}

function sameAssertedSummary(
  a: IsomuxCurlRequest,
  b: IsomuxCurlRequest,
): boolean {
  return (
    a.method === b.method &&
    a.path === b.path &&
    a.action === b.action &&
    JSON.stringify(a.bodyFields) === JSON.stringify(b.bodyFields) &&
    a.bodyRaw === b.bodyRaw &&
    a.bodyNote === b.bodyNote &&
    a.hasAuth === b.hasAuth &&
    a.outputFile === b.outputFile &&
    a.outputAppend === b.outputAppend
  );
}

/** Attach the verbatim trailing statements to a successfully parsed request. */
function withTrailing(
  req: IsomuxCurlRequest | null,
  trailingCommand: string | null,
): IsomuxCurlRequest | null {
  if (!req || !trailingCommand) return req;
  return { ...req, trailingCommand };
}

/**
 * Parse one tokenized curl invocation (plus its optional display pipe tail).
 * `stdinBody` is a body resolved from curl's stdin - a leading jq producer
 * stage or an attached heredoc; when present, the curl must read its body from
 * stdin via an @-interpreting data flag (`-d @-`) and `stdinBody` supplies
 * bodyFields/bodyNote.
 */
function parseCurlStage(
  tokens: string[],
  pipeTail: string | null,
  ports: readonly string[],
  stdinBody: ResolvedBody | null,
  outputRedirect: OutputRedirect | null = null,
): IsomuxCurlRequest | null {
  if (pipeTail !== null && !isSafePipeTail(pipeTail)) return null;

  let method: string | null = null;
  let url: string | null = null;
  let hasAuth = false;
  const dataParts: string[] = [];
  const formParts: string[] = [];
  let getStyle = false; // -G/--get sends -d data as query params
  let stdinData = 0; // count of `@-` values seen via @-interpreting data flags
  let outputFromFlag: string | null = null; // -o/--output with a real path

  const applyArg = (kind: ArgKind, value: string): boolean => {
    switch (kind) {
      case "method":
        if (method !== null) return false;
        method = value.toUpperCase();
        return true;
      case "header": {
        const name = value.split(":", 1)[0].trim().toLowerCase();
        if (!ALLOWED_HEADERS.has(name)) return false;
        if (name === "authorization") hasAuth = true;
        return true;
      }
      case "data":
        if (value === "@-") stdinData++;
        dataParts.push(value);
        return true;
      case "dataLiteral":
        dataParts.push(value);
        return true;
      case "form":
        formParts.push(value);
        return true;
      case "url":
        if (url !== null) return false;
        url = value;
        return true;
      case "ignore":
        return true;
      case "output":
        // `/dev/null` discards silently. A real path is a file write - a
        // side effect - so it is accepted only when displayable verbatim
        // (REDIRECT_PATH_RE) and is surfaced on the card via outputFile.
        // One output target per command.
        if (value === "/dev/null") return true;
        if (outputFromFlag !== null || !REDIRECT_PATH_RE.test(value))
          return false;
        outputFromFlag = value;
        return true;
      case "dumpHeader":
        // Headers to stdout only; a file path rejects.
        return value === "-";
      case "writeOut":
        // @file reads a format file; %output{file} (curl >= 8.3.0) writes
        // one. Plain formats like '%{http_code}' are output-text-only.
        return (
          !value.toLowerCase().includes("%output") && !value.startsWith("@")
        );
    }
  };

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok : tok.slice(0, eq);
      if (BOOLEAN_LONG.has(name)) {
        if (eq !== -1) return null;
        if (name === "--get") getStyle = true;
        continue;
      }
      const kind = ARG_LONG[name];
      if (!kind) return null;
      const value = eq !== -1 ? tok.slice(eq + 1) : tokens[++i];
      if (value === undefined) return null;
      if (!applyArg(kind, value)) return null;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // Cluster of short flags, e.g. -sS, -fsSL, -sXPOST. A value-taking flag
      // ends the cluster: the rest of the token (or the next token) is its
      // value, matching curl's own parsing.
      for (let j = 1; j < tok.length; j++) {
        const ch = tok[j];
        if (BOOLEAN_SHORT.has(ch)) {
          if (ch === "G") getStyle = true;
          continue;
        }
        const kind = ARG_SHORT[ch];
        if (!kind) return null;
        const attached = tok.slice(j + 1);
        const value = attached !== "" ? attached : tokens[++i];
        if (value === undefined) return null;
        if (!applyArg(kind, value)) return null;
        break;
      }
      continue;
    }
    // Positional argument: the URL.
    if (!applyArg("url", tok)) return null;
  }

  if (url === null) return null;
  const path = matchIsomuxUrl(url, new Set(ports));
  if (path === null) return null;

  if (stdinBody !== null) {
    // The stdin body must actually be the request body: exactly one body
    // argument, `@-`, via an @-interpreting data flag, not diverted to the
    // query string by -G. Anything else and the card would attribute the
    // producer/heredoc body to a request that doesn't carry it.
    if (
      stdinData !== 1 ||
      dataParts.length !== 1 ||
      formParts.length !== 0 ||
      getStyle
    )
      return null;
  }

  const hasBody = !getStyle && (dataParts.length > 0 || formParts.length > 0);
  const resolvedMethod = method ?? (hasBody ? "POST" : "GET");

  let bodyFields: CurlBodyField[] | null = null;
  let bodyRaw: string | null = null;
  let bodyNote: string | null = null;
  if (stdinBody !== null) {
    if (stdinBody.kind === "fields") bodyFields = stdinBody.fields;
    else bodyNote = stdinBody.note;
  } else if (hasBody) {
    if (formParts.length > 0) {
      bodyFields = formParts.map((part) => {
        const eq = part.indexOf("=");
        return eq === -1
          ? { key: part, value: "" }
          : { key: part.slice(0, eq), value: displayValue(part.slice(eq + 1)) };
      });
    } else {
      const raw = dataParts.length === 1 ? dataParts[0] : dataParts.join("&");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (
        parsed !== undefined &&
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        bodyFields = Object.entries(parsed as Record<string, unknown>).map(
          ([key, value]) => ({ key, value: displayValue(value) }),
        );
      } else {
        bodyRaw = raw;
      }
    }
  }

  // One output target per command, from either the shell redirect or -o.
  if (outputRedirect !== null && outputFromFlag !== null) return null;
  const outputFile = outputRedirect?.path ?? outputFromFlag;
  // Output to a file AND a display pipe is shell-legal but nonsense for the
  // patterns we card (the pipe would receive nothing) - bail to raw.
  if (outputFile !== null && pipeTail !== null) return null;

  return {
    method: resolvedMethod,
    path,
    action: describeIsomuxRoute(resolvedMethod, path),
    bodyFields,
    bodyRaw,
    hasAuth,
    pipeTail,
    bodyNote,
    outputFile,
    outputAppend: outputRedirect?.append ?? false,
    // Filled in by withTrailing() once the whole command has been split; a
    // single curl stage on its own never has trailing statements.
    trailingCommand: null,
  };
}
