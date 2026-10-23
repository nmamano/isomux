// Shared attachment convention (attachment-prompt.ts) - unit tier.
//
// Covers the resolver (missing-file skipping, order preservation, duplicates)
// and the formatter (one-line invariant under hostile originalName input,
// escaping, deterministic size formatting). Backend wrapper behavior is
// frozen separately through each session's send() in
// backends/claude.session.test.ts and backends/codex/adapter.test.ts.
import { describe, expect, it, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { STATE_ROOT } from "./config.ts";
import {
  resolveAttachmentNotices,
  formatAttachmentLines,
  stripAttachmentNotices,
} from "./attachment-prompt.ts";
// formatSize moved to the leaf formatting module; the notice-line contract it
// feeds is still asserted here, alongside the lines that embed it.
import { formatSize } from "../shared/format-human.ts";

const TEST_AGENT_ID = `test-att-prompt-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const AGENT_FILES_DIR = join(STATE_ROOT, "logs", TEST_AGENT_ID, "files");

function fixtureFile(filename: string, contents: Buffer | string) {
  mkdirSync(AGENT_FILES_DIR, { recursive: true });
  writeFileSync(join(AGENT_FILES_DIR, filename), contents);
}

function spec(filename: string, mediaType = "text/plain", size = 1) {
  return { filename, originalName: filename, mediaType, size };
}

afterAll(() => {
  try {
    rmSync(join(STATE_ROOT, "logs", TEST_AGENT_ID), {
      recursive: true,
      force: true,
    });
  } catch {}
});

describe("resolveAttachmentNotices", () => {
  it("resolves specs to notices with the on-disk path", () => {
    fixtureFile("a.txt", "hello");
    const notices = resolveAttachmentNotices(TEST_AGENT_ID, [
      {
        filename: "a.txt",
        originalName: "orig a.txt",
        mediaType: "text/plain",
        size: 5,
      },
    ]);
    expect(notices).toEqual([
      {
        originalName: "orig a.txt",
        mediaType: "text/plain",
        size: 5,
        path: join(AGENT_FILES_DIR, "a.txt"),
      },
    ]);
  });

  it("skips missing files without placeholders and preserves order", () => {
    fixtureFile("one.png", Buffer.from([1]));
    fixtureFile("three.pdf", Buffer.from([3]));
    const notices = resolveAttachmentNotices(TEST_AGENT_ID, [
      spec("one.png", "image/png"),
      spec("two-missing.txt"),
      spec("three.pdf", "application/pdf"),
    ]);
    expect(notices.map((n) => n.originalName)).toEqual([
      "one.png",
      "three.pdf",
    ]);
  });
});

describe("formatAttachmentLines", () => {
  const notice = (
    over: Partial<Parameters<typeof formatAttachmentLines>[0][0]> = {},
  ) => ({
    originalName: "photo.png",
    mediaType: "image/png",
    size: 2048,
    path: "/state/logs/agent-1/files/photo.png",
    ...over,
  });

  it("formats one line per notice with the quoted name, type, size and quoted path", () => {
    const lines = formatAttachmentLines([
      notice(),
      notice({ path: "/state/logs/a 1/files/my file.png" }),
    ]);
    expect(lines).toHaveLength(2);
    const [line, spaced] = lines;
    expect(line).toStartWith('[Attachment: "photo.png" (image/png, ');
    expect(line).toContain(formatSize(2048));
    expect(line).toContain('"/state/logs/agent-1/files/photo.png"');
    expect(line).not.toContain("\n");
    // A path with spaces stays unambiguous: JSON quoting.
    expect(spaced).toContain('"/state/logs/a 1/files/my file.png"');
  });

  it("hostile originalName cannot break the one-line invariant", () => {
    const hostile = 'evil"name\nwith \\ tricks\tand \u0007bell';
    const [line] = formatAttachmentLines([notice({ originalName: hostile })]);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\t");
    expect(line).not.toContain("\u0007");
    // JSON-escaped forms present instead
    expect(line).toContain('\\"name');
    expect(line).toContain("\\n");
    expect(line).toContain("\\\\");
  });

  it("escapes unicode line separators in originalName, and passes other unicode through", () => {
    const [line] = formatAttachmentLines([
      notice({ originalName: "città 写真\u2028b\u2029c" }),
    ]);
    expect(line).not.toContain("\u2028");
    expect(line).not.toContain("\u2029");
    expect(line).toContain('"città 写真\\u2028b\\u2029c"');
  });

  it("malformed mediaType cannot inject newlines or fake delimiters", () => {
    const [line] = formatAttachmentLines([
      notice({ mediaType: 'image/png\n(fake) "quote"' }),
    ]);
    expect(line).not.toContain("\n");
    expect(line).toContain("image/png__fake_ _quote_");
  });
});

describe("formatSize", () => {
  it("is deterministic at unit boundaries, and garbage gets no number", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(10.4 * 1024 * 1024)).toBe("10.4 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");
    const garbage = formatSize(-5);
    expect(garbage).not.toMatch(/\d|NaN|Infinity/);
    expect(formatSize(Number.NaN)).toBe(garbage);
    expect(formatSize(Number.POSITIVE_INFINITY)).toBe(garbage);
  });
});

// Regression for task 1a3a0820: editing a message that carried attachments
// failed with "Cannot edit: could not locate message in backend session."
// Attachments ride as a second content block, and all three backends'
// getSessionMessages flatten content blocks by concatenation with no
// separator, so the transcript text is `<user text><notice block>` while the
// isomux log entry only holds `<user text>`. agent-manager's editMessage
// matcher compares the two by equality; without this strip it never matched.
// The fixture below is the real recorded shape (agent-1782317790021-xp9e,
// session 931f6215), not a synthesized one.
describe("stripAttachmentNotices", () => {
  const NOTICE =
    '[Attachment: "image.png" (image/png, 527.0 KB) saved at ' +
    '"/home/nil/.isomux/logs/agent-1782317790021-xp9e/files/image_7.png". ' +
    "If your reply depends on it, open it before answering about its contents.]";

  const spaced =
    '[Attachment: "Screen Shot 2026-07-24 at 3.15 PM (1).png" ' +
    '(image/png, 1.2 MB) saved at "/home/nil/.isomux/logs/agent-1/files/' +
    'Screen Shot 2026-07-24 at 3.15 PM (1).png". If your reply depends on ' +
    "it, open it before answering about its contents.]";
  const second =
    '[Attachment: "notes.md" (text/plain, 2.0 KB) saved at "/tmp/notes.md". ' +
    "If your reply depends on it, open it before answering about its contents.]";

  // [case, the user's own text, the notice block glued after it]
  it.each([
    [
      "a notice glued straight onto the user text",
      "[Nil (Windows)] Here is the screenshot of the cutoff slide.",
      NOTICE,
    ],
    [
      "a multi-attachment block joined by newlines",
      "[Nil] two files",
      NOTICE + "\n" + second,
    ],
    [
      "a notice after the user's own trailing newline",
      "[Nil] trailing\n",
      NOTICE,
    ],
    ["a notice block with no user text", "", NOTICE],
    [
      "a name or path containing escaped quotes",
      "[Nil] look",
      '[Attachment: "sa\\"y \\"hi\\".png" (image/png, 1.0 KB) saved at ' +
        '"/tmp/we\\"ird.png". If your reply depends on it, open it before ' +
        "answering about its contents.]",
    ],
    // Old transcripts keep matching after the advisory tail changes.
    [
      "a notice with an older advisory tail",
      "[Nil] older wording",
      '[Attachment: "image.png" (image/png, 1.0 KB) saved at "/tmp/image.png"]',
    ],
    [
      "quoted names and paths with spaces and parentheses",
      "[Nil] the shot",
      spaced,
    ],
  ])("strips %s", (_case, userText, block) => {
    expect(stripAttachmentNotices(userText + block)).toBe(userText);
  });

  it("matches the block the formatter actually produces", () => {
    fixtureFile("strip-me.txt", "x");
    fixtureFile("strip me (2).png", "y");
    const lines = formatAttachmentLines(
      resolveAttachmentNotices(TEST_AGENT_ID, [
        spec("strip-me.txt"),
        spec("strip me (2).png", "image/png"),
      ]),
    );
    expect(lines).toHaveLength(2);
    expect(stripAttachmentNotices("[Nil] here" + lines.join("\n"))).toBe(
      "[Nil] here",
    );
  });

  it.each([
    ["plain text", "[Nil] hello world"],
    ["empty text", ""],
    // Only at the end, never mid-message.
    [
      "a notice mid-message",
      "[Nil] see " + NOTICE + " and then some more words",
    ],
    [
      "a name with no quotes",
      "[Nil] a[Attachment: image.png (image/png, 1.0 KB) saved at /tmp/x.png]",
    ],
    [
      "a notice with no saved-at anchor",
      '[Nil] b[Attachment: "image.png" (image/png, 1.0 KB)]',
    ],
    [
      "an unterminated notice",
      '[Nil] c[Attachment: "image.png" (image/png, 1.0 KB) saved at "/tmp/x.png"',
    ],
    ["a bracketed word that resembles one", "[Nil] d[Attachment]"],
    [
      "ordinary text that ends in a bracket",
      "[Nil] the regex is /\\[Attachment: .*\\]/ [see above]",
    ],
  ])("leaves %s alone", (_case, text) => {
    expect(stripAttachmentNotices(text)).toBe(text);
  });
});
