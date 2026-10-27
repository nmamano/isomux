// Fallback to the office sign-in (task 2008c993).
//
// When the owner turns it on, an agent that runs on its member's own sign-in
// and stops on a usage limit continues on the office sign-in until the
// member's limit resets. The state is per member and provider: all of the
// member's agents on that provider fall back, and a Claude stop that only
// one model family's weekly limit caused covers only sessions on that family.
// Schedule runs stay on the member's own sign-in, except OpenCode: one
// OpenCode server serves all of a member's OpenCode work, so her OpenCode
// schedule runs use the key her agents use.
//
// An entry also ends when the member's own account changes (a personal
// sign-in, sign-out or personal-provider switch): a counter per member and
// provider goes up at each change, and an entry counts only while it holds
// the counter of its start. provider-account-state.json stores no account
// identity, so the counter stands in for one.
//
// This module keeps the switch and the state. agent-manager does the rest:
// it starts an entry at a stop, and at each turn start it moves the agent's
// conversation to the account the state wants (alignAccount; design in task
// 2008c993).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackendType } from "../shared/types.ts";
import { STATE_ROOT } from "./config.ts";
import {
  atomicWriteFileSync,
  loadProviderFallback,
  saveProviderFallback,
} from "./persistence.ts";

export type FallbackProvider = AgentBackendType;

// The Claude model families that have their own weekly limit
// (SDKRateLimitInfo.rateLimitType seven_day_opus, seven_day_sonnet).
export type FallbackFamily = "opus" | "sonnet";

export type FallbackEntry = {
  // The member's reset time (epoch ms). For OpenCode, which reports none,
  // the time of the next try on the member's key.
  until: number;
  // Set for a model-scoped Claude stop: only sessions on this family fall
  // back.
  family?: FallbackFamily;
  // The member's account counter when the entry started.
  account: number;
};

// An account an agent session runs on: the account folder for Claude and
// Codex, the OPENCODE_API_KEY for OpenCode.
export type FallbackAccount = { dir: string } | { apiKey: string };

// OpenCode reports no reset time with most refusals: the member's key is
// tried again this long after the stop.
export const OPENCODE_FALLBACK_RETRY_MS = 60 * 60 * 1000;

/** The agent-facing message of the turn that continues a stopped turn on
 *  the office sign-in. The flush sends it as it is, with no prefix. */
export const FALLBACK_CONTINUE_TEXT =
  "[Isomux: your member's own sign-in reached its usage limit, so this conversation now runs on the office sign-in. Continue where you stopped.]";

export interface ProviderFallback {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  // The member's entry while it counts: its time is in the future and the
  // member's account counter has not moved. Else null.
  entry(userId: string, provider: FallbackProvider): FallbackEntry | null;
  // A stop on the member's own sign-in. Replaces an entry that is there.
  start(
    userId: string,
    provider: FallbackProvider,
    stop: { until: number; family?: FallbackFamily },
  ): void;
  // A personal sign-in, sign-out or personal-provider switch: the counter
  // goes up, so an entry that is there no longer counts.
  accountChanged(userId: string, provider: FallbackProvider): void;
}

export interface ProviderFallbackDeps {
  // The office switch (office-config.json providerFallback).
  load?: () => boolean;
  save?: (enabled: boolean) => void;
  // The entries and counters (provider-fallback.json in the state root).
  loadState?: () => unknown;
  saveState?: (state: unknown) => void;
  now?: () => number;
}

type FallbackState = {
  entries: Record<string, Partial<Record<FallbackProvider, FallbackEntry>>>;
  accounts: Record<string, Partial<Record<FallbackProvider, number>>>;
};

