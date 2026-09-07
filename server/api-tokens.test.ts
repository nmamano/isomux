import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import {
  API_TOKEN_LAST_USED_PERSIST_INTERVAL_MS,
  API_TOKEN_INBOX_CAPACITY,
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
        messages: [],
        previouslyDrainedAt: null,
        drainedAt: 3_000,
        depth: 0,
        capacity: 100,
        highWatermark: 0,
      });
      expect(error).toHaveBeenCalledWith(
        "Ignoring malformed API token inbox:",
        minted.apiToken.id,
      );
    } finally {
      error.mockRestore();
    }
  });

  it("persists bounded messages and retains them across repeated drains", async () => {
    const minted = await mintApiToken({
      userId: "u1",
      name: "Poller",
      expiresInDays: null,
      now: 1_000,
    });
    for (let i = 0; i < API_TOKEN_INBOX_CAPACITY; i++) {
      const result = await enqueueApiTokenInboxMessage({
        tokenId: minted.apiToken.id,
        userId: "u1",
        text: `message ${i}`,
        senderAgentId: "a1",
        senderAgentName: "Worker",
        senderRoomName: "Lab",
        now: 2_000 + i,
      });
      expect(result.ok).toBe(true);
    }
    expect(
      await enqueueApiTokenInboxMessage({
        tokenId: minted.apiToken.id,
        userId: "u1",
        text: "overflow",
        senderAgentId: "a1",
        senderAgentName: "Worker",
        senderRoomName: "Lab",
        now: 4_000,
      }),
    ).toEqual({ ok: false, reason: "full" });
    _testResetApiTokens();
    const first = await drainApiTokenInbox(minted.apiToken.id, 5_000);
    expect(first?.messages).toHaveLength(API_TOKEN_INBOX_CAPACITY);
    expect(first?.messages[0]).toMatchObject({
      text: "message 0",
      senderAgentId: "a1",
      senderAgentName: "Worker",
      senderRoomName: "Lab",
    });
    expect(await drainApiTokenInbox(minted.apiToken.id, 6_000)).toEqual({
      messages: first!.messages,
      previouslyDrainedAt: 5_000,
      drainedAt: 6_000,
      depth: 100,
      capacity: 100,
      highWatermark: 100,
    });
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
async function readInbox(tokenId: string, ackThrough?: number) {
  const result = await drainApiTokenInbox(tokenId, undefined, ackThrough);
  if (!result) throw new Error("Expected live inbox");
  return result;
}

describe("API token inbox cursors", () => {
  it("loads a pre-upgrade credential and backfills every message in load order", async () => {
    const minted = await mintApiToken({
      userId: "u1",
      name: "Old",
      expiresInDays: null,
    });
    await inboxMessage(minted.apiToken.id, "first");
    await inboxMessage(minted.apiToken.id, "second");
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    const old = stored[minted.apiToken.id];
    delete old.lastSequence;
    for (const message of old.inbox) delete message.sequence;
    writeFileSync(file, JSON.stringify(stored));
    _testResetApiTokens();
    expect(resolveApiToken(minted.token)?.id).toBe(minted.apiToken.id);
    expect(listApiTokens("u1")[0]).not.toHaveProperty("ackMode");
    const first = await readInbox(minted.apiToken.id);
    expect(
      first.messages.map(({ text, sequence }) => ({ text, sequence })),
    ).toEqual([
      { text: "first", sequence: 1 },
      { text: "second", sequence: 2 },
    ]);
    expect(first.highWatermark).toBe(2);
    await readInbox(minted.apiToken.id, 2);
    _testResetApiTokens();
    await inboxMessage(minted.apiToken.id, "after drain");
    expect((await readInbox(minted.apiToken.id)).messages[0].sequence).toBe(3);
  });

  it("rejects present invalid counters instead of reusing acknowledged sequences", async () => {
    const minted = await mintApiToken({
      userId: "u1",
      name: "Corrupt",
      expiresInDays: null,
    });
    await inboxMessage(minted.apiToken.id, "acknowledged");
    await readInbox(minted.apiToken.id, 1);
    const valid = JSON.parse(readFileSync(file, "utf-8"));
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const lastSequence of [
        null,
        -1,
        1.5,
        "1",
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const stored = structuredClone(valid);
        stored[minted.apiToken.id].lastSequence = lastSequence;
        writeFileSync(file, JSON.stringify(stored));
        _testResetApiTokens();
        error.mockClear();
        expect(resolveApiToken(minted.token)).toBeNull();
        expect(error).toHaveBeenCalledWith(
          "Ignoring invalid API token record:",
          minted.apiToken.id,
        );
        expect(listApiTokens("u1")).toEqual([]);
      }
    } finally {
      error.mockRestore();
    }
  });

  for (const ackMode of [true, false, null, "true", "false", 0, 1, {}, []]) {
    it(`ignores stored ackMode ${JSON.stringify(ackMode)} and retains replies`, async () => {
      const minted = await mintApiToken({
        userId: "u1",
        name: "Interim",
        expiresInDays: null,
      });
      await inboxMessage(minted.apiToken.id, "retained");
      const stored = JSON.parse(readFileSync(file, "utf-8"));
      stored[minted.apiToken.id].ackMode = ackMode;
      writeFileSync(file, JSON.stringify(stored));
      _testResetApiTokens();
      expect(resolveApiToken(minted.token)?.id).toBe(minted.apiToken.id);
      expect(listApiTokens("u1")[0]).not.toHaveProperty("ackMode");
      const first = await readInbox(minted.apiToken.id);
      expect(first.messages.map((message) => message.text)).toEqual([
        "retained",
      ]);
      expect((await readInbox(minted.apiToken.id)).messages).toEqual(
        first.messages,
      );
      expect((await readInbox(minted.apiToken.id, 1)).messages).toEqual([]);
      expect(
        JSON.parse(readFileSync(file, "utf-8"))[minted.apiToken.id],
      ).not.toHaveProperty("ackMode");
    });
  }

  it("migrates an absent counter from the maximum stored sequence before backfill", async () => {
    const { apiToken } = await mintApiToken({
      userId: "u1",
      name: "Migration",
      expiresInDays: null,
    });
    for (const text of ["old", "sequenced", "later old"])
      await inboxMessage(apiToken.id, text);
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    delete stored[apiToken.id].lastSequence;
    delete stored[apiToken.id].inbox[0].sequence;
    stored[apiToken.id].inbox[1].sequence = 10;
    delete stored[apiToken.id].inbox[2].sequence;
    writeFileSync(file, JSON.stringify(stored));
    _testResetApiTokens();
    const migrated = await readInbox(apiToken.id);
    expect(migrated.messages.map((message) => message.sequence)).toEqual([
      11, 10, 12,
    ]);
    expect(migrated.highWatermark).toBe(12);
    _testResetApiTokens();
    expect((await readInbox(apiToken.id)).messages).toEqual(migrated.messages);
    await readInbox(apiToken.id, 12);
    _testResetApiTokens();
    await inboxMessage(apiToken.id, "new");
    expect(
      (await readInbox(apiToken.id)).messages.map(
        (message) => message.sequence,
      ),
    ).toEqual([13]);
  });

  it("redelivers after reload and deletes only through the inclusive ACK bound", async () => {
    const { apiToken } = await mintApiToken({
      userId: "u1",
      name: "Ack",
      expiresInDays: null,
    });
    for (const text of ["one", "two", "three"])
      await inboxMessage(apiToken.id, text);
    const first = await readInbox(apiToken.id);
    expect(first).toMatchObject({ depth: 3, capacity: 100, highWatermark: 3 });
    _testResetApiTokens();
    expect(listApiTokens("u1")[0]).not.toHaveProperty("ackMode");
    const retry = await readInbox(apiToken.id);
    expect(retry.messages).toEqual(first.messages);
    expect(retry.previouslyDrainedAt).toBe(first.drainedAt);
    const partial = await readInbox(apiToken.id, 2);
    expect(partial.messages.map((message) => message.sequence)).toEqual([3]);
    expect(partial.depth).toBe(1);
    expect((await readInbox(apiToken.id, 2)).messages).toEqual(
      partial.messages,
    );
    _testResetApiTokens();
    await inboxMessage(apiToken.id, "four");
    expect(
      (await readInbox(apiToken.id)).messages.map(
        (message) => message.sequence,
      ),
    ).toEqual([3, 4]);
    expect((await readInbox(apiToken.id, 100)).depth).toBe(0);
    _testResetApiTokens();
    await inboxMessage(apiToken.id, "five");
    const next = await readInbox(apiToken.id);
    expect(next.messages.map((message) => message.sequence)).toEqual([5]);
    expect(next.highWatermark).toBe(5);
  });

  it("stamps each no-ACK read without deleting messages", async () => {
    const { apiToken } = await mintApiToken({
      userId: "u1",
      name: "Reads",
      expiresInDays: null,
    });
    await inboxMessage(apiToken.id, "retained");
    const first = await drainApiTokenInbox(apiToken.id, 10_000);
    const second = await drainApiTokenInbox(apiToken.id, 20_000);
    expect(first).toMatchObject({
      previouslyDrainedAt: null,
      drainedAt: 10_000,
      depth: 1,
    });
    expect(second).toMatchObject({
      previouslyDrainedAt: 10_000,
      drainedAt: 20_000,
      depth: 1,
    });
    if (
      !first ||
      !second ||
      typeof first === "string" ||
      typeof second === "string"
    ) {
      throw new Error("Expected live inbox reads");
    }
    expect(first.messages.map((message) => message.text)).toEqual(["retained"]);
    expect(second.messages).toEqual(first.messages);
  });

  it("keeps a full inbox full until the client acknowledges a message", async () => {
    const { apiToken } = await mintApiToken({
      userId: "u1",
      name: "Full",
      expiresInDays: null,
    });
    for (let i = 0; i < API_TOKEN_INBOX_CAPACITY; i++) {
      expect((await inboxMessage(apiToken.id, `message ${i}`)).ok).toBe(true);
    }
    const polled = await readInbox(apiToken.id);
    expect(polled.messages).toHaveLength(API_TOKEN_INBOX_CAPACITY);
    expect(polled.depth).toBe(API_TOKEN_INBOX_CAPACITY);
    expect(await inboxMessage(apiToken.id, "still full")).toEqual({
      ok: false,
      reason: "full",
    });
    expect((await readInbox(apiToken.id, 1)).depth).toBe(
      API_TOKEN_INBOX_CAPACITY - 1,
    );
    expect((await inboxMessage(apiToken.id, "now accepted")).ok).toBe(true);
  });

  it("accepts zero ACKs without deleting replies and accepts inclusive ACKs on every token", async () => {
    const { apiToken } = await mintApiToken({
      userId: "u1",
      name: "Plain",
      expiresInDays: null,
    });
    await inboxMessage(apiToken.id, "kept");
    const zero = await readInbox(apiToken.id, 0);
    expect(zero.messages.map((message) => message.text)).toEqual(["kept"]);
    expect(zero.previouslyDrainedAt).toBeNull();
    expect((await readInbox(apiToken.id)).messages).toEqual(zero.messages);
    expect((await readInbox(apiToken.id, 1)).messages).toEqual([]);
  });
});
