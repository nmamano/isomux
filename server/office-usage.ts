// Weekly usage of the OFFICE sign-in, read straight from the provider for the
// member usage cap (internal-docs/usage-caps-design.md). Not the per-agent
// subscription pill: that reading needs a live session and does not say which
// account it describes. This one reads the office account directory itself.
//
// One warm reader process per provider, closed after a quiet spell. Every
// answer, failed included, counts for FRESH_MS. An older one under FALLBACK_MS
// still answers at once while a probe that concurrent callers share reads a
// new one; with none, the caller waits for that probe. A failed answer stands
// for the last good reading if that is under FALLBACK_MS old, else it is
// failed, and the cap lets a failed reading through (Nil's ruling,
// 2026-10-02).

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { ProviderAccountProvider } from "../shared/types.ts";
import type { SubscriptionUsageWindow } from "./backends/types.ts";
import { CLAUDE_NATIVE_BIN } from "./engine-binaries.ts";
import {
  CLAUDE_LAUNCH_SETTINGS,
  normalizeClaudeSubscriptionUsage,
  USAGE_LIMITS_ONLY,
} from "./backends/claude.ts";
import { withAgentSpawn } from "./backends/claude/agent-spawn.ts";
import { JsonRpcLiteClient } from "./backends/codex/client.ts";
import {
  CODEX_LEGACY_LIMIT_KEY,
  CODEX_PREFERRED_LIMIT_ID,
  normalizeCodexSubscriptionUsage,
} from "./backends/codex/adapter.ts";
import type { GetAccountResponse } from "./backends/codex/_generated/v2/GetAccountResponse.ts";
import type { GetAccountRateLimitsResponse } from "./backends/codex/_generated/v2/GetAccountRateLimitsResponse.ts";
import type { RateLimitSnapshot } from "./backends/codex/_generated/v2/RateLimitSnapshot.ts";
import type { RateLimitWindow } from "./backends/codex/_generated/v2/RateLimitWindow.ts";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const FRESH_MS = 60_000;
export const FALLBACK_MS = 60 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const IDLE_CLOSE_MS = 10 * 60_000;
// Slack on the far edge of a valid reset time: a reset more than a week and an
// hour away is not a weekly window.
const RESET_SLACK_MS = 60 * 60_000;
const CODEX_WEEK_MINUTES = 10_080;

// What a probe learned. `no_limit` is the provider's own statement that the
// account has no plan limit (API key, Bedrock, Vertex). With `signed_out` or
// `failed` the cap cannot measure the account and lets members through;
// signed_out only drops the status line.
export type OfficeWeeklyOutcome =
  | {
      kind: "weekly";
      usedPercent: number;
      resetsAtMs: number;
      observedAtMs: number;
    }
  | { kind: "no_limit"; observedAtMs: number }
  | { kind: "signed_out" }
  | { kind: "failed" };

type GoodOutcome = Extract<OfficeWeeklyOutcome, { observedAtMs: number }>;

// One probe's answer, before it is stamped and checked against the clock.
export type ProbeResult =
  | { kind: "weekly"; usedPercent: number; resetsAtMs: number }
  | { kind: "no_limit" }
  | { kind: "signed_out" }
  | { kind: "failed" };

export interface OfficeUsageProbe {
  read(): Promise<ProbeResult>;
  close(): void;
}

function validPercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

// The experimental Claude /usage answer -> the weekly outcome. Exported for
// tests. Only `seven_day` counts; the 5-hour and per-model windows do not. A
// `seven_day` sent as null (a team plan) means the account has no weekly
// window; a missing key is an answer we do not know.
export function parseClaudeWeekly(raw: unknown): ProbeResult {
  if (!raw || typeof raw !== "object") return { kind: "failed" };
  const resp = raw as {
    rate_limits_available?: unknown;
    rate_limits?: unknown;
  };
  if (resp.rate_limits_available === false) return { kind: "no_limit" };
  if (resp.rate_limits_available !== true) return { kind: "failed" };
  const limits = resp.rate_limits;
  if (!limits || typeof limits !== "object") return { kind: "failed" };
  const week = (limits as Record<string, unknown>).seven_day as
    { utilization?: unknown; resets_at?: unknown } | null | undefined;
  if (week === null) return { kind: "no_limit" };
  if (!week || !validPercent(week.utilization)) return { kind: "failed" };
  const resetsAtMs =
    typeof week.resets_at === "string" ? Date.parse(week.resets_at) : NaN;
  if (!Number.isFinite(resetsAtMs)) return { kind: "failed" };
  return { kind: "weekly", usedPercent: week.utilization, resetsAtMs };
}

