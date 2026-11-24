/**
 * Whether a Bash command is one curl call to this office's own API. The
 * Claude safety hook lets such a call run with no prompt and no auto-mode
 * classifier (GitHub #82: auto mode refused GET /agents as "Undermining
 * Oversight", so an agent could not find another agent by name).
 *
 * A true runs the command unasked, a false only leaves it to the agent's
 * permission mode, so this fails closed: anything the grammar below does not
 * fully read is false. It has its own strict reader, not the safety policy's
 * shell parser, which is built to find danger and errs the other way.
 *
 * The grammar:
 * - Words: unquoted characters from [A-Za-z0-9_./:?=%@,+-] (an unquoted `?`,
 *   a glob, only in the path of an office URL); single-quoted
 *   spans; double-quoted spans, where `\` is taken only before " \ $ ` and a
 *   newline. The one expansion is the agent token, `$ISOMUX_AGENT_TOKEN` or
 *   `${ISOMUX_AGENT_TOKEN}`, quoted or not. Backslash-newline outside quotes
 *   joins lines. Any other `$`, a backtick, `;`, `&`, `(`, `<`, `>`, a glob,
 *   a comment or a bare newline makes the command false.
 * - First stage: `curl` itself, with flags from CURL_FLAGS only, and at least
 *   one URL; every URL (operand or --url) is http on localhost, 127.0.0.1 or
 *   [::1] at `port`. A data value (-d, --data, --data-binary, --json) that
 *   starts with `@` must be exactly `@-` (stdin); a header value must not
 *   start with `@`. Both forms read a local file and send it on.
 * - Then pipe stages on the same line: jq, head, tail, wc or grep, each with
 *   its own small flag set and no file operand. A jq filter must not name
 *   import, include, modulemeta, env or $ENV.
 * - A stage may end with `2>/dev/null` and `2>&1`, as exact words.
 * - The curl stage may take one heredoc with a quoted tag (`<<'EOF'`,
 *   `<<"EOF"`, `<<-'EOF'`), so the body is never expanded. The pipe stages sit
 *   on the operator line; the body follows; the last line is the tag alone,
 *   with nothing after it but one trailing newline.
 * - readOnly (plan mode): no data flag and no method other than GET.
 */

export interface OfficeApiCallOptions {
  /** Plan mode: only a read (no data flag, no method other than GET). */
  readOnly?: boolean;
}

// Stands for the agent token in a word: it is never a URL or a file name.
const TOKEN = "\u0001";
const TOKEN_NAME = "ISOMUX_AGENT_TOKEN";
// Stands for an unquoted `?`, which bash expands against the files in the
// folder: `-d ?x` can turn into `-d @x`, and a URL `localhost:4000?evil` into
// `localhost:4000@evil`. It may stand only in the path of an office URL, where
// the expansion keeps the host.
const GLOB = "\u0002";
const UNQUOTED = /[A-Za-z0-9_./:?=%@,+-]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const STDERR_WORDS = ["2>/dev/null", "2>&1"];

type Token =
  | { kind: "word"; text: string }
  | { kind: "pipe" }
  | { kind: "stderr" }
  | { kind: "heredoc" };

interface FlagSet {
  boolean: Set<string>;
  value: Set<string>;
}

const CURL_FLAGS: FlagSet = {
  boolean: new Set([
    "-s",
    "-S",
    "-f",
    "-i",
    "-G",
    "-N",
    "--silent",
    "--show-error",
    "--fail",
    "--fail-with-body",
    "--include",
    "--get",
    "--no-buffer",
    "--compressed",
  ]),
  value: new Set([
    "-X",
    "-H",
    "-d",
    "-m",
    "--request",
    "--header",
    "--data",
    "--data-raw",
    "--data-binary",
    "--json",
    "--max-time",
    "--connect-timeout",
    "--url",
  ]),
};
const CURL_METHOD = new Set(["-X", "--request"]);
const CURL_HEADER = new Set(["-H", "--header"]);
// Data flags that read a file from an `@` value.
const CURL_FILE_DATA = new Set(["-d", "--data", "--data-binary", "--json"]);
const CURL_DATA = new Set([...CURL_FILE_DATA, "--data-raw"]);

