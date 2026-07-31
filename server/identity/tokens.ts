// Identity & capabilities - the secret token store (implementation).
//
// In-memory ONLY (Phase 2.1, reviewed): raw tokens are never persisted, and a
// server restart kills the subprocess consumers (agents + cron runs) and
// regenerates their env on the next session anyway, so a persisted hash would
// be dead state until/unless externally long-lived tokens exist. The doc's
// "only a hash or token id is persisted" is the SECRECY rule (if persisted
// later, hash-only), not a mandate to persist now. (Doc follow-up filed so a
// security pass doesn't read this as an accidental omission.)
//
// Lifecycle (wired by the managers): agent tokens are minted on spawn and on
// restore/revive (rotation), revoked on kill; cron-run tokens are minted at run
// start and revoked on every terminal run path. Delivery is via env injection
// (ISOMUX_AGENT_TOKEN), used for BOTH agent and cron-run scopes - scope is
// resolved server-side, so the documented curl snippets don't branch.
//
// Imports only the stable identity surface (./index.ts) + the standard library,
// keeping this leaf-like (no auth-middleware / manager imports).

import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { agentCapabilities, RUN_CAPABILITIES, type Identity } from "./index.ts";

const TOKEN_BYTES = 32; // 256 bits of entropy, matching auth.ts session/invite tokens

interface StoredToken {
  scope: "agent" | "cron-run";
  hash: string; // sha256(raw) hex - the value compared at resolve time
  raw: string; // in-memory only; injected into subprocess env, NEVER persisted/logged
  userId: string | null;
  agentId?: string;
  cronjobId?: string;
  runId?: string;
  // AGENT scope only: stamps the privileged capability set into the resolved
  // identity (see agentCapabilities). Always false for cron-run. Bound at mint
  // time so changing the setting requires a re-mint (rotation), never a
  // per-request recompute.
  privileged: boolean;
}

// Primary store keyed by a stable store-key (agent:<id> / run:<job>:<run>) so
// the lifecycle owner can rotate/revoke by id. Secondary index maps the token
// hash to its store-key for O(1) resolve.
const byKey = new Map<string, StoredToken>();
const byHash = new Map<string, string>();

function agentKey(agentId: string): string {
  return `agent:${agentId}`;
}
function runKey(cronjobId: string, runId: string): string {
  return `run:${cronjobId}:${runId}`;
}

function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function hashOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Constant-time hex compare (both are 64-char sha256 hex). Mirrors auth.ts's
// safeHashEq so the resolve path doesn't open a timing side channel.
function safeHashEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function store(key: string, token: StoredToken): void {
  byKey.set(key, token);
  byHash.set(token.hash, key);
}

function remove(key: string): void {
  const existing = byKey.get(key);
  if (!existing) return;
  byHash.delete(existing.hash);
  byKey.delete(key);
}

// --- Agent tokens -----------------------------------------------------------

// Mint (or rotate) the agent's token. Re-minting for the same agentId revokes
// the prior token in the same call, so spawn/restore/revive all funnel here and
// "rotated on revive" falls out for free. `privileged` stamps the capability
// set the token resolves to - toggling the setting re-mints (revoking the old
// token), so a live agent MUST be session-swapped onto the new token or its
// in-flight one goes dead. Returns the raw secret to inject into the agent's
// session env.
export function mintAgentToken(
  agentId: string,
  userId: string | null,
  privileged = false,
): string {
  revokeAgentToken(agentId); // rotation: drop any prior token for this agent
  const { raw, hash } = newToken();
  store(agentKey(agentId), {
    scope: "agent",
    hash,
    raw,
    userId,
    agentId,
    privileged,
  });
  return raw;
}

// The current raw token for an agent, or null if none is live. Used by the
// env-injection chokepoint (agent-manager buildSessionEnv).
export function getAgentTokenRaw(agentId: string): string | null {
  return byKey.get(agentKey(agentId))?.raw ?? null;
}

export function revokeAgentToken(agentId: string): void {
  remove(agentKey(agentId));
}

// --- Cron-run tokens --------------------------------------------------------

// Mint a run token bound to {cronjobId, runId}. `userId` is the cronjob's
// creator (attribution; may be null for an unowned job).
export function mintRunToken(
  cronjobId: string,
  runId: string,
  userId: string | null,
): string {
  revokeRunToken(cronjobId, runId);
  const { raw, hash } = newToken();
  store(runKey(cronjobId, runId), {
    scope: "cron-run",
    hash,
    raw,
    userId,
    cronjobId,
    runId,
    privileged: false, // cron-run tokens are never privileged
  });
  return raw;
}

export function getRunTokenRaw(
  cronjobId: string,
  runId: string,
): string | null {
  return byKey.get(runKey(cronjobId, runId))?.raw ?? null;
}

export function revokeRunToken(cronjobId: string, runId: string): void {
  remove(runKey(cronjobId, runId));
}

// --- Resolution -------------------------------------------------------------

// Resolve a raw bearer token to its Identity, or null if it doesn't match a
// live token. Capabilities are derived from the stored scope, so a token can
// never carry more than its scope allows.
export function resolveToken(raw: string): Identity | null {
  if (!raw) return null;
  const hash = hashOf(raw);
  const key = byHash.get(hash);
  if (!key) return null;
  const token = byKey.get(key);
  if (!token) return null;
  if (!safeHashEq(token.hash, hash)) return null;
  return {
    scope: token.scope,
    userId: token.userId,
    agentId: token.agentId,
    cronjobId: token.cronjobId,
    runId: token.runId,
    role: "member", // inert filler for non-user scope (see Identity.role)
    // AGENT scope resolves to the baseline or privileged set by the token's
    // stamped flag; cron-run is always the run set. Scope itself never changes
    // (privilege only ADDS capabilities - no impersonation).
    capabilities:
      token.scope === "agent"
        ? agentCapabilities(token.privileged)
        : RUN_CAPABILITIES,
  };
}

// --- Redaction --------------------------------------------------------------

// Scrub any LIVE raw token embedded in arbitrary text. The primary secrecy
// guarantee is structural (the token only ever enters subprocess env, never a
// log/prompt/WS/diff path); this is a belt-and-suspenders helper for any
// diagnostic surface that might otherwise echo an env value. Only active tokens
// are scrubbed - a revoked token is no longer a live secret.
export function redactTokens(text: string): string {
  let out = text;
  for (const token of byKey.values()) {
    if (token.raw && out.includes(token.raw)) {
      out = out.split(token.raw).join("[redacted-token]");
    }
  }
  return out;
}

// Test-only: wipe the in-memory store between harness boots. Mirrors auth.ts's
// _testResetState / users.ts's _testResetUsers; wired into the harness reset.
export function _testResetTokens(): void {
  byKey.clear();
  byHash.clear();
}
