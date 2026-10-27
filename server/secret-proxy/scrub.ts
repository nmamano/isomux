// The response scrub of the secret proxy (internal-docs/secrets-design.md,
// section 2.2). It removes secret values, in raw, URL-encoded and base64
// form, from response headers and bodies. A backstop, not a proof: a host
// that reflects a value in another encoding (hex, for one) still returns it
// (section 2.5).

import { SECRET_MIN_VALUE_LENGTH } from "../../shared/secret-hosts.ts";

export const SCRUB_MARKER = "ISOMUX-REDACTED";

// No pattern shorter than this is scrubbed, here or in the log masking
// (log-redaction.ts). A short pattern matches ordinary text and binary
// bodies: a 3-character value would rewrite every response of every
// terminated host, and break a git packfile's checksum. The store refuses a
// new value shorter than this; one stored before that rule is not scrubbed.
export const MIN_SCRUB_LENGTH = SECRET_MIN_VALUE_LENGTH;

// The base64 text of `value` at each of the three byte alignments, without
// the edge groups that mix in neighbouring bytes. A value inside a longer
// base64 string (Basic credentials, `user:value`) contains one of these.
function base64Cores(value: Buffer): string[] {
  const cores: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const text = Buffer.concat([Buffer.alloc(offset), value]).toString(
      "base64",
    );
    const start = offset === 0 ? 0 : 4;
    const end =
      (offset + value.length) % 3 === 0 ? text.length : text.length - 4;
    const core = text.slice(start, end);
    if (core.length >= 4) cores.push(core);
  }
  return cores;
}

// The strings to remove for a set of values, longest first so that a longer
// form is replaced before a shorter one inside it.
export function scrubPatterns(values: Iterable<string>): string[] {
  const patterns = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    patterns.add(value);
    patterns.add(encodeURIComponent(value));
    for (const core of base64Cores(Buffer.from(value, "latin1")))
      patterns.add(core);
  }
  return [...patterns]
    .filter((pattern) => pattern.length >= MIN_SCRUB_LENGTH)
    .sort((a, b) => b.length - a.length);
}

// Where scrubText replaces, as [start, end) offsets into `text`. One
// left-to-right pass: at each position the longest pattern that starts there
// wins.
export function scrubSpans(
  text: string,
  patterns: readonly string[],
): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  for (;;) {
    let best = -1;
    let bestPattern = "";
    for (const pattern of patterns) {
      const at = text.indexOf(pattern, i);
      if (at !== -1 && (best === -1 || at < best)) {
        best = at;
        bestPattern = pattern;
      } else if (
        at !== -1 &&
        at === best &&
        pattern.length > bestPattern.length
      ) {
        bestPattern = pattern;
      }
    }
    if (best === -1) return spans;
    spans.push([best, best + bestPattern.length]);
    i = best + bestPattern.length;
  }
}

// Replace every pattern in `text`, at the spans scrubSpans finds.
function replaceAll(
  text: string,
  patterns: readonly string[],
): { text: string; lastEnd: number } {
  let out = "";
  let i = 0;
  let lastEnd = 0;
  for (const [start, end] of scrubSpans(text, patterns)) {
    out += text.slice(i, start) + SCRUB_MARKER;
    i = end;
    lastEnd = out.length;
  }
  return { text: out + text.slice(i), lastEnd };
}

export function scrubText(text: string, patterns: readonly string[]): string {
  return patterns.length ? replaceAll(text, patterns).text : text;
}

// A streaming scrub. It holds back the last (longest pattern - 1) bytes of
// each chunk, so a value split across two chunks is still found.
export class StreamScrubber {
  private carry = "";
  private readonly keep: number;

  constructor(private readonly patterns: readonly string[]) {
    this.keep = patterns.reduce((max, p) => Math.max(max, p.length), 0) - 1;
  }

  push(chunk: Buffer): Buffer {
    if (this.patterns.length === 0) return chunk;
    const { text, lastEnd } = replaceAll(
      this.carry + chunk.toString("latin1"),
      this.patterns,
    );
    // A match that starts before `safe` ends inside `text`, because every
    // pattern is at most keep + 1 long. Text after a replacement is final.
    const safe = Math.max(lastEnd, text.length - this.keep, 0);
    this.carry = text.slice(safe);
    return Buffer.from(text.slice(0, safe), "latin1");
  }

  end(): Buffer {
    const rest = Buffer.from(this.carry, "latin1");
    this.carry = "";
    return rest;
  }
}