/** The command's tokens, or null when it holds anything outside the grammar. */
function tokenize(command: string): Token[] | null {
  const tokens: Token[] = [];
  let heredoc: { tag: string; strip: boolean } | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "\\" && command[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (ch === "\n") {
      const rest = command.slice(i + 1);
      if (!heredoc) return rest.trim() === "" ? tokens : null;
      return heredocEnds(rest, heredoc) ? tokens : null;
    }
    if (ch === "|") {
      if (command[i + 1] === "|" || command[i + 1] === "&") return null;
      tokens.push({ kind: "pipe" });
      i++;
      continue;
    }
    if (command.startsWith("<<", i)) {
      if (heredoc) return null;
      const m = /^<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)")/.exec(
        command.slice(i),
      );
      if (!m) return null;
      heredoc = { tag: m[2] ?? m[3], strip: m[1] === "-" };
      tokens.push({ kind: "heredoc" });
      i += m[0].length;
      continue;
    }
    const stderr = STDERR_WORDS.find(
      (w) => command.startsWith(w, i) && endsWord(command[i + w.length]),
    );
    if (stderr) {
      tokens.push({ kind: "stderr" });
      i += stderr.length;
      continue;
    }
    const word = readWord(command, i);
    if (!word) return null;
    tokens.push({ kind: "word", text: word.text });
    i = word.end;
  }
  // A heredoc operator with no body.
  return heredoc ? null : tokens;
}

function endsWord(next: string | undefined): boolean {
  return next === undefined || /[ \t\n|]/.test(next);
}

/** The body after the operator line ends with the tag alone, then nothing. */
function heredocEnds(
  body: string,
  heredoc: { tag: string; strip: boolean },
): boolean {
  const lines = body.split("\n");
  const at = lines.findIndex(
    (line) => (heredoc.strip ? line.replace(/^\t+/, "") : line) === heredoc.tag,
  );
  if (at < 0) return false;
  const after = lines.slice(at + 1);
  return after.length === 0 || (after.length === 1 && after[0] === "");
}

/** The agent token expansion at `i` (`$` included), or null. */
function tokenExpansion(command: string, i: number): number | null {
  const plain = `$${TOKEN_NAME}`;
  if (
    command.startsWith(plain, i) &&
    !NAME_CHAR.test(command[i + plain.length] ?? "")
  )
    return i + plain.length;
  const braced = `\${${TOKEN_NAME}}`;
  if (command.startsWith(braced, i)) return i + braced.length;
  return null;
}

function readWord(
  command: string,
  start: number,
): { text: string; end: number } | null {
  let text = "";
  let i = start;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "?") {
      text += GLOB;
      i++;
    } else if (UNQUOTED.test(ch)) {
      text += ch;
      i++;
    } else if (ch === "$") {
      const end = tokenExpansion(command, i);
      if (end === null) return null;
      text += TOKEN;
      i = end;
    } else if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return null;
      text += command.slice(i + 1, close);
      i = close + 1;
    } else if (ch === '"') {
      const quoted = readDoubleQuoted(command, i + 1);
      if (!quoted) return null;
      text += quoted.text;
      i = quoted.end;
    } else if (/[ \t\n|]/.test(ch) || (ch === "\\" && command[i + 1] === "\n"))
      break;
    else return null;
  }
  return i > start ? { text, end: i } : null;
}

function readDoubleQuoted(
  command: string,
  start: number,
): { text: string; end: number } | null {
  let text = "";
  let i = start;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '"') return { text, end: i + 1 };
    if (ch === "`") return null;
    if (ch === "$") {
      const end = tokenExpansion(command, i);
      if (end === null) return null;
      text += TOKEN;
      i = end;
    } else if (ch === "\\") {
      const next = command[i + 1];
      if (next === "\n") i += 2;
      else if (next !== undefined && '"\\$`'.includes(next)) {
        text += next;
        i += 2;
      } else return null;
    } else {
      text += ch;
      i++;
    }
  }
  return null;
}

/** The words of each pipe stage, or null when a stage is malformed. */
function stages(
  tokens: Token[],
): { words: string[]; heredoc: boolean }[] | null {
  const out: { words: string[]; heredoc: boolean; stderr: boolean }[] = [
    { words: [], heredoc: false, stderr: false },
  ];
  for (const token of tokens) {
    const stage = out[out.length - 1];
    if (token.kind === "pipe") {
      if (stage.words.length === 0) return null;
      out.push({ words: [], heredoc: false, stderr: false });
    } else if (token.kind === "heredoc") stage.heredoc = true;
    else if (token.kind === "stderr") stage.stderr = true;
    // The stderr words end a stage.
    else if (stage.stderr) return null;
    else stage.words.push(token.text);
  }
  if (out[out.length - 1].words.length === 0) return null;
  return out;
}

function officeUrl(word: string, port: string): boolean {
  if (!/^\d+$/.test(port)) return false;
  const host = `^(?:http://)?(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}`;
  if (!word.includes(GLOB)) return new RegExp(`${host}(?:[/?]|$)`).test(word);
  // The prefix holds no GLOB, so every `?` sits after the path's first `/`.
  return new RegExp(`${host}/`).test(word);
}

/** Split curl-style flags: `--opt=value`, `-abc`, `-Xvalue`. */
function* flags(
  words: string[],
  set: FlagSet,
): Generator<
  { flag: string; value?: string } | { operand: string } | { bad: true }
