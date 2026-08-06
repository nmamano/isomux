// App tokens - the identity a registered app presents back to isomux.
// See internal-docs/agent-apps-design.md section 5.
//
// THE FIRST TOKENS THAT OUTLIVE THE PROCESS. Agent and cron-run tokens live in
// memory (server/identity/tokens.ts) and that is justified there by a fact that
// stops being true here: a restart kills every subprocess holding one, so a
// persisted token would be dead state. An app is a systemd unit that keeps
// running across an isomux restart, so its token has to survive one - the
// alternative is isomux bouncing every app at boot purely to re-inject, which
// throws away the reason to use systemd at all.
//
// So this store persists, and it persists ONLY THE HASH, per the secrecy rule
// stated in identity/tokens.ts. The plaintext exists for exactly as long as it
// takes to write it into the app's environment file; isomux does not keep it in
// memory and cannot reproduce it afterwards. Two consequences worth stating
// rather than discovering:
//   - There is no "show me my app's token" and there cannot be one.
//   - A token and its environment file are a PAIR. Either both exist and agree,
//     or the app has no token. A hash whose plaintext was lost is not a token,
//     it is an app that can never authenticate and cannot be repaired - which
//     is why provisioning failures revoke rather than leave the hash behind,
//     and why boot reconciliation rotates any pair that disagrees.
//
// WHAT THE TOKEN IS AND IS NOT WORTH. Every app runs as the SAME Unix account
// as isomux itself, so an app can read another app's environment file, this
// store, and the whole office state directory. Cross-app secrecy is NOT
// enforceable at this layer and nothing here claims it is. What the token
// carries is SCOPE: an identity that is neither its owner nor the agent that
// built it, holding no capabilities at all until the messaging slice grants it
// one. That is the property this module exists to keep true.

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import { APP_CAPABILITIES, type Identity } from "./identity/index.ts";

// --- constants --------------------------------------------------------------

// 256 bits, matching the agent/cron-run tokens and auth.ts's session tokens.
const TOKEN_BYTES = 32;

// The store holds hashes, not secrets - but it is a credential file by
// association and there is no reason for anything else on the box to read it.
export const APP_TOKEN_FILE_MODE = 0o600;
// The directory holds this file next to the app registry's own state.
export const APP_TOKEN_DIR_MODE = 0o700;

// base64url's alphabet, and the reason it is asserted rather than assumed: the
// plaintext is written into a systemd EnvironmentFile as a bare `KEY=value`
// line, where quoting rules would apply to spaces, quotes and backslashes. A
// token that needed quoting would be a token systemd read back differently from
// the one isomux hashed, so a value outside this alphabet is refused rather
// than written.
export const APP_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

// --- errors -----------------------------------------------------------------

export class AppTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppTokenError";
  }
}

// --- persistence ------------------------------------------------------------

interface StoredAppToken {
  hash: string; // sha256(raw) hex
  userId: string | null; // the app's owning user, for the resolved identity
  mintedAt: number;
}

type AppTokenFile = Record<string, StoredAppToken>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStoredToken = (v: unknown): v is StoredAppToken =>
  isPlainObject(v) &&
  typeof v.hash === "string" &&
  /^[0-9a-f]{64}$/.test(v.hash) &&
  (v.userId === null || typeof v.userId === "string") &&
  typeof v.mintedAt === "number" &&
  Number.isFinite(v.mintedAt);

function hashOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Constant-time hex compare, same as identity/tokens.ts: the resolve path must
// not leak how much of a guessed token was right.
function safeHashEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --- the store --------------------------------------------------------------

export interface AppTokenStore {
  // Mint a token for an app, replacing any it already had. Returns the
  // plaintext - the ONLY moment it exists. Throws AppTokenError if the store
  // cannot be read or written; the caller decides what an app with no token
  // means (register: the app still installs and runs).
  mint(appName: string, userId: string | null): string;
  // Drop an app's token. Idempotent.
  revoke(appName: string): void;
  // Does this plaintext match a stored hash? Used by boot reconciliation to
  // check an environment file against the store - a real integrity check, not a
  // presence check.
  matches(appName: string, raw: string): boolean;
  // Resolve a plaintext to its app, or null. Never throws: an unreadable store
  // resolves NOTHING (deny), because the alternative is a credential file
  // failure turning into an authorization failure of the wrong sign.
  lookup(raw: string): { appName: string; userId: string | null } | null;
  // Every app that currently holds a token, for reconciliation's prune pass.
  names(): string[];
}

export interface AppTokenStoreOptions {
  // Defaults to STATE_ROOT/apps, beside the registry's own state.
  dir?: string;
  now?: () => number;
  // Test seam: the raw-token generator.
  mintRaw?: () => string;
}

