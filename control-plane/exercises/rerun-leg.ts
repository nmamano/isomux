#!/usr/bin/env bun
// Drive ONE operation against a real box, on a throwaway database.
//
// The reviewer's P0 findings changed what a failed revocation and a crashed
// installer do to attention and to the deadline flags, so both legs have to be
// re-run live. Doing it from here rather than from the CLI keeps the exercise
// reproducible - a fresh database every time, no state carried in from an
// earlier run that could explain a result away - and it is the same shape the
// ambiguous-create exercise already uses.
//
// Usage (credentials only needed for kinds that reconcile):
//   bun control-plane/exercises/rerun-leg.ts <runId> <kind> [--db <path>]
//
// It prints the operation row after every tick and keeps ticking until the
// operation is terminal, or until interrupted.
//
// `--db` reuses an existing database instead of making a new one, which is what
// the crash-recovery leg needs: the whole claim being tested is that a restarted
// provisioner recovers from the PERSISTED ROWS, so a fresh database per process
// would let the box arbitrate alone and prove much less.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KEYS_DIR, RUNS_DIR } from "../config.ts";
import { boxHandlers } from "../handlers.ts";
import { deadlinesFor, type OperationKind } from "../operations.ts";
import { Reporter } from "../report.ts";
import { loadRun } from "../run-record.ts";
import { SpawnExec } from "../ssh.ts";
import { Store } from "../store.ts";
import { POLL_INTERVAL_MS, Ticker } from "../tick.ts";

const [runId, kind, ...rest] = process.argv.slice(2);
if (!runId || !kind) {
  console.error("usage: rerun-leg.ts <runId> <kind> [--forever]");
  process.exit(2);
}
deadlinesFor(kind); // refuses a kind this slice does not drive

const rec = loadRun(RUNS_DIR, runId);
if (!rec) throw new Error(`no run record ${runId}`);

const reporter = new Reporter();
const dbFlag = rest.indexOf("--db");
const dbPath =
  dbFlag >= 0 && rest[dbFlag + 1]
    ? rest[dbFlag + 1]
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cp-rerun-")), "cp.db");
const store = await Store.open(dbPath);
reporter.line(`store: ${dbPath}`);

const instanceId = `inst-${runId}`;
if (!(await store.getInstance(instanceId))) {
  await store.createInstance({
    id: instanceId,
    run_id: runId,
    name: rec.host,
    plan: "V153",
    region: "EU",
    service_state: "provisioning",
    goal: "handed_off",
    // The ceiling the box already carries, taken from the run record rather than
    // invented here: the key option and the timer are the truth, and this row
    // must agree with them rather than compete.
    access_window_expires_at: rec.expiry ? expiryToMs(rec.expiry) : null,
  });
}

const ticker = new Ticker({
  store,
  handlers: boxHandlers({
    exec: new SpawnExec(),
    reporter,
    runsDir: RUNS_DIR,
    keysDir: KEYS_DIR,
  }),
  report: (line) => reporter.line(line),
});
// A restart ADOPTS the operation the dead process left behind rather than
// opening a second one - the partial unique index would refuse it anyway.
const existing = await store.activeOperation(instanceId, kind);
const op =
  existing ?? (await ticker.enqueue(instanceId, kind as OperationKind));
reporter.line(
  `${existing ? "adopted" : "enqueued"} ${op.id} (${kind}) for ${runId} on ${rec.ipv4}`,
);

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});

for (;;) {
  await ticker.once();
  const row = await store.getOperation(op.id);
  const inst = await store.getInstance(instanceId);
  reporter.line(
    `${new Date().toISOString()} ${row?.status} attempt=${row?.attempt} ` +
      `flags=${row?.inactivity_flagged}/${row?.absolute_flagged} ` +
      `attention=${inst?.attention_state} evidence=${row?.evidence}`,
  );
  for (const r of await store.openReasons(instanceId)) {
    reporter.line(`  OPEN [${r.reason_class}/${r.severity}] ${r.reason}`);
  }
  if (stopping) break;
  if (row && (row.status === "succeeded" || row.status === "failed")) break;
  await Bun.sleep(POLL_INTERVAL_MS);
}

reporter.line("--- audit events ---");
for (const e of await store.auditEvents()) {
  reporter.line(
    `  ${e.action} ${e.outcome}${e.detail ? ` (${e.detail})` : ""}`,
  );
}

/** `YYYYMMDDHHMMSSZ` back to ms. */
function expiryToMs(expiry: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(expiry);
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}
