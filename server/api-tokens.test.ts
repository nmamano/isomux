import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  truncateSync,
  appendFileSync,
  renameSync,
} from "fs";
import { join } from "path";
import * as crypto from "crypto";
import * as fs from "fs";
import { blockAtomicFileReplacement } from "./test-support/temp-state.ts";
import { STATE_ROOT } from "./config.ts";
import {
  API_TOKEN_LAST_USED_PERSIST_INTERVAL_MS,
  API_TOKEN_LOG_DIR,
  loadApiTokens,
  sendApiTokenMessage,
  _testResetApiTokens,
  drainApiTokenInbox,
  enqueueApiTokenInboxMessage,
  listApiTokens,
  mintApiToken,
  resolveApiToken,
  revokeApiToken,
} from "./api-tokens.ts";

const file = join(STATE_ROOT, "api-tokens.json");

beforeEach(() => {
  _testResetApiTokens();
  rmSync(API_TOKEN_LOG_DIR, { recursive: true, force: true });
  for (const name of readdirSync(STATE_ROOT, { encoding: "utf-8" })) {
    if (
      name === "api-tokens.json" ||
      name.startsWith("api-tokens.json.corrupt-")
    ) {
      rmSync(join(STATE_ROOT, name), { force: true });
    }
  }
});
afterEach(() => _testResetApiTokens());