export function createAppTokenStore(
  options: AppTokenStoreOptions = {},
): AppTokenStore {
  const dir = resolve(options.dir ?? join(STATE_ROOT, "apps"));
  const file = join(dir, "app-tokens.json");
  const now = options.now ?? (() => Date.now());
  const mintRaw =
    options.mintRaw ?? (() => randomBytes(TOKEN_BYTES).toString("base64url"));

  // Read + validate the whole file. A MISSING file is an empty store (no app
  // has a token yet); anything present but unreadable or malformed THROWS, and
  // every caller either denies or refuses to write. What must never happen is
  // the tempting third option - treating a corrupt file as empty - because the
  // next mint would then rewrite it and silently revoke every other app's
  // token.
  const load = (): AppTokenFile => {
    if (!existsSync(file)) return {};
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch (err) {
      throw new AppTokenError(
        `${file} cannot be read (${(err as Error).message}); app tokens are unavailable`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppTokenError(`${file} is not valid JSON`);
    }
    if (!isPlainObject(parsed)) {
      throw new AppTokenError(`${file} is not a JSON object`);
    }
    for (const [name, record] of Object.entries(parsed)) {
      if (!isStoredToken(record)) {
        throw new AppTokenError(`${file} holds an invalid entry for "${name}"`);
      }
    }
    return parsed as AppTokenFile;
  };

  const save = (contents: AppTokenFile): void => {
    try {
      // The directory before the file: atomicWriteFileSync would create it at
      // the ambient umask, and this one holds credential material.
      mkdirSync(dir, { recursive: true, mode: APP_TOKEN_DIR_MODE });
      atomicWriteFileSync(
        file,
        JSON.stringify(contents, null, 2),
        APP_TOKEN_FILE_MODE,
      );
    } catch (err) {
      console.error(`[app-tokens] failed to write ${file}:`, err);
      throw new AppTokenError(
        "the app token store could not be written; inspect server logs",
      );
    }
  };

  return {
    mint(appName, userId) {
      const contents = load(); // throws on corruption: never clobber
      const raw = mintRaw();
      if (!APP_TOKEN_PATTERN.test(raw)) {
        // A generator that produced something needing env-file quoting. Refused
        // here rather than written, so what systemd reads back and what isomux
        // hashed can never disagree.
        throw new AppTokenError(
          "generated app token contains characters that cannot be written to an environment file",
        );
      }
      contents[appName] = { hash: hashOf(raw), userId, mintedAt: now() };
      save(contents);
      return raw;
    },

    revoke(appName) {
      const contents = load();
      if (!(appName in contents)) return;
      delete contents[appName];
      save(contents);
    },

    matches(appName, raw) {
      let stored: StoredAppToken | undefined;
      try {
        stored = load()[appName];
      } catch {
        return false;
      }
      return stored ? safeHashEq(stored.hash, hashOf(raw)) : false;
    },

    lookup(raw) {
      if (!raw) return null;
      let contents: AppTokenFile;
      try {
        contents = load();
      } catch (err) {
        // Deny, loudly. A resolve happens on a request path, so this must not
        // throw into the transport - but an unreadable credential store is not
        // something to swallow silently either.
        console.error("[app-tokens] cannot resolve, store unreadable:", err);
        return null;
      }
      const hash = hashOf(raw);
      for (const [appName, record] of Object.entries(contents)) {
        if (safeHashEq(record.hash, hash)) {
          return { appName, userId: record.userId };
        }
      }
      return null;
    },

    names() {
      try {
        return Object.keys(load());
      } catch {
        return [];
      }
    },
  };
}

// Production singleton over STATE_ROOT/apps. Touches no disk until used.
export const appTokens: AppTokenStore = createAppTokenStore();

// --- identity ---------------------------------------------------------------

// Resolve a bearer to an APP identity, or null. Wired into the ONE bearer
// resolution point (auth-middleware), after the in-memory agent/cron-run store.
//
// The identity carries no capabilities (APP_CAPABILITIES), so it authenticates
// and authorizes nothing; `role` is the same inert least-privilege filler the
// other non-user scopes use.
//
// DELIBERATELY NOT CHECKED HERE: whether the app is still registered. In this
// slice an app identity can reach no route at all, so a hash that outlived its
// app is a valid-but-powerless identity rather than a hole - and the two paths
// that could leave one behind are both closed (delete revokes; boot
// reconciliation prunes hashes with no app). The slice that grants the token an
// actual capability is the one that must resolve the app RECORD anyway, to know
// which agent it may message, and that is where existence gets enforced.
export function appIdentityFromToken(
  raw: string,
  store: AppTokenStore = appTokens,
): Identity | null {
  const found = store.lookup(raw);
  if (!found) return null;
  return {
    scope: "app",
    userId: found.userId,
    appName: found.appName,
    role: "member",
    capabilities: APP_CAPABILITIES,
  };
}
