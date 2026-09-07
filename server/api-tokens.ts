// Durable personal API tokens. Raw secrets are returned once at mint and never
// persisted; api-tokens.json stores only SHA-256 hashes plus display metadata.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
} from "fs";
import { StringDecoder } from "string_decoder";
import type { UserSendAcceptance } from "./internal-types.ts";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import type {
  ApiTokenInboxDrainRes,
  ApiTokenInboxMessage,
  ApiTokenLogEntry,
  ApiTokenWire,
} from "../shared/contract-shapes.ts";
import { errMessage } from "../shared/errors.ts";

// null means the token never expires.
export const API_TOKEN_EXPIRY_DAYS = [30, 365, null] as const;
export const DEFAULT_API_TOKEN_EXPIRY_DAYS = 30;
export const API_TOKEN_LAST_USED_PERSIST_INTERVAL_MS = 60_000;
export const API_TOKEN_LOG_PAGE_SIZE = 500;
export const API_TOKEN_LOG_DIR = join(STATE_ROOT, "token-logs");

const API_TOKENS_FILE = join(STATE_ROOT, "api-tokens.json");
const RAW_PREFIX = "isomux_pat_";

interface StoredApiToken extends ApiTokenWire {
  userId: string;
  tokenHash: string;
  lastSequence: number;
  lastDrainedAt: number | null;
  inbox?: ApiTokenInboxMessage[]; // Only retained if a legacy migration could not finish.
}

export interface ResolvedApiToken {
  id: string;
  userId: string;
  name: string;
}

