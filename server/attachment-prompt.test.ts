// Shared attachment convention (attachment-prompt.ts) — unit tier.
//
// Covers the resolver (missing-file skipping, order preservation, duplicates)
// and the formatter (one-line invariant under hostile originalName input,
// escaping, deterministic size formatting). Backend wrapper behavior is
// frozen separately in claude.test.ts (buildClaudeUserMessage) and
// codex/adapter.test.ts (buildCodexUserInput).
import { describe, expect, it, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { STATE_ROOT } from "./config.ts";
import { stripOutboundEnvelope } from "./plugin-hooks.ts";
import {
  resolveAttachmentNotices,
  formatAttachmentLines,
  quoteOneLine,
  stripAttachmentNotices,
} from "./attachment-prompt.ts";
// formatSize moved to the leaf formatting module; the notice-line contract it
// feeds is still asserted here, alongside the lines that embed it.
import { formatSize } from "./format-human.ts";

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

  it("duplicate specs yield duplicate notices (no dedup)", () => {
    fixtureFile("dup.txt", "x");
    const notices = resolveAttachmentNotices(TEST_AGENT_ID, [
      spec("dup.txt"),
      spec("dup.txt"),
    ]);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toEqual(notices[1]);
  });

  it("returns [] when nothing resolves", () => {
    expect(resolveAttachmentNotices(TEST_AGENT_ID, [spec("nope.txt")])).toEqual(
      [],
    );
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

  it("formats one line per notice with quoted name and path", () => {
    const lines = formatAttachmentLines([notice()]);
    expect(lines).toEqual([
      '[Attachment: "photo.png" (image/png, 2.0 KB) saved at "/state/logs/agent-1/files/photo.png". If your reply depends on it, open it before answering about its contents.]',
    ]);
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

  it("unicode line separators in originalName are escaped", () => {
    const [line] = formatAttachmentLines([
      notice({ originalName: "a\u2028b\u2029c" }),
    ]);
    expect(line).not.toContain("\u2028");
    expect(line).not.toContain("\u2029");
    expect(line).toContain("\\u2028");
    expect(line).toContain("\\u2029");
  });

  it("plain unicode in originalName passes through", () => {
    const [line] = formatAttachmentLines([
      notice({ originalName: "città 写真.png" }),
    ]);
    expect(line).toContain('"città 写真.png"');
  });

  it("malformed mediaType cannot inject newlines or fake delimiters", () => {
    const [line] = formatAttachmentLines([
      notice({ mediaType: 'image/png\n(fake) "quote"' }),
    ]);
    expect(line).not.toContain("\n");
    expect(line).toContain("image/png__fake_ _quote_");
  });

  it("paths with spaces are unambiguous via JSON quoting", () => {
    const [line] = formatAttachmentLines([
      notice({ path: "/state/logs/a 1/files/my file.png" }),
    ]);
    expect(line).toContain('saved at "/state/logs/a 1/files/my file.png"');
  });

  it("empty input yields no lines", () => {
    expect(formatAttachmentLines([])).toEqual([]);
  });
});

describe("formatSize", () => {
  it("is deterministic at unit boundaries", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1)).toBe("1 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(10.4 * 1024 * 1024)).toBe("10.4 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("rejects garbage without breaking the line", () => {
    expect(formatSize(-5)).toBe("unknown size");
    expect(formatSize(Number.NaN)).toBe("unknown size");
    expect(formatSize(Number.POSITIVE_INFINITY)).toBe("unknown size");
  });
});

describe("quoteOneLine", () => {
  it("round-trips as JSON for normal strings", () => {
    expect(JSON.parse(quoteOneLine("hello world"))).toBe("hello world");
  });
});

// Regression for task 1a3a0820: editing a message that carried attachments
// failed with "Cannot edit: could not locate message in backend session."
// Attachments ride as a second content block, and both backends'
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

  it("leaves text without a notice block untouched", () => {
    expect(stripAttachmentNotices("[Nil] hello world")).toBe(
      "[Nil] hello world",
    );
    expect(stripAttachmentNotices("")).toBe("");
  });

  it("strips a notice glued straight onto the user text", () => {
    const userText =
      "[Nil (Windows)] Here is the screenshot of the cutoff slide.";
    expect(stripAttachmentNotices(userText + NOTICE)).toBe(userText);
  });

  it("strips a multi-attachment block joined by newlines", () => {
    const second =
      '[Attachment: "notes.md" (text/plain, 2.0 KB) saved at "/tmp/notes.md". ' +
      "If your reply depends on it, open it before answering about its contents.]";
    expect(
      stripAttachmentNotices("[Nil] two files" + NOTICE + "\n" + second),
    ).toBe("[Nil] two files");
  });

  it("matches the block the formatter actually produces", () => {
    fixtureFile("strip-me.txt", "x");
    const lines = formatAttachmentLines(
      resolveAttachmentNotices(TEST_AGENT_ID, [spec("strip-me.txt")]),
    );
    expect(stripAttachmentNotices("[Nil] here" + lines.join("\n"))).toBe(
      "[Nil] here",
    );
  });

  it("preserves the user's own trailing newline", () => {
    expect(stripAttachmentNotices("[Nil] trailing\n" + NOTICE)).toBe(
      "[Nil] trailing\n",
    );
  });

  it("handles an empty user message (notice block only)", () => {
    expect(stripAttachmentNotices(NOTICE)).toBe("");
    expect(stripAttachmentNotices("[Nil] " + NOTICE)).toBe("[Nil] ");
  });

  it("survives a name or path containing escaped quotes", () => {
    const tricky =
      '[Attachment: "sa\\"y \\"hi\\".png" (image/png, 1.0 KB) saved at ' +
      '"/tmp/we\\"ird.png". If your reply depends on it, open it before ' +
      "answering about its contents.]";
    expect(stripAttachmentNotices("[Nil] look" + tricky)).toBe("[Nil] look");
  });

  it("tolerates a changed advisory tail (old transcripts keep matching)", () => {
    const legacy =
      '[Attachment: "image.png" (image/png, 1.0 KB) saved at "/tmp/image.png"]';
    expect(stripAttachmentNotices("[Nil] older wording" + legacy)).toBe(
      "[Nil] older wording",
    );
  });

  it("only strips at the end, never mid-message", () => {
    const text = "[Nil] see " + NOTICE + " and then some more words";
    expect(stripAttachmentNotices(text)).toBe(text);
  });

  it("keeps quoted names and paths that contain spaces and punctuation", () => {
    const spaced =
      '[Attachment: "Screen Shot 2026-07-24 at 3.15 PM (1).png" ' +
      '(image/png, 1.2 MB) saved at "/home/nil/.isomux/logs/agent-1/files/' +
      'Screen Shot 2026-07-24 at 3.15 PM (1).png". If your reply depends on ' +
      "it, open it before answering about its contents.]";
    expect(stripAttachmentNotices("[Nil] the shot" + spaced)).toBe(
      "[Nil] the shot",
    );
  });

  it("leaves near misses alone", () => {
    const cases = [
      // no quoting around the name
      "[Nil] a[Attachment: image.png (image/png, 1.0 KB) saved at /tmp/x.png]",
      // missing the "saved at" anchor
      '[Nil] b[Attachment: "image.png" (image/png, 1.0 KB)]',
      // unterminated
      '[Nil] c[Attachment: "image.png" (image/png, 1.0 KB) saved at "/tmp/x.png"',
      // a bracketed word that merely resembles one
      "[Nil] d[Attachment]",
    ];
    for (const text of cases) expect(stripAttachmentNotices(text)).toBe(text);
  });

  it("leaves ordinary text that just happens to end in a bracket", () => {
    const text = "[Nil] the regex is /\\[Attachment: .*\\]/ [see above]";
    expect(stripAttachmentNotices(text)).toBe(text);
  });

  // The two strips compose in the order editMessage applies them: a turn can
  // carry BOTH a beforeTurn/context-notice envelope (prefix) and attachments
  // (suffix), and the log entry holds neither.
  it("composes with stripOutboundEnvelope to recover the bare sdkText", () => {
    const sdkText = "[Nil] both at once";
    const recorded =
      "--- begin isomux: context-check ---\n" +
      "Your context is 75% full.\n" +
      "--- end isomux: context-check ---\n\n" +
      "User message:\n" +
      sdkText +
      NOTICE;
    expect(stripAttachmentNotices(stripOutboundEnvelope(recorded))).toBe(
      sdkText,
    );
  });
});
