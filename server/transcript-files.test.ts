// The two on-disk forms of a session transcript (task e9776386): plain
// <sid>.jsonl and gzipped <sid>.jsonl.gz. The owner of the suffixes and of the
// compress / inflate moves. The readers that sit on top of it (persistence,
// log-source, usage, prune, compress) have their own tests; this file pins the
// moves themselves: lossless, mtime kept, crash leftovers handled, and a failed
// inflate never leaves a .jsonl that would hide the history.

import { describe, it, expect, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeStateDir } from "./test-support/temp-state.ts";
import {
  compressTranscript,
  inflateTranscript,
  readTranscriptHeadSync,
  readTranscriptSync,
  resolveTranscript,
  sessionIdOfTranscript,
  transcriptByteStream,
} from "./transcript-files.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) removeStateDir(dirs.pop()!);
});

function agentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "isomux-transcript-"));
  dirs.push(root);
  const dir = join(root, "logs", "agent-a");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Non-ASCII and an escaped quote, so a lossy text round-trip would show.
const TEXT =
  [
    { id: "1", kind: "user_message", content: 'say "hi" café ☕' },
    { id: "2", kind: "text", content: "x".repeat(5000) },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";

// An mtime on a whole second, so a stat round-trip compares exactly.
const OLD_MTIME_S = 1_700_000_000;

function writePlain(dir: string, sid: string, text = TEXT): string {
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, text);
  utimesSync(p, OLD_MTIME_S, OLD_MTIME_S);
  return p;
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

describe("sessionIdOfTranscript", () => {
  it("names a session only for a plain or a gzipped transcript", () => {
    expect(sessionIdOfTranscript("abc-1.jsonl")).toEqual({
      sessionId: "abc-1",
      compressed: false,
    });
    expect(sessionIdOfTranscript("abc-1.jsonl.gz")).toEqual({
      sessionId: "abc-1",
      compressed: true,
    });
    for (const name of [
      "abc-1.jsonl.gz.tmp",
      "abc-1.jsonl.tmp",
      "sessions.json",
      "abc-1.json",
      "abc-1.gz",
      ".jsonl",
      ".jsonl.gz",
      "abc-1.jsonl.corrupt-123",
    ]) {
      expect(sessionIdOfTranscript(name)).toBeNull();
    }
  });
});

describe("resolveTranscript", () => {
  it("finds the plain file, the gzipped file, or nothing", () => {
    const dir = agentDir();
    writePlain(dir, "plain");
    writeFileSync(join(dir, "packed.jsonl.gz"), Bun.gzipSync(TEXT));
    expect(resolveTranscript(dir, "plain")).toEqual({
      path: join(dir, "plain.jsonl"),
      compressed: false,
    });
    expect(resolveTranscript(dir, "packed")).toEqual({
      path: join(dir, "packed.jsonl.gz"),
      compressed: true,
    });
    expect(resolveTranscript(dir, "missing")).toBeNull();
  });

  it("prefers the plain file when a crash left both", () => {
    const dir = agentDir();
    writePlain(dir, "both", TEXT + '{"id":"3"}\n');
    writeFileSync(join(dir, "both.jsonl.gz"), Bun.gzipSync(TEXT));
    const file = resolveTranscript(dir, "both")!;
    expect(file.compressed).toBe(false);
    expect(readTranscriptSync(file)).toBe(TEXT + '{"id":"3"}\n');
  });
});

describe("compressTranscript", () => {
  it("replaces the .jsonl with a gzip of the same bytes and the same mtime", async () => {
    const dir = agentDir();
    const plain = writePlain(dir, "s1");
    const sizeBefore = statSync(plain).size;

    const result = compressTranscript(dir, "s1");

    const gz = join(dir, "s1.jsonl.gz");
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(gz)).toBe(true);
    // Plain gzip, so `zcat` reads it (the agent reference says so).
    expect(Buffer.from(Bun.gunzipSync(readFileSync(gz))).toString()).toBe(TEXT);
    expect(statSync(gz).mtimeMs).toBe(OLD_MTIME_S * 1000);
    expect(result).toEqual({
      bytesBefore: sizeBefore,
      bytesAfter: statSync(gz).size,
    });
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);

    // Every read form gives back the original text.
    const file = resolveTranscript(dir, "s1")!;
    expect(file.compressed).toBe(true);
    expect(readTranscriptSync(file)).toBe(TEXT);
    expect(readTranscriptHeadSync(file, 40)).toBe(TEXT.slice(0, 40));
    expect(await streamText(transcriptByteStream(file))).toBe(TEXT);
  });

  it("overwrites a stale .gz and a leftover temp file with the current .jsonl", () => {
    const dir = agentDir();
    writePlain(dir, "s1");
    writeFileSync(join(dir, "s1.jsonl.gz"), Bun.gzipSync("stale\n"));
    writeFileSync(join(dir, "s1.jsonl.gz.tmp"), "half-written");

    compressTranscript(dir, "s1");

    expect(readdirNames(dir)).toEqual(["s1.jsonl.gz"]);
    expect(readTranscriptSync(resolveTranscript(dir, "s1")!)).toBe(TEXT);
  });
});

