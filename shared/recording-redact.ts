// Recording mode's text rules (task 6e08239a): while a member records or
// streams the office, the UI swaps office addresses, other office names,
// emails, phone numbers, IP addresses, secret shapes and the member's own
// words for stand-ins before the text reaches the screen
// (ui/recording-mode.ts). Pure: no DOM, so the server checks the word list
// with the same rules the browser applies.

import { SECRET_PATTERN } from "./secret-shapes.ts";

export interface RecordingWord {
  word: string;
  standIn: string;
}

export interface RecordingRules {
  // This office's own hosts: the host the page was opened on, plus the
  // public origin's host when the client knows it.
  officeHosts: string[];
  // Other offices in elevator panel order; numbered from 2.
  otherOffices: { url: string; name: string | null }[];
  words: RecordingWord[];
}

export interface RedactOptions {
  // Pad or cut each stand-in to the length of its match (terminal rows).
  keepLength?: boolean;
}

// One replaced match: text.slice(from, to) is drawn as standIn.
export interface RedactedSpan {
  from: number;
  to: number;
  standIn: string;
}

export type Redactor = ((text: string, opts?: RedactOptions) => string) & {
  // Where each stand-in goes, for a view that draws over the text instead
  // of changing it (the CodeMirror editor). compileRedactor's has it.
  spans?: (text: string) => RedactedSpan[];
};

export type RecordingWordsProblem =
  | "empty_word"
  | "empty_stand_in"
  | "duplicate_word"
  | "stand_in_is_a_word"
  | "too_many"
  | "too_long";

export const MAX_RECORDING_WORDS = 200;
export const MAX_RECORDING_WORD_CHARS = 120;

// The stand-ins are reserved names (RFC 2606, RFC 5737, RFC 6761), so a
// recording never shows a real address in their place.
const OFFICE_HOST = "office.example.com";
const otherOfficeHost = (n: number) => `office-${n}.example.com`;
const otherOfficeName = (n: number) => `Office ${n}`;
const TAILNET_HOST = "host.example.net";
const EMAIL_STAND_IN = "name@example.com";
const PHONE_STAND_IN = "+1 555 0100";
const IPV4_STAND_IN = "192.0.2.1";
const SECRET_STAND_IN = "••••••••";

// A host label character: a host never starts or ends inside one.
const HOST_EDGE_BEFORE = "(?<![A-Za-z0-9-])";
const HOST_EDGE_AFTER = "(?![A-Za-z0-9-])";
// Letters and digits of the scripts that put spaces between words. A member
// word is matched whole only at an end that is one of these, so a word in a
// script without spaces (Chinese, Japanese) still matches inside a sentence.
const WORD_CHAR = "A-Za-z0-9_\\u00C0-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF";
const isWordChar = (c: string) => new RegExp(`[${WORD_CHAR}]`).test(c);

// Every rule starts only where a run of its characters starts, and every
// repeated part is bounded: the regex runs on the main thread over each text
// node, and a rule that may start anywhere in a long run with no space (a
// JWT, a minified line) scans to its end from every position.
const EMAIL =
  "(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){0,8}\\.[A-Za-z]{2,24}(?![A-Za-z])";
const TAILNET = `(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]{1,63}\\.){1,8}[tT][sS]\\.[nN][eE][tT]${HOST_EDGE_AFTER}`;
// A + and a country code with groups, or the North American forms. The
// digit count is checked on the match (8 to 15, E.164).
const PHONE =
  "(?<![\\w+])\\+\\d{1,3}(?:[ .-]?\\(?\\d{1,4}\\)?){2,5}(?![\\w])" +
  "|(?<![\\w+-])\\(\\d{3}\\) ?\\d{3}-\\d{4}(?![\\w-])" +
  "|(?<![\\w+.-])\\d{3}-\\d{3}-\\d{4}(?![\\w-])";
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = `(?<![\\w.])(?:${OCTET}\\.){3}${OCTET}(?![\\w])(?!\\.\\d)`;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Case-insensitive without the i flag: the secret prefixes are
// case-sensitive, and one regex holds every rule.
function caseless(s: string): string {
  let out = "";
  for (const c of s) {
    const lo = c.toLowerCase();
    const up = c.toUpperCase();
    out +=
      lo !== up && lo.length === 1 && up.length === 1
        ? `[${lo}${up}]`
        : escapeRegex(c);
  }
  return out;
}

