// The restore check: does a copy that arrived whole compare equal, and does a
// copy that did not say where?
//
// The "restored" side is built the way a restore builds it: the same schema
// statements on an empty schema, then every row copied across. The source
// drops a column that sits BEFORE a live one, so the live column's attribute
// number differs between the two sides - the case that broke a raw-attnum
// comparison on a real move.

import { afterEach, describe, expect, test } from "bun:test";
import pg from "pg";
import { writeDatabaseIdentity } from "./bootstrap.ts";
import {
  compareFingerprints,
  fingerprint,
  type Fingerprint,
} from "./restore-check.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { PRODUCT_TABLES } from "./store.ts";
import {
  freshDsn,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

async function exec(dsn: string, statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

/** The attribute number of a live column, as the engine stores it. */
async function attnumOf(
  dsn: string,
  table: string,
  column: string,
): Promise<number> {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    const row = await client.query<{ n: number }>(
      "select attnum::int as n from pg_attribute " +
        "where attrelid = $1::regclass and attname = $2 and not attisdropped",
      [table, column],
    );
    return row.rows[0].n;
  } finally {
    await client.end();
  }
}

/** A source with rows and an attnum gap, and a copy of it made restore-style. */
async function sourceAndCopy(): Promise<{ source: string; copy: string }> {
  const source = await freshDsn();
  const store = await openTestStoreOn(source);
  const account = await accountForDevSignIn(store, "a@example.com");
  const out = await reserveOffice(store, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!out.ok) throw new Error("signup failed");
  await store.close();
  await writeDatabaseIdentity(source, "source-identity-0001");
  await exec(source, [
    "alter table accounts add column scratch integer",
    "alter table accounts add column kept text default 'k'",
    "alter table accounts drop column scratch",
  ]);

  const copy = await freshDsn();
  await (await openTestStoreOn(copy)).close();
  await exec(copy, ["alter table accounts add column kept text default 'k'"]);
  const sourceSchema = new URL(source).searchParams
    .get("options")!
    .match(/search_path=([a-z0-9_]+)/)![1];
  await exec(copy, [
    "begin",
    ...PRODUCT_TABLES.map((t) => `truncate ${t}`),
    ...PRODUCT_TABLES.map(
      (t) => `insert into ${t} select * from "${sourceSchema}".${t}`,
    ),
    "commit",
  ]);
  return { source, copy };
}

describe("the restore check", () => {
  test("a whole copy compares equal, though its live columns are numbered differently", async () => {
    const { source, copy } = await sourceAndCopy();
    expect(await attnumOf(source, "accounts", "kept")).toBe(
      (await attnumOf(copy, "accounts", "kept")) + 1,
    );
    const a = await fingerprint(source);
    expect(a.tables.accounts.rows).toBe(1);
    expect(compareFingerprints(a, await fingerprint(copy))).toEqual([]);
  });

  test("the target's own identity does not count as a difference", async () => {
    const { source, copy } = await sourceAndCopy();
    await writeDatabaseIdentity(copy, "target-identity-0001");
    expect(
      compareFingerprints(await fingerprint(source), await fingerprint(copy)),
    ).toEqual([]);
  });

  test("a changed row, a missing row and a changed column are each named", async () => {
    const { source, copy } = await sourceAndCopy();
    const a = await fingerprint(source);

    await exec(copy, ["update accounts set email = 'b@example.com'"]);
    expect(compareFingerprints(a, await fingerprint(copy))).toEqual([
      "table accounts: content differs",
    ]);

    await exec(copy, ["delete from name_reservations"]);
    expect(compareFingerprints(a, await fingerprint(copy))).toContain(
      "table name_reservations: row count differs",
    );

    await exec(copy, ["alter table instances alter column name drop not null"]);
    expect(compareFingerprints(a, await fingerprint(copy))).toContain(
      "table instances: columns differ",
    );
  });

  test("a table, a sequence or an index on one side only is named", () => {
    const base: Fingerprint = {
      tables: { t: { columns: ["id text"], rows: 0, hash: "h" } },
      sequences: { s: "1 1 1 9 false" },
      constraints: [],
      indexes: ["CREATE INDEX i ON t (id)"],
    };
    expect(
      compareFingerprints(base, {
        tables: {},
        sequences: {},
        constraints: [],
        indexes: [],
      }),
    ).toEqual([
      "table t: only on the source",
      "sequence s: differs",
      "indexes differ",
    ]);
  });
});
