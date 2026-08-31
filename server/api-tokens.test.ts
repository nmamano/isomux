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
      });
      expect(error).toHaveBeenCalledWith(
        "Ignoring malformed API token inbox:",
        minted.apiToken.id,
      );
    } finally {
      error.mockRestore();
    }
  });

  it("persists bounded messages and drains them atomically at most once", async () => {
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
      messages: [],
      previouslyDrainedAt: 5_000,
      drainedAt: 6_000,
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