describe("inflateTranscript", () => {
  it("turns the .gz back into the identical .jsonl", () => {
    const dir = agentDir();
    writePlain(dir, "s1");
    compressTranscript(dir, "s1");
    writeFileSync(join(dir, "s1.jsonl.tmp"), "half-written");

    inflateTranscript(dir, "s1");

    expect(readdirNames(dir)).toEqual(["s1.jsonl"]);
    expect(readFileSync(join(dir, "s1.jsonl"), "utf8")).toBe(TEXT);
  });

  it("leaves a .jsonl that already exists alone", () => {
    const dir = agentDir();
    writePlain(dir, "s1", "current\n");
    writeFileSync(join(dir, "s1.jsonl.gz"), Bun.gzipSync("stale\n"));

    inflateTranscript(dir, "s1");

    expect(readFileSync(join(dir, "s1.jsonl"), "utf8")).toBe("current\n");
  });

  it("throws on a .gz it cannot read, and keeps the .gz with no .jsonl", () => {
    const dir = agentDir();
    // A good one beside it inflates, so the throw below is about the bytes.
    writeFileSync(join(dir, "good.jsonl.gz"), Bun.gzipSync(TEXT));
    inflateTranscript(dir, "good");
    expect(readFileSync(join(dir, "good.jsonl"), "utf8")).toBe(TEXT);
    const gz = join(dir, "s1.jsonl.gz");
    writeFileSync(gz, "not gzip at all");

    expect(() => inflateTranscript(dir, "s1")).toThrow();
    expect(readFileSync(gz, "utf8")).toBe("not gzip at all");
    expect(existsSync(join(dir, "s1.jsonl"))).toBe(false);
  });

  it("throws when it cannot write, and keeps the .gz with no .jsonl", () => {
    const dir = agentDir();
    writePlain(dir, "s1");
    compressTranscript(dir, "s1");
    const gzBytes = readFileSync(join(dir, "s1.jsonl.gz"));
    chmodSync(dir, 0o500);
    try {
      expect(() => inflateTranscript(dir, "s1")).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(join(dir, "s1.jsonl.gz")).equals(gzBytes)).toBe(true);
    expect(existsSync(join(dir, "s1.jsonl"))).toBe(false);
  });
});

describe("readTranscriptSync", () => {
  it("throws on a corrupt .gz instead of returning an empty transcript", () => {
    const dir = agentDir();
    writeFileSync(join(dir, "good.jsonl.gz"), Bun.gzipSync(TEXT));
    expect(readTranscriptSync(resolveTranscript(dir, "good")!)).toBe(TEXT);
    writeFileSync(join(dir, "s1.jsonl.gz"), "not gzip at all");
    expect(() => readTranscriptSync(resolveTranscript(dir, "s1")!)).toThrow();
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}
