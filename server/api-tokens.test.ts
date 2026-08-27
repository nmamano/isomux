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
  _testResetApiTokens,
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
      expiresInDays: 90,
      now: 1_000,
    });
    expect(minted.token).toStartWith("isomux_pat_");
    expect(minted.apiToken.lastUsedAt).toBeNull();
    const disk = readFileSync(file, "utf-8");
    expect(disk).not.toContain(minted.token);
    expect(disk).toContain("tokenHash");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    _testResetApiTokens();
    expect(resolveApiToken(minted.token, 2_000)).toEqual({
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
    expect(resolveApiToken(minted.token, minted.apiToken.expiresAt)).toBeNull();
    expect(await revokeApiToken("other", minted.apiToken.id)).toBe(false);
    expect(await revokeApiToken("u1", minted.apiToken.id)).toBe(true);
    expect(resolveApiToken(minted.token, 2_000)).toBeNull();
    expect(existsSync(file)).toBe(true);
  });

  it("coalesces approximate last-authenticated persistence to once per minute", async () => {
    const minted = await mintApiToken({
      userId: "u1",
      name: "Poller",
      expiresInDays: 90,
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
});
