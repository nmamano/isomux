#!/usr/bin/env bun
// Move the provisioner state a new host needs, and nothing else.
//
//   bun control-plane/state-move.ts export [--data /data] > state.json
//   bun control-plane/state-move.ts import [--data /data] < state.json
//
// The state volume holds private keys that revoke our access to customer
// boxes, and those never leave the volume they were made on. So this is not a
// copy: the export READS the few records a new provisioner needs and writes
// them out freshly serialized, field by field, and the import writes them into
// an empty volume. What the runtime reads under the state root, and what
// happens to it:
//
//   intents/<id>.json   the legacy create latch: CreateLatch vetoes from it and
//                       every store open imports it. MOVES, so a box the old
//                       host latched can never be bought again.
//   audit.jsonl         operator CLI history; nothing reads it. MOVES without
//                       the free-text detail. A line that does not fit is
//                       dropped and counted; the old volume keeps it.
//   runs/<id>.json      read only while a box is being provisioned. Nothing
//                       moves, and a run that is not revoked REFUSES the
//                       export: its key is the only way to finish or revoke it.
//   certificate-dns-intents, in the state root and in the data directory (the
//                       lego hook's default): any entry REFUSES the export, as
//                       it names a challenge record nobody has removed yet.
//   keys/, certificates/ never opened. The new host's lego registers a new ACME
//                       account on first use.
//   .deployment         the new host writes its own on its first start.
//
// SELF-CONTAINED ON PURPOSE: node built-ins only, so the old host's image can
// run this file from stdin (`bun run - export`) without carrying it.
//
// Every path this reads is checked with lstat first, and a symlink or a file
// that is not regular refuses. Nothing more: this runs as root over our own
// stopped volume, and what it guards against is a lost record.

import * as fs from "node:fs";
import * as path from "node:path";

export const FORMAT = "isomux-provisioner-state";
export const VERSION = 1;
export const ROOT_NAME = ".isomux-control-plane";
export const DNS_INTENTS_NAME = "certificate-dns-intents";

const INTENT_STATES = ["intended", "created", "rejected", "ambiguous"] as const;
const AUDIT_OUTCOMES = ["started", "succeeded", "failed", "ambiguous"] as const;

/** The intent journal's own filename rule (intents.ts). */
const INTENT_ID = /^[A-Za-z0-9_-]+$/;
const LABEL = /^[A-Za-z0-9_-]{1,64}$/;
const WORD = /^[a-z][a-z0-9_-]{0,63}$/;
const TARGET = /^[A-Za-z0-9._:@-]{1,128}$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;

export interface MovedIntent {
  intentId: string;
  state: (typeof INTENT_STATES)[number];
  latchedAt: number;
  plan: string;
  region: string;
  providerId?: string;
}

export interface MovedAuditEvent {
  ts: string;
  actor: string;
  action: string;
  target: string;
  outcome: (typeof AUDIT_OUTCOMES)[number];
}

export interface StateExport {
  format: typeof FORMAT;
  version: typeof VERSION;
  exportedAt: string;
  intents: MovedIntent[];
  audit: MovedAuditEvent[];
  /** What stays on the old volume, as counts. */
  left: { revokedRuns: number; auditLinesDropped: number };
}

/** A reason not to move. Its message is for the operator. */
export class Refusal extends Error {}

// ------------------------------------------------------------------ paths

/**
 * lstat a path this reads. Absent is null; a symlink, the wrong kind of entry
 * or an unreadable path refuses.
 */
function entry(p: string, kind: "dir" | "file"): fs.Stats | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Refusal(`${p} cannot be read (${code})`);
  }
  if (st.isSymbolicLink()) throw new Refusal(`${p} is a symlink`);
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) {
    throw new Refusal(
      `${p} is not a ${kind === "dir" ? "directory" : "regular file"}`,
    );
  }
  return st;
}

