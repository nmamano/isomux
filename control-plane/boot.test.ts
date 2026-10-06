// The boot proof: which database a deployed control plane is talking to.
//
// The proof is a row the database owner writes and the runtime roles can only
// read, so every case that matters runs as a role holding EXACTLY one of the
// real grant matrices from roles.ts. The owner session every other test uses
// can write the row, which is itself one of the refusals below.
//
// LOCAL ENGINE ONLY: it creates login roles.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DATABASE_IDENTITY_ENV,
  DATABASE_IDENTITY_KEY,
  proveDatabaseIdentity,
} from "./boot.ts";
import pg from "pg";
import { writeDatabaseIdentity } from "./bootstrap.ts";
import { IntentJournal } from "./intents.ts";
import { HEALTH_PATH } from "./mint-seam.ts";
import { PROVISIONER_GRANTS, WEB_GRANTS, type TableGrant } from "./roles.ts";
import { Store } from "./store.ts";
import {
  TARGET_IS_LOCAL,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";
import {
  dropLeastPrivilegedRoles,
  leastPrivilegedDsn,
  schemaOf,
} from "./testing/least-privilege.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

const IDENTITY = "hosted-identity-0001";
/** The seam refuses a credential shorter than 32 characters. */
const SEAM_TOKEN = "boot-test-token-boot-test-token-boot-test";
const OTHER_IDENTITY = "hosted-identity-0002";

const runtimeStores: Store[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const store of runtimeStores.splice(0)) {
    await store.close().catch(() => {});
  }
  await releaseTestStores();
  while (temps.length)
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
}, PG_TEST_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await dropLeastPrivilegedRoles();
}, PG_TEST_HOOK_TIMEOUT_MS);

/** The refusal's message, or a sentence saying there was not one. */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => "IT DID NOT REFUSE",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

/** A bootstrapped schema, its owner DSN, and a runtime role's DSN on it. */
async function bed(
  grants: readonly TableGrant[],
): Promise<{ ownerDsn: string; roleDsn: string }> {
  const ownerDsn = await testDsn();
  await (await openTestStoreOn(ownerDsn)).close();
  return {
    ownerDsn,
    roleDsn: await leastPrivilegedDsn({ dsn: ownerDsn, grants }),
  };
}

/** A store opened the way a deployed runtime opens one. */
async function runtimeStore(dsn: string): Promise<Store> {
  const store = await Store.openRuntime(dsn);
  runtimeStores.push(store);
  return store;
}

/** Run statements as the owner, on the owner DSN's schema. */
async function asOwner(ownerDsn: string, statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: ownerDsn });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

async function identityRow(ownerDsn: string): Promise<string | null> {
  const store = await openTestStoreOn(ownerDsn);
  const row = await store.sqlGet<{ value: string }>(
    "select value from schema_meta where key = $1",
    [DATABASE_IDENTITY_KEY],
  );
  return row?.value ?? null;
}

