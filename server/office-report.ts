// The incident report (task cdd7883d, slice 3): one markdown file the office's
// admin sends to Isomux support when the office is down or under attack. Every
// text from the office passes through the export's redaction with the
// office's own secret values; when those cannot be read, the logs and the
// audit reasons are left out and the file says why.

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICE_DATABASE } from "./audit-store.ts";
import { readLockState } from "./lockdown.ts";
import { redactSecretTextWith } from "./log-redaction.ts";
import {
  collectSecretValues,
  fenced,
  SecretSourceError,
} from "./office-export.ts";
import { scrubPatterns } from "./secret-proxy/scrub.ts";

export interface IncidentReportInput {
  stateRoot: string;
  now: Date;
  /** The lines `rescue status --no-journal` prints. */
  statusLines: string[];
  /** The last journal lines, or null when none could be read. */
  journal: string | null;
  /** The installed release, when known. */
  release: string | null;
  /** The release the last update replaced, when known. */
  previousRelease: string | null;
  /** The updater's last result message, when root passed it. */
  updateResult: string | null;
  /** What the admin tried, in their words (--note). */
  note: string;
}

const AUDIT_ROWS = 20;
const LOCK_OPERATIONS = ["office.lockdown", "office.unlock"];

interface LockRow {
  time: number;
  operation: string;
  actor: string;
  reason: string;
}

/** The report as markdown. */
export function buildIncidentReport(input: IncidentReportInput): string {
  // Without the office's values, only the shape patterns can mask: the texts
  // the office wrote itself (its logs, the audit reasons) stay out.
  let patterns: string[] = [];
  let leftOut: string | null = null;
  try {
    patterns = scrubPatterns(collectSecretValues(input.stateRoot));
  } catch (error) {
    if (!(error instanceof SecretSourceError)) throw error;
    leftOut = error.message;
  }
  const redact = (text: string) => redactSecretTextWith(patterns, text);
  // The status lines carry the lock marker's reason, which the office wrote
  // like the audit reasons: it stays out with them.
  const withoutReasons = (text: string) => {
    if (!leftOut) return text;
    for (const m of readLockState(input.stateRoot).markers)
      if (m.marker?.reason)
        text = text.split(m.marker.reason).join("(left out)");
    return text;
  };

  const out: string[] = [
    "# Isomux incident report",
    "",
    `Written ${input.now.toISOString()} by the rescue command.`,
    `Release: ${input.release ?? "unknown"}. Previous release: ${input.previousRelease ?? "unknown"}.`,
    "Secret values are masked.",
  ];
  if (leftOut)
    out.push(
      "",
      `The logs and the audit reasons are left out: ${leftOut}, so their secret values could not be removed.`,
    );

  out.push("", "## What was tried", "");
  out.push(input.note.trim() ? redact(input.note.trim()) : "Nothing noted.");

  out.push(
    "",
    "## Status",
    "",
    fenced(redact(withoutReasons(input.statusLines.join("\n")))),
  );

  out.push("", "## Updates", "");
  out.push(
    input.updateResult
      ? `Last update: ${redact(input.updateResult)}`
      : "Last update: no record.",
  );

  out.push("", "## Lock history", "");
  const rows = readLockRows(input.stateRoot);
  if (rows === null) out.push("The office's database could not be read.");
  else if (rows.length === 0) out.push("No lock or unlock on record.");
  else
    for (const row of rows) {
      const reason = leftOut || !row.reason ? "" : `: ${redact(row.reason)}`;
      out.push(
        `- ${new Date(row.time).toISOString()} ${row.operation} by ${redact(row.actor)}${reason}`,
      );
    }

  out.push("", "## Logs", "");
  if (leftOut) out.push("Left out (see above).");
  else if (input.journal === null) out.push("No log lines could be read.");
  else out.push(fenced(redact(input.journal.trimEnd())));

  return out.join("\n") + "\n";
}

// The last lock and unlock rows, oldest first; [] without a database, null
// when it cannot be read. A read-only connection sees the WAL and writes
// nothing; when it cannot open (a WAL with no -shm in a folder it cannot
// write), the files are copied to a scratch folder and the copy is read.
function readLockRows(stateRoot: string): LockRow[] | null {
  const source = join(stateRoot, OFFICE_DATABASE);
  if (!existsSync(source)) return [];
  const query = (db: Database) =>
    (
      db
        .query(
          `SELECT time, operation, record FROM audit WHERE operation IN (${LOCK_OPERATIONS.map(() => "?").join(",")}) ORDER BY sequence DESC LIMIT ?`,
        )
        .all(...LOCK_OPERATIONS, AUDIT_ROWS) as {
        time: number;
        operation: string;
        record: string;
      }[]
    )
      .reverse()
      .map((row) => lockRow(row));
  try {
    const db = new Database(source, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout=5000");
      return query(db);
    } finally {
      db.close();
    }
  } catch {
    // Fall through to the copy.
  }
  const scratch = mkdtempSync(join(tmpdir(), "isomux-report-"));
  try {
    const copy = join(scratch, "copy.sqlite");
    copyFileSync(source, copy);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(source + suffix))
        copyFileSync(source + suffix, copy + suffix);
    const db = new Database(copy);
    try {
      return query(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function lockRow(row: {
  time: number;
  operation: string;
  record: string;
}): LockRow {
  let actor = "";
  let reason = "";
  try {
    const record = JSON.parse(row.record) as {
      actor?: { name?: unknown; id?: unknown };
      lockdown?: { reason?: unknown };
    };
    const name = record.actor?.name ?? record.actor?.id;
    if (typeof name === "string") actor = name;
    if (typeof record.lockdown?.reason === "string")
      reason = record.lockdown.reason;
  } catch {
    // A row that does not parse still shows its time and operation.
  }
  return { time: row.time, operation: row.operation, actor, reason };
}
