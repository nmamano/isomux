import { redactText } from "./log-redaction.ts";

// Turns the raw PTY buffer into text an agent can read: escape codes removed,
// carriage returns and backspaces replayed, secrets masked, and optionally only
// the last `lines` lines. truncated drops the partial first line that the
// buffer trim can leave.
//
// The order is the redaction contract. Redaction runs before the replay, so
// an overwrite of a key's head cannot leave a tail that no pattern matches,
// and again after it, for a key that is whole only once a correction is
// replayed. CRLF becomes LF before the first pass, so a multi-line secret
// value matches as stored, and the line cut runs last, so it never splits a
// value before redaction sees it.
export function terminalText(
  raw: string,
  opts: { truncated: boolean; lines?: number },
): string {
  let text = Bun.stripANSI(raw).replace(/\r\n/g, "\n");
  if (opts.truncated) text = dropPartialHead(text);
  text = redactText(replay(redactText(text)));
  return opts.lines === undefined ? text : lastLines(text, opts.lines);
}

// The buffer trim can cut a line, an escape code or a secret in two. Drop
// through the first newline; a buffer with no newline drops through its
// first carriage return, and with neither, nothing of it is kept.
function dropPartialHead(text: string): string {
  const nl = text.indexOf("\n");
  if (nl >= 0) return text.slice(nl + 1);
  const cr = text.indexOf("\r");
  return cr >= 0 ? text.slice(cr) : "";
}

// Per line, the screen state the controls leave: \r moves to column 0, \b one
// column back (never before 0), later characters overwrite. Other C0 controls
// and DEL are dropped; tabs stay.
function replay(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const cells: string[] = [];
      let col = 0;
      for (const ch of line) {
        if (ch === "\r") col = 0;
        else if (ch === "\b") col = Math.max(0, col - 1);
        else if (ch === "\t" || !isControl(ch)) cells[col++] = ch;
      }
      return cells.join("");
    })
    .join("\n");
}

function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

// The last n lines. A final newline ends the last line; it does not start an
// extra empty one.
function lastLines(text: string, n: number): string {
  const ending = text.endsWith("\n") ? "\n" : "";
  const body = ending ? text.slice(0, -1) : text;
  return body.split("\n").slice(-n).join("\n") + ending;
}