// Whether a Codex login has plan usage limits. Only a ChatGPT login has
// them. The switch is exhaustive, so a login type that a new Codex adds fails
// the typecheck until it is sorted here. At runtime, an unknown type takes
// the rate-limit path, never "no limit".
function codexAccountHasPlanLimits(
  account: NonNullable<GetAccountResponse["account"]>,
): boolean {
  switch (account.type) {
    case "apiKey":
    case "amazonBedrock":
    case "gcp":
      return false;
    case "chatgpt":
      return true;
    default: {
      const unsorted: never = account;
      void unsorted;
      return true;
    }
  }
}

// Codex account + rate limits -> the weekly outcome. Exported for tests. The
// weekly window is the one 10080 minutes long, whichever slot it rides in (a
// Pro plan sends it as `primary`). Windows that are all of another length (the
// free plan's 30-day window) mean the plan has no weekly window.
export function parseCodexWeekly(
  account: GetAccountResponse["account"],
  limits: GetAccountRateLimitsResponse | null,
): ProbeResult {
  if (!account) return { kind: "signed_out" };
  if (!codexAccountHasPlanLimits(account)) return { kind: "no_limit" };
  if (!limits) return { kind: "failed" };
  const snapshot: RateLimitSnapshot | undefined =
    limits.rateLimitsByLimitId?.[CODEX_PREFERRED_LIMIT_ID] ??
    limits.rateLimitsByLimitId?.[CODEX_LEGACY_LIMIT_KEY] ??
    limits.rateLimits;
  if (!snapshot) return { kind: "failed" };
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (win): win is RateLimitWindow => !!win,
  );
  const win = windows.find((w) => w.windowDurationMins === CODEX_WEEK_MINUTES);
  if (!win) {
    // No window, or one of unknown length (it could be the weekly one), says
    // nothing about the plan.
    const known = windows.every(
      (w) =>
        typeof w.windowDurationMins === "number" &&
        Number.isFinite(w.windowDurationMins),
    );
    return windows.length > 0 && known
      ? { kind: "no_limit" }
      : { kind: "failed" };
  }
  if (!validPercent(win.usedPercent)) return { kind: "failed" };
  if (typeof win.resetsAt !== "number" || !Number.isFinite(win.resetsAt))
    return { kind: "failed" };
  return {
    kind: "weekly",
    usedPercent: win.usedPercent,
    resetsAtMs: win.resetsAt * 1000,
  };
}

type UsageQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (opts?: {
    skipBehaviors?: boolean;
  }) => Promise<unknown>;
  accountInfo?: () => Promise<unknown>;
  close?: () => void;
};

// ---------------------------------------------------------------------------
// The account usage reader (task 3e70b6d4): the same reader for every
// provider account the office's agents can run on, keyed by the usage key
// (server/usage-account.ts). The office slots keep the cap's rules above
// and a warm process; the owners' card reads the same slot, so the office
// account never has a second process. A member's slot is one-shot: its
// process closes after the answer.

// Everything one provider answer says about an account: all its windows.
export type AccountReading =
  | { kind: "usage"; plan: string | null; windows: SubscriptionUsageWindow[] }
  | { kind: "no_limit" }
  | { kind: "signed_out" }
  | { kind: "failed" };

// One probe's answer: the cap's weekly projection and the full reading,
// from the same provider answer, plus who the account is (its email), or
// null when the provider does not say.
export type AccountProbeResult = {
  weekly: ProbeResult;
  reading: AccountReading;
  identity: string | null;
};