const PROVIDERS: readonly FallbackProvider[] = ["claude", "codex", "opencode"];
const FAMILIES: readonly FallbackFamily[] = ["opus", "sonnet"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The stored state, keeping only well-formed entries and counters. Anything
// else reads as no state.
function parseState(raw: unknown): FallbackState {
  const state: FallbackState = { entries: {}, accounts: {} };
  if (!isRecord(raw)) return state;
  if (isRecord(raw.entries)) {
    for (const [userId, byProvider] of Object.entries(raw.entries)) {
      if (!isRecord(byProvider)) continue;
      for (const provider of PROVIDERS) {
        const e = byProvider[provider];
        if (
          !isRecord(e) ||
          typeof e.until !== "number" ||
          !Number.isFinite(e.until) ||
          typeof e.account !== "number"
        )
          continue;
        const family = FAMILIES.find((f) => f === e.family);
        (state.entries[userId] ??= {})[provider] = {
          until: e.until,
          account: e.account,
          ...(family ? { family } : {}),
        };
      }
    }
  }
  if (isRecord(raw.accounts)) {
    for (const [userId, byProvider] of Object.entries(raw.accounts)) {
      if (!isRecord(byProvider)) continue;
      for (const provider of PROVIDERS) {
        const n = byProvider[provider];
        if (typeof n === "number" && Number.isSafeInteger(n))
          (state.accounts[userId] ??= {})[provider] = n;
      }
    }
  }
  return state;
}

export function createProviderFallback(
  deps: ProviderFallbackDeps = {},
): ProviderFallback {
  const now = deps.now ?? Date.now;
  let enabled = deps.load?.() ?? false;
  let state: FallbackState;
  try {
    state = parseState(deps.loadState?.());
  } catch {
    state = parseState(undefined);
  }
  const account = (userId: string, provider: FallbackProvider) =>
    state.accounts[userId]?.[provider] ?? 0;
  const save = () => {
    try {
      deps.saveState?.(state);
    } catch (err) {
      console.error(
        "[provider-fallback] Failed to save the fallback state:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  return {
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = next;
      deps.save?.(next);
    },
    entry(userId, provider) {
      const e = state.entries[userId]?.[provider];
      if (!e) return null;
      if (e.until <= now() || e.account !== account(userId, provider))
        return null;
      return { ...e };
    },
    start(userId, provider, stop) {
      (state.entries[userId] ??= {})[provider] = {
        until: stop.until,
        account: account(userId, provider),
        ...(stop.family ? { family: stop.family } : {}),
      };
      save();
    },
    accountChanged(userId, provider) {
      (state.accounts[userId] ??= {})[provider] = account(userId, provider) + 1;
      const entries = state.entries[userId];
      if (entries) {
        delete entries[provider];
        if (Object.keys(entries).length === 0) delete state.entries[userId];
      }
      save();
    },
  };
}

/** Whether an entry covers a session that runs on `modelFamily`. */
export function entryCovers(
  entry: FallbackEntry,
  modelFamily: string | undefined,
): boolean {
  return entry.family === undefined || entry.family === modelFamily;
}

/** The family of a model-scoped Claude stop, from the rate limit type the
 *  engine reported. Undefined for a stop that covers every model. */
export function claudeStopFamily(
  rateLimitType: string | undefined,
): FallbackFamily | undefined {
  if (rateLimitType === "seven_day_opus") return "opus";
  if (rateLimitType === "seven_day_sonnet") return "sonnet";
  return undefined;
}

const STATE_FILE = join(STATE_ROOT, "provider-fallback.json");

function loadStateFile(): unknown {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function saveStateFile(state: unknown): void {
  atomicWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2), 0o600);
}

let shared: ProviderFallback | null = null;

/** The office's fallback state. Built on first use. */
export function providerFallback(): ProviderFallback {
  shared ??= createProviderFallback({
    load: loadProviderFallback,
    save: saveProviderFallback,
    loadState: loadStateFile,
    saveState: saveStateFile,
  });
  return shared;
}

/** A server boot reads the switch and the state from its own state root. */
export function resetProviderFallback(): void {
  shared = null;
}

/** Tests swap the office's state and must put back exactly what they found. */
export function setProviderFallbackForTests(
  next: ProviderFallback | null,
): ProviderFallback | null {
  const previous = shared;
  shared = next;
  return previous;
}