// SECRET_PATTERN's "(?i:...)" group as explicit case classes: older
// browsers (Safari before 18) refuse a regex modifier group at compile.
function withoutModifiers(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("(?i:", i)) {
      out += "(?:";
      i += 4;
      let depth = 1;
      let inClass = false;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (c === "\\") {
          out += c + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (inClass) inClass = c !== "]";
        else if (c === "[") inClass = true;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        out += !inClass && /[a-z]/i.test(c) ? caseless(c) : c;
        i++;
      }
      continue;
    }
    if (source[i] === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

const SECRET = withoutModifiers(SECRET_PATTERN.source);

function hostnameOf(hostOrUrl: string): string | null {
  const text = hostOrUrl.trim();
  if (!text) return null;
  try {
    const url = new URL(text.includes("://") ? text : `http://${text}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return host && !host.startsWith("[") ? host : null;
  } catch {
    return null;
  }
}

// A loopback host reveals nothing, and "localhost" is in every agent's
// output: replacing it would garble the scene.
function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

// A host and its subdomains; the subdomain labels stay.
const hostSource = (host: string) =>
  `${HOST_EDGE_BEFORE}${caseless(host)}${HOST_EDGE_AFTER}`;

function wordSource(word: string): string {
  const before = isWordChar(word[0]) ? `(?<![${WORD_CHAR}])` : "";
  const after = isWordChar(word[word.length - 1]) ? `(?![${WORD_CHAR}])` : "";
  return `${before}${caseless(word)}${after}`;
}

interface Rule {
  source: string;
  // The match and its rule's own capture groups; returns the stand-in.
  standIn: (match: string, groups: (string | undefined)[]) => string;
}

const fixed = (standIn: string) => (): string => standIn;

function groupCount(source: string): number {
  return new RegExp(`(?:${source})|`).exec("")!.length - 1;
}

function fit(standIn: string, length: number): string {
  return standIn.length >= length
    ? standIn.slice(0, length)
    : standIn.padEnd(length, " ");
}

export function compileRedactor(rules: RecordingRules): Redactor {
  const list: Rule[] = [];

  list.push({
    source: SECRET,
    // An assignment keeps its label, so the reader sees which key it was.
    standIn: (match, groups) => {
      const value = groups[1];
      return value === undefined
        ? SECRET_STAND_IN
        : match.slice(0, match.length - value.length) + SECRET_STAND_IN;
    },
  });
  list.push({ source: EMAIL, standIn: fixed(EMAIL_STAND_IN) });

  const ownHosts = new Set<string>();
  for (const h of rules.officeHosts) {
    const host = hostnameOf(h);
    if (host && !isLoopback(host)) ownHosts.add(host);
  }
  const hostRules: Rule[] = [...ownHosts].map((host) => ({
    source: hostSource(host),
    standIn: fixed(OFFICE_HOST),
  }));

  const seen = new Set<string>();
  const nameRules: Rule[] = [];
  let n = 1;
  for (const office of rules.otherOffices) {
    const host = hostnameOf(office.url);
    if (!host || ownHosts.has(host) || seen.has(host)) continue;
    seen.add(host);
    n++;
    if (!isLoopback(host))
      hostRules.push({
        source: hostSource(host),
        standIn: fixed(otherOfficeHost(n)),
      });
    const name = office.name?.trim();
    if (name)
      nameRules.push({
        source: wordSource(name),
        standIn: fixed(otherOfficeName(n)),
      });
  }
  // Longest first: a host never loses to its parent domain.
  const byLength = (a: Rule, b: Rule) => b.source.length - a.source.length;
  list.push(...hostRules.sort(byLength));
  list.push({ source: TAILNET, standIn: fixed(TAILNET_HOST) });
  list.push(...nameRules.sort(byLength));
  list.push({
    source: PHONE,
    standIn: (match) => {
      const digits = match.replace(/\D/g, "").length;
      return digits >= 8 && digits <= 15 ? PHONE_STAND_IN : match;
    },
  });
  list.push({
    source: IPV4,
    standIn: (match) =>
      match.startsWith("127.") || match === "0.0.0.0" ? match : IPV4_STAND_IN,
  });

  const words = rules.words
    .map((w) => ({ word: w.word.trim(), standIn: w.standIn }))
    .filter((w) => w.word.length > 0)
    .sort((a, b) => b.word.length - a.word.length);
  for (const w of words)
    list.push({ source: wordSource(w.word), standIn: fixed(w.standIn) });

  // One regex, one pass: a stand-in is written, never scanned again.
  const starts: number[] = [];
  let next = 1;
  const parts = list.map((rule) => {
    starts.push(next);
    next += 1 + groupCount(rule.source);
    return `(${rule.source})`;
  });
  const pattern = new RegExp(parts.join("|"), "g");

  // The stand-in of one match; the match itself when its rule keeps it.
  const standInOf = (match: string, groups: unknown[]): string => {
    for (let k = 0; k < list.length; k++) {
      const at = starts[k] - 1;
      if (groups[at] === undefined) continue;
      const end = (starts[k + 1] ?? next) - 1;
      const inner = groups.slice(at + 1, end) as (string | undefined)[];
      return list[k].standIn(match, inner);
    }
    return match;
  };

  const redact: Redactor = (text, opts) => {
    if (!text) return text;
    return text.replace(pattern, (match: string, ...args: unknown[]) => {
      const standIn = standInOf(match, args);
      if (standIn === match || !opts?.keepLength) return standIn;
      return fit(standIn, match.length);
    });
  };
  redact.spans = (text) => {
    const out: RedactedSpan[] = [];
    if (!text) return out;
    for (const m of text.matchAll(pattern)) {
      const standIn = standInOf(m[0], m.slice(1));
      if (standIn !== m[0])
        out.push({ from: m.index, to: m.index + m[0].length, standIn });
    }
    return out;
  };
  return redact;
}

// The shape of a stored or sent list: an array of {word, standIn} strings.
export function isRecordingWordList(value: unknown): value is RecordingWord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        !!row &&
        typeof row === "object" &&
        typeof (row as RecordingWord).word === "string" &&
        typeof (row as RecordingWord).standIn === "string",
    )
  );
}

export function recordingWordsProblem(
  words: readonly RecordingWord[],
): RecordingWordsProblem | null {
  if (words.length > MAX_RECORDING_WORDS) return "too_many";
  const seen = new Set<string>();
  for (const { word, standIn } of words) {
    if (!word.trim()) return "empty_word";
    if (!standIn.trim()) return "empty_stand_in";
    if (
      word.length > MAX_RECORDING_WORD_CHARS ||
      standIn.length > MAX_RECORDING_WORD_CHARS
    )
      return "too_long";
    const key = word.trim().toLowerCase();
    if (seen.has(key)) return "duplicate_word";
    seen.add(key);
  }
  // A stand-in that holds a word on the list would turn into another
  // stand-in on a second pass (no chains, no cycles).
  const onlyWords = new RegExp(
    words.map((w) => `(?:${wordSource(w.word.trim())})`).join("|"),
  );
  if (words.length > 0 && words.some((w) => onlyWords.test(w.standIn)))
    return "stand_in_is_a_word";
  return null;
}

// The list a member who never saved one gets: the office name, when it has
// one.
export function defaultRecordingWords(
  officeName: string | null,
): RecordingWord[] {
  const word = officeName?.trim();
  if (!word) return [];
  const standIn = word.toLowerCase() === "office 1" ? "Office" : "Office 1";
  return [{ word, standIn }];
}