> {
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word.startsWith("-") || word === "-") {
      yield { operand: word };
      continue;
    }
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq < 0 ? word : word.slice(0, eq);
      if (set.boolean.has(name) && eq < 0) yield { flag: name };
      else if (set.value.has(name)) {
        const value = eq < 0 ? words[++i] : word.slice(eq + 1);
        if (value === undefined) yield { bad: true };
        else yield { flag: name, value };
      } else yield { bad: true };
      continue;
    }
    // A bundle of short flags: a value flag takes the rest of the word, or
    // the next word.
    for (let j = 1; j < word.length; j++) {
      const name = `-${word[j]}`;
      if (set.boolean.has(name)) {
        yield { flag: name };
        continue;
      }
      if (!set.value.has(name)) {
        yield { bad: true };
        break;
      }
      const rest = word.slice(j + 1);
      const value = rest !== "" ? rest : words[++i];
      if (value === undefined) yield { bad: true };
      else yield { flag: name, value };
      break;
    }
  }
}

function curlStage(words: string[], port: string, readOnly: boolean): boolean {
  if (words[0] !== "curl") return false;
  let urls = 0;
  for (const part of flags(words.slice(1), CURL_FLAGS)) {
    if ("bad" in part) return false;
    if ("operand" in part) {
      if (!officeUrl(part.operand, port)) return false;
      urls++;
      continue;
    }
    const { flag, value } = part;
    if (value === undefined) continue;
    if (flag === "--url") {
      if (!officeUrl(value, port)) return false;
      urls++;
    } else if (value.includes(GLOB)) return false;
    if (CURL_FILE_DATA.has(flag) && value.startsWith("@") && value !== "@-")
      return false;
    if (CURL_HEADER.has(flag) && value.startsWith("@")) return false;
    if (readOnly && CURL_DATA.has(flag)) return false;
    if (readOnly && CURL_METHOD.has(flag) && value !== "GET") return false;
  }
  return urls > 0;
}

const JQ_FLAGS: FlagSet = {
  boolean: new Set(["-r", "-c", "-e", "-s", "-S", "-M", "-j", "-a"]),
  value: new Set(),
};
const COUNT = /^[+-]?\d+$/;
const HEAD_TAIL_FLAGS: FlagSet = {
  boolean: new Set(),
  value: new Set(["-n", "-c"]),
};
const WC_FLAGS: FlagSet = {
  boolean: new Set(["-l", "-c", "-w", "-m"]),
  value: new Set(),
};
const GREP_FLAGS: FlagSet = {
  boolean: new Set([
    "-i",
    "-v",
    "-c",
    "-n",
    "-o",
    "-E",
    "-F",
    "-w",
    "-x",
    "-q",
  ]),
  value: new Set(["-e", "-A", "-B", "-C"]),
};

// jq's module system (import, include, modulemeta) reads files from any
// folder, and $ENV and env hold the agent token. A field such as .env is
// refused too.
const JQ_READS = /\b(?:import|include|modulemeta|env)\b|\$ENV\b/;

function jqStage(words: string[]): boolean {
  let filters = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "--arg" || word === "--argjson") {
      if (words[i + 2] === undefined) return false;
      i += 2;
    } else if (word.startsWith("-") && word !== "-") {
      for (const part of flags([word], JQ_FLAGS))
        if ("bad" in part) return false;
    } else if (JQ_READS.test(word)) return false;
    else filters++;
  }
  return filters === 1;
}

function pipeStage(words: string[]): boolean {
  if (words.some((word) => word.includes(GLOB))) return false;
  const [program, ...args] = words;
  if (program === "jq") return jqStage(args);
  if (program === "head" || program === "tail") {
    for (const word of args) if (/^-\d+$/.test(word)) return args.length === 1;
    for (const part of flags(args, HEAD_TAIL_FLAGS))
      if (!("flag" in part) || !COUNT.test(part.value ?? "")) return false;
    return true;
  }
  if (program === "wc") {
    for (const part of flags(args, WC_FLAGS))
      if (!("flag" in part)) return false;
    return true;
  }
  if (program === "grep") {
    let patterns = 0;
    let operands = 0;
    for (const part of flags(args, GREP_FLAGS)) {
      if ("bad" in part) return false;
      if ("operand" in part) operands++;
      else if (part.flag === "-e") patterns++;
      else if (part.value !== undefined && !/^\d+$/.test(part.value))
        return false;
    }
    return patterns > 0 ? operands === 0 : operands === 1;
  }
  return false;
}

export function isOfficeApiCall(
  command: string,
  port: string,
  opts: OfficeApiCallOptions = {},
): boolean {
  const tokens = tokenize(command);
  if (!tokens) return false;
  const parts = stages(tokens);
  if (!parts) return false;
  const [first, ...rest] = parts;
  if (!curlStage(first.words, port, opts.readOnly === true)) return false;
  return rest.every((stage) => !stage.heredoc && pipeStage(stage.words));
}