suite("the database identity proof", () => {
  test("no expected identity means no claim, and no claim is not proved", async () => {
    const { roleDsn } = await bed(PROVISIONER_GRANTS);
    const store = await runtimeStore(roleDsn);
    expect(await proveDatabaseIdentity(store, undefined)).toBe(false);
    expect(await proveDatabaseIdentity(store, "")).toBe(false);
  });

  test("a malformed expected identity REFUSES", async () => {
    const { ownerDsn, roleDsn } = await bed(PROVISIONER_GRANTS);
    await writeDatabaseIdentity(ownerDsn, IDENTITY);
    const store = await runtimeStore(roleDsn);
    for (const bad of ["short", "has a space in it", "-leading-dash-x"]) {
      expect(await refusalOf(proveDatabaseIdentity(store, bad))).toContain(
        "refusing to start",
      );
    }
  });

  test("a session that can write the identity REFUSES, even when the row matches", async () => {
    const ownerDsn = await testDsn();
    const owner = await openTestStoreOn(ownerDsn);
    await writeDatabaseIdentity(ownerDsn, IDENTITY);
    const failure = await refusalOf(proveDatabaseIdentity(owner, IDENTITY));
    expect(failure).toContain("refusing to start");
    expect(failure).toContain("can write");
  });

  for (const [tier, grants] of [
    ["provisioner", PROVISIONER_GRANTS],
    ["web", WEB_GRANTS],
  ] as const) {
    describe(`as the ${tier} role`, () => {
      test("the identity the deployment names is proved", async () => {
        const { ownerDsn, roleDsn } = await bed(grants);
        await writeDatabaseIdentity(ownerDsn, IDENTITY);
        const store = await runtimeStore(roleDsn);
        expect(await proveDatabaseIdentity(store, IDENTITY)).toBe(true);
      });

      test("a database with no identity row REFUSES", async () => {
        const { roleDsn } = await bed(grants);
        const store = await runtimeStore(roleDsn);
        const failure = await refusalOf(proveDatabaseIdentity(store, IDENTITY));
        expect(failure).toContain("refusing to start");
        expect(failure).toContain("no identity row");
      });

      test("a database carrying a different identity REFUSES", async () => {
        const { ownerDsn, roleDsn } = await bed(grants);
        await writeDatabaseIdentity(ownerDsn, OTHER_IDENTITY);
        const store = await runtimeStore(roleDsn);
        const failure = await refusalOf(proveDatabaseIdentity(store, IDENTITY));
        expect(failure).toContain("refusing to start");
        expect(failure).toContain("not the one this deployment names");
      });

      test("the role cannot write the identity row, by any route", async () => {
        const { ownerDsn, roleDsn } = await bed(grants);
        await writeDatabaseIdentity(ownerDsn, IDENTITY);
        const store = await runtimeStore(roleDsn);
        const attempts: [string, unknown[]][] = [
          [
            "update schema_meta set value = $2 where key = $1",
            [DATABASE_IDENTITY_KEY, OTHER_IDENTITY],
          ],
          ["delete from schema_meta where key = $1", [DATABASE_IDENTITY_KEY]],
          [
            "insert into schema_meta (key, value) values ($1, $2)",
            ["database_identity_shadow", OTHER_IDENTITY],
          ],
          ["truncate schema_meta", []],
        ];
        for (const [statement, args] of attempts) {
          const code = await store.sqlRun(statement, args as never).then(
            () => "WRITTEN",
            (err: { code?: string }) => err.code,
          );
          expect([statement, code]).toEqual([statement, "42501"]);
        }
        // The owner's own writer, handed the role's string, refuses too.
        expect(
          await refusalOf(writeDatabaseIdentity(roleDsn, OTHER_IDENTITY)),
        ).toContain("only the database owner");
        expect(await identityRow(ownerDsn)).toBe(IDENTITY);
      });
    });
  }

  // A write can be granted on a column without being granted on the table,
  // and the owner's writer must not take a grant for ownership. Each case
  // first shows the grant is in the shape it claims, then that it refuses.
  const writeGrants: [string, string, string][] = [
    [
      "UPDATE on the value column alone",
      "grant update (value) on schema_meta to ROLE",
      "select not has_table_privilege(current_user, 'schema_meta', 'UPDATE') " +
        "and has_column_privilege(current_user, 'schema_meta', 'value', 'UPDATE') as ok",
    ],
    [
      "INSERT on the columns alone",
      "grant insert (key, value) on schema_meta to ROLE",
      "select not has_table_privilege(current_user, 'schema_meta', 'INSERT') " +
        "and has_column_privilege(current_user, 'schema_meta', 'key', 'INSERT') as ok",
    ],
    [
      "table INSERT and UPDATE",
      "grant insert, update on schema_meta to ROLE",
      "select has_table_privilege(current_user, 'schema_meta', 'INSERT, UPDATE') as ok",
    ],
  ];
  for (const [label, grant, shape] of writeGrants) {
    test(`a runtime role holding ${label} REFUSES, and the writer refuses it`, async () => {
      const { ownerDsn, roleDsn } = await bed(PROVISIONER_GRANTS);
      await writeDatabaseIdentity(ownerDsn, IDENTITY);
      const role = new URL(roleDsn).username;
      expect(schemaOf(roleDsn)).toBe(schemaOf(ownerDsn));
      await asOwner(ownerDsn, [grant.replace("ROLE", role)]);
      const store = await runtimeStore(roleDsn);
      expect(await store.sqlGet<{ ok: boolean }>(shape)).toEqual({ ok: true });

      const failure = await refusalOf(proveDatabaseIdentity(store, IDENTITY));
      expect(failure).toContain("refusing to start");
      expect(failure).toContain("can write");
      expect(
        await refusalOf(writeDatabaseIdentity(roleDsn, OTHER_IDENTITY)),
      ).toContain("only the database owner");
      expect(await identityRow(ownerDsn)).toBe(IDENTITY);
    });
  }

  test("the refusal names neither identity nor any connection detail", async () => {
    const { ownerDsn, roleDsn } = await bed(PROVISIONER_GRANTS);
    await writeDatabaseIdentity(ownerDsn, OTHER_IDENTITY);
    const store = await runtimeStore(roleDsn);
    const message = await refusalOf(proveDatabaseIdentity(store, IDENTITY));
    expect(message).toContain("refusing to start");
    for (const detail of [IDENTITY, OTHER_IDENTITY, "isomux", "5433"]) {
      expect(message).not.toContain(detail);
    }
  });
});

