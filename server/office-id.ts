// The office id: 12 random hex characters in <state root>/office-id, made on
// the first boot and read on every boot after. It gives each office its own
// session cookie names (server/auth.ts), because browsers scope cookies by
// host, not by port, so two offices on one host would otherwise share them.
//
// The id is NOT a secret: every page on the host sees it in the cookie name.
// Never use it to authenticate anything.
//
// A restore from backup keeps the id, so the restored office keeps its
// browsers' cookies. An office started from a copy of another office's state
// root shares that office's id, like a restore.

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";

export const OFFICE_ID_PATTERN = /^[0-9a-f]{12}$/;

export function officeIdFile(stateRoot: string = STATE_ROOT): string {
  return join(stateRoot, "office-id");
}

export interface OfficeId {
  id: string;
  // Set when a present file held no valid id: where its bytes went, and why.
  replaced?: { asidePath: string; problem: string };
}

// Read the id, or make it when the file does not exist.
//
// Throws (a boot error) when the write fails or the file cannot be read for
// any reason other than its absence: an id kept only in memory would change at
// every restart and sign out every browser each time.
//
// A file that exists but holds no valid id (empty, wrong length, not hex) is
// renamed aside, never overwritten, and a new id replaces it. Browsers that
// still carry the shared cookie names move to the new id through the
// migration in server/auth.ts.
export function readOrCreateOfficeId(
  path: string = officeIdFile(),
  now: number = Date.now(),
): OfficeId {
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let replaced: OfficeId["replaced"];
  if (text !== null) {
    const saved = text.trim();
    if (OFFICE_ID_PATTERN.test(saved)) return { id: saved };
    const asidePath = `${path}.invalid-${now}`;
    renameSync(path, asidePath);
    replaced = {
      asidePath,
      problem: saved === "" ? "empty" : "not 12 lowercase hex characters",
    };
  }
  const id = randomBytes(6).toString("hex");
  atomicWriteFileSync(path, id, 0o600);
  return replaced ? { id, replaced } : { id };
}
