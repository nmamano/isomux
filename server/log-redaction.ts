import { scrubPatterns, scrubText } from "./secret-proxy/scrub.ts";

// Every current secret value, in raw, URL-encoded and base64 form, whatever
// its shape (secrets design, section 6). The secrets runtime sets them on
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

// Masks one string, as redactLogEntry masks each string value. A bare key keeps its first eight characters. A KEY=value assignment keeps
// the label and the value's first eight characters, so the reader still sees
// which key it was. A secret value goes whole first.
export function redactText(text: string): string {
  return scrubText(text, exactPatterns).replace(
    SECRET_PATTERN,
    (match, _label: string | undefined, assigned: string | undefined) =>
      assigned === undefined
        ? match.slice(0, 8) + "...REDACTED"
        : match.slice(0, match.length - assigned.length) +
          assigned.slice(0, 8) +
          "...REDACTED",
  );
}

/** Copy an entry without changing the producer's payload. Keys are structural;
 * string values (including nested payloads and metadata) are scanned. Agent
 * logs and API-token logs both store entries through this. */
export function redactLogEntry<T extends object>(entry: T): T {
  const seen = new WeakMap<object, object>();
  const pending: { source: object; target: object }[] = [];
  function copy(value: unknown): unknown {
    if (typeof value === "string") return redactText(value);
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

// True when the text holds a key-shaped string that redactLogEntry would mask.
// The secret routes use it to refuse a value pasted into the name field.
export function hasCredentialShape(text: string): boolean {
  return new RegExp(SECRET_PATTERN.source).test(text);
}
