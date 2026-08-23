// Does a minted invite reach anything durable? Asked by looking, not by
// reading the code that promises it does not.
//
// R-2026-08-10-1-AMENDED: the plaintext URL lives ONLY in provisioner process
// memory. This drives a real mint through the real ticker against a fake box,
// then searches every durable surface the run touched for the value and for
// anything URL-shaped.
//
// THERE ARE TWO NETS, and they catch different things.
//
//   WHAT IS STORED. Every column of every table in the schema, rendered to
//   text - the whole row, not the columns we thought to query, so a value put
//   somewhere nobody expects is still found.
//
//   WHAT WAS SUBMITTED. Every statement and every argument the store was asked
//   to run, recorded at the seam. This is the HISTORICAL net: a URL written and
//   then deleted, or written inside a transaction that rolled back, leaves no
//   live row at all, and the first net would call that clean. It also does not
//   care whether the value reached the disk - it was handed to the database,
//   which is already the thing the ruling forbids.
//
// Under the previous engine the first net was a scan of the database FILE'S
// BYTES, which reached freed pages and the write-ahead log. Postgres keeps its
// pages inside a server we do not read, so the honest statement of what is
// proven changed with the engine: the value was never SUBMITTED through the one
// handle that can write, and is in no live row. The store's engine is private,
// so there is no second route to the database to leave that claim with a gap.
//
// Both nets have a POSITIVE CONTROL below. A search that finds nothing is only
// evidence if it would have found something.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { boxHandlers } from "./handlers.ts";
import { InviteHold } from "./invite-hold.ts";
import { Reporter, type Sink } from "./report.ts";
import { requestInvite } from "./requests.ts";
import { saveRun, type RunRecord } from "./run-record.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { Store } from "./store.ts";
import {
  openTestStore,
  quoteIdentifier,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import type { Exec, ExecOptions, ExecResult } from "./ssh.ts";
import { Ticker } from "./tick.ts";

/** Distinctive enough that a substring hit anywhere is unambiguous. */
const SECRET = "zzsentinelinvitezz";
const INVITE_URL = `https://cp1.test.isomux.app/i/${SECRET}`;

const temps: string[] = [];

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

class MintExec implements Exec {
  async run(_argv: string[], _opts?: ExecOptions): Promise<ExecResult> {
    return { code: 0, stdout: `${INVITE_URL}\n`, stderr: "" };
  }
}

/**
 * Record every statement the store is asked to run, with its arguments.
 *
 * At the store's own seam rather than at the driver: `sqlAll`/`sqlGet`/`sqlRun`
 * are the only way anything in this codebase reaches the database, so a
 * credential that never appears here never went to Postgres at all.
 */
function observe(store: Store): string[] {
  const submitted: string[] = [];
  for (const name of ["sqlAll", "sqlGet", "sqlRun"] as const) {
    const real = store[name].bind(store) as (
      sql: string,
      args?: unknown[],
    ) => Promise<unknown>;
    (store as unknown as Record<string, unknown>)[name] = (
      sql: string,
      args: unknown[] = [],
    ) => {
      submitted.push(`${sql} ${JSON.stringify(args)}`);
      return real(sql, args);
    };
  }
  return submitted;
}

interface Surfaces {
  store: Store;
  /** Every statement and argument list handed to the store, in order. */
  submitted: string[];
  reporter: Reporter;
  lines: string[];
}

/**
 * Every durable surface, searched for the material and for URL shapes.
 *
 * Returns WHERE it was found, so a failure names the surface rather than saying
 * "somewhere".
 */
async function scan(s: Surfaces): Promise<string[]> {
  const hits: string[] = [];
  const look = (where: string, text: string): void => {
    if (text.includes(SECRET)) hits.push(`${where}: sentinel`);
    if (/https?:\/\/\S*\/(?:i|invite)\//.test(text))
      hits.push(`${where}: url-shaped`);
  };
  // WHAT WAS SUBMITTED: the statements themselves, before any of them could be
  // undone. A rolled-back write is still a submitted credential.
  look("submitted sql", s.submitted.join("\n"));
  // WHAT IS STORED: every table in the schema, whole rows rendered to text, so
  // a column nobody thought to query is covered too.
  for (const { tablename } of await s.store.sqlAll<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = current_schema() " +
      "order by tablename",
  )) {
    const rows = await s.store.sqlAll<{ row: string }>(
      `select t::text as row from ${quoteIdentifier(tablename)} t`,
    );
    look(`table ${tablename}`, rows.map((r) => r.row).join("\n"));
  }
  for (const instance of await s.store.listInstances()) {
    for (const op of await s.store.operationsFor(instance.id)) {
      look(`evidence ${op.kind}`, op.evidence);
    }
  }
  look("audit", JSON.stringify(await s.store.auditEvents()));
  look("transcript", s.reporter.transcript.join("\n"));
  look("output", s.lines.join("\n"));
  return hits;
}

interface Bed extends Surfaces {
  hold: InviteHold;
  ticker: Ticker;
  instanceId: string;
  accountId: string;
  opId: string;
}

async function bed(opts: { deliver?: boolean } = {}): Promise<Bed> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-invite-persist-"));
  temps.push(dir);
  const store = await openTestStore();
  // The observer goes on BEFORE anything runs, so the record covers the whole
  // mint rather than whatever survived it.
  const submitted = observe(store);
  const lines: string[] = [];
  const sink: Sink = { out: (l) => lines.push(l), err: (l) => lines.push(l) };
  const reporter = new Reporter(sink);

  const account = await accountForDevSignIn(store, "persist@example.com");
  const reserved = await reserveOffice(store, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;

  const rec: RunRecord = {
    runId: "run-1",
    state: "reachable",
    host: "cp1.test.isomux.app",
    instanceId: "203474835",
    ipv4: "169.58.97.2",
    loginUser: "root",
    privateKeyPath: path.join(dir, "key"),
    publicKeyPath: path.join(dir, "key.pub"),
    algorithm: "ssh-ed25519",
    blob: "AAAAC3NzaC1lZDI1NTE5AAAAITESTBLOB",
    knownHostsFile: path.join(dir, "run-1.known_hosts"),
  };
  saveRun(dir, rec);
  const instance = (await store.getInstance(instanceId))!;
  await store.casInstance(instance.id, instance.version, { run_id: "run-1" });
  const asset = (await store.assetForInstance(instanceId))!;
  await store.casAsset(asset.id, asset.version, {
    provider_id: "203474835",
    ipv4: "169.58.97.2",
    asset_state: "active",
  });
  // A proven first contact is what makes the window open, which is what lets a
  // mint be requested at all.
  const contact = await store.enqueue({
    id: "op-first_contact-0",
    instance_id: instanceId,
    kind: "first_contact",
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
  });
  const leased = (await store.tryLease(
    contact.id,
    contact.version,
    "h",
    0,
    Date.now(),
  ))!;
  await store.casOperation(
    { id: leased.id, version: leased.version, holder: "h" },
    { status: "succeeded" },
  );

  const hold = new InviteHold();
  const ticker = new Ticker({
    store,
    handlers: boxHandlers({
      exec: new MintExec(),
      reporter,
      runsDir: dir,
      keysDir: dir,
      ...(opts.deliver === false ? {} : { deliver: hold }),
    }),
    report: (l) => lines.push(l),
  });

  const asked = await requestInvite(store, {
    accountId: account.id,
    instanceId,
  });
  if (!asked.ok) throw new Error(asked.reason);
  return {
    store,
    submitted,
    reporter,
    lines,
    hold,
    ticker,
    instanceId,
    accountId: account.id,
    opId: asked.operationId,
  };
}

describe("a dashboard mint leaves no trace", () => {
  test("the URL is in memory, and in nothing that survives the process", async () => {
    const b = await bed();
    await b.ticker.once();

    // It really was minted: a scan of an empty run would pass for free.
    const taken = b.hold.take(b.opId, b.instanceId);
    expect(taken).toEqual({ found: true, url: INVITE_URL });
    expect((await b.store.getOperation(b.opId))!.status).toBe("succeeded");

    expect(await scan(b)).toEqual([]);
  });

  test("and it is gone from memory once collected", async () => {
    const b = await bed();
    await b.ticker.once();
    b.hold.take(b.opId, b.instanceId);
    expect(b.hold.size()).toBe(0);
    expect(b.hold.take(b.opId, b.instanceId).found).toBe(false);
  });

  test("without a delivery channel, nothing is minted to leave a trace of", async () => {
    const b = await bed({ deliver: false });
    await b.ticker.once();
    expect((await b.store.getOperation(b.opId))!.status).toBe("failed");
    expect(b.hold.size()).toBe(0);
    expect(await scan(b)).toEqual([]);
  });
});

describe("the scan would catch a leak", () => {
  test("a URL written to evidence or an audit row is found in both", async () => {
    // THE POSITIVE CONTROL. Without this, the test above is a search whose
    // sensitivity nobody has checked - and a scanner that never matches
    // anything passes every run.
    const b = await bed();
    await b.ticker.once();
    b.hold.take(b.opId, b.instanceId);
    expect(await scan(b)).toEqual([]);

    const op = (await b.store.getOperation(b.opId))!;
    const leased = (await b.store.tryLease(
      op.id,
      op.version,
      "leak",
      0,
      Date.now(),
    ))!;
    await b.store.casOperation(
      { id: leased.id, version: leased.version, holder: "leak" },
      { evidence: { url: INVITE_URL } },
    );
    await b.store.tx(
      async () =>
        await b.store.appendAudit({
          actor: "leak",
          instance_id: b.instanceId,
          action: "mint_invite",
          target: b.opId,
          outcome: "succeeded",
          detail: INVITE_URL,
        }),
    );
    const hits = await scan(b);
    expect(hits).toContain("evidence mint_invite: sentinel");
    expect(hits).toContain("audit: sentinel");
    // Both nets see a committed leak: the row it became, and the statement it
    // arrived on.
    expect(
      hits.some((h) => h.startsWith("table ") && h.endsWith("sentinel")),
    ).toBe(true);
    expect(hits).toContain("submitted sql: sentinel");
  });

  test("and it would catch one that was written and then ROLLED BACK", async () => {
    // The case the row scan cannot see, and the reason there are two nets. A
    // credential handed to the database and then undone was still handed to the
    // database - and the previous engine caught that class only by accident,
    // because a freed page kept the bytes.
    const b = await bed();
    await b.ticker.once();
    b.hold.take(b.opId, b.instanceId);
    const clean = await scan(b);
    expect(clean).toEqual([]);

    // Not awaited, matching every other rejects assertion here: awaiting one
    // trips await-thenable under the bun test types.
    expect(
      b.store.tx(async () => {
        await b.store.appendAudit({
          actor: "leak",
          instance_id: b.instanceId,
          action: "mint_invite",
          target: b.opId,
          outcome: "succeeded",
          detail: INVITE_URL,
        });
        throw new Error("and then the transaction failed");
      }),
    ).rejects.toThrow(/and then the transaction failed/);

    const hits = await scan(b);
    // No live row holds it...
    expect(hits.filter((h) => h.startsWith("table "))).toEqual([]);
    expect(hits).not.toContain("audit: sentinel");
    // ...and it is caught anyway.
    expect(hits).toContain("submitted sql: sentinel");
  });

  test("and it would catch one printed to the operator's output", async () => {
    const b = await bed();
    b.reporter.line(`OWNER INVITE: ${INVITE_URL}`);
    const hits = await scan(b);
    expect(hits).toContain("output: sentinel");
    // The transcript redacts URL shapes, which is slice 1's contract - so the
    // live output is the surface that catches this, and it does.
    expect(hits).not.toContain("transcript: sentinel");
  });
});
