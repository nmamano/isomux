// The pull's production wiring for the MOVE-locked server (task 78733adf,
// slice 2a): the scope of this office, the manifest jobs, the batch source
// and the two audit rows. server/isomux-office.ts calls it at a MOVE boot.

import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createAuditStore,
  OFFICE_DATABASE,
  openOfficeDatabase,
} from "./audit-store.ts";
import {
  readUnitsRecord,
  type MoveLockedOfficeOpts,
} from "./move-locked-office.ts";
import {
  createMoveManifestJobs,
  type MovePullDeps,
} from "./office-move-pull.ts";
import { readMoveState } from "./office-move.ts";
import { MOVE_AUDIT_ACTOR } from "./office-move-routes.ts";
import type { MoveOutsideFolder } from "../shared/office-move.ts";
import type { MemberHomeSource, MoveMember } from "./office-move-members.ts";
import { createMoveScope, MOVE_SCRATCH_DIR } from "./office-move-scope.ts";
import { createSecretStore } from "./secret-store.ts";
import { snapshotOfficeDatabase } from "./sqlite-snapshot.ts";

/** The pull of this office: its scope, the manifest jobs and the batch
 *  source. The MOVE-locked server serves it, and (slice 4) the running
 *  office while paired. Manifests and snapshots of an earlier process are
 *  stale, so the scratch folder starts empty: the new office starts its
 *  pull again. */
export function createMovePull(input: {
  stateRoot: string;
  home: string;
  codeDir: string | null;
  backupDir: string | null;
  /** Slice 5b: the folders outside the home that move. Absent: the list the
   *  lock recorded in the move state (the MOVE-locked server loads no
   *  records). */
  outside?(): MoveOutsideFolder[];
  /** Slice 5c-1: the members whose homes move, and their runners' streams.
   *  Absent: the members the lock recorded in the move state. */
  members?(): MoveMember[];
  memberSource?: MemberHomeSource;
  now(): Date;
}): MovePullDeps {
  const scope = createMoveScope(input);
  const scratch = join(input.stateRoot, MOVE_SCRATCH_DIR);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  return {
    manifests: createMoveManifestJobs({
      scope,
      dir: scratch,
      units: () => readUnitsRecord(input.stateRoot),
      secretCount: () => countSecrets(input.stateRoot),
      outside: () =>
        input.outside
          ? input.outside()
          : lockedOutside(input.stateRoot, input.now()),
      members: () =>
        input.members
          ? input.members()
          : lockedMembers(input.stateRoot, input.now()),
      ...(input.memberSource ? { memberSource: input.memberSource } : {}),
      now: () => input.now(),
    }),
    batch: { scope, scratchDir: scratch, snapshot: moveSnapshot },
    ...(input.memberSource ? { memberSource: input.memberSource } : {}),
  };
}

export function movePullForBoot(input: {
  stateRoot: string;
  home: string;
  codeDir: string;
  backupDir: string;
  memberSource?: MemberHomeSource;
  now(): Date;
}): Required<Pick<MoveLockedOfficeOpts, "pull" | "audit">> {
  return {
    pull: createMovePull(input),
    // No audit store is open in the MOVE-locked server: open it for the
    // write only.
    audit: ({ operation }) => {
      const db = openOfficeDatabase(join(input.stateRoot, OFFICE_DATABASE));
      try {
        createAuditStore(db).append({
          actor: MOVE_AUDIT_ACTOR,
          operation,
          targets: ["office"],
          fields: [],
        });
      } finally {
        db.close();
      }
    },
  };
}

/** Slice 5b: the folders the lock recorded in the move state (none in any
 *  other state, or in a state of an earlier release). The walk reads each
 *  one's mode itself. */
function lockedOutside(stateRoot: string, now: Date): MoveOutsideFolder[] {
  const current = readMoveState(stateRoot, now).current;
  if (!current || (current.state !== "move" && current.state !== "moved"))
    return [];
  return (current.outside ?? []).map((path) => ({ path, mode: 0 }));
}

/** Slice 5c-1: the members the lock recorded in the move state (none in
 *  any other state, or in a state of an earlier release). */
function lockedMembers(stateRoot: string, now: Date): MoveMember[] {
  const current = readMoveState(stateRoot, now).current;
  if (!current || (current.state !== "move" && current.state !== "moved"))
    return [];
  return current.members ?? [];
}

/** The time limit of a member database's snapshot: 60 s, plus 1 s per
 *  10 MB, so a big database moves on a slow disk too. A snapshot that still
 *  runs out gets an error record, which the new office lists. */
export function moveSnapshotTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / (10 * 1024 * 1024)) * 1000;
}

function moveSnapshot(src: string, dst: string): Promise<void> {
  let bytes = statSync(src).size;
  try {
    bytes += statSync(`${src}-wal`).size;
  } catch {
    // No WAL file.
  }
  return snapshotOfficeDatabase(src, dst, moveSnapshotTimeoutMs(bytes));
}

/** How many secrets the office holds (names only, no value is read out),
 *  for the new office's after-move report. A scope that does not read
 *  counts as none. */
function countSecrets(stateRoot: string): number {
  const store = createSecretStore(stateRoot);
  let n = 0;
  for (const scope of store.scopes()) {
    try {
      n += store.list(scope).length;
    } catch {
      // An unreadable file: its secrets cannot be counted.
    }
  }
  return n;
}
