// Per-user records persisted to ~/.isomux/users.json.
// Keyed by lowercase(name); display case is whatever the client sent.

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import type { UserRecord, NotifRoomsSetting } from "../shared/types.ts";
import { lowercaseKey } from "../shared/identity.ts";
import { atomicWriteFileSync } from "./persistence.ts";

const USERS_FILE = join(homedir(), ".isomux", "users.json");

let users: Record<string, UserRecord> = {};
let loaded = false;

function load(): Record<string, UserRecord> {
  if (loaded) return users;
  loaded = true;
  try {
    if (!existsSync(USERS_FILE)) {
      users = {};
      return users;
    }
    const parsed = JSON.parse(readFileSync(USERS_FILE, "utf-8")) as Record<
      string,
      UserRecord
    >;
    // Normalize: ensure every record has all fields (older records may lack envFile etc.)
    const result: Record<string, UserRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value.name !== "string") continue;
      result[lowercaseKey(key)] = {
        name: value.name,
        defaultRoomId:
          typeof value.defaultRoomId === "string" ? value.defaultRoomId : null,
        notifRooms: normalizeNotifRooms(value.notifRooms),
        envFile:
          typeof value.envFile === "string" && value.envFile
            ? value.envFile
            : null,
        createdAt:
          typeof value.createdAt === "number" ? value.createdAt : Date.now(),
      };
    }
    users = result;
  } catch (err) {
    console.error("Failed to load users.json:", err);
    users = {};
  }
  return users;
}

function normalizeNotifRooms(value: unknown): NotifRoomsSetting {
  if (value === "all") return "all";
  if (Array.isArray(value) && value.every((x) => typeof x === "string"))
    return value;
  return "all";
}

function persist() {
  try {
    atomicWriteFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Failed to save users.json:", err);
  }
}

export function listUsers(): UserRecord[] {
  load();
  return Object.values(users).sort((a, b) => a.name.localeCompare(b.name));
}

export function getUser(name: string): UserRecord | undefined {
  load();
  return users[lowercaseKey(name)];
}

export function getUserEnvFile(name: string): string | null {
  return getUser(name)?.envFile ?? null;
}

// Idempotent: if the record already exists, returns it untouched. Otherwise
// creates a fresh record with the supplied initial values (used for the
// localStorage-to-server claim path).
export function claimUser(
  name: string,
  initial?: { defaultRoomId?: string | null; notifRooms?: NotifRoomsSetting },
): UserRecord {
  load();
  const key = lowercaseKey(name);
  if (users[key]) return users[key];
  const record: UserRecord = {
    name,
    defaultRoomId: initial?.defaultRoomId ?? null,
    notifRooms: initial?.notifRooms ?? "all",
    envFile: null,
    createdAt: Date.now(),
  };
  users[key] = record;
  persist();
  return record;
}

// Delete a user record. No-op if the user doesn't exist (idempotent).
// Agents stamped with this username keep their string reference but lose
// the env-file layer at next spawn — that's the price of removing a user
// who still has live agents. The user can be re-created via claim_user;
// agents will pick up the new env on next spawn.
export function deleteUser(name: string): boolean {
  load();
  const key = lowercaseKey(name);
  if (!users[key]) return false;
  delete users[key];
  persist();
  return true;
}

// Update an existing user record. If `changes.name` re-keys the record (the
// new lowercased name differs from the old), the existing record is moved
// under the new key. Display case can change without re-keying.
export function updateUser(
  name: string,
  changes: Partial<
    Pick<UserRecord, "name" | "defaultRoomId" | "notifRooms" | "envFile">
  >,
): { ok: true; user: UserRecord } | { ok: false; error: string } {
  load();
  const key = lowercaseKey(name);
  const existing = users[key];
  if (!existing) return { ok: false, error: `User ${name} not found` };

  let nextKey = key;
  let nextName = existing.name;
  if (changes.name !== undefined) {
    const trimmed = String(changes.name).trim();
    if (!trimmed) return { ok: false, error: "Name cannot be empty" };
    nextName = trimmed;
    const newKey = lowercaseKey(trimmed);
    if (newKey !== key) {
      // Re-keying. Reject if a different record already lives under the new key.
      if (users[newKey]) {
        return { ok: false, error: `User ${trimmed} already exists` };
      }
      nextKey = newKey;
    }
  }

  const next: UserRecord = {
    name: nextName,
    defaultRoomId:
      changes.defaultRoomId !== undefined
        ? (changes.defaultRoomId ?? null)
        : existing.defaultRoomId,
    notifRooms:
      changes.notifRooms !== undefined
        ? normalizeNotifRooms(changes.notifRooms)
        : existing.notifRooms,
    envFile:
      changes.envFile !== undefined
        ? changes.envFile && String(changes.envFile).trim()
          ? String(changes.envFile).trim()
          : null
        : existing.envFile,
    createdAt: existing.createdAt,
  };

  if (nextKey !== key) {
    delete users[key];
  }
  users[nextKey] = next;
  persist();
  return { ok: true, user: next };
}