export interface AccountUsageProbe {
  read(): Promise<AccountProbeResult>;
  close(): void;
}

// The email of a Claude accountInfo answer, by the sign-in card's rules
// (ClaudeAccountClient.read): none for an account another provider
// authenticates (Bedrock, Vertex).
function claudeIdentity(accountInfo: unknown): string | null {
  if (!accountInfo || typeof accountInfo !== "object") return null;
  const value = accountInfo as Record<string, unknown>;
  if (
    typeof value.apiProvider === "string" &&
    value.apiProvider.length > 0 &&
    value.apiProvider !== "firstParty"
  )
    return null;
  if (value.tokenSource === "none") return null;
  return typeof value.email === "string" && value.email.length > 0
    ? value.email
    : null;
}

// The Claude /usage answer and accountInfo answer -> the probe result.
export function claudeAccountProbeResult(
  usage: unknown,
  accountInfo: unknown,
): AccountProbeResult {
  const weekly = parseClaudeWeekly(usage);
  const identity = claudeIdentity(accountInfo);
  if (
    usage &&
    typeof usage === "object" &&
    (usage as { rate_limits_available?: unknown }).rate_limits_available ===
      false
  )
    return { weekly, reading: { kind: "no_limit" }, identity };
  const normalized = normalizeClaudeSubscriptionUsage(usage);
  return {
    weekly,
    reading:
      normalized.kind === "usage"
        ? { kind: "usage", ...normalized.usage }
        : { kind: "failed" },
    identity,
  };
}

// The Codex account/read and account/rateLimits/read answers -> the probe
// result. The snapshot is the cap's (parseCodexWeekly).
export function codexAccountProbeResult(
  account: GetAccountResponse["account"],
  limits: GetAccountRateLimitsResponse | null,
): AccountProbeResult {
  const weekly = parseCodexWeekly(account, limits);
  if (!account)
    return { weekly, reading: { kind: "signed_out" }, identity: null };
  const identity =
    account.type === "chatgpt" &&
    typeof account.email === "string" &&
    account.email.length > 0
      ? account.email
      : null;
  if (!codexAccountHasPlanLimits(account))
    return { weekly, reading: { kind: "no_limit" }, identity };
  const snapshot =
    limits?.rateLimitsByLimitId?.[CODEX_PREFERRED_LIMIT_ID] ??
    limits?.rateLimitsByLimitId?.[CODEX_LEGACY_LIMIT_KEY] ??
    limits?.rateLimits;
  const normalized = normalizeCodexSubscriptionUsage(snapshot);
  return {
    weekly,
    reading:
      normalized.kind === "usage"
        ? { kind: "usage", ...normalized.usage }
        : { kind: "failed" },
    identity,
  };
}

// A standalone SDK query with no prompt: it reads the account the
// CLAUDE_CONFIG_DIR in `env` is signed in to, and never starts a conversation.
export function claudeAccountProbe(
  env: Record<string, string | undefined>,
  createQuery: (params: Parameters<typeof query>[0]) => unknown = query,
): AccountUsageProbe {
  const abortController = new AbortController();
  // Never yields a prompt; it ends when the probe closes.
  async function* input(): AsyncGenerator<never> {
    await new Promise<void>((resolve) =>
      abortController.signal.addEventListener("abort", () => resolve()),
    );
    if (!abortController.signal.aborted) yield undefined as never;
  }
  const q = createQuery({
    prompt: input(),
    options: withAgentSpawn({
      cwd: tmpdir(),
      env,
      settingSources: [],
      strictMcpConfig: true,
      settings: CLAUDE_LAUNCH_SETTINGS,
      pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
      abortController,
    }),
  }) as UsageQuery;
  return {
    async read() {
      const usage = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      // A lost SDK method is not proof of "no limit": deny.
      if (typeof usage !== "function")
        return claudeAccountProbeResult(null, null);
      const info = q.accountInfo;
      // The email only names the row: a failed accountInfo leaves it out.
      const [raw, account] = await Promise.all([
        usage.call(q, USAGE_LIMITS_ONLY),
        typeof info === "function"
          ? info.call(q).catch(() => null)
          : Promise.resolve(null),
      ]);
      return claudeAccountProbeResult(raw, account);
    },
    close() {
      abortController.abort();
      try {
        q.close?.();
      } catch {}
    },
  };
}

