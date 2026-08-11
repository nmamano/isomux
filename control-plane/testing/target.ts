// Refuse to run a suite, or seed a transcript, against anything but the
// scratch branch.
//
// The suite creates schemas, opens stores and writes rows. Pointed at the
// production branch it would leave `cp_test_%` schemas in a customer database -
// which the design forbids (loop ruling 4: no suite or e2e data on production,
// ever) - so the refusal is MECHANICAL and FAIL CLOSED rather than a comment
// somebody reads after the fact.
//
// The proof does not trust the connection string. A DSN can name any host, so
// the question "which branch is this" is put to the ENGINE, and its answer is
// checked against the Neon API in this process:
//
//   1. the session reports `neon.branch_id` (measured 2026-08-11: present on a
//      real child connection, and equal to the id the API reports);
//   2. the API is asked for the branch the tooling targets, by name;
//   3. the two ids must be equal, and that branch must be a non-default branch
//      WITH a parent.
//
// Absent setting, unreadable setting, an API that cannot answer, or any
// mismatch - all refuse. There is no "assume child" arm, and no environment
// flag that skips it.
//
// A LOCAL database is the other allowed target, and it is allowed by identity
// rather than by exception: the built-in constant is a throwaway container on
// 5433, so CI and a contributor's `bun test` are unchanged and never reach the
// network.

import {
  SUITES_BRANCH,
  branchNamed,
  liveBranchId,
  project,
} from "../exercises/neon-api.ts";

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

const REFUSED =
  "refusing to run against a remote database that has not proved it is the " +
  `\`${SUITES_BRANCH}\` branch. The suite writes rows and creates schemas, and ` +
  "a customer database is not a place to do either";

/**
 * Prove a remote target is the scratch branch, or throw.
 *
 * Called once per process, before the first schema is acquired and before a
 * transcript seeds anything.
 */
export async function assertScratchTarget(
  dsn: string,
  localUrl: string,
): Promise<void> {
  if (sameDatabase(dsn, localUrl)) return;

  const live = await liveBranchId(dsn);
  if (live === null) {
    throw new Error(
      `${REFUSED}: the session does not report neon.branch_id, so nothing ` +
        `about which branch is answering can be established.`,
    );
  }
  let expected;
  try {
    const { id } = await project();
    expected = await branchNamed(id, SUITES_BRANCH);
  } catch (err) {
    // The cause is safe to carry here and only here: these errors come from
    // the API layer, whose messages are a status code and a count by
    // construction. A DRIVER error never reaches this line - `liveBranchId`
    // swallows those rather than returning them.
    throw new Error(
      `${REFUSED}: the Neon API could not confirm it ` +
        `(${err instanceof Error ? err.message : "unknown error"}).`,
      { cause: err },
    );
  }
  if (live !== expected.id) {
    throw new Error(
      `${REFUSED}: the branch answering is not the one named ` +
        `\`${SUITES_BRANCH}\`.`,
    );
  }
  if (expected.isDefault || !expected.hasParent) {
    throw new Error(
      `${REFUSED}: \`${SUITES_BRANCH}\` is the default branch or has no ` +
        `parent, so it is not a child of production.`,
    );
  }
}
