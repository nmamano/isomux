// The preload drops the in-memory caches that load from STATE_ROOT before and
// after each test (server/state-cache-resets.ts), so a member that an earlier
// test or file made and then wiped from disk is gone for the next one (task
// 3a93528c). The preload hooks run per test, so describe blocks in one file
// stand in for separate files in one bun process: a describe's beforeAll runs
// in the same gap as the next file's beforeAll or top level.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { createMember, deleteUserById, getUserByName } from "../users.ts";

const USERS_FILE = join(STATE_ROOT, "users.json");

function wipeDisk(): void {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
}

function make(name: string): void {
  const made = createMember(name, { role: "member" });
  if (!made.ok) throw new Error(`createMember(${name}): ${made.code}`);
}

beforeAll(wipeDisk);
afterAll(wipeDisk);

describe("a test that makes a member and wipes only the disk", () => {
  it("leaves the member in memory until the test ends", () => {
    make("CacheResetLeak");
    expect(existsSync(USERS_FILE)).toBe(true);
    wipeDisk();
    // The condition the next block depends on: disk is empty, the cache is not.
    expect(existsSync(USERS_FILE)).toBe(false);
    expect(getUserByName("CacheResetLeak")).toBeDefined();
  });
});

describe("the next block's beforeAll (the next file's top level)", () => {
  let seenBeforeAll: boolean | null = null;
  beforeAll(() => {
    seenBeforeAll = getUserByName("CacheResetLeak") !== undefined;
  });

  it("does not see the wiped member", () => {
    expect(seenBeforeAll).toBe(false);
    make("CacheResetLeak");
  });
});

describe("a member made in beforeAll, then wiped in beforeEach", () => {
  let seenBeforeAll = false;
  beforeAll(() => {
    wipeDisk();
    make("CacheResetLeak2");
    seenBeforeAll = getUserByName("CacheResetLeak2") !== undefined;
  });
  beforeEach(wipeDisk);

  it("is gone in the test, and the name can be made again", () => {
    expect(seenBeforeAll).toBe(true);
    expect(existsSync(USERS_FILE)).toBe(false);
    expect(getUserByName("CacheResetLeak2")).toBeUndefined();
    expect(createMember("CacheResetLeak2", { role: "member" }).ok).toBe(true);
  });
});

describe("a member that stays on disk", () => {
  let id = "";
  beforeAll(() => {
    wipeDisk();
    const made = createMember("CacheResetKept", { role: "member" });
    if (!made.ok) throw new Error(made.code);
    id = made.user.id;
  });
  afterAll(() => {
    deleteUserById(id);
  });

  it("is visible in the first test", () => {
    expect(getUserByName("CacheResetKept")?.id).toBe(id);
  });

  it("is still visible in the next test, reloaded from disk", () => {
    expect(existsSync(USERS_FILE)).toBe(true);
    expect(getUserByName("CacheResetKept")?.id).toBe(id);
  });
});