// The cap's view of claudeAccountProbe: the weekly projection only.
export function claudeOfficeProbe(
  env: Record<string, string | undefined>,
  createQuery: (params: Parameters<typeof query>[0]) => unknown = query,
): OfficeUsageProbe {
  return weeklyProbe(claudeAccountProbe(env, createQuery));
}

// A standalone Codex app-server on the account's CODEX_HOME. It reads the
// plan of the stored sign-in, so an OPENAI_API_KEY does not sign it in.
export function codexAccountProbe(
  env: Record<string, string | undefined>,
): AccountUsageProbe {
  const client = new JsonRpcLiteClient({ env, envApiKeyLogin: false });
  let started: Promise<void> | null = null;
  return {
    async read() {
      started ??= (async () => {
        await client.start();
        await client.initialize({
          clientInfo: { name: "isomux", version: "1", title: null },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: null,
          },
        });
      })();
      await started;
      const account = await client.request<GetAccountResponse>("account/read", {
        refreshToken: false,
      });
      if (!account.account || account.account.type !== "chatgpt")
        return codexAccountProbeResult(account.account, null);
      const limits = await client.request<GetAccountRateLimitsResponse>(
        "account/rateLimits/read",
        undefined,
      );
      return codexAccountProbeResult(account.account, limits);
    },
    close() {
      void client.close().catch(() => {});
    },
  };
}

// The cap's view of codexAccountProbe: the weekly projection only.
export function codexOfficeProbe(
  env: Record<string, string | undefined>,
): OfficeUsageProbe {
  return weeklyProbe(codexAccountProbe(env));
}

function weeklyProbe(probe: AccountUsageProbe): OfficeUsageProbe {
  return {
    read: async () => (await probe.read()).weekly,
    close: () => probe.close(),
  };
}

// A cap-only probe as an account probe: its reading is the weekly window.
function accountProbe(probe: OfficeUsageProbe): AccountUsageProbe {
  return {
    async read() {
      const weekly = await probe.read();
      const reading: AccountReading =
        weekly.kind === "weekly"
          ? {
              kind: "usage",
              plan: null,
              windows: [
                {
                  label: "Weekly",
                  shortLabel: "WK",
                  usedPercent: weekly.usedPercent,
                  resetsAtMs: weekly.resetsAtMs,
                },
              ],
            }
          : weekly;
      return { weekly, reading, identity: null };
    },
    close: () => probe.close(),
  };
}

export interface OfficeUsageReaderDeps {
  // The office sign-in for this provider: its account directory and the env a
  // reader process needs to use it. Throws when the office env cannot load.
  officeTarget: (provider: ProviderAccountProvider) => {
    dir: string;
    env: Record<string, string | undefined>;
  };
  createProbe?: (
    provider: ProviderAccountProvider,
    env: Record<string, string | undefined>,
  ) => OfficeUsageProbe;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface OfficeUsageReader {
  // The last answer if under FRESH_MS old. Else a probe shared with
  // concurrent callers starts, and the caller gets the last answer at once if
  // it is under FALLBACK_MS old (a weekly one only until its reset), or waits
  // for the probe. A failed answer stands for the last good reading while
  // that is under FALLBACK_MS old.
  read(provider: ProviderAccountProvider): Promise<OfficeWeeklyOutcome>;
  // Drop the last answer, the last good reading and the warm process, e.g.
  // after the office signs in or out.
  invalidate(provider: ProviderAccountProvider): void;
  close(): void;
}

// The cap's reader alone, keyed by the office directory and the whole env
// it runs with, so a changed office variable (an API key, a cloud switch) is
// a different account even in the same directory. The office uses
// createAccountUsageReader, which serves the cap and the owners' card.
export function createOfficeUsageReader(
  deps: OfficeUsageReaderDeps,
): OfficeUsageReader {
  const createProbe =
    deps.createProbe ??
    ((provider, env) =>
      provider === "claude" ? claudeOfficeProbe(env) : codexOfficeProbe(env));
  return createReader({
    officeKey: (provider) => {
      try {
        const target = deps.officeTarget(provider);
        const entries = Object.entries(target.env)
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => a.localeCompare(b));
        const envHash = createHash("sha256")
          .update(JSON.stringify(entries))
          .digest("hex");
        return { key: `${target.dir}\0${envHash}`, env: target.env };
      } catch {
        return null;
      }
    },
    createProbe: (provider, env) => accountProbe(createProbe(provider, env)),
    maxMemberProbes: DEFAULT_MAX_MEMBER_PROBES,
    now: deps.now ?? Date.now,
    setTimer: deps.setTimer ?? defaultSetTimer,
  });
}