let tokens: Map<string, StoredApiToken> | null = null;
let hashIndex: Map<string, string> | null = null;
let lastUsedPersistedAt = new Map<string, number>();
interface LogHint {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  firstSequence: number;
  tailSequence: number;
  cursorSequence: number;
  cursorOffset: number;
}
let logHints = new Map<string, LogHint>();
let blockedLogs = new Set<string>();
let storeLoadFailed = false;
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
  logHints = new Map();
  blockedLogs = new Set();
  storeLoadFailed = false;
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
    const records = parsed as Record<
      string,
      Partial<StoredApiToken> & { inbox?: ApiTokenInboxMessage[] }
    >;
    let migrated = false;
    for (const [id, value] of Object.entries(records)) {
      if (
        !value ||
        value.id !== id ||
        !/^[a-f0-9]{16}$/.test(id) ||
        typeof value.userId !== "string" ||
        typeof value.name !== "string" ||
        typeof value.tokenPrefix !== "string" ||
        typeof value.tokenHash !== "string" ||
        typeof value.createdAt !== "number" ||
        (value.lastSequence !== undefined &&
          (!Number.isSafeInteger(value.lastSequence) ||
            value.lastSequence < 0)) ||
        (typeof value.expiresAt !== "number" && value.expiresAt !== null)
      ) {
        console.error("Ignoring invalid API token record:", id);
        continue;
      }
      const inboxValid =
        Array.isArray(value.inbox) && value.inbox.every(validInboxMessage);
      const lastDrainedAtValid =
        typeof value.lastDrainedAt === "number" || value.lastDrainedAt === null;
      if (!inboxValid && value.inbox !== undefined) {
        console.error("Ignoring malformed API token inbox:", id);
      }
      if (!lastDrainedAtValid && value.lastDrainedAt !== undefined) {
        console.error("Ignoring malformed API token last-drained time:", id);
      }
      // Old inboxes have no sequences. Assign them in stored order while
      // preserving the counter even when previous messages have been removed.
      let lastSequence =
        Number.isSafeInteger(value.lastSequence) && value.lastSequence! >= 0
          ? value.lastSequence!
          : 0;
      const inbox = inboxValid ? value.inbox! : [];
      for (const message of inbox) {
        if (message.sequence !== undefined)
          lastSequence = Math.max(lastSequence, message.sequence);
      }
      let previous = 0;
      const ordered = inbox.every((message) => {
        const valid =
          message.sequence !== undefined && message.sequence > previous;
        previous = message.sequence;
        return valid;
      });
      if (!ordered)
        for (const message of inbox) message.sequence = ++lastSequence;
      // Only the small legacy inbox needs a dedupe set. This also handles a
      // crash after part of the migration appended but before persist().
      const pendingIds = new Set(inbox.map((message) => message.id));
      let logSequence = 0;
      let migrationFailed = false;
      try {
        const hint = scanLogSync(id, (entry) => {
          pendingIds.delete(entry.id);
        });
        if (hint.tailSequence === 0)
          for (const message of inbox) pendingIds.add(message.id);
        logSequence = hint.tailSequence;
        for (const message of inbox) {
          if (pendingIds.has(message.id)) {
            appendLog(id, { ...message, direction: "from_agent" });
            logSequence = Math.max(logSequence, message.sequence);
          }
        }
      } catch (err) {
        console.error("Could not recover API token log:", id, errMessage(err));
        blockedLogs.add(id);
        migrationFailed = true;
      }
      lastSequence = Math.max(lastSequence, logSequence);
      if (
        !migrationFailed &&
        (value.inbox !== undefined || lastSequence !== value.lastSequence)
      )
        migrated = true;
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
        lastSequence,
        ...(migrationFailed && inbox.length ? { inbox } : {}),
        lastDrainedAt: lastDrainedAtValid ? value.lastDrainedAt! : null,
      };
      tokens.set(id, record);
      hashIndex.set(record.tokenHash, id);
      lastUsedPersistedAt.set(id, record.lastUsedAt ?? 0);
    }
    if (migrated) {
      try {
        persist();
      } catch (err) {
        console.error("Could not save API token migration:", errMessage(err));
      }
    }
  } catch (err) {
    if (
      !(err instanceof SyntaxError) &&
      !(err instanceof Error && err.message === "not an object")
    ) {
      storeLoadFailed = true;
      console.error("Could not load API tokens:", errMessage(err));
      return;
    }
    tokens = new Map();
    hashIndex = new Map();
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

function logPath(id: string): string {
  return join(API_TOKEN_LOG_DIR, `${id}.jsonl`);
}

function fileHint(
  id: string,
): Pick<LogHint, "ino" | "size" | "mtimeMs" | "ctimeMs"> {
  try {
    const stat = statSync(logPath(id));
    return {
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    return { ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 };
  }
}

function sameFile(
  a: ReturnType<typeof fileHint>,
  b: ReturnType<typeof fileHint>,
): boolean {
  return (
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function appendLog(id: string, entry: ApiTokenLogEntry): void {
  mkdirSync(API_TOKEN_LOG_DIR, { recursive: true, mode: 0o700 });
  const hint = logHints.get(id);
  try {
    appendFileSync(logPath(id), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (err) {
    logHints.delete(id); // A short write needs recovery before any later append.
    throw err;
  }
  logHints.set(id, {
    ...fileHint(id),
    firstSequence: hint?.firstSequence || entry.sequence,
    tailSequence: entry.sequence,
    cursorSequence: hint?.cursorSequence ?? 0,
    cursorOffset: hint?.cursorOffset ?? 0,
  });
}

function refreshLog(record: StoredApiToken): LogHint {
  if (blockedLogs.has(record.id))
    throw new Error("API token log recovery is unavailable");
  const previous = logHints.get(record.id);
  const hint =
    previous && sameFile(previous, fileHint(record.id))
      ? previous
      : scanLogSync(record.id);
  record.lastSequence = Math.max(record.lastSequence, hint.tailSequence);
  return hint;
}

function commitEntry(record: StoredApiToken, entry: ApiTokenLogEntry): void {
  refreshLog(record);
  entry.sequence = record.lastSequence + 1;
  appendLog(record.id, entry);
  // Never roll back a sequence after its line reached disk. A failed counter
  // persist is repaired by the log scan at boot.
  record.lastSequence = entry.sequence;
  persist();
}

function parseLogEntry(line: string, previous: number): ApiTokenLogEntry {
  const entry = JSON.parse(line) as ApiTokenLogEntry;
  if (
    !entry ||
    !Number.isSafeInteger(entry.sequence) ||
    entry.sequence <= previous ||
    typeof entry.id !== "string" ||
    typeof entry.text !== "string" ||
    typeof entry.sentAt !== "number" ||
    (entry.direction !== "from_agent" && entry.direction !== "to_agent")
  ) {
    throw new Error("Invalid API token log entry");
  }
  return entry;
}

// Recover only the incomplete suffix of a short append. Complete but corrupt
// lines quarantine this token's file, keeping its bytes for inspection while
// allowing other credentials and the office to start.
function scanLogSync(
  id: string,
  visit?: (entry: ApiTokenLogEntry) => void,
): LogHint {
  let firstSequence = 0;
  let tailSequence = 0;
  let completeBytes = 0;
  if (existsSync(logPath(id))) {
    const fd = openSync(logPath(id), "r");
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let corrupt = false;
    try {
      let count: number;
      while (
        !corrupt &&
        (count = readSync(fd, buffer, 0, buffer.length, null)) > 0
      ) {
        pending += decoder.write(buffer.subarray(0, count));
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          completeBytes += Buffer.byteLength(line + "\n");
          if (!line.trim()) continue;
          let entry: ApiTokenLogEntry;
          try {
            entry = parseLogEntry(line, tailSequence);
          } catch {
            corrupt = true;
            break;
          }
          firstSequence ||= entry.sequence;
          tailSequence = entry.sequence;
          visit?.(entry);
        }
      }
    } finally {
      closeSync(fd);
    }
    if (corrupt) {
      renameSync(logPath(id), `${logPath(id)}.corrupt-${Date.now()}`);
      console.error("Quarantined corrupt API token log:", id);
      firstSequence = 0;
      tailSequence = 0;
    } else if (fileHint(id).size > completeBytes) {
      truncateSync(logPath(id), completeBytes);
      console.error("Removed incomplete API token log tail:", id);
    }
  }
  const hint: LogHint = {
    ...fileHint(id),
    firstSequence,
    tailSequence,
    cursorSequence: tailSequence,
    cursorOffset: fileHint(id).size,
  };
  logHints.set(id, hint);
  return hint;
}

export function loadApiTokens(): void {
  ensureLoaded();
}

function validInboxMessage(value: unknown): value is ApiTokenInboxMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const message = value as Partial<ApiTokenInboxMessage>;
  return (
    (message.sequence === undefined ||
      (Number.isSafeInteger(message.sequence) && message.sequence > 0)) &&
    typeof message.id === "string" &&
    typeof message.sentAt === "number" &&
    typeof message.text === "string" &&
    typeof message.senderAgentId === "string" &&
    typeof message.senderAgentName === "string" &&
    typeof message.senderRoomName === "string"
  );
}

function persist(): void {
  ensureLoaded();
  if (storeLoadFailed) throw new Error("API token store is unavailable");
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
  expiresInDays: number | null;
  now?: number;
}): Promise<{ token: string; apiToken: ApiTokenWire }> {
  return mutate(() => {
    ensureLoaded();
    const now = input.now ?? Date.now();
    const raw = `${RAW_PREFIX}${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashOf(raw);
    let id: string;
    do {
      id = randomBytes(8).toString("hex");
    } while (tokens!.has(id) || existsSync(logPath(id)));
    const record: StoredApiToken = {
      id,
      userId: input.userId,
      name: input.name,
      tokenPrefix: raw.slice(0, RAW_PREFIX.length + 8),
      tokenHash,
      createdAt: now,
      expiresAt:
        input.expiresInDays === null
          ? null
          : now + input.expiresInDays * 24 * 60 * 60 * 1000,
      lastUsedAt: null,
      lastSequence: 0,
      lastDrainedAt: null,
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

function isLive(record: StoredApiToken, now: number): boolean {
  return record.expiresAt === null || record.expiresAt > now;
}

export function isLiveApiTokenOwnedBy(
  tokenId: string,
  userId: string,
  now = Date.now(),
): boolean {
  ensureLoaded();
  const record = tokens!.get(tokenId);
  return !!record && record.userId === userId && isLive(record, now);
}

export async function enqueueApiTokenInboxMessage(input: {
  tokenId: string;
  userId: string;
  text: string;
  senderAgentId: string;
  senderAgentName: string;
  senderRoomName: string;
  now?: number;
}): Promise<
  | {
      ok: true;
      message: ApiTokenInboxMessage;
      lastDrainedAt: number | null;
      tokenName: string;
    }
  | { ok: false; reason: "unavailable" }
> {
  return mutate(() => {
    ensureLoaded();
    const now = input.now ?? Date.now();
    const record = tokens!.get(input.tokenId);
    if (!record || record.userId !== input.userId || !isLive(record, now)) {
      return { ok: false as const, reason: "unavailable" as const };
    }
    const message: ApiTokenInboxMessage = {
      direction: "from_agent",
      sequence: record.lastSequence + 1,
      id: randomBytes(8).toString("hex"),
      sentAt: now,
      text: input.text,
      senderAgentId: input.senderAgentId,
      senderAgentName: input.senderAgentName,
      senderRoomName: input.senderRoomName,
    };
    commitEntry(record, message);
    return {
      ok: true as const,
      message,
      lastDrainedAt: record.lastDrainedAt,
      tokenName: record.name,
    };
  });
}

// Hold the same queue as agent replies through the acceptance decision, so a
// fast reply cannot overtake the send that caused it in the token conversation.
export async function sendApiTokenMessage(
  tokenId: string,
  target: {
    targetAgentId: string;
    targetAgentName: string;
    targetRoomName: string;
    text: string;
  },
  send: () => Promise<UserSendAcceptance>,
): Promise<
  Exclude<UserSendAcceptance, { ok: true }> | { ok: true; messageId: string }
> {
  return mutate(async () => {
    ensureLoaded();
    const record = tokens!.get(tokenId);
    if (!record || !isLive(record, Date.now())) {
      return {
        ok: false,
        status: 404,
        code: "api_token_unavailable",
        message: "API token unavailable.",
      };
    }
    const result = await send();
    if (!result.ok) return result;
    const id = randomBytes(8).toString("hex");
    commitEntry(record, {
      ...target,
      direction: "to_agent",
      id,
      sentAt: Date.now(),
      sequence: record.lastSequence + 1,
    });
    return { ok: true, messageId: id };
  });
}

export async function drainApiTokenInbox(
  tokenId: string,
  now = Date.now(),
  after = 0,
): Promise<ApiTokenInboxDrainRes | null> {
  return mutate(async () => {
    ensureLoaded();
    const record = tokens!.get(tokenId);
    if (!record || !isLive(record, now)) return null;
    const hint = refreshLog(record);
    const entries: ApiTokenLogEntry[] = [];
    let firstSequence = hint.firstSequence || record.lastSequence;
    // Sequential catch-up resumes at the last returned byte. Steady-state
    // polling starts at EOF; only a different cursor falls back to byte zero.
    const start =
      after >= hint.tailSequence
        ? hint.size
        : after === hint.cursorSequence
          ? hint.cursorOffset
          : 0;
    if (start < hint.size) {
      const input = createReadStream(logPath(tokenId), {
        start,
        end: hint.size - 1,
      });
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let offset = start;
      let sequence = start === 0 ? 0 : after;
      try {
        outer: for await (const chunk of input) {
          pending += decoder.write(chunk as Buffer);
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            offset += Buffer.byteLength(line + "\n");
            if (!line.trim()) continue;
            const entry = parseLogEntry(line, sequence);
            sequence = entry.sequence;
            if (sequence > after) entries.push(entry);
            hint.cursorSequence = sequence;
            hint.cursorOffset = offset;
            if (entries.length === API_TOKEN_LOG_PAGE_SIZE) break outer;
          }
        }
      } catch {
        // An external write raced this read. Apply the same recovery as boot;
        // return no stale page from a file that needed quarantine.
        logHints.delete(tokenId);
        const recovered = refreshLog(record);
        firstSequence = recovered.firstSequence || record.lastSequence;
        entries.length = 0;
      } finally {
        input.destroy();
      }
    }
    const previouslyDrainedAt = record.lastDrainedAt;
    record.lastDrainedAt = now;
    try {
      persist();
    } catch (err) {
      record.lastDrainedAt = previouslyDrainedAt;
      throw err;
    }
    return {
      entries,
      firstSequence,
      latestSequence: record.lastSequence,
      previouslyDrainedAt,
      drainedAt: now,
    };
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
  if (record.expiresAt !== null && record.expiresAt <= now) return null;
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
  logHints = new Map();
  blockedLogs = new Set();
  storeLoadFailed = false;
}