describe("personal API token persistence", () => {
  it("persists only a hash and returns the raw token once", async () => {
    const minted = await mintApiToken({
      userId: "u1",
      name: "Laptop",
      expiresInDays: null,
      now: 1_000,
    });
    expect(minted.apiToken.expiresAt).toBeNull();
    expect(minted.token).toStartWith("isomux_pat_");
    expect(minted.apiToken.lastUsedAt).toBeNull();
    const disk = readFileSync(file, "utf-8");
    expect(disk).not.toContain(minted.token);
    expect(disk).toContain("tokenHash");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    _testResetApiTokens();
    // A never-expiring token stays valid arbitrarily far in the future.
    expect(resolveApiToken(minted.token, 4_000_000_000_000)).toEqual({
      id: minted.apiToken.id,
      userId: "u1",
      name: "Laptop",
    });
    expect(listApiTokens("u1")).toHaveLength(1);
  });

  it("rejects expired, revoked, invalid, and leaked-prefix values", async () => {
    const minted = await mintApiToken({
      userId: "u1",
      name: "Short",
      expiresInDays: 30,
      now: 1_000,
    });
    expect(resolveApiToken("garbage", 2_000)).toBeNull();
    expect(resolveApiToken(minted.apiToken.tokenPrefix, 2_000)).toBeNull();
    expect(
      resolveApiToken(minted.token, minted.apiToken.expiresAt!),
    ).toBeNull();
    expect(await revokeApiToken("other", minted.apiToken.id)).toBe(false);
    expect(await revokeApiToken("u1", minted.apiToken.id)).toBe(true);
    expect(resolveApiToken(minted.token, 2_000)).toBeNull();
    expect(existsSync(file)).toBe(true);
  });

  it("coalesces approximate last-authenticated persistence to once per minute", async () => {
    const minted = await mintApiToken({
      userId: "u1",
      name: "Poller",
      expiresInDays: 30,
      now: 1_000,
    });
    expect(resolveApiToken(minted.token, 100_000)).not.toBeNull();
    const firstDisk = readFileSync(file, "utf-8");
    expect(firstDisk).toContain('"lastUsedAt": 100000');
    expect(resolveApiToken(minted.token, 101_000)).not.toBeNull();
    expect(readFileSync(file, "utf-8")).toBe(firstDisk);
    expect(
      resolveApiToken(
        minted.token,
        100_000 + API_TOKEN_LAST_USED_PERSIST_INTERVAL_MS,
      ),
    ).not.toBeNull();
    expect(readFileSync(file, "utf-8")).toContain('"lastUsedAt": 160000');
  });

  it("quarantines a corrupt store and reports invalid record ids", async () => {
    writeFileSync(file, "{broken", { mode: 0o600 });
    expect(listApiTokens("u1")).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(
      readdirSync(STATE_ROOT).some((name) =>
        name.startsWith("api-tokens.json.corrupt-"),
      ),
    ).toBe(true);
    await mintApiToken({
      userId: "u1",
      name: "After quarantine",
      expiresInDays: 30,
    });
    expect(existsSync(file)).toBe(true);

    writeFileSync(file, JSON.stringify({ damaged: { id: "damaged" } }));
    _testResetApiTokens();
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(listApiTokens("u1")).toEqual([]);
      expect(error).toHaveBeenCalledWith(
        "Ignoring invalid API token record:",
        "damaged",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("isolates a malformed inbox without revoking the credential", async () => {
    const minted = await mintApiToken({
      userId: "u1",
      name: "Durable",
      expiresInDays: null,
      now: 1_000,
    });
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    stored[minted.apiToken.id].inbox = { garbage: true };
    stored[minted.apiToken.id].lastDrainedAt = "yesterday";
    writeFileSync(file, JSON.stringify(stored));
    _testResetApiTokens();
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(resolveApiToken(minted.token, 2_000)?.id).toBe(minted.apiToken.id);
      expect(await drainApiTokenInbox(minted.apiToken.id, 3_000)).toEqual({
        entries: [],
        previouslyDrainedAt: null,
        drainedAt: 3_000,
        firstSequence: 0,
        latestSequence: 0,
      });
      expect(error).toHaveBeenCalledWith(
        "Ignoring malformed API token inbox:",
        minted.apiToken.id,
      );
    } finally {
      error.mockRestore();
    }
  });

  it("fails closed for wrong-owner, expired, and revoked inbox targets", async () => {
    const minted = await mintApiToken({
      userId: "u1",
      name: "Short",
      expiresInDays: 30,
      now: 1_000,
    });
    const input = {
      tokenId: minted.apiToken.id,
      text: "hello",
      senderAgentId: "a1",
      senderAgentName: "Worker",
      senderRoomName: "Lab",
    };
    expect(
      await enqueueApiTokenInboxMessage({ ...input, userId: "u2", now: 2_000 }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(
      await enqueueApiTokenInboxMessage({
        ...input,
        userId: "u1",
        now: minted.apiToken.expiresAt!,
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(await revokeApiToken("u1", minted.apiToken.id)).toBe(true);
    expect(
      await enqueueApiTokenInboxMessage({ ...input, userId: "u1", now: 2_000 }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

async function inboxMessage(tokenId: string, text: string) {
  return enqueueApiTokenInboxMessage({
    tokenId,
    userId: "u1",
    text,
    senderAgentId: "a1",
    senderAgentName: "Worker",
    senderRoomName: "Lab",
  });
}
async function readInbox(tokenId: string, after = 0) {
  const result = await drainApiTokenInbox(tokenId, undefined, after);
  if (!result) throw new Error("Expected live inbox");
  return result;
}

const mint = () => mintApiToken({ userId: "u1", name: "Log", expiresInDays: null });
const pathFor = (id: string) => join(API_TOKEN_LOG_DIR, `${id}.jsonl`);

describe("API token conversation log", () => {
  it("keeps both directions in order and correlates sends across reload", async () => {
    const { apiToken } = await mint();
    const sent = await sendApiTokenMessage(apiToken.id, {
      targetAgentId: "a2", targetAgentName: "Second", targetRoomName: "Lab", text: "request",
    }, async () => ({ ok: true }));
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error("send failed");
    await inboxMessage(apiToken.id, "reply");
    const initial = await readInbox(apiToken.id);
    expect(initial.entries).toMatchObject([
      { direction: "to_agent", id: sent.messageId, sequence: 1, targetAgentId: "a2", targetAgentName: "Second", targetRoomName: "Lab", text: "request" },
      { direction: "from_agent", sequence: 2, senderAgentId: "a1", text: "reply" },
    ]);
    _testResetApiTokens();
    expect((await readInbox(apiToken.id)).entries).toEqual(initial.entries);
    expect((await readInbox(apiToken.id, 1)).entries.map(e => e.sequence)).toEqual([2]);
    expect((await readInbox(apiToken.id, 2)).entries).toEqual([]);
    expect(await readInbox(apiToken.id, 999)).toMatchObject({ entries: [], firstSequence: 1, latestSequence: 2 });
    expect((await readInbox(apiToken.id)).entries).toEqual(initial.entries);
  });

  it("pages at 500 without limiting storage; first and latest describe the entire log", async () => {
    const { apiToken } = await mint();
    expect(await readInbox(apiToken.id)).toMatchObject({ entries: [], firstSequence: 0, latestSequence: 0 });
    for (let i = 0; i < 501; i++) await inboxMessage(apiToken.id, `entry ${i}`);
    const first = await readInbox(apiToken.id);
    expect(first.entries).toHaveLength(500);
    expect(first.firstSequence).toBe(1);
    expect(first.latestSequence).toBe(501);
    const second = await readInbox(apiToken.id, 500);
    expect(second.entries.map(e => e.sequence)).toEqual([501]);
    expect(second.firstSequence).toBe(1);
    expect(second.latestSequence).toBe(501);
    expect((await readInbox(apiToken.id, 499)).entries.map(e => e.sequence)).toEqual([500, 501]);
  });

  it("appends to the same inode and keeps messages out of the token record", async () => {
    const { apiToken } = await mint();
    await inboxMessage(apiToken.id, "one");
    const path = pathFor(apiToken.id);
    const inode = statSync(path).ino;
    const before = readFileSync(path, "utf8");
    await inboxMessage(apiToken.id, "two");
    expect(statSync(path).ino).toBe(inode);
    expect(readFileSync(path, "utf8")).toStartWith(before);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, "utf8"))[apiToken.id];
    expect(stored).not.toHaveProperty("inbox");
    expect(stored.lastSequence).toBe(2);
  });

  for (const legacy of [false, true]) {
    it(`migrates ${legacy ? "unsequenced" : "interim retained"} inbox once, including partial migration`, async () => {
      const { apiToken, token } = await mint();
      await inboxMessage(apiToken.id, "one");
      await inboxMessage(apiToken.id, "two");
      const entries = (await readInbox(apiToken.id)).entries;
      const stored = JSON.parse(readFileSync(file, "utf8"));
      stored[apiToken.id].inbox = entries.map(({ direction: _direction, ...entry }) => entry);
      stored[apiToken.id].ackMode = true;
      stored[apiToken.id].ackThrough = 900;
      if (legacy) {
        delete stored[apiToken.id].lastSequence;
        for (const entry of stored[apiToken.id].inbox) delete entry.sequence;
      }
      writeFileSync(file, JSON.stringify(stored));
      writeFileSync(pathFor(apiToken.id), JSON.stringify(entries[0]) + "\n");
      _testResetApiTokens();
      expect(resolveApiToken(token)?.id).toBe(apiToken.id);
      const first = await readInbox(apiToken.id);
      expect(first.entries.map(e => [e.sequence, e.text])).toEqual([[1, "one"], [2, "two"]]);
      expect(first.entries.every(e => e.direction === "from_agent")).toBe(true);
      _testResetApiTokens();
      expect((await readInbox(apiToken.id)).entries).toEqual(first.entries);
      const disk = JSON.parse(readFileSync(file, "utf8"))[apiToken.id];
      for (const key of ["inbox", "ackMode", "ackThrough"]) expect(disk).not.toHaveProperty(key);
    });
  }

  it("recovers an appended line after a stale counter and preserves an ahead counter", async () => {
    const { apiToken } = await mint();
    const stale = readFileSync(file, "utf8");
    await inboxMessage(apiToken.id, "durable line");
    writeFileSync(file, stale);
    _testResetApiTokens();
    await inboxMessage(apiToken.id, "after crash");
    expect((await readInbox(apiToken.id)).entries.map(e => e.sequence)).toEqual([1, 2]);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored[apiToken.id].lastSequence = 10;
    writeFileSync(file, JSON.stringify(stored));
    _testResetApiTokens();
    await inboxMessage(apiToken.id, "after reserved counter");
    expect((await readInbox(apiToken.id)).entries.map(e => e.sequence)).toEqual([1, 2, 11]);
  });

  it("keeps the appended entry when counter persistence fails and recovers on reload", async () => {
    const { apiToken } = await mint();
    const before = readFileSync(file, "utf8");
    blockAtomicFileReplacement(file);
    try {
      const failure = await inboxMessage(apiToken.id, "saved before counter").then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(JSON.parse(readFileSync(pathFor(apiToken.id), "utf8")).text).toBe("saved before counter");
    } finally {
      rmSync(file, { recursive: true, force: true });
      writeFileSync(file, before);
    }
    _testResetApiTokens();
    await inboxMessage(apiToken.id, "next");
    expect((await readInbox(apiToken.id)).entries.map(e => e.sequence)).toEqual([1, 2]);
  });

  it("reads a pruned file as empty and starts the next file above the preserved counter", async () => {
    const { apiToken } = await mint();
    for (let i = 0; i < 3; i++) await inboxMessage(apiToken.id, "old");
    rmSync(pathFor(apiToken.id)); // the storage-prune tests exercise the owner path
    expect(await readInbox(apiToken.id, 0)).toMatchObject({ entries: [], firstSequence: 3, latestSequence: 3 });
    _testResetApiTokens();
    await inboxMessage(apiToken.id, "new");
    expect(await readInbox(apiToken.id, 0)).toMatchObject({ firstSequence: 4, latestSequence: 4 });
    expect((await readInbox(apiToken.id)).entries.map(e => e.sequence)).toEqual([4]);
  });

  it("retains a revoked token log and keeps it separate from later credentials", async () => {
    const { apiToken } = await mint();
    await inboxMessage(apiToken.id, "retained");
    const bytes = readFileSync(pathFor(apiToken.id), "utf8");
    await revokeApiToken("u1", apiToken.id);
    _testResetApiTokens();
    expect(await drainApiTokenInbox(apiToken.id)).toBeNull();
    const random = crypto.randomBytes;
    let collision = true;
    const spy = spyOn(crypto, "randomBytes").mockImplementation((size: number) => {
      if (size === 8 && collision) { collision = false; return Buffer.from(apiToken.id, "hex"); }
      return random(size);
    });
    let next;
    try { next = await mint(); } finally { spy.mockRestore(); }
    expect(next.apiToken.id).not.toBe(apiToken.id);
    expect(readFileSync(pathFor(apiToken.id), "utf8")).toBe(bytes);
    expect((await readInbox(next.apiToken.id)).entries).toEqual([]);
  });

  it("rejects invalid persisted sequence counters", async () => {
    const { apiToken, token } = await mint();
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const value of [null, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
        stored[apiToken.id].lastSequence = value;
        writeFileSync(file, JSON.stringify(stored));
        _testResetApiTokens();
        expect(resolveApiToken(token)).toBeNull();
      }
    } finally { error.mockRestore(); }
  });

  it("stamps empty reads and never records a rejected send", async () => {
    const { apiToken } = await mint();
    const rejected = await sendApiTokenMessage(apiToken.id, {
      targetAgentId: "a1", targetAgentName: "One", targetRoomName: "Lab", text: "rejected",
    }, async () => ({ ok: false, status: 409, code: "busy", message: "Busy" }));
    expect(rejected.ok).toBe(false);
    expect(await drainApiTokenInbox(apiToken.id, 10_000)).toMatchObject({ entries: [], previouslyDrainedAt: null, drainedAt: 10_000 });
    expect(await drainApiTokenInbox(apiToken.id, 20_000)).toMatchObject({ entries: [], previouslyDrainedAt: 10_000, drainedAt: 20_000 });
  });
});


describe("token log recovery and read offsets", () => {
  for (const reboot of [false, true]) {
    it(`recovers a torn tail ${reboot ? "at boot" : "during polling"} without losing complete entries`, async () => {
      const { apiToken, token } = await mint();
      const other = await mint();
      await inboxMessage(apiToken.id, "complete café 👋");
      const prefix = readFileSync(pathFor(apiToken.id), "utf8");
      await inboxMessage(apiToken.id, "cut this tail");
      truncateSync(pathFor(apiToken.id), statSync(pathFor(apiToken.id)).size - 12);
      if (reboot) _testResetApiTokens();
      expect(() => loadApiTokens()).not.toThrow();
      expect(resolveApiToken(token)?.id).toBe(apiToken.id);
      expect(listApiTokens("u1")).toHaveLength(2);
      const result = await readInbox(apiToken.id);
      expect(result.entries.map(e => e.text)).toEqual(["complete café 👋"]);
      expect(readFileSync(pathFor(apiToken.id), "utf8")).toBe(prefix);
      expect(result.latestSequence).toBe(2);
      await inboxMessage(apiToken.id, "after recovery");
      expect((await readInbox(apiToken.id)).entries.map(e => e.sequence)).toEqual([1, 3]);
      expect((await inboxMessage(other.apiToken.id, "unaffected")).ok).toBe(true);
    });

    it(`quarantines a corrupt complete line ${reboot ? "at boot" : "during polling"} without revoking credentials`, async () => {
      const { apiToken, token } = await mint();
      const other = await mint();
      await inboxMessage(apiToken.id, "first");
      appendFileSync(pathFor(apiToken.id), "not-json\n");
      await inboxMessage(other.apiToken.id, "other history");
      const damaged = readFileSync(pathFor(apiToken.id), "utf8");
      if (reboot) _testResetApiTokens();
      expect(() => loadApiTokens()).not.toThrow();
      const read = await readInbox(apiToken.id);
      expect(read.entries).toEqual([]);
      expect(read.latestSequence).toBe(1);
      expect(resolveApiToken(token)?.id).toBe(apiToken.id);
      expect((await readInbox(other.apiToken.id)).entries.map(e => e.text)).toEqual(["other history"]);
      const quarantined = readdirSync(API_TOKEN_LOG_DIR).find(name => name.startsWith(`${apiToken.id}.jsonl.corrupt-`));
      expect(quarantined).toBeDefined();
      expect(readFileSync(join(API_TOKEN_LOG_DIR, quarantined!), "utf8")).toBe(damaged);
      await inboxMessage(apiToken.id, "fresh");
      expect((await readInbox(apiToken.id)).entries.map(e => e.sequence)).toEqual([2]);
    });
  }

  it("seeks to the saved offset for sequential pages and never scans a steady-state poll", async () => {
    const { apiToken } = await mint();
    for (let i = 0; i < 1002; i++) await inboxMessage(apiToken.id, `café 👋 ${i}`);
    _testResetApiTokens();
    loadApiTokens();
    const readSpy = spyOn(fs, "readSync");
    const create = fs.createReadStream;
    const starts: number[] = [];
    const spy = spyOn(fs, "createReadStream").mockImplementation((path, options) => {
      starts.push((options as { start?: number })?.start ?? 0);
      return create(path, options);
    });
    try {
      const first = await readInbox(apiToken.id);
      expect(first.entries).toHaveLength(500);
      const second = await readInbox(apiToken.id, 500);
      expect(second.entries.map(e => e.sequence)).toEqual(Array.from({ length: 500 }, (_, i) => i + 501));
      const third = await readInbox(apiToken.id, 1000);
      expect(third.entries.map(e => e.sequence)).toEqual([1001, 1002]);
      expect(starts[0]).toBe(0);
      expect(starts[1]).toBeGreaterThan(0);
      expect(starts[2]).toBeGreaterThan(starts[1]);
      const calls = starts.length;
      expect((await readInbox(apiToken.id, 1002)).entries).toEqual([]);
      expect(starts).toHaveLength(calls);
      await inboxMessage(apiToken.id, "new");
      expect((await readInbox(apiToken.id, 1002)).entries.map(e => e.sequence)).toEqual([1003]);
      expect(starts.at(-1)).toBeGreaterThan(starts[2]);
      // A different reader/cursor falls back safely rather than skipping data.
      expect((await readInbox(apiToken.id, 999)).entries.map(e => e.sequence)).toEqual([1000, 1001, 1002, 1003]);
      expect(starts.at(-1)).toBe(0);
      expect(readSpy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); readSpy.mockRestore(); }
  });

  it("invalidates offsets when the file is replaced or pruned", async () => {
    const { apiToken } = await mint();
    await inboxMessage(apiToken.id, "one");
    await inboxMessage(apiToken.id, "two");
    await readInbox(apiToken.id, 1);
    const lines = readFileSync(pathFor(apiToken.id), "utf8").trim().split("\n");
    const replacement = pathFor(apiToken.id) + ".replacement";
    writeFileSync(replacement, lines[1] + "\n");
    renameSync(replacement, pathFor(apiToken.id));
    expect(await readInbox(apiToken.id, 1)).toMatchObject({ firstSequence: 2, latestSequence: 2 });
    expect((await readInbox(apiToken.id, 1)).entries.map(e => e.sequence)).toEqual([2]);
    rmSync(pathFor(apiToken.id));
    expect(await readInbox(apiToken.id, 1)).toMatchObject({ entries: [], firstSequence: 2, latestSequence: 2 });
    await inboxMessage(apiToken.id, "three");
    expect((await readInbox(apiToken.id, 2)).entries.map(e => e.sequence)).toEqual([3]);
  });
});