/** The `.json` files of a directory, each one checked, sorted by name. */
function jsonFiles(
  dir: string,
): { name: string; file: string; st: fs.Stats }[] {
  if (!entry(dir, "dir")) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      return { name, file, st: entry(file, "file") as fs.Stats };
    });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ----------------------------------------------------------------- export

/**
 * A legacy intent as a record that still forbids. The same rule as
 * migrateLegacyIntents: a field that does not fit becomes `unknown` or
 * `ambiguous`, and an unreadable file still latches by its filename.
 */
function intentFrom(intentId: string, raw: string, st: fs.Stats): MovedIntent {
  const fallbackAt = Math.floor(st.mtimeMs);
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    rec = null;
  }
  if (!isRecord(rec)) {
    return {
      intentId,
      state: "ambiguous",
      latchedAt: fallbackAt,
      plan: "unknown",
      region: "unknown",
    };
  }
  const label = (v: unknown) =>
    typeof v === "string" && LABEL.test(v) ? v : "unknown";
  const out: MovedIntent = {
    intentId,
    state: INTENT_STATES.includes(rec.state as MovedIntent["state"])
      ? (rec.state as MovedIntent["state"])
      : "ambiguous",
    latchedAt:
      Number.isSafeInteger(rec.latchedAt) && (rec.latchedAt as number) >= 0
        ? (rec.latchedAt as number)
        : fallbackAt,
    plan: label(rec.plan),
    region: label(rec.region),
  };
  if (typeof rec.providerId === "string" && LABEL.test(rec.providerId)) {
    out.providerId = rec.providerId;
  }
  return out;
}

function auditFrom(line: string): MovedAuditEvent | null {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(rec)) return null;
  const event = {
    ts: rec.ts,
    actor: rec.actor,
    action: rec.action,
    target: rec.target,
    outcome: rec.outcome,
  };
  try {
    return checkAudit(event);
  } catch {
    return null;
  }
}

/**
 * Read what moves from the data directory, or refuse. Every reason to refuse
 * is collected first, so one run tells the operator everything to clear.
 */
export function exportState(data: string, now = new Date()): StateExport {
  if (!entry(data, "dir")) throw new Refusal(`${data} does not exist`);
  const root = path.join(data, ROOT_NAME);
  // An absent root would export nothing, and nothing must never read as "no
  // latch": a wrong --data is the likely cause.
  if (!entry(root, "dir")) {
    throw new Refusal(`there is no state root at ${root}`);
  }
  const reasons: string[] = [];

  let revokedRuns = 0;
  const active: string[] = [];
  for (const { name, file } of jsonFiles(path.join(root, "runs"))) {
    let state: unknown;
    try {
      const rec: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      state = isRecord(rec) ? rec.state : undefined;
    } catch {
      state = undefined;
    }
    if (state === "revoked") revokedRuns++;
    else {
      const label = typeof state === "string" ? state : "unreadable";
      active.push(`${name.slice(0, -".json".length)} (${label})`);
    }
  }
  if (active.length > 0) {
    reasons.push(
      `${active.length} run(s) are not revoked: ${active.join(", ")}. Each ` +
        `holds the only key to its box, and keys do not move. Start the old ` +
        `provisioner, let it finish them (revoke_access marks a run revoked), ` +
        `stop it, and export again.`,
    );
  }

  for (const dir of [
    path.join(root, DNS_INTENTS_NAME),
    path.join(data, DNS_INTENTS_NAME),
  ]) {
    if (!entry(dir, "dir")) continue;
    const pending = fs.readdirSync(dir).length;
    if (pending > 0) {
      reasons.push(
        `${pending} certificate DNS challenge file(s) in ${dir}. Each names a ` +
          `TXT record that may still be in the DNS zone. Start the old ` +
          `provisioner and let its certificate request finish (lego's cleanup ` +
          `removes the record and the file), or delete the TXT record a file ` +
          `names from the zone and then the file, and export again.`,
      );
    }
  }
  if (reasons.length > 0) throw new Refusal(reasons.join("\n"));

  const intents: MovedIntent[] = [];
  for (const { name, file, st } of jsonFiles(path.join(root, "intents"))) {
    const intentId = name.slice(0, -".json".length);
    if (!INTENT_ID.test(intentId)) {
      throw new Refusal(`${file} has an id the intent journal cannot hold`);
    }
    intents.push(intentFrom(intentId, fs.readFileSync(file, "utf8"), st));
  }

  const audit: MovedAuditEvent[] = [];
  let auditLinesDropped = 0;
  const auditFile = path.join(root, "audit.jsonl");
  if (entry(auditFile, "file")) {
    for (const line of fs.readFileSync(auditFile, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const event = auditFrom(line);
      if (event) audit.push(event);
      else auditLinesDropped++;
    }
  }

  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: now.toISOString(),
    intents,
    audit,
    left: { revokedRuns, auditLinesDropped },
  };
}

