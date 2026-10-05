// Who may see a cronjob, and who may manage it. One rule for every surface:
// the REST list/get, the WebSocket state and deltas, the run routes, the live
// run stream and the run files all ask these predicates.
//
//   SEE    - the whole job (prompt, cwd, engine settings, runs, transcripts,
//            run files, system prompt): the maker, an office owner, or a
//            member of the job's room while that room is live.
//   MANAGE - run/edit/delete: the maker or an office owner, plus
//            `cron:manage`. Read authority alone never reports canManage.
//
// The maker and office-owner arms are cronjobOwnerOrOfficeOwner's: an office
// owner is a USER-scope owner (a privileged agent or API token of an owner gets
// only its own jobs), and a maker match needs a non-null userId on both sides.
//
// LEAF over types: the full truth table is unit-testable without a server.

import type { Cronjob, CronjobListWire } from "../shared/types.ts";
import { identityHasCapability, type Identity } from "./identity/index.ts";

export interface CronjobVisibilityFacts {
  makerUserId: string | null;
  // The job's roomId when it names a live ordinary room, else null. A job with
  // no room, or whose room was closed, is maker + owners only.
  liveRoomId: string | null;
}

export interface CronjobViewer {
  userId: string | null;
  // USER-scope office owner (the officeOwner guard's rule).
  isOfficeOwner: boolean;
  // Participates as a cronjob reader: a USER, or an agent/API token holding
  // cron:read. A cron run or a narrow agent never does.
  canRead: boolean;
  // Participates as a cronjob manager: a USER, or an agent/API token holding
  // cron:manage.
  canManage: boolean;
  hasRoomAccess(roomId: string): boolean;
}

function makerOrOfficeOwner(
  facts: CronjobVisibilityFacts,
  viewer: CronjobViewer,
): boolean {
  if (viewer.isOfficeOwner) return true;
  return (
    viewer.userId !== null &&
    facts.makerUserId !== null &&
    facts.makerUserId === viewer.userId
  );
}

export function cronjobVisibleTo(
  facts: CronjobVisibilityFacts,
  viewer: CronjobViewer,
): boolean {
  if (!viewer.canRead) return false;
  if (makerOrOfficeOwner(facts, viewer)) return true;
  return facts.liveRoomId !== null && viewer.hasRoomAccess(facts.liveRoomId);
}

export function cronjobManageFor(
  facts: CronjobVisibilityFacts,
  viewer: CronjobViewer,
): boolean {
  return (
    viewer.canRead && viewer.canManage && makerOrOfficeOwner(facts, viewer)
  );
}

// The record this viewer receives, or null when they may not see the job.
export function projectCronjob(
  job: Cronjob,
  facts: CronjobVisibilityFacts,
  viewer: CronjobViewer,
): CronjobListWire | null {
  if (!cronjobVisibleTo(facts, viewer)) return null;
  return { ...job, canManage: cronjobManageFor(facts, viewer) };
}

// The viewer an authenticated identity resolves to. Only the office-owner arm
// needs live state beyond the identity, and it stays USER-scope by rule.
export function cronjobViewerForIdentity(
  identity: Identity,
  hasRoomAccess: (roomId: string) => boolean,
): CronjobViewer {
  const isUser = identity.scope === "user";
  const operator = identity.scope === "agent" || identity.scope === "api";
  return {
    userId: identity.userId,
    isOfficeOwner: isUser && identity.role === "owner",
    canRead:
      isUser || (operator && identityHasCapability(identity, "cron:read")),
    canManage:
      isUser || (operator && identityHasCapability(identity, "cron:manage")),
    hasRoomAccess,
  };
}
