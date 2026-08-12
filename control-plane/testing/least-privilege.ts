// A login role holding EXACTLY one grant matrix, on one test schema.
//
// The deployed provisioner and web tier authenticate as roles that hold rows
// and nothing else, and several properties of this build are only true from
// there: whether a catalog check can still see a table nobody granted, whether
// a decision function can complete without a read the matrix withheld, whether
// a runtime open writes. None of those can be staged from the owner session
// every other test uses - the owner can do everything, so it proves nothing
// about a boundary.
//
// THE MATRIX IS THE ARGUMENT, not a copy of one. Callers pass the real
// `PROVISIONER_GRANTS` (or a deliberately narrowed version of it), so removing
// an entry from `roles.ts` changes what these roles can do and the test that
// depends on it fails. A helper that granted a hand-written list would go on
// passing after the matrix was narrowed, which is the failure this exists to
// catch.
//
// LOCAL ENGINE ONLY. These are cluster-global role names on a shared branch
// otherwise, and creating them there is churn nobody asked for.

import pg from "pg";
import type { TableGrant } from "../roles.ts";
import { LOCAL_DATABASE_URL, quoteIdentifier } from "./pg.ts";

/** The container's own owner, which is what creates and drops the roles. */
const admin = new pg.Pool({
  connectionString: LOCAL_DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5_000,
});
admin.on("error", () => {});

/** Everything this process created, so teardown needs no bookkeeping from the
 * caller beyond one call. */
const roles: { role: string; schema: string }[] = [];

/** Which schema a test DSN resolves names in. */
export function schemaOf(dsn: string): string {
  const options = new URL(dsn).searchParams.get("options") ?? "";
  const match = options.match(/search_path=([a-z0-9_]+)/);
  if (!match) throw new Error("the test DSN carries no search_path");
  return match[1];
}

/**
 * A DSN for a login role that holds exactly `grants` on `dsn`'s schema.
 *
 * USAGE on the schema and the per-table verbs, and nothing else: no CREATE, no
 * privilege on any table the matrix does not name, and no membership. The
 * password is generated here and travels only in the string returned.
 */
export async function leastPrivilegedDsn(args: {
  dsn: string;
  grants: readonly TableGrant[];
}): Promise<string> {
  const schema = schemaOf(args.dsn);
  const role = `cp_lp_${Math.random().toString(36).slice(2, 10)}`;
  const password = crypto.randomUUID().replace(/-/g, "");
  await admin.query(`create role ${role} login password '${password}'`);
  roles.push({ role, schema });
  await admin.query(
    `grant usage on schema ${quoteIdentifier(schema)} to ${role}`,
  );
  for (const grant of args.grants) {
    // The verbs are a closed union in `roles.ts` and the table names are
    // literals there; the identifier is quoted anyway, because a test helper
    // that builds SQL loosely is a bad example wherever it is copied to.
    const verbs = grant.verbs.join(", ");
    await admin.query(
      `grant ${verbs} on ${quoteIdentifier(schema)}.${quoteIdentifier(grant.table)} to ${role}`,
    );
  }
  const url = new URL(args.dsn);
  url.username = role;
  url.password = password;
  return url.toString();
}

/**
 * Drop every role this process made.
 *
 * Revokes first: a role that still holds a grant refuses to drop with SQLSTATE
 * 2BP01, and `drop owned by` needs a membership the container's owner does not
 * always have. Learned on a live branch, and the same order every other
 * role-creating suite here uses.
 */
export async function dropLeastPrivilegedRoles(): Promise<void> {
  for (const { role, schema } of roles.splice(0)) {
    const quoted = quoteIdentifier(schema);
    await admin
      .query(
        `revoke all privileges on all tables in schema ${quoted} from ${role}`,
      )
      .catch(() => {});
    await admin
      .query(`revoke all privileges on schema ${quoted} from ${role}`)
      .catch(() => {});
    await admin.query(`drop role if exists ${role}`).catch(() => {});
  }
}

// The admin pool is deliberately never closed, exactly as `testing/pg.ts`'s is:
// `bun test` shares one process across files, so a pool ended in one file's
// afterAll is a pool the next file finds dead.