// ------------------------------------------------------------- validation

function exactKeys(
  v: unknown,
  what: string,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!isRecord(v)) throw new Refusal(`${what} is not an object`);
  for (const key of required) {
    if (!(key in v)) throw new Refusal(`${what} has no ${key}`);
  }
  for (const key of Object.keys(v)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Refusal(`${what} has an unknown field ${key}`);
    }
  }
  return v;
}

function matching(v: unknown, re: RegExp, what: string): string {
  if (typeof v !== "string" || !re.test(v)) {
    throw new Refusal(`${what} is not valid`);
  }
  return v;
}

function checkIntent(v: unknown, i: number): MovedIntent {
  const what = `intent ${i}`;
  const rec = exactKeys(
    v,
    what,
    ["intentId", "state", "latchedAt", "plan", "region"],
    ["providerId"],
  );
  if (!INTENT_STATES.includes(rec.state as MovedIntent["state"])) {
    throw new Refusal(`${what} has an unknown state`);
  }
  if (!Number.isSafeInteger(rec.latchedAt) || (rec.latchedAt as number) < 0) {
    throw new Refusal(`${what} has an invalid latchedAt`);
  }
  const out: MovedIntent = {
    intentId: matching(rec.intentId, INTENT_ID, `${what} intentId`),
    state: rec.state as MovedIntent["state"],
    latchedAt: rec.latchedAt as number,
    plan: matching(rec.plan, LABEL, `${what} plan`),
    region: matching(rec.region, LABEL, `${what} region`),
  };
  if ("providerId" in rec) {
    out.providerId = matching(rec.providerId, LABEL, `${what} providerId`);
  }
  return out;
}

function checkAudit(v: unknown, what = "audit event"): MovedAuditEvent {
  const rec = exactKeys(v, what, [
    "ts",
    "actor",
    "action",
    "target",
    "outcome",
  ]);
  const ts = matching(rec.ts, TIMESTAMP, `${what} ts`);
  if (!Number.isFinite(Date.parse(ts)))
    throw new Refusal(`${what} ts is not valid`);
  if (!AUDIT_OUTCOMES.includes(rec.outcome as MovedAuditEvent["outcome"])) {
    throw new Refusal(`${what} has an unknown outcome`);
  }
  return {
    ts,
    actor: matching(rec.actor, WORD, `${what} actor`),
    action: matching(rec.action, WORD, `${what} action`),
    target: matching(rec.target, TARGET, `${what} target`),
    outcome: rec.outcome as MovedAuditEvent["outcome"],
  };
}

