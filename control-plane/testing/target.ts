// Refuse to run a suite, or seed a transcript, against anything but the local
// test database.
//
// The suite creates schemas, opens stores and writes rows. Pointed at the
// production database it would leave `cp_test_%` schemas in a customer
// database - which the design forbids (loop ruling 4: no suite or e2e data on
// production, ever) - so the refusal is MECHANICAL and FAIL CLOSED rather than
// a comment somebody reads after the fact.
//
// The local database is the one allowed target: the built-in constant is a
// throwaway Postgres on 5433, so CI and a contributor's `bun test` never reach
// the network. A remote scratch branch used to be the other target, proved by
// the engine's own branch id; that managed database is retired, so every other
// connection string refuses. There is no environment flag that skips it.

/** Same database, ignoring whatever options a caller appended. */
export function sameDatabase(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return (
      x.protocol === y.protocol &&
      x.hostname === y.hostname &&
      x.port === y.port &&
      x.pathname === y.pathname &&
      x.username === y.username
    );
  } catch {
    return false;
  }
}

/**
 * Accept the local test database, or throw.
 *
 * Called once per process, before the first schema is acquired and before a
 * transcript seeds anything. Async so callers keep one awaited proof.
 */
export async function assertScratchTarget(
  dsn: string,
  localUrl: string,
): Promise<void> {
  if (sameDatabase(dsn, localUrl)) return;
  throw new Error(
    "refusing to run against a database other than the local test database. " +
      "The suite writes rows and creates schemas, and a customer database is " +
      "not a place to do either. Unset CONTROL_PLANE_DB to use the local one.",
  );
}
