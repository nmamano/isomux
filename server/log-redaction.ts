import { scrubPatterns, scrubSpans, scrubText } from "./secret-proxy/scrub.ts";

// Every current secret value, in raw, URL-encoded and base64 form, whatever
// its shape, except a public address (secrets design, section 6). The secrets runtime sets them on
// every change. Values shorter than MIN_SCRUB_LENGTH are left out, as in the
// proxy's scrub: a short pattern would rewrite ordinary log text. That is
// safe because agents never get a value; a value reaches a log only if a
// host reflects it in a form the scrub misses.
let exactPatterns: string[] = [];

export function setSecretValuesForRedaction(values: readonly string[]): void {
  exactPatterns = scrubPatterns(values);
}

// Generic assignment names ignore case; provider prefixes remain case-sensitive.
// A single pass means one match cannot
// consume the replacement of another overlapping match.
const SECRET_PATTERN =
  /sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-api03-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|m0-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|AKIA[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9+/=]{20,}|(?i:(api[_-]?key|secret|token|password)\s*[=:]\s*['"]?)([A-Za-z0-9_\-+/.=]{16,})/g;

/** Copy an entry without changing the producer's payload. Keys are structural;
 * string values (including nested payloads and metadata) are scanned. Agent
 * logs and API-token logs both store entries through this. */
export function redactLogEntry<T extends object>(entry: T): T {
  const seen = new WeakMap<object, object>();
  const pending: { source: object; target: object }[] = [];
  function copy(value: unknown): unknown {
    if (typeof value === "string") return redactSecretText(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    const target = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, target);
    pending.push({ source: value, target });
    return target;
  }
  const result = copy(entry) as T;
  // An explicit stack handles deeply nested payloads without call-stack limits.
  while (pending.length > 0) {
    const { source, target } = pending.pop()!;
    for (const [key, child] of Object.entries(source)) {
      Object.defineProperty(target, key, {
        value: copy(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return result;
}

/** The string redaction redactLogEntry applies to each string value: stored
 * secret values become ISOMUX-REDACTED, secret-shaped strings keep their first
 * eight characters. */
export function redactSecretText(text: string): string {
  return maskSecretShapes(scrubText(text, exactPatterns));
}

// A bare key keeps its first eight characters. A KEY=value assignment keeps
// the label and the value's first eight characters, so the reader still sees
// which key it was. A secret value goes whole first (scrubText).
function maskSecretShapes(text: string): string {
  return text.replace(
    SECRET_PATTERN,
    (match, _label: string | undefined, assigned: string | undefined) =>
      assigned === undefined
        ? match.slice(0, 8) + "...REDACTED"
        : match.slice(0, match.length - assigned.length) +
          assigned.slice(0, 8) +
          "...REDACTED",
  );
}

// A tail longer than this is cut anyway, so one endless line of key
// characters cannot grow the held text without bound.
const MAX_HELD = 4096;
// [A-Za-z0-9_\-+/.=], by char code: the scan back runs on every output chunk.
const KEY_CHAR = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-+/.=")
  KEY_CHAR[ch.charCodeAt(0)] = 1;
// An assignment label, and what may follow it before the value starts.
const LABEL_AT_END =
  /(?:api[_-]?key|secret|token|password)\s*(?:[=:]\s*['"]?)?$/i;

// Where the end of `text` that could still grow into a SECRET_PATTERN match
// starts: a trailing run of key characters, with an assignment label before
// it. A scan back, not one regex anchored at the end, which would retry the
// run from every position in it.
function shapeTailStart(text: string): number {
  const floor = Math.max(0, text.length - MAX_HELD);
  let start = text.length;
  while (start > floor && KEY_CHAR[text.charCodeAt(start - 1)] === 1) start--;
  const window = text.slice(Math.max(floor, start - 64), start);
  const label = LABEL_AT_END.exec(window);
  return label ? start - window.length + label.index : start;
}

// Moves `cut` back to the start of any span that crosses it. Spans are
// sorted and disjoint. A shape match that ends at the end of the text still
// crosses: it ends in a key character, so the held trailing run starts
// inside it.
function cutOutside(cut: number, spans: readonly [number, number][]): number {
  for (let i = spans.length - 1; i >= 0; i--) {
    const [start, end] = spans[i];
    if (start < cut && end > cut) cut = start;
  }
  return cut;
}

// The length of the longest end of `text` that is a proper start of a pattern.
function patternStartAtEnd(text: string, patterns: readonly string[]): number {
  let longest = 0;
  for (const pattern of patterns) {
    const max = Math.min(pattern.length - 1, text.length);
    for (let k = max; k > longest; k--) {
      if (text.endsWith(pattern.slice(0, k))) {
        longest = k;
        break;
      }
    }
  }
  return longest;
}

// The characters that continue a SECRET_PATTERN match, by the alternative
// that matched; null for the fixed-length ones.
function continuation(match: RegExpExecArray): RegExp | null {
  if (match[2] !== undefined) return /[A-Za-z0-9_\-+/.=]/;
  const text = match[0];
  if (/^(?:sk-proj-|sk-ant-api03-|m0-)/.test(text)) return /[A-Za-z0-9_-]/;
  if (text.startsWith("whsec_")) return /[A-Za-z0-9+/=]/;
  if (/^(?:sk-|(?:sk|rk)_(?:live|test)_)/.test(text)) return /[A-Za-z0-9]/;
  return null;
}

/** redactSecretText over a stream of text chunks. push() holds back a tail
 * that could be the start of a match and returns the rest redacted, so a
 * secret split across two chunks is still found; end() returns the held tail,
 * redacted. */
export interface RedactingTextStream {
  push(chunk: string): string;
  end(): string;
}

export function createRedactingTextStream(): RedactingTextStream {
  // Two stages, as in redactSecretText: the stored values, then the shapes.
  // Each stage writes only text no later chunk can change.
  let valueHeld = "";
  let shapeHeld = "";
  // Set while the rest of a masked match that passed MAX_HELD is dropped:
  // the mask keeps only the match's head, so its tail changes nothing.
  let dropping: RegExp | null = null;
  function values(chunk: string, final: boolean): string {
    const text = valueHeld + chunk;
    const patterns = exactPatterns;
    let cut = final
      ? text.length
      : text.length - patternStartAtEnd(text, patterns);
    if (!final) cut = cutOutside(cut, scrubSpans(text, patterns));
    valueHeld = text.slice(cut);
    return scrubText(text.slice(0, cut), patterns);
  }
  function shapes(chunk: string, final: boolean): string {
    let text = shapeHeld + chunk;
    shapeHeld = "";
    if (dropping) {
      let i = 0;
      while (i < text.length && dropping.test(text[i])) i++;
      if (i === text.length) return "";
      dropping = null;
      text = text.slice(i);
    }
    if (final) return maskSecretShapes(text);
    const matches = [...text.matchAll(SECRET_PATTERN)];
    const last = matches.at(-1);
    if (last && last.index + last[0].length === text.length) {
      const grows = continuation(last);
      if (grows && last[0].length > MAX_HELD) {
        // The mask of this match is final: write it, drop what follows.
        dropping = grows;
        return maskSecretShapes(text);
      }
    }
    const spans = matches.map((m): [number, number] => [
      m.index,
      m.index + m[0].length,
    ]);
    const cut = cutOutside(shapeTailStart(text), spans);
    shapeHeld = text.slice(cut);
    return maskSecretShapes(text.slice(0, cut));
  }
  return {
    push: (chunk) => shapes(values(chunk, false), false),
    end: () => shapes(values("", true), true),
  };
}

// True when the text holds a key-shaped string that redactLogEntry would mask.
// The secret routes use it to refuse a value pasted into the name field.
export function hasCredentialShape(text: string): boolean {
  return new RegExp(SECRET_PATTERN.source).test(text);
}