// An account to read: its usage key, provider, the env a session on it gets,
// and whether its process stays warm (the office sign-in) or closes after
// the answer (a member's).
export type AccountUsageTarget = {
  key: string;
  provider: ProviderAccountProvider;
  env: Record<string, string | undefined>;
  warm: boolean;
};

// What a slot says about its account. A failed read stands for the last good
// reading under FALLBACK_MS, with that reading's observedAtMs.
export type AccountUsageAnswer = {
  reading: AccountReading;
  identity: string | null;
  observedAtMs: number | null;
};

export interface AccountUsageReaderDeps {
  // As OfficeUsageReaderDeps.officeTarget. The office slot of a provider is
  // the slot of keyOf(provider, env), shared with readAccount.
  officeTarget: (provider: ProviderAccountProvider) => {
    dir: string;
    env: Record<string, string | undefined>;
  };
  createProbe?: (
    provider: ProviderAccountProvider,
    env: Record<string, string | undefined>,
  ) => AccountUsageProbe;
  // The usage key of an account (usageAccountKey). Injected: importing it
  // here closes an import cycle through member-usage-cap.ts.
  keyOf: (
    provider: ProviderAccountProvider,
    env: Record<string, string | undefined>,
  ) => string | null;
  // At most this many member (non-warm) probes at once; default 3. Office
  // reads have their own lane.
  maxMemberProbes?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface AccountUsageReader extends OfficeUsageReader {
  // What the slot of `key` holds now, and whether a read for it runs.
  peek(key: string): { answer: AccountUsageAnswer | null; reading: boolean };
  // The slot's answer if under FRESH_MS old (refresh: REFRESH_FLOOR_MS),
  // else a read shared with concurrent callers of the same key.
  readAccount(
    target: AccountUsageTarget,
    opts?: { refresh?: boolean },
  ): Promise<AccountUsageAnswer>;
  // Drop every non-office slot whose key is not in `keys`.
  retain(keys: ReadonlySet<string>): void;
}

export const REFRESH_FLOOR_MS = 10_000;
const DEFAULT_MAX_MEMBER_PROBES = 3;

function defaultSetTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function createAccountUsageReader(
  deps: AccountUsageReaderDeps,
): AccountUsageReader {
  const keyOf = deps.keyOf;
  const createProbe =
    deps.createProbe ??
    ((provider, env) =>
      provider === "claude" ? claudeAccountProbe(env) : codexAccountProbe(env));
  return createReader({
    officeKey: (provider) => {
      try {
        const env = deps.officeTarget(provider).env;
        const key = keyOf(provider, env);
        return key === null ? null : { key, env };
      } catch {
        return null;
      }
    },
    createProbe,
    maxMemberProbes: deps.maxMemberProbes ?? DEFAULT_MAX_MEMBER_PROBES,
    now: deps.now ?? Date.now,
    setTimer: deps.setTimer ?? defaultSetTimer,
  });
}

function createReader(deps: {
  officeKey: (
    provider: ProviderAccountProvider,
  ) => { key: string; env: Record<string, string | undefined> } | null;
  createProbe: (
    provider: ProviderAccountProvider,
    env: Record<string, string | undefined>,
  ) => AccountUsageProbe;
  maxMemberProbes: number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => () => void;
}): AccountUsageReader {
  const { now, setTimer } = deps;

  type Slot = {
    key: string;
    provider: ProviderAccountProvider;
    generation: number;
    // The last answer of any kind, and when it was read.
    answer: {
      outcome: OfficeWeeklyOutcome;
      account: AccountUsageAnswer;
      at: number;
    } | null;
    // The last weekly or no_limit reading, for a failed probe to fall back on.
    lastGood: GoodOutcome | null;
    // The last reading that was not failed, for the card's fallback.
    lastGoodAccount: AccountUsageAnswer | null;
    inFlight: Promise<void> | null;
    probe: AccountUsageProbe | null;
    cancelIdle: (() => void) | null;
  };
  const slots = new Map<string, Slot>();
  // The office slot's key per provider, as last resolved.
  const officeKeys = new Map<ProviderAccountProvider, string>();
  // The member lane: reads running, and the ones waiting for a place.
  let memberRunning = 0;
  const memberQueue: (() => void)[] = [];

  function isOffice(slot: Slot): boolean {
    return officeKeys.get(slot.provider) === slot.key;
  }

  // The slot of `key`, made if missing.
  function slotFor(provider: ProviderAccountProvider, key: string): Slot {
    let slot = slots.get(key);
    if (!slot) {
      slot = {
        key,
        provider,
        generation: 0,
        answer: null,
        lastGood: null,
        lastGoodAccount: null,
        inFlight: null,
        probe: null,
        cancelIdle: null,
      };
      slots.set(key, slot);
    }
    return slot;
  }

  // The office slot of a provider. When the office key moved, the old slot
  // goes: nothing from the old account may answer as the office.
  function officeSlot(
    provider: ProviderAccountProvider,
  ): { slot: Slot; env: Record<string, string | undefined> } | null {
    const target = officeTarget(provider);
    if (!target) return null;
    return { slot: slotFor(provider, target.key), env: target.env };
  }

  // The office key of a provider, as of now.
  function officeTarget(
    provider: ProviderAccountProvider,
  ): { key: string; env: Record<string, string | undefined> } | null {
    const target = deps.officeKey(provider);
    const previous = officeKeys.get(provider);
    if (previous !== undefined && previous !== target?.key) {
      const old = slots.get(previous);
      officeKeys.delete(provider);
      if (old) drop(old);
    }
    if (target) officeKeys.set(provider, target.key);
    return target;
  }

  // Take the slot out of the reader: its read in flight no longer lands.
  function drop(slot: Slot): void {
    slot.generation++;
    dropProbe(slot);
    if (slots.get(slot.key) === slot) slots.delete(slot.key);
  }

  function dropProbe(slot: Slot): void {
    slot.cancelIdle?.();
    slot.cancelIdle = null;
    slot.probe?.close();
    slot.probe = null;
  }

  function armIdleClose(slot: Slot): void {
    slot.cancelIdle?.();
    slot.cancelIdle = setTimer(() => {
      slot.cancelIdle = null;
      slot.probe?.close();
      slot.probe = null;
    }, IDLE_CLOSE_MS);
  }

  // A probe that closes only once, whichever path closes it.
  function closeOnce(probe: AccountUsageProbe): AccountUsageProbe {
    let closed = false;
    return {
      read: () => probe.read(),
      close() {
        if (closed) return;
        closed = true;
        probe.close();
      },
    };
  }

  // The cap's rule: the last answer if it is at most `maxAge` old. A reset
  // already past means the reading predates a rollover: it never answers.
  function kept(slot: Slot, at: number, maxAge: number): boolean {
    const answer = slot.answer;
    if (!answer || at - answer.at > maxAge) return false;
    const outcome = answer.outcome;
    return outcome.kind !== "weekly" || outcome.resetsAtMs > at;
  }

  // What the last answer says now: a failed one stands for the last good
  // reading while that is eligible.
  function keptAnswer(slot: Slot, at: number): OfficeWeeklyOutcome {
    const outcome = slot.answer!.outcome;
    return outcome.kind === "failed"
      ? (fallback(slot, at) ?? outcome)
      : outcome;
  }

  // The last good reading, if under FALLBACK_MS old and, for a weekly one,
  // its reset is still ahead.
  function fallback(slot: Slot, at: number): GoodOutcome | null {
    const last = slot.lastGood;
    if (!last || at - last.observedAtMs >= FALLBACK_MS) return null;
    if (last.kind === "weekly" && last.resetsAtMs <= at) return null;
    return last;
  }

  // The card's view of the last answer: a failed one stands for the last
  // reading that was not, while that is under FALLBACK_MS old.
  function accountAnswer(slot: Slot, at: number): AccountUsageAnswer | null {
    const answer = slot.answer?.account;
    if (!answer || answer.reading.kind !== "failed") return answer ?? null;
    const last = slot.lastGoodAccount;
    if (
      last &&
      last.observedAtMs !== null &&
      at - last.observedAtMs < FALLBACK_MS
    )
      return last;
    return answer;
  }

  function settle(result: ProbeResult, at: number): OfficeWeeklyOutcome {
    if (result.kind === "no_limit")
      return { kind: "no_limit", observedAtMs: at };
    if (result.kind !== "weekly") return result;
    if (
      result.resetsAtMs <= at ||
      result.resetsAtMs > at + WEEK_MS + RESET_SLACK_MS
    )
      return { kind: "failed" };
    return { ...result, observedAtMs: at };
  }

  // A place in the member lane; office reads never wait for one. Answers
  // at once when there is a place, so the read starts in the caller's tick.
  function enterLane(office: boolean): (() => void) | Promise<() => void> {
    if (office) return () => {};
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      const next = memberQueue.shift();
      // The place passes straight to the next read.
      if (next) next();
      else memberRunning--;
    };
    if (memberRunning < deps.maxMemberProbes) {
      memberRunning++;
      return leave;
    }
    return new Promise((resolve) => memberQueue.push(() => resolve(leave)));
  }

