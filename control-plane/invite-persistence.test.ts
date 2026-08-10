// Does a minted invite reach anything durable? Asked by looking, not by
// reading the code that promises it does not.
//
// R-2026-08-10-1-AMENDED: the plaintext URL lives ONLY in provisioner process
// memory. This drives a real mint through the real ticker against a fake box,
// then searches every durable surface the run touched for the value and for
// anything URL-shaped: the DATABASE FILE'S BYTES (not just the rows we think to
// query - a dropped column, a WAL page or an index entry would still be a
// stored credential), every operation's evidence, every audit row, the
// reporter's live output and its redacted transcript.
//
// The scanner has a POSITIVE CONTROL below. A search that finds nothing is only
// evidence if it would have found something, so one test deliberately persists
// the URL and requires the same scan to catch it in every place.

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
import type { Exec, ExecOptions, ExecResult } from "./ssh.ts";
import { Ticker } from "./tick.ts";

/** Distinctive enough that a substring hit anywhere is unambiguous. */
const SECRET = "zzsentinelinvitezz";
const INVITE_URL = `https://cp1.test.isomux.app/i/${SECRET}`;

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class MintExec implements Exec {
  async run(_argv: string[], _opts?: ExecOptions): Promise<ExecResult> {
    return { code: 0, stdout: `${INVITE_URL}\n`, stderr: "" };
  }
}

interface Surfaces {
  dbFile: string;
  store: Store;
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
  // The whole file as bytes, including anything a query would not return.
  look("database file", fs.readFileSync(s.dbFile).toString("latin1"));
  for (const file of fs.readdirSync(path.dirname(s.dbFile))) {
    if (!file.startsWith(path.basename(s.dbFile))) continue;
    if (file === path.basename(s.dbFile)) continue;
    // -wal and -shm: a value can live in the write-ahead log after a commit.
    look(
      `database ${file}`,
      fs
        .readFileSync(path.join(path.dirname(s.dbFile), file))
        .toString("latin1"),
    );
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
  const dbFile = path.join(dir, "cp.db");
  const store = await Store.open(dbFile);
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
    dbFile,
    store,
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
    // A committed value lands in the WRITE-AHEAD LOG before it is checkpointed
    // into the main file, so scanning only cp.db would miss a fresh leak
    // entirely. This is why the sweep covers the sidecars, and the assertion
    // accepts either file rather than pinning which one it landed in.
    expect(
      hits.some((h) => h.startsWith("database") && h.endsWith("sentinel")),
    ).toBe(true);
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
