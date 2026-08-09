// Append-only audit log.
//
// The writer takes a CLASSIFIED record and nothing else. There is deliberately
// no field that accepts free text from a provider response, an ssh transcript
// or a command line: raw output is where key material and invite URLs live, so
// the way to keep them out of the log is to give them no path into it rather
// than to filter them on the way past.
//
// What a mint records is that a mint happened, by whom and when - never the
// URL. Same for keys: an action name and an outcome, never the material.

import * as fs from "node:fs";
import * as path from "node:path";

export type AuditOutcome = "started" | "succeeded" | "failed" | "ambiguous";

export interface AuditEvent {
  ts: string;
  actor: string;
  /** Fixed vocabulary, not a message. */
  action: string;
  /** What it acted on: an instance id, a host, a run id. Never a credential. */
  target: string;
  outcome: AuditOutcome;
  /** A short classified reason, e.g. "host key mismatch". Never raw output. */
  detail?: string;
}

export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly actor: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(
    action: string,
    target: string,
    outcome: AuditOutcome,
    detail?: string,
  ): void {
    const event: AuditEvent = {
      ts: this.now().toISOString(),
      actor: this.actor,
      action,
      target,
      outcome,
      ...(detail === undefined ? {} : { detail }),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
}