  async function probeOnce(
    slot: Slot,
    env: Record<string, string | undefined>,
    warm: boolean,
  ): Promise<void> {
    const generation = slot.generation;
    const lane = enterLane(warm);
    const leave = typeof lane === "function" ? lane : await lane;
    let probe: AccountUsageProbe | null = null;
    let cancelTimeout: (() => void) | null = null;
    let result: AccountProbeResult;
    // Why a read failed, for its log line.
    let cause = "failed reading";
    const startedAt = now();
    try {
      // A slot dropped while it waited for its place reads nothing.
      if (slot.generation !== generation) return;
      // Inside the try: a process that cannot even start is a failed read.
      slot.probe ??= closeOnce(deps.createProbe(slot.provider, env));
      probe = slot.probe;
      result = await Promise.race([
        probe.read(),
        new Promise<AccountProbeResult>((resolve) => {
          cancelTimeout = setTimer(() => {
            cause = "timeout";
            resolve(FAILED_RESULT);
          }, PROBE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      cause = `threw: ${oneLine(error)}`;
      result = FAILED_RESULT;
    } finally {
      (cancelTimeout as (() => void) | null)?.();
      leave();
    }
    // A failure may mean the process died: start a new one next time. A
    // member's process closes after every answer.
    if ((result.weekly.kind === "failed" || !warm) && probe) {
      probe.close();
      if (slot.probe === probe) {
        slot.cancelIdle?.();
        slot.cancelIdle = null;
        slot.probe = null;
      }
    }
    const at = now();
    // No key, directory or email: the key names the sign-in's directory.
    if (result.reading.kind === "failed")
      console.warn(
        `[account-usage] ${slot.provider} ${warm ? "office" : "member"} account: usage read failed (${cause}) after ${at - startedAt} ms`,
      );
    if (slots.get(slot.key) !== slot || slot.generation !== generation) return;
    const outcome = settle(result.weekly, at);
    const failed = result.reading.kind === "failed";
    const account: AccountUsageAnswer = {
      reading: result.reading,
      identity: failed ? null : result.identity,
      observedAtMs: failed ? null : at,
    };
    slot.answer = { outcome, account, at };
    if (outcome.kind === "weekly" || outcome.kind === "no_limit")
      slot.lastGood = outcome;
    if (!failed) slot.lastGoodAccount = account;
    if (slot.probe) armIdleClose(slot);
  }

  // The read in flight of the slot, or a new one.
  function flightOf(
    slot: Slot,
    env: Record<string, string | undefined>,
    warm: boolean,
  ): Promise<void> {
    if (slot.inFlight) return slot.inFlight;
    const started = probeOnce(slot, env, warm).finally(() => {
      if (slot.inFlight === started) slot.inFlight = null;
    });
    // No caller may await it: Bun kills the process on an unhandled
    // rejection.
    started.catch(() => {});
    slot.inFlight = started;
    return started;
  }

  return {
    async read(provider) {
      // An answer counts only if the account it was read for is still the
      // office's when it arrives: an invalidation or an office change during
      // the probe sends the caller round again, never the old answer.
      for (let attempt = 0; attempt < 3; attempt++) {
        const office = officeSlot(provider);
        if (!office) return { kind: "failed" };
        const { slot, env } = office;
        const generation = slot.generation;
        if (kept(slot, now(), FRESH_MS)) return keptAnswer(slot, now());
        const flight = flightOf(slot, env, true);
        if (kept(slot, now(), FALLBACK_MS)) return keptAnswer(slot, now());
        await flight;
        if (
          slots.get(slot.key) === slot &&
          slot.generation === generation &&
          deps.officeKey(provider)?.key === slot.key &&
          slot.answer
        ) {
          const outcome = slot.answer.outcome;
          return outcome.kind === "failed"
            ? (fallback(slot, now()) ?? outcome)
            : outcome;
        }
      }
      return { kind: "failed" };
    },
    peek(key) {
      const slot = slots.get(key);
      if (!slot) return { answer: null, reading: false };
      return { answer: accountAnswer(slot, now()), reading: !!slot.inFlight };
    },
    async readAccount(target, opts) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const slot = slotFor(target.provider, target.key);
        const generation = slot.generation;
        const maxAge = opts?.refresh ? REFRESH_FLOOR_MS : FRESH_MS;
        const at = now();
        if (slot.answer && at - slot.answer.at < maxAge && !slot.inFlight)
          return accountAnswer(slot, at)!;
        await flightOf(slot, target.env, target.warm || isOffice(slot));
        // A slot dropped during the read (retain, an office change) sends
        // the caller round again.
        if (slots.get(slot.key) === slot && slot.generation === generation) {
          const answer = accountAnswer(slot, now());
          if (answer) return answer;
        }
        if (slots.get(target.key) !== slot) break;
      }
      return {
        reading: { kind: "failed" },
        identity: null,
        observedAtMs: null,
      };
    },
    retain(keys) {
      for (const provider of PROVIDERS) officeTarget(provider);
      for (const slot of [...slots.values()])
        if (!keys.has(slot.key) && !isOffice(slot)) drop(slot);
    },
    invalidate(provider) {
      const key = officeKeys.get(provider);
      const slot = key === undefined ? undefined : slots.get(key);
      if (!slot) return;
      slot.generation++;
      slot.answer = null;
      slot.lastGood = null;
      slot.lastGoodAccount = null;
      slot.inFlight = null;
      dropProbe(slot);
    },
    close() {
      for (const slot of slots.values()) {
        slot.generation++;
        dropProbe(slot);
      }
      slots.clear();
      officeKeys.clear();
    },
  };
}

const PROVIDERS: readonly ProviderAccountProvider[] = ["claude", "codex"];

// An error's message on one line, capped, for a log line.
function oneLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const FAILED_RESULT: AccountProbeResult = {
  weekly: { kind: "failed" },
  reading: { kind: "failed" },
  identity: null,
};
