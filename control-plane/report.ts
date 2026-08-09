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

export class Reporter {
  /** A redacted copy of the run, safe to paste anywhere. */
  readonly transcript: string[] = [];

  constructor(private readonly sink: Sink = consoleSink) {}

  line(text: string): void {
    this.sink.out(redactKeyMaterial(text));
    this.transcript.push(redactForTranscript(text));
  }

  problem(text: string): void {
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
    this.sink.out(`OWNER INVITE: ${url}`);
    this.transcript.push(`OWNER INVITE: ${INVITE_REDACTION}`);
  }
}
