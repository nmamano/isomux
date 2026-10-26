// The pinned OpenCode profile key of each owner and its one-time migration
// (task df0e7b51). The key never moves while an owner is a member; the first
// boot after the update keeps each owner on the profile that holds their
// sessions, and an owner that loses a shared profile gets its agents' last
// sessions as pending moves, which survive a stop between the boot steps.

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "path";

import { STATE_ROOT } from "./config.ts";
import {
  completeProfileKeyMove,
  migrateProfileKeysOnce,
  profileKeyForOwner,
  readProfileKeyState,
  type ProfileKeyMigrationInput,
} from "./opencode-profile-keys.ts";
import { removeStateDir } from "./test-support/temp-state.ts";

afterEach(() => {
  removeStateDir(join(STATE_ROOT, "opencode", "profile-keys.json"));
});

type Owner = ProfileKeyMigrationInput["owners"][number];

const opencode = (agentId: string, lastSessionId: string | null = null) => ({
  agentId,
  agentType: "opencode",
  lastSessionId,
});

// Each owner's legacy key comes from `legacy` (default: a key of its own),
// and only the keys in `existing` have a profile dir.
function input(
  owners: Owner[],
  legacy: Record<string, string> = {},
  existing: string[] = Object.values(legacy),
): ProfileKeyMigrationInput {
  return {
    owners,
    legacyKey: (userId) => legacy[userId ?? ""] ?? `legacy-own-${userId ?? ""}`,
    profileExists: (key) => existing.includes(key),
  };
}

describe("profileKeyForOwner", () => {
  it("gives each owner a key of its own with no state file, and writes nothing", () => {
    const keys = ["u1", "u2", null].map((id) => profileKeyForOwner(id));
    expect(new Set(keys).size).toBe(3);
    expect(profileKeyForOwner("u1")).toBe(keys[0]);
    expect(profileKeyForOwner(undefined)).toBe(keys[2]);
    expect(readProfileKeyState()).toBeNull();
  });
});

