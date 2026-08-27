// Durable personal API tokens. Raw secrets are returned once at mint and never
// persisted; api-tokens.json stores only SHA-256 hashes plus display metadata.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import type { ApiTokenWire } from "../shared/contract-shapes.ts";
import { errMessage } from "../shared/errors.ts";

export const API_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;
export const DEFAULT_API_TOKEN_EXPIRY_DAYS = 90;
export const MAX_API_TOKEN_EXPIRY_DAYS = 365;
export const API_TOKEN_LAST_USED_PERSIST_INTERVAL_MS = 60_000;

const API_TOKENS_FILE = join(STATE_ROOT, "api-tokens.json");
const RAW_PREFIX = "isomux_pat_";

interface StoredApiToken extends ApiTokenWire {
  userId: string;
  tokenHash: string;
}

export interface ResolvedApiToken {
  id: string;
  userId: string;
  name: string;
}

let tokens: Map<string, StoredApiToken> | null = null;
let hashIndex: Map<string, string> | null = null;
let lastUsedPersistedAt = new Map<string, number>();
let mutexTail: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = mutexTail.then(() => fn());
  mutexTail = run.catch(() => undefined);
  return run;
}

function hashOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function safeHashEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function ensureLoaded(): void {
  if (tokens && hashIndex) return;
  tokens = new Map();
  hashIndex = new Map();
  lastUsedPersistedAt = new Map();
  try {
    if (!existsSync(API_TOKENS_FILE)) return;
    const raw = readFileSync(API_TOKENS_FILE, "utf-8");
    if (!raw.trim()) return;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    const records = parsed as Record<string, Partial<StoredApiToken>>;
    for (const [id, value] of Object.entries(records)) {
      if (
        value.id !== id ||
        typeof value.userId !== "string" ||
        typeof value.name !== "string" ||
        typeof value.tokenPrefix !== "string" ||
        typeof value.tokenHash !== "string" ||
        typeof value.createdAt !== "number" ||
        typeof value.expiresAt !== "number"
      ) {
        console.error("Ignoring invalid API token record:", id);
        continue;
      }
      const record: StoredApiToken = {
        id,
        userId: value.userId,
        name: value.name,
        tokenPrefix: value.tokenPrefix,
        tokenHash: value.tokenHash,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        lastUsedAt:
          typeof value.lastUsedAt === "number" ? value.lastUsedAt : null,
      };
      tokens.set(id, record);
      hashIndex.set(record.tokenHash, id);
      lastUsedPersistedAt.set(id, record.lastUsedAt ?? 0);
    }
  } catch (err) {
    console.error("Corrupt api-tokens.json; quarantining:", errMessage(err));
    try {
      renameSync(API_TOKENS_FILE, `${API_TOKENS_FILE}.corrupt-${Date.now()}`);
    } catch (renameErr) {
      console.error(
        "Failed to quarantine api-tokens.json:",
        errMessage(renameErr),
      );
    }
  }
}

function persist(): void {
  ensureLoaded();
  const out: Record<string, StoredApiToken> = {};
  for (const [id, record] of tokens!) out[id] = record;
  atomicWriteFileSync(API_TOKENS_FILE, JSON.stringify(out, null, 2), 0o600);
}

function wire(record: StoredApiToken): ApiTokenWire {
  return {
    id: record.id,
    name: record.name,
    tokenPrefix: record.tokenPrefix,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
  };
}

export function listApiTokens(userId: string): ApiTokenWire[] {
  ensureLoaded();
  return [...tokens!.values()]
    .filter((record) => record.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(wire);
}

export async function mintApiToken(input: {
  userId: string;
  name: string;
  expiresInDays: number;
  now?: number;
}): Promise<{ token: string; apiToken: ApiTokenWire }> {
  return mutate(() => {
    ensureLoaded();
    const now = input.now ?? Date.now();
    const raw = `${RAW_PREFIX}${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashOf(raw);
    const id = randomBytes(8).toString("hex");
    const record: StoredApiToken = {
      id,
      userId: input.userId,
      name: input.name,
      tokenPrefix: raw.slice(0, RAW_PREFIX.length + 8),
      tokenHash,
      createdAt: now,
      expiresAt: now + input.expiresInDays * 24 * 60 * 60 * 1000,
      lastUsedAt: null,
    };
    tokens!.set(id, record);
    hashIndex!.set(tokenHash, id);
    try {
      persist();
    } catch (err) {
      tokens!.delete(id);
      hashIndex!.delete(tokenHash);
      throw err;
    }
    return { token: raw, apiToken: wire(record) };
  });
}

export async function revokeApiToken(
  userId: string,
  id: string,
): Promise<boolean> {
  return mutate(() => {
    ensureLoaded();
    const record = tokens!.get(id);
    if (!record || record.userId !== userId) return false;
    tokens!.delete(id);
    hashIndex!.delete(record.tokenHash);
    lastUsedPersistedAt.delete(id);
    try {
      persist();
    } catch (err) {
      tokens!.set(id, record);
      hashIndex!.set(record.tokenHash, id);
      throw err;
    }
    return true;
  });
}

// Resolves and records the last authenticated request. Persistence is
// coalesced to once per token per minute; the UI therefore labels it
// approximate rather than implying a precise last successful API operation.
export function resolveApiToken(
  raw: string,
  now = Date.now(),
): ResolvedApiToken | null {
  if (!raw.startsWith(RAW_PREFIX)) return null;
  ensureLoaded();
  const hash = hashOf(raw);
  const id = hashIndex!.get(hash);
  if (!id) return null;
  const record = tokens!.get(id);
  if (!record || !safeHashEq(record.tokenHash, hash)) return null;
  if (record.expiresAt <= now) return null;
  record.lastUsedAt = now;
  const lastPersist = lastUsedPersistedAt.get(id) ?? 0;
  if (now - lastPersist >= API_TOKEN_LAST_USED_PERSIST_INTERVAL_MS) {
    try {
      persist();
      lastUsedPersistedAt.set(id, now);
    } catch (err) {
      // Metadata persistence must not turn a valid credential into a 500.
      console.error(
        "Failed to persist API token last-authenticated time:",
        err,
      );
    }
  }
  return { id, userId: record.userId, name: record.name };
}

export function _testResetApiTokens(): void {
  tokens = null;
  hashIndex = null;
  lastUsedPersistedAt = new Map();
  mutexTail = Promise.resolve();
}
