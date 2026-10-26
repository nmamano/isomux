// The OpenCode profile key of each owner (a member, or "" for agents with no
// member), pinned once so it never moves while they are a member (task
// df0e7b51). An owner with no pin gets member:<userId>, or unowned.
//
// The first boot after the update adopts each owner's current profile: the
// legacy key, which hashed the env files that existed. Where several owners
// shared one legacy profile, one keeps it and the others get new profiles;
// their agents' last sessions are pending moves, kept in the same file so a
// stop between the two boot steps loses none.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";

// Server state, never agent space: an agent that could write it could point
// its owner at another member's profile.
const PROFILE_KEYS_FILE = join(STATE_ROOT, "opencode", "profile-keys.json");

export interface ProfileKeyMove {
  agentId: string;
  sessionId: string;
  // The legacy key whose profile holds the session.
  fromKey: string;
  // The owner's pinned key.
  toKey: string;
  userId: string | null;
}

export interface ProfileKeyState {
  // Owner ("" = unowned) -> environment key.
  pins: Record<string, string>;
  pendingMoves: ProfileKeyMove[];
}

export interface ProfileKeyMigrationInput {
  owners: Array<{
    userId: string | null;
    agents: Array<{
      agentId: string;
      agentType: string;
      lastSessionId: string | null;
    }>;
  }>;
  legacyKey: (userId: string | null) => string;
  profileExists: (key: string) => boolean;
}

// The state file, or null when it is absent.
export function readProfileKeyState(): ProfileKeyState | null {
  if (!existsSync(PROFILE_KEYS_FILE)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PROFILE_KEYS_FILE, "utf8"));
  } catch (error) {
    throw new Error(
      `${PROFILE_KEYS_FILE} could not be read: fix or restore it, then restart isomux.`,
      { cause: error },
    );
  }
  const state = raw as Partial<ProfileKeyState> | null;
  return {
    pins: state?.pins && typeof state.pins === "object" ? state.pins : {},
    pendingMoves: Array.isArray(state?.pendingMoves) ? state.pendingMoves : [],
  };
}

function writeProfileKeyState(state: ProfileKeyState): void {
  atomicWriteFileSync(
    PROFILE_KEYS_FILE,
    `${JSON.stringify(state, null, 2)}\n`,
    0o600,
  );
}

function ownerSlot(userId: string | null | undefined): string {
  return userId ?? "";
}

// The key of an owner with no pin.
function ownKey(userId: string | null | undefined): string {
  return userId ? `member:${userId}` : "unowned";
}

// The owner's pinned key, else member:<userId> (unowned for no member).
// Reads only; never writes.
export function profileKeyForOwner(userId: string | null | undefined): string {
  return readProfileKeyState()?.pins[ownerSlot(userId)] ?? ownKey(userId);
}

// The keep rule, with no I/O. An owner whose legacy profile exists keeps it.
// Where several owners shared one, the owner with the most OpenCode agents
// that have a last session keeps it (they all are in that profile); a tie goes
// to the first member, and unowned agents never win one. The others get their
// own key, and their agents' last sessions are pending moves.
export function planProfileKeyMigration(
  input: ProfileKeyMigrationInput,
): ProfileKeyState {
  const groups = new Map<string, ProfileKeyMigrationInput["owners"]>();
  for (const owner of input.owners) {
    const legacy = input.legacyKey(owner.userId);
    if (!input.profileExists(legacy)) continue;
    groups.set(legacy, [...(groups.get(legacy) ?? []), owner]);
  }
  const sessions = (owner: ProfileKeyMigrationInput["owners"][number]) =>
    owner.agents.filter(
      (agent) => agent.agentType === "opencode" && agent.lastSessionId,
    );
  const pins: Record<string, string> = {};
  const pendingMoves: ProfileKeyMove[] = [];
  for (const [legacy, owners] of groups) {
    let keeper = owners[0];
    for (const owner of owners.slice(1)) {
      const lead = sessions(owner).length - sessions(keeper).length;
      if (lead > 0 || (lead === 0 && keeper.userId === null)) keeper = owner;
    }
    pins[ownerSlot(keeper.userId)] = legacy;
    for (const owner of owners) {
      if (owner === keeper) continue;
      for (const agent of sessions(owner))
        pendingMoves.push({
          agentId: agent.agentId,
          sessionId: agent.lastSessionId!,
          fromKey: legacy,
          toKey: ownKey(owner.userId),
          userId: owner.userId,
        });
    }
  }
  return { pins, pendingMoves };
}

// Boot step 1. When the file is absent, plans, writes pins and pending moves
// in one atomic write. Returns the pending moves in the file either way.
export function migrateProfileKeysOnce(
  input: ProfileKeyMigrationInput,
): ProfileKeyMove[] {
  const existing = readProfileKeyState();
  if (existing) return existing.pendingMoves;
  const planned = planProfileKeyMigration(input);
  writeProfileKeyState(planned);
  return planned.pendingMoves;
}

// Removes one ended move (moved, source not v2, or failed) from the file.
export function completeProfileKeyMove(move: ProfileKeyMove): void {
  const state = readProfileKeyState();
  if (!state) return;
  writeProfileKeyState({
    pins: state.pins,
    pendingMoves: state.pendingMoves.filter(
      (pending) =>
        pending.agentId !== move.agentId ||
        pending.sessionId !== move.sessionId ||
        pending.fromKey !== move.fromKey ||
        pending.toKey !== move.toKey,
    ),
  });
}
