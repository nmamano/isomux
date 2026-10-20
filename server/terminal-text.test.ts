// terminalText: the raw PTY buffer as an agent reads it through
// GET /api/agents/:id/terminal (task 11d010ab). The route test
// (test-support/routes-terminal-rest.test.ts) proves the handler runs this
// function; the cleaning rules and the order of the redaction passes are
// pinned here, where each case is one string.

import { describe, it, expect, afterEach } from "bun:test";
import { terminalText } from "./terminal-text.ts";
import { setSecretValuesForRedaction } from "./log-redaction.ts";

const clean = (raw: string, lines?: number) =>
  terminalText(raw, { truncated: false, lines });

// The lines of an output, without the empty string a final newline leaves.
const linesOf = (text: string) => {
  const parts = text.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
};

describe("terminalText cleaning", () => {
  it("strips CSI and OSC sequences and turns CRLF into LF", () => {
    expect(
      clean(
        "a\x1b[31mb\x1b[0m\x1b[?2004h\r\n\x1b]0;title\x07c\x1b]8;;u\x1b\\d",
      ),
    ).toBe("ab\ncd");
  });

  it("replays a carriage return as an overwrite from column 0", () => {
    // A progress bar reads as its last state.
    expect(clean("10%\r50%\r100%\n")).toBe("100%\n");
    // A shorter overwrite leaves the rest of the line on screen.
    expect(clean("abcdef\rXY")).toBe("XYcdef");
  });

  it("replays a backspace as one column back, never before column 0", () => {
    expect(clean("ab\bc")).toBe("ac");
    expect(clean("\bx")).toBe("x");
  });

  it("drops other C0 controls and keeps tabs", () => {
    expect(clean("a\x07b\tc\x00d\n")).toBe("ab\tcd\n");
  });

  it("drops the partial first line only when the buffer was truncated", () => {
    const raw = "tail-of-old-output\r\nkept\r\n$ ";
    expect(terminalText(raw, { truncated: true })).toBe("kept\n$ ");
    expect(terminalText(raw, { truncated: false })).toBe(
      "tail-of-old-output\nkept\n$ ",
    );
  });
});

describe("terminalText lines", () => {
  it("returns the last N lines; a final newline is not an extra line", () => {
    expect(linesOf(clean("a\nb\nc\n", 2))).toEqual(["b", "c"]);
    expect(linesOf(clean("a\r\nb\r\n$ ", 1))).toEqual(["$ "]);
    expect(linesOf(clean("a\nb\n", 10))).toEqual(["a", "b"]);
  });

  it("counts lines after cleaning, so a progress bar is one line", () => {
    expect(linesOf(clean("start\n10%\r50%\r100%\n", 1))).toEqual(["100%"]);
  });
});

describe("terminalText redaction", () => {
  afterEach(() => setSecretValuesForRedaction([]));

  // 30 characters after the provider prefix: the pattern needs 20 or more.
  const BODY = "Q7wErTy9UiOp4AsDfGh2JkLzXcVbNm";
  const KEY = "sk-ant-api03-" + BODY;

  it("masks a key-shaped string and a KEY=value assignment", () => {
    const out = clean(`$ echo ${KEY}\r\n${KEY}\r\nexport API_KEY=${BODY}\r\n`);
    expect(out).not.toContain(BODY);
    expect(out).not.toContain(BODY.slice(-12));
    // The reader still sees which key it was.
    expect(out).toContain("export API_KEY=" + BODY.slice(0, 8));
  });

  it("masks a key before a carriage return overwrites its head", () => {
    // The prompt redraw covers the 13-character prefix; on screen the rest
    // of the key stays visible, and no pattern matches it alone.
    const out = clean(`${KEY}\rPROMPT$ hello\n`);
    expect(out).not.toContain(BODY.slice(-20));
  });

  it("masks a key that is key-shaped only after a backspace is replayed", () => {
    // Typed with a correction: the raw text holds "X\b" in the middle, so
    // neither half is long enough to match the pattern.
    const head = BODY.slice(0, 10);
    const tail = BODY.slice(10);
    const out = clean(`sk-ant-api03-${head}X\b${tail}\n`);
    expect(out).not.toContain(tail);
    expect(out).toContain("sk-ant-a");
  });

  it("masks a multi-line secret value the PTY printed with CRLF", () => {
    const first = "first-line-of-secret-9f3k";
    const second = "second-line-of-secret-2m7q";
    setSecretValuesForRedaction([`${first}\n${second}`]);
    const raw = `$ cat key.pem\r\n${first}\r\n${second}\r\n$ `;
    const full = clean(raw);
    expect(full).not.toContain(first);
    expect(full).not.toContain(second);
    expect(full).toContain("$ cat key.pem");
    // The line cut runs after redaction: a cut through the value must not
    // leave its last line unmasked.
    const last = clean(raw, 2);
    expect(last).not.toContain(second);
    expect(linesOf(last).at(-1)).toBe("$ ");
    // The pass before the replay sees LF line ends: when a carriage return
    // then overwrites the head of the value's last line, the value no longer
    // matches after the replay, so only that pass can mask it.
    const redrawn = clean(`${first}\r\n${second}\rXXXX\r\n$ `);
    expect(redrawn).not.toContain(first);
    expect(redrawn).not.toContain(second.slice(4));
  });
});