suite("the owner's identity writer", () => {
  test("writes, leaves an equal value alone, and replaces a different one", async () => {
    const ownerDsn = await testDsn();
    await (await openTestStoreOn(ownerDsn)).close();
    expect(await writeDatabaseIdentity(ownerDsn, IDENTITY)).toBe("written");
    expect(await writeDatabaseIdentity(ownerDsn, IDENTITY)).toBe("unchanged");
    // A restored copy carries its source's row; the target gets its own.
    expect(await writeDatabaseIdentity(ownerDsn, OTHER_IDENTITY)).toBe(
      "replaced",
    );
    expect(await identityRow(ownerDsn)).toBe(OTHER_IDENTITY);
  });

  test("refuses a malformed value before it connects", async () => {
    const failure = await refusalOf(
      writeDatabaseIdentity("postgres://nobody@127.0.0.1:1/none", "bad value"),
    );
    expect(failure).toContain("not a valid identity");
  });
});

/** A loopback port nothing is listening on, at the moment of asking. */
function freePort(): number {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = probe.port;
  void probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

/**
 * The provisioner's own `run`, as a child, against a runtime role: the
 * environment a deployment supplies, with loopback stand-ins for everything
 * that is not the database.
 */
function startRun(
  roleDsn: string,
  identity: string,
  port: number,
  home: string,
) {
  return Bun.spawn(["bun", path.join(import.meta.dir, "cli.ts"), "run"], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      NODE_ENV: "test",
      CONTROL_PLANE_DB: roleDsn,
      [DATABASE_IDENTITY_ENV]: identity,
      CONTROL_PLANE_MINT_TOKEN: SEAM_TOKEN,
      CONTROL_PLANE_MINT_PORT: String(port),
      STRIPE_TEST_SECRET_KEY: "sk_test_boot",
      STRIPE_WEBHOOK_SECRET: "whsec_boot",
      ISOMUX_ACME_EMAIL: "ops@example.com",
      ISOMUX_CF_TOKEN: "cf-boot",
      ISOMUX_CERT_TARGET: "test",
      ISOMUX_ACME_DIRECTORY: "http://127.0.0.1:9/directory",
      ISOMUX_CF_API: "http://127.0.0.1:9",
      ISOMUX_CF_ZONE_ID: "zone-boot",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const LEGACY_INTENT = "legacy-boot-1";

/** A home whose legacy intent journal holds one valid record, which `run`
 * imports into create_intents on its first write. */
function homeWithLegacyIntent(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-boot-"));
  temps.push(home);
  new IntentJournal(
    path.join(home, ".isomux-control-plane", "intents"),
  ).reserve(LEGACY_INTENT, { plan: "V153", region: "EU" });
  return home;
}

async function importedIntents(ownerDsn: string): Promise<number> {
  const store = await openTestStoreOn(ownerDsn);
  const row = await store.sqlGet<{ n: number }>(
    "select count(*)::int as n from create_intents where intent_id = $1",
    [LEGACY_INTENT],
  );
  return row?.n ?? -1;
}

async function health(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      headers: { authorization: `Bearer ${SEAM_TOKEN}` },
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

suite("the provisioner's run, booted against a real runtime role", () => {
  test("boots healthy on the database it names", async () => {
    const { ownerDsn, roleDsn } = await bed(PROVISIONER_GRANTS);
    await writeDatabaseIdentity(ownerDsn, IDENTITY);
    const port = freePort();
    const child = startRun(roleDsn, IDENTITY, port, homeWithLegacyIntent());
    let report: Record<string, unknown> | null = null;
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        report = await health(port);
        if (report?.ok === true || child.exitCode !== null) break;
        await Bun.sleep(250);
      }
    } finally {
      // SIGKILL: a SIGTERM lets the loop finish its idle sleep first, and
      // this child holds nothing worth a graceful stop.
      child.kill("SIGKILL");
      await child.exited;
    }
    // The child's own account goes into the failure, not a bare null.
    const stderr = await new Response(child.stderr).text();
    expect({ report, stderr: report?.ok === true ? "" : stderr }).toMatchObject(
      {
        report: {
          ok: true,
          database_identity: true,
          bounds_governed: true,
          database_reachable: true,
          tick_recent: true,
        },
        stderr: "",
      },
    );
    // The legacy record is valid: a proved boot imports it.
    expect(await importedIntents(ownerDsn)).toBe(1);
  }, 30_000);

  test("refuses to start on a database that names another identity", async () => {
    const { ownerDsn, roleDsn } = await bed(PROVISIONER_GRANTS);
    await writeDatabaseIdentity(ownerDsn, OTHER_IDENTITY);
    const child = startRun(
      roleDsn,
      IDENTITY,
      freePort(),
      homeWithLegacyIntent(),
    );
    const code = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(code).not.toBe(0);
    expect(stderr).toContain("refusing to start");
    expect(stderr).not.toContain(IDENTITY);
    // The refusal comes before the first write: nothing was imported.
    expect(await importedIntents(ownerDsn)).toBe(0);
  }, 30_000);
});
