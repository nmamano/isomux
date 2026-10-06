// What a deployed control-plane process proves about its database before it
// starts working.
//
// Two properties, and they are checked in opposite directions from the same
// seam the store already uses:
//
//   BOUNDS. `Store.open` builds the `options` string that carries
//   statement_timeout and idle_in_transaction_session_timeout and reads both
//   back from the engine, refusing to return a store if either is wrong. So a
//   store handle IS the evidence, and this module does not re-derive it.
//
//   IDENTITY. A connection string can name any database, and a restored copy
//   or a rehearsal database answers exactly like the real one. So the database
//   owner writes one row (`schema_meta`, key `database_identity`) and the
//   deployment names the value it expects. A mismatch REFUSES rather than
//   warns: the failure this guards against is a customer's control plane
//   writing into a copy that gets thrown away. The runtime roles may read the
//   row and may not write it, and the proof refuses a session that could: a
//   process able to rewrite its own identity proves nothing with it.
//
// The expected value is optional in code and mandatory in deployment. Unset
// means "no claim was made": a local run and CI are unchanged, and the answer
// is FALSE rather than true, because a check nobody configured has not passed -
// it was not run. The health surface carries that boolean straight through, so
// a deployment missing its expected value is visibly not ok.
//
// NEITHER VALUE IS EVER PRINTED, here or by any caller. The output of this
// module is a boolean.

import type { Store } from "./store.ts";

/** The identity the deployment expects, from the environment. No default. */
export const DATABASE_IDENTITY_ENV = "CONTROL_PLANE_DB_IDENTITY";

/** The `schema_meta` key the database owner writes the identity under. */
export const DATABASE_IDENTITY_KEY = "database_identity";

/** What an identity value may look like: a UUID or a readable name. */
export const DATABASE_IDENTITY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

function refusal(reason: string): Error {
  return new Error(`refusing to start: ${reason}`);
}

/**
 * Prove the store is talking to the database this deployment names.
 *
 * Returns whether an expected identity was configured AND proved. Throws when
 * one was configured and anything is wrong: a malformed expected value, a
 * session role that can write the identity, a missing row or a different one.
 */
export async function proveDatabaseIdentity(
  store: Store,
  expected: string | undefined,
): Promise<boolean> {
  if (!expected) return false;
  if (!DATABASE_IDENTITY_SHAPE.test(expected)) {
    throw refusal("the expected database identity is not a valid identity");
  }
  // Asked first: a row this session could have written says nothing. INSERT
  // and UPDATE can be granted per column, so they are asked of every column
  // as well as the table; DELETE and TRUNCATE exist only per table. Each
  // privilege list is ORed by the engine.
  const writable = await store.sqlGet<{ w: boolean }>(
    "select has_any_column_privilege(current_user, 'schema_meta', " +
      "'INSERT, UPDATE') or has_table_privilege(current_user, 'schema_meta', " +
      "'DELETE, TRUNCATE') as w",
  );
  if (writable?.w !== false) {
    throw refusal(
      "this session's role can write the database identity, so the identity " +
        "proves nothing; a runtime connects as a role that can only read it",
    );
  }
  const row = await store.sqlGet<{ value: string }>(
    "select value from schema_meta where key = $1",
    [DATABASE_IDENTITY_KEY],
  );
  if (row === null) {
    throw refusal(
      "the database carries no identity row, so nothing establishes that it " +
        "is the one this deployment names",
    );
  }
  if (row.value !== expected) {
    throw refusal(
      "the database answering is not the one this deployment names",
    );
  }
  return true;
}
