// The privilege listing restore.sh compares (control-plane/deploy/vps/).
//
// restore.sh reads its `acl` query on the prepared bootstrap, and runs it again
// inside the restore's transaction: a restore commits only when the two agree.
// So the restore notices a lost or an extra privilege only if the query lists
// it. The end-to-end run is vps/local-proof.sh, which needs Docker; these
// checks run the script's own query, evaluated by bash, on the local test
// database, inside a transaction that is rolled back.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import pg from "pg";
import { LOCAL_DATABASE_URL, TEST_DATABASE_URL } from "../testing/pg.ts";
import { assertScratchTarget } from "../testing/target.ts";

const RESTORE = path.join(import.meta.dir, "vps", "restore.sh");

/** The script's `acl` assignment, with bash's own quoting applied. */
function aclQuery(): string {
  const run = Bun.spawnSync([
    "bash",
    "-c",
    'eval "$(sed -n \'/^acl="/,/"$/p\' "$1")"; printf %s "${acl-}"',
    "_",
    RESTORE,
  ]);
  expect(run.exitCode).toBe(0);
  const sql = run.stdout.toString();
  expect(sql.trim()).not.toBe("");
  return sql;
}

const TABLE = `restore_acl_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const OTHER = `${TABLE}_s`;
let client: pg.Client;
let acl: string;

/** The query's lines for the scratch table and its columns. */
async function listed(): Promise<string[]> {
  const { rows } = await client.query<{ out: string }>(
    `select (${acl}) as out`,
  );
  return rows[0].out.split("\n").filter((line) => line.startsWith(TABLE));
}

beforeAll(async () => {
  await assertScratchTarget(TEST_DATABASE_URL, LOCAL_DATABASE_URL);
  acl = aclQuery();
  client = new pg.Client(TEST_DATABASE_URL);
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

describe("restore.sh privilege listing", () => {
  test("lists a column grant, and loses only it when that grant goes", async () => {
    await client.query("begin");
    try {
      await client.query(
        `create table public.${TABLE} (granted int, never int, revoked int)`,
      );
      await client.query(`grant select on public.${TABLE} to public`);
      await client.query(
        `grant update (granted, revoked) on public.${TABLE} to public`,
      );
      const before = await listed();
      const tableLine = before.find((line) => line.startsWith(`${TABLE} `));
      expect(tableLine).toBeDefined();
      expect(
        before.filter((line) => line.startsWith(`${TABLE}(granted)`)),
      ).toHaveLength(1);
      expect(
        before.filter((line) => line.startsWith(`${TABLE}(revoked)`)),
      ).toHaveLength(1);
      expect(before.some((line) => line.startsWith(`${TABLE}(never)`))).toBe(
        false,
      );

      await client.query(
        `revoke update (revoked) on public.${TABLE} from public`,
      );
      const after = await listed();
      // The compare sees the lost column grant ...
      expect(after).not.toEqual(before);
      // ... and nothing else moved: the table's line and the other column's.
      expect(after).toEqual(
        before.filter((line) => !line.startsWith(`${TABLE}(revoked)`)),
      );
      // A column whose grant was revoked has no line, so a bootstrap that
      // once granted it equals a restore that never did.
      expect(after.some((line) => line.startsWith(`${TABLE}(revoked)`))).toBe(
        false,
      );
    } finally {
      await client.query("rollback");
    }
  });

  test("lists only the public schema's tables", async () => {
    await client.query("begin");
    try {
      await client.query(`create schema ${OTHER}`);
      await client.query(`create table ${OTHER}.${TABLE} (c int)`);
      await client.query(`grant select on ${OTHER}.${TABLE} to public`);
      await client.query(`grant update (c) on ${OTHER}.${TABLE} to public`);
      expect(await listed()).toEqual([]);
    } finally {
      await client.query("rollback");
    }
  });
});
