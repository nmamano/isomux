/**
 * Finds `<writer> | grep -q` in shell scripts. grep -q (and -m, -l, -L) stops
 * reading at the first match; under pipefail the writer then dies of SIGPIPE
 * and the pipeline status reads as "no match". Task 8e6cd05d.
 *
 * The scan is a small shell tokenizer, not a parser: quotes do not span
 * lines, so a heredoc or a multi-line quoted string is scanned as code. That
 * is on purpose: install.sh embeds whole scripts in heredocs.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

interface Token {
  op: boolean;
  text: string;
  line: number;
}

/** Operators that end a command. Longest first. */
const OPS = ["||", "|&", "&&", ";;", "|", "&", ";", "(", ")"];

/** After one of these, a newline continues the command list. */
const JOINS = new Set(["|", "|&", "&&", "||"]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let word = "";
  let wordLine = 1;
  const flush = () => {
    if (word !== "") tokens.push({ op: false, text: word, line: wordLine });
    word = "";
  };
  const append = (text: string) => {
    if (word === "") wordLine = line;
    word += text;
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\n") {
      flush();
      const last = tokens.at(-1);
      if (!(last?.op && JOINS.has(last.text)))
        tokens.push({ op: true, text: "\n", line });
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      flush();
      i++;
    } else if (c === "#" && word === "") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "\\") {
      if (source[i + 1] === "\n") {
        line++;
      } else {
        append(source.slice(i, i + 2));
      }
      i += 2;
    } else if (c === "'" || c === '"') {
      // A quote ends at its pair or at the end of the line.
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") {
        if (c === '"' && source[j] === "\\" && source[j + 1] !== "\n") j++;
        j++;
      }
      if (source[j] === c) j++;
      append(source.slice(i, j));
      i = j;
    } else if (c === "&" && /[<>]$/.test(word)) {
      append(c); // 2>&1, >&2
      i++;
    } else {
      const op = OPS.find((o) => source.startsWith(o, i));
      if (op) {
        flush();
        tokens.push({ op: true, text: op, line });
        i += op.length;
      } else {
        append(c);
        i++;
      }
    }
  }
  flush();
  return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Short options of grep that stop reading early. */
const EARLY_SHORT = new Set(["q", "m", "l", "L"]);
/** Short options of grep that take an argument. */
const ARG_SHORT = new Set(["e", "f", "m", "A", "B", "C", "d", "D"]);
const EARLY_LONG =
  /^--(quiet|silent|max-count(=.*)?|files-with-matches|files-without-match)$/;

function unquote(word: string): string {
  return word.replace(/['"]/g, "");
}

/** True when the command words are a grep that can stop before EOF. */
function stopsEarly(words: string[]): boolean {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return false;
    if (ASSIGNMENT.test(w) || w === "command") i++;
    else if (w === "env") {
      i++;
      while (words[i] !== undefined && /^-/.test(words[i])) i++;
    } else break;
  }
  const name = words[i].replace(/^\\/, "").split("/").at(-1);
  if (name !== "grep" && name !== "egrep" && name !== "fgrep") return false;
  for (i++; i < words.length; i++) {
    const w = unquote(words[i]);
    if (w === "--") return false;
    if (w.startsWith("--")) {
      if (EARLY_LONG.test(w)) return true;
    } else if (/^-[A-Za-z0-9]/.test(w)) {
      for (let k = 1; k < w.length; k++) {
        if (EARLY_SHORT.has(w[k])) return true;
        if (ARG_SHORT.has(w[k])) {
          if (k === w.length - 1) i++; // the argument is the next word
          break;
        }
      }
    }
  }
  return false;
}

/** 1-based line numbers of each grep that reads a pipe and can stop early. */
export function findPipedEarlyExitGreps(source: string): number[] {
  const tokens = tokenize(source);
  const lines = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.op || (t.text !== "|" && t.text !== "|&")) continue;
    const words: Token[] = [];
    for (let j = i + 1; j < tokens.length && !tokens[j].op; j++)
      words.push(tokens[j]);
    if (words.length > 0 && stopsEarly(words.map((w) => w.text))) {
      const name = words.find(
        (w) => !ASSIGNMENT.test(w.text) && /grep$/.test(w.text),
      );
      lines.add((name ?? words[0]).line);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

const SHEBANG = /^#!\s*\S*\/(?:env\s+(?:-\S+\s+)*)?(?:ba|da)?sh(?:\s|$)/;

function firstLine(path: string): string {
  const buf = Buffer.alloc(128);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("latin1").split("\n")[0];
  } catch {
    return ""; // a symlink to a directory, or a file deleted in the tree
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Tracked shell scripts under `root`, relative to it: *.sh, or a sh/bash shebang. */
export function shellScripts(root: string): string[] {
  const files = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  return files.filter(
    (f) => f.endsWith(".sh") || SHEBANG.test(firstLine(join(root, f))),
  );
}
