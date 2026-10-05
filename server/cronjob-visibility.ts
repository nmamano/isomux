// Who may see a cronjob, and how much of it. One rule for every surface: the
// REST list/get, the WebSocket state and deltas, the run routes, the live run
// stream and the run files all ask these predicates.
//
//   SEE    - the job exists for this viewer: the maker, an office owner, or a
//            member of the job's room while that room is live.
//   DETAIL - prompt, cwd, engine settings, runs and transcripts: the maker or an
//            office owner. A run uses the maker's environment, so its transcript
//            can show the maker's secrets; room access never widens this.
//   MANAGE - run/edit/delete: DETAIL plus `cron:manage`. Read authority alone
//            never reports canManage.
//
// The maker and office-owner arms are cronjobOwnerOrOfficeOwner's: an office
// owner is a USER-scope owner (a privileged agent or API token of an owner gets
// only its own jobs), and a maker match needs a non-null userId on both sides.
//
// LEAF over types: the full truth table is unit-testable without a server.

import type {
  Cronjob,
  CronjobLastRun,
  CronjobListWire,
} from "../shared/types.ts";
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

export function cronjobDetailFor(
  facts: CronjobVisibilityFacts,
  viewer: CronjobViewer,
): boolean {
  if (!viewer.canRead) return false;
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
  if (cronjobDetailFor(facts, viewer)) return true;
  return (
    viewer.canRead &&
    facts.liveRoomId !== null &&
    viewer.hasRoomAccess(facts.liveRoomId)
  );
}

export function cronjobManageFor(
  facts: CronjobVisibilityFacts,
  viewer: CronjobViewer,
): boolean {
  return viewer.canManage && cronjobDetailFor(facts, viewer);
}

// The record this viewer receives, or null when they may not see the job.
// A room viewer gets the schedule and the last run's outcome only: no prompt,
// cwd, engine settings, run list or transcript excerpt.
export function projectCronjob(
  job: Cronjob,
  facts: CronjobVisibilityFacts,
  viewer: CronjobViewer,
  lastRun: CronjobLastRun | null,
): CronjobListWire | null {
  if (cronjobDetailFor(facts, viewer)) {
    return {
      ...job,
      detail: true,
      canManage: cronjobManageFor(facts, viewer),
    };
  }
  if (!cronjobVisibleTo(facts, viewer)) return null;
  return {
    detail: false,
    canManage: false,
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    enabled: job.enabled,
    agentType: job.agentType,
    ...(job.roomId !== undefined ? { roomId: job.roomId } : {}),
    createdBy: job.createdBy,
    userId: job.userId,
    username: job.username,
    createdAt: job.createdAt,
    lastFireAt: job.lastFireAt,
    nextFireAt: job.nextFireAt,
    lastRun,
  };
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