/** The import's reading of an export: exact keys, the export's own grammar. */
export function checkExport(v: unknown): StateExport {
  const doc = exactKeys(v, "the export", [
    "format",
    "version",
    "exportedAt",
    "intents",
    "audit",
    "left",
  ]);
  if (doc.format !== FORMAT || doc.version !== VERSION) {
    throw new Refusal(`the export is not ${FORMAT} version ${VERSION}`);
  }
  if (!Array.isArray(doc.intents) || !Array.isArray(doc.audit)) {
    throw new Refusal("the export's intents and audit are not lists");
  }
  const left = exactKeys(doc.left, "the export's left", [
    "revokedRuns",
    "auditLinesDropped",
  ]);
  for (const key of ["revokedRuns", "auditLinesDropped"]) {
    if (!Number.isSafeInteger(left[key]) || (left[key] as number) < 0) {
      throw new Refusal(`the export's left.${key} is not a count`);
    }
  }
  const intents = doc.intents.map(checkIntent);
  const ids = new Set(intents.map((i) => i.intentId));
  if (ids.size !== intents.length) {
    throw new Refusal("the export names an intent twice");
  }
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: matching(doc.exportedAt, TIMESTAMP, "the export's exportedAt"),
    intents,
    audit: doc.audit.map((e, i) => checkAudit(e, `audit event ${i}`)),
    left: left as StateExport["left"],
  };
}

// ----------------------------------------------------------------- import

function writeDurably(file: string, contents: string): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write an export into an empty state volume, before any provisioner has
 * started on it.
 *
 * The intents are staged in a sibling directory and renamed into place, and
 * the audit log goes through a temp file, so a failed import leaves a name the
 * next attempt refuses on rather than half a journal.
 */
export function importState(
  data: string,
  input: unknown,
): { intents: number; audit: number } {
  const doc = checkExport(input);
  if (!entry(data, "dir")) throw new Refusal(`${data} does not exist`);
  const found = fs.readdirSync(data);
  if (found.length > 0) {
    throw new Refusal(
      `${data} is not an empty state volume: it holds ${found.sort().join(", ")}`,
    );
  }
  const root = path.join(data, ROOT_NAME);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  if (doc.intents.length > 0) {
    const staged = path.join(root, "intents.importing");
    fs.mkdirSync(staged, { mode: 0o700 });
    for (const intent of doc.intents) {
      writeDurably(
        path.join(staged, `${intent.intentId}.json`),
        JSON.stringify(intent, null, 2),
      );
    }
    fsyncDir(staged);
    fs.renameSync(staged, path.join(root, "intents"));
  }
  if (doc.audit.length > 0) {
    const staged = path.join(root, "audit.jsonl.importing");
    writeDurably(
      staged,
      doc.audit.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    fs.renameSync(staged, path.join(root, "audit.jsonl"));
  }
  fsyncDir(root);
  // The root is a new entry in data: until data is synced, a crash can lose
  // the root and every latch under it.
  fsyncDir(data);
  return { intents: doc.intents.length, audit: doc.audit.length };
}

// -------------------------------------------------------------------- CLI

function dataDirOf(args: string[]): string {
  if (args.length === 0) return "/data";
  if (args.length === 2 && args[0] === "--data" && args[1]) return args[1];
  throw new Refusal("usage: state-move.ts export|import [--data <dir>]");
}

async function main(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === "export") {
    const doc = exportState(dataDirOf(rest));
    process.stdout.write(`${JSON.stringify(doc)}\n`);
    console.error(
      `exported ${doc.intents.length} intent(s) and ${doc.audit.length} audit ` +
        `event(s); left on the source: ${doc.left.revokedRuns} revoked run(s), ` +
        `${doc.left.auditLinesDropped} audit line(s) that did not fit`,
    );
  } else if (verb === "import") {
    const data = dataDirOf(rest);
    let input: unknown;
    try {
      input = JSON.parse(await Bun.stdin.text());
    } catch {
      throw new Refusal("stdin is not a JSON document");
    }
    const n = importState(data, input);
    console.error(
      `imported ${n.intents} intent(s) and ${n.audit} audit event(s)`,
    );
  } else {
    throw new Refusal("usage: state-move.ts export|import [--data <dir>]");
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    console.error(`refused: ${err.message}`);
    process.exit(1);
  }
}
