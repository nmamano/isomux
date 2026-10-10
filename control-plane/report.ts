// What the operator sees, and what may be written down afterwards.
//
// These are deliberately not the same thing. The invite is a live credential:
// the operator watching the run needs it, and a transcript pasted into a task,
// a report or a chat must not carry it. So every line goes to the live sink as
// written and to a TRANSCRIPT copy with credential-shaped values replaced.
//
// The audit log is stricter still and does not go through here at all: it takes
// classified records only (see audit.ts), so raw output has no path into it.

export interface Sink {
  out(line: string): void;
  err(line: string): void;
}

export const consoleSink: Sink = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export const INVITE_REDACTION = "<invite url redacted>";
export const KEY_REDACTION = "<private key material redacted>";

/**
 * Strip private key material. Applied to EVERY line, live output included:
 * there is no version of this run where the operator needs to look at a private
 * key, so it is never printed at all rather than merely never recorded.
 */
export function redactKeyMaterial(text: string): string {
  return text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    KEY_REDACTION,
  );
}

/**
 * Make text safe to write down. Strips key material and, additionally, invite
 * URLs - the one credential that IS shown live, because the operator cannot
 * complete the handoff without it, and so must be kept out of anything durable.
 *
 * Both patterns are shapes rather than known values, because the point is to
 * catch material we did not expect to be holding.
 */
export function redactForTranscript(text: string): string {
  return redactKeyMaterial(text).replace(
    /https?:\/\/\S*\/(?:i|invite)\/\S+/g,
    INVITE_REDACTION,
  );
}

export const SECRET_REDACTION = "<redacted>";

/**
 * Replace every credential-shaped value in text from a tool we do not control,
 * before it reaches a log. Shapes, not known values: key material, an HTTP
 * credential, URL credentials, a value labelled as a secret, and opaque
 * strings (mixed-case runs and long hex). Hostnames, UUIDs and ACME URLs
 * survive.
 */
export function redactCredentialShapes(text: string): string {
  return redactKeyMaterial(text)
    .replace(/:\/\/[^/\s@]+@/g, `://${SECRET_REDACTION}@`)
    .replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, `$1 ${SECRET_REDACTION}`)
    .replace(
      // A quoted value goes whole, through its closing quote, or to the end
      // of the text when the quote never closes. A backslash escapes the next
      // character, so an escaped quote does not close the value.
      /\b([\w-]*(?:token|secret|passw(?:or)?d|key|authorization|credential)[\w-]*)(["']?\s*[:=]\s*)("(?:[^"\\]|\\[\s\S]?)*"?|'(?:[^'\\]|\\[\s\S]?)*'?|[^\s"',;&]+)/gi,
      `$1$2${SECRET_REDACTION}`,
    )
    .replace(/[A-Za-z0-9_+=-]{20,}/g, (run) =>
      /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run)
        ? SECRET_REDACTION
        : run,
    )
    .replace(/\b[0-9a-fA-F]{32,}\b/g, SECRET_REDACTION);
}

/** Replace every occurrence of each known secret value in text, however
 * short. Matches are found in the original text and overlapping or touching
 * ones are merged first, so no part of a longer value survives a shorter one. */
export function redactValues(text: string, values: readonly string[]): string {
  const spans: [number, number][] = [];
  for (const value of new Set(values)) {
    if (value.length === 0) continue;
    for (
      let at = text.indexOf(value);
      at !== -1;
      at = text.indexOf(value, at + 1)
    )
      spans.push([at, at + value.length]);
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let done = 0;
  let [start, end] = spans[0];
  for (const [from, to] of spans.slice(1)) {
    if (from <= end) {
      end = Math.max(end, to);
      continue;
    }
    out += text.slice(done, start) + SECRET_REDACTION;
    done = end;
    [start, end] = [from, to];
  }
  return out + text.slice(done, start) + SECRET_REDACTION + text.slice(end);
}

/** The values of environment variables whose names say they hold a credential. */
export function credentialValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name]) =>
      /TOKEN|SECRET|PASSWORD|KEY|DSN|DATABASE|_DB(?:_|$)|CREDENTIAL/i.test(
        name,
      ),
    )
    .map(([, value]) => value ?? "");
}

/** Durable process logs never carry the interactive owner's invite. */
export function redactLogText(
  text: string,
  secrets: readonly string[] = credentialValues(process.env),
): string {
  return redactCredentialShapes(
    redactForTranscript(redactValues(text, secrets)),
  );
}

export class Reporter {
  /** A redacted copy of the run, safe to paste anywhere. */
  readonly transcript: string[] = [];

  constructor(
    private readonly sink: Sink = consoleSink,
    private readonly durable = false,
  ) {}

  line(text: string): void {
    if (this.durable) text = redactLogText(text);
    this.sink.out(redactKeyMaterial(text));
    this.transcript.push(redactForTranscript(text));
  }

  problem(text: string): void {
    if (this.durable) text = redactLogText(text);
    this.sink.err(redactKeyMaterial(text));
    this.transcript.push(redactForTranscript(text));
  }

  step(name: string, detail?: string): void {
    this.line(detail ? `--- ${name}: ${detail}` : `--- ${name}`);
  }

  /**
   * The one place an invite URL is emitted. It is never persisted, never
   * audited and never kept in the transcript - the installer's own copy on the
   * box is a stale credential the moment a new one is minted.
   */
  invite(url: string): void {
    if (this.durable) url = INVITE_REDACTION;
    this.sink.out(`OWNER INVITE: ${url}`);
    this.transcript.push(`OWNER INVITE: ${INVITE_REDACTION}`);
  }
}
