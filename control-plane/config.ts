// Constants for the slice-1 driver.
//
// Runtime state lives OUTSIDE the repo: generated private keys, run records and
// the audit log never enter the repo tree, not even gitignored.

import * as os from "node:os";
import * as path from "node:path";

export const STATE_ROOT = path.join(os.homedir(), ".isomux-control-plane");
export const RUNS_DIR = path.join(STATE_ROOT, "runs");
export const KEYS_DIR = path.join(STATE_ROOT, "keys");
export const INTENTS_DIR = path.join(STATE_ROOT, "intents");
export const AUDIT_FILE = path.join(STATE_ROOT, "audit.jsonl");

/**
 * A local Postgres for development and for the test suite, as one command.
 *
 * Quoted verbatim by everything that has to tell somebody the database is
 * missing, so the instruction and the thing it starts cannot drift apart.
 */
export const LOCAL_POSTGRES_COMMAND =
  "docker run -d --name isomux-cp-pg " +
  "-e POSTGRES_PASSWORD=isomux -e POSTGRES_USER=isomux " +
  "-e POSTGRES_DB=control_plane_test " +
  "-p 127.0.0.1:5433:5432 postgres:18";

/**
 * Instances, provider assets, operations, attention and audit_events, as a
 * postgres:// connection string.
 *
 * There is NO DEFAULT, deliberately. A file path could be derived from a home
 * directory and be wrong only for this user; a connection string cannot be
 * derived from anything, and a guessed one is how a command writes to a
 * database nobody meant it to touch. The JSONL above stays as a post-commit
 * mirror that survives losing this one.
 */
export function databaseUrl(): string {
  const configured = process.env.CONTROL_PLANE_DB;
  if (configured) return configured;
  throw new Error(
    "CONTROL_PLANE_DB is not set: it is the postgres:// connection string " +
      "for the control plane's database, and there is no default. A local " +
      `one: ${LOCAL_POSTGRES_COMMAND}`,
  );
}

/** Contabo's Ubuntu 24.04 image, as measured on the pilot account. */
export const UBUNTU_2404_IMAGE_ID = "d64d5c6c-9dda-4e38-8174-0ee282474d8a";
export const DEFAULT_PRODUCT = "V153";
export const DEFAULT_REGION = "EU";

/**
 * The account our key is asked to land on.
 *
 * Sent explicitly on every create and reinstall. Contabo documents `defaultUser`
 * as defaulting to "admin" and then produces `ubuntu` when it is omitted -
 * which is not even one of the values the API accepts - so the default is never
 * relied on and the resulting user is carried forward as run evidence.
 */
export const DEFAULT_LOGIN_USER = "root";

/** How long to wait for a rebuilt box to accept SSH. The pilot measured
 * create-to-SSH at 110s on 2026-07-30; a reinstall is quoted at ~5 minutes. */
export const SSH_WAIT_TIMEOUT_MS = 15 * 60_000;