describe("migrateProfileKeysOnce", () => {
  it("adopts each owner's existing legacy profile, and a missing one gives the owner's own key", () => {
    const moves = migrateProfileKeysOnce(
      input(
        [
          { userId: "u1", agents: [opencode("a1", "s1")] },
          { userId: "u2", agents: [opencode("a2", "s2")] },
          { userId: null, agents: [] },
        ],
        { u1: "legacy-u1", u2: "legacy-u2", "": "legacy-unowned" },
        ["legacy-u1"],
      ),
    );
    expect(moves).toEqual([]);
    expect(readProfileKeyState()?.pendingMoves).toEqual([]);
    expect(profileKeyForOwner("u1")).toBe("legacy-u1");
    // No profile dir: nothing to keep, so not the legacy key.
    expect(profileKeyForOwner("u2")).not.toBe("legacy-u2");
    expect(profileKeyForOwner(null)).not.toBe("legacy-unowned");
    expect(profileKeyForOwner("u2")).not.toBe(profileKeyForOwner(null));
  });

  it("writes the state on a fresh install, so it never plans again", () => {
    expect(migrateProfileKeysOnce(input([]))).toEqual([]);
    expect(readProfileKeyState()).toEqual({ pins: {}, pendingMoves: [] });
  });

  // MUTANTS: count every agent, or every OpenCode agent with or without a
  // session; the owner with the most sessions in the profile must keep it.
  it("keeps a shared legacy profile for the owner with the most OpenCode sessions in it, and moves the others' last sessions", () => {
    const shared = "legacy-shared";
    const moves = migrateProfileKeysOnce(
      input(
        [
          {
            userId: "u1",
            agents: [
              opencode("a1", "s1"),
              opencode("a1-none"),
              opencode("a1-none-2"),
              {
                agentId: "a1-claude",
                agentType: "claude",
                lastSessionId: "c1",
              },
              { agentId: "a1-codex", agentType: "codex", lastSessionId: "x1" },
            ],
          },
          {
            userId: "u2",
            agents: [
              opencode("a2", "s2"),
              opencode("a2-b", "s2-b"),
              {
                agentId: "a2-claude",
                agentType: "claude",
                lastSessionId: "c2",
              },
            ],
          },
          { userId: null, agents: [opencode("a0", "s0")] },
        ],
        { u1: shared, u2: shared, "": shared },
      ),
    );
    expect(profileKeyForOwner("u2")).toBe(shared);
    const u1 = profileKeyForOwner("u1");
    const unowned = profileKeyForOwner(null);
    expect(new Set([shared, u1, unowned]).size).toBe(3);
    // Only the losers' OpenCode agents with a last session move.
    const expected = [
      {
        agentId: "a1",
        sessionId: "s1",
        fromKey: shared,
        toKey: u1,
        userId: "u1",
      },
      {
        agentId: "a0",
        sessionId: "s0",
        fromKey: shared,
        toKey: unowned,
        userId: null,
      },
    ];
    const byAgent = (a: { agentId: string }, b: { agentId: string }) =>
      a.agentId.localeCompare(b.agentId);
    expect([...moves].sort(byAgent)).toEqual([...expected].sort(byAgent));
    expect(
      [...(readProfileKeyState()?.pendingMoves ?? [])].sort(byAgent),
    ).toEqual([...expected].sort(byAgent));
  });

  // MUTANT: the tie goes to the first owner in the input, unowned included.
  it("breaks a tie for the first member in users order, and unowned agents never win one", () => {
    const shared = "legacy-shared";
    migrateProfileKeysOnce(
      input(
        [
          { userId: null, agents: [opencode("a0", "s0")] },
          { userId: "u1", agents: [opencode("a1", "s1")] },
          { userId: "u2", agents: [opencode("a2", "s2")] },
        ],
        { u1: shared, u2: shared, "": shared },
      ),
    );
    expect(profileKeyForOwner("u1")).toBe(shared);
    expect(profileKeyForOwner("u2")).not.toBe(shared);
    expect(profileKeyForOwner(null)).not.toBe(shared);
  });

  // MUTANT: plan again when the file exists (or adopt lazily in the getter):
  // a member added later, with no file of their own, computes the shared
  // legacy key, and its dir exists.
  it("plans only once: a member added later gets a key of their own, not an existing legacy profile", () => {
    const shared = "legacy-shared";
    const owners: Owner[] = [{ userId: "u1", agents: [opencode("a1", "s1")] }];
    migrateProfileKeysOnce(input(owners, { u1: shared }));
    expect(profileKeyForOwner("u1")).toBe(shared);

    const later = input(
      [...owners, { userId: "u3", agents: [opencode("a3", "s3")] }],
      { u1: shared, u3: shared },
    );
    expect(migrateProfileKeysOnce(later)).toEqual([]);
    expect(profileKeyForOwner("u3")).not.toBe(shared);
    expect(profileKeyForOwner("u1")).toBe(shared);
  });

  // MUTANT: return the moves only from the planning call. A stop after step 1
  // and before step 2 would lose them, because the file then exists.
  it("returns the pending moves again after a stop between the boot steps, until each one ends", () => {
    const shared = "legacy-shared";
    const owners: Owner[] = [
      {
        userId: "u1",
        agents: [opencode("a1", "s1"), opencode("a1-b", "s1-b")],
      },
      { userId: "u2", agents: [opencode("a2", "s2")] },
      { userId: "u3", agents: [opencode("a3", "s3")] },
    ];
    const legacy = { u1: shared, u2: shared, u3: shared };
    const first = migrateProfileKeysOnce(input(owners, legacy));
    expect(first.map((move) => move.agentId).sort()).toEqual(["a2", "a3"]);
    const pinsAfterPlan = readProfileKeyState()?.pins;

    // The next boot: the same moves, from the file.
    expect(migrateProfileKeysOnce(input(owners, legacy))).toEqual(first);

    const ended = first.find((move) => move.agentId === "a2")!;
    completeProfileKeyMove(ended);
    const left = migrateProfileKeysOnce(input(owners, legacy));
    expect(left).toEqual(first.filter((move) => move !== ended));
    expect(readProfileKeyState()?.pins).toEqual(pinsAfterPlan);

    for (const move of left) completeProfileKeyMove(move);
    expect(migrateProfileKeysOnce(input(owners, legacy))).toEqual([]);
    expect(profileKeyForOwner("u2")).not.toBe(shared);
  });
});
