// Weekly usage of the OFFICE sign-in, read straight from the provider for the
// member usage cap (internal-docs/usage-caps-design.md). Not the per-agent
// subscription pill: that reading needs a live session and does not say which
// account it describes. This one reads the office account directory itself.
//
// One warm reader process per provider, closed after a quiet spell. A reading
// counts for FRESH_MS; an older one triggers a probe that concurrent callers
// share. A failed probe is never cached: it answers with the last good reading
// if that is under FALLBACK_MS old, else as failed, and the cap lets a failed
// reading through (Nil's ruling, 2026-10-02).

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { ProviderAccountProvider } from "../shared/types.ts";
import { CLAUDE_NATIVE_BIN } from "./cwd-utils.ts";
import { JsonRpcLiteClient } from "./backends/codex/client.ts";
import {
  CODEX_LEGACY_LIMIT_KEY,
  CODEX_PREFERRED_LIMIT_ID,
} from "./backends/codex/adapter.ts";
import type { GetAccountResponse } from "./backends/codex/_generated/v2/GetAccountResponse.ts";
import type { GetAccountRateLimitsResponse } from "./backends/codex/_generated/v2/GetAccountRateLimitsResponse.ts";
import type { RateLimitSnapshot } from "./backends/codex/_generated/v2/RateLimitSnapshot.ts";

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
// tests. Only `seven_day` counts; the 5-hour and per-model windows do not.
export function parseClaudeWeekly(raw: unknown): ProbeResult {
  if (!raw || typeof raw !== "object") return { kind: "failed" };
  const resp = raw as {
    rate_limits_available?: unknown;
    rate_limits?: unknown;
  };
  if (resp.rate_limits_available === false) return { kind: "no_limit" };
  if (resp.rate_limits_available !== true) return { kind: "failed" };
  const week = (resp.rate_limits as Record<string, unknown> | undefined)
    ?.seven_day as { utilization?: unknown; resets_at?: unknown } | undefined;
  if (!week || !validPercent(week.utilization)) return { kind: "failed" };
  const resetsAtMs =
    typeof week.resets_at === "string" ? Date.parse(week.resets_at) : NaN;
  if (!Number.isFinite(resetsAtMs)) return { kind: "failed" };
  return { kind: "weekly", usedPercent: week.utilization, resetsAtMs };
}

// Codex account + rate limits -> the weekly outcome. Exported for tests. The
// weekly window is the one 10080 minutes long, whichever slot it rides in (a
// Pro plan sends it as `primary`).
export function parseCodexWeekly(
  account: GetAccountResponse["account"],
  limits: GetAccountRateLimitsResponse | null,
): ProbeResult {
  if (!account) return { kind: "signed_out" };
  if (account.type === "apiKey" || account.type === "amazonBedrock")
    return { kind: "no_limit" };
  if (!limits) return { kind: "failed" };
  const snapshot: RateLimitSnapshot | undefined =
    limits.rateLimitsByLimitId?.[CODEX_PREFERRED_LIMIT_ID] ??
    limits.rateLimitsByLimitId?.[CODEX_LEGACY_LIMIT_KEY] ??
    limits.rateLimits;
  if (!snapshot) return { kind: "failed" };
  for (const win of [snapshot.primary, snapshot.secondary]) {
    if (!win || win.windowDurationMins !== CODEX_WEEK_MINUTES) continue;
    if (!validPercent(win.usedPercent)) return { kind: "failed" };
    if (typeof win.resetsAt !== "number" || !Number.isFinite(win.resetsAt))
      return { kind: "failed" };
    return {
      kind: "weekly",
      usedPercent: win.usedPercent,
      resetsAtMs: win.resetsAt * 1000,
    };
  }
  return { kind: "failed" };
}

type UsageQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
  close?: () => void;
};

// A standalone SDK query with no prompt: it reads the account the
// CLAUDE_CONFIG_DIR in `env` is signed in to, and never starts a conversation.
export function claudeOfficeProbe(
  env: Record<string, string | undefined>,
): OfficeUsageProbe {
  const abortController = new AbortController();
  // Never yields a prompt; it ends when the probe closes.
  async function* input(): AsyncGenerator<never> {
    await new Promise<void>((resolve) =>
      abortController.signal.addEventListener("abort", () => resolve()),
    );
    if (!abortController.signal.aborted) yield undefined as never;
  }
  const q = query({
    prompt: input(),
    options: {
      cwd: tmpdir(),
      env,
      settingSources: [],
      pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
      abortController,
    },
  }) as unknown as UsageQuery;
  return {
    async read() {
      const usage = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      // A lost SDK method is not proof of "no limit": deny.
      if (typeof usage !== "function") return { kind: "failed" };
      return parseClaudeWeekly(await usage.call(q));
    },
    close() {
      abortController.abort();
      try {
        q.close?.();
      } catch {}
    },
  };
}

// A standalone Codex app-server on the office CODEX_HOME.
export function codexOfficeProbe(
  env: Record<string, string | undefined>,
): OfficeUsageProbe {
  const client = new JsonRpcLiteClient({ env });
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
        return parseCodexWeekly(account.account, null);
      const limits = await client.request<GetAccountRateLimitsResponse>(
        "account/rateLimits/read",
        undefined,
      );
      return parseCodexWeekly(account.account, limits);
    },
    close() {
      void client.close().catch(() => {});
    },
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
  // A reading at most FRESH_MS old, or the result of a probe shared with
  // concurrent callers. A failed probe answers with the last good reading
  // while it is under FALLBACK_MS old.
  read(provider: ProviderAccountProvider): Promise<OfficeWeeklyOutcome>;
  // Drop the cached and last good readings and the warm process, e.g. after
  // the office signs in or out.
  invalidate(provider: ProviderAccountProvider): void;
  close(): void;
}

export function createOfficeUsageReader(
  deps: OfficeUsageReaderDeps,
): OfficeUsageReader {
  const now = deps.now ?? Date.now;
  const createProbe =
    deps.createProbe ??
    ((provider, env) =>
      provider === "claude" ? claudeOfficeProbe(env) : codexOfficeProbe(env));
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });

  type Slot = {
    key: string;
    generation: number;
    cached: OfficeWeeklyOutcome | null;
    // The last weekly or no_limit reading, for a failed probe to fall back on.
    lastGood: GoodOutcome | null;
    inFlight: Promise<OfficeWeeklyOutcome> | null;
    probe: OfficeUsageProbe | null;
    cancelIdle: (() => void) | null;
  };
  const slots = new Map<ProviderAccountProvider, Slot>();

  function slotFor(provider: ProviderAccountProvider, key: string): Slot {
    let slot = slots.get(provider);
    if (slot && slot.key !== key) {
      // The office directory moved: nothing from the old account may answer.
      dropProbe(slot);
      slot = undefined;
    }
    if (!slot) {
      slot = {
        key,
        generation: 0,
        cached: null,
        lastGood: null,
        inFlight: null,
        probe: null,
        cancelIdle: null,
      };
      slots.set(provider, slot);
    }
    return slot;
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

  function usable(outcome: OfficeWeeklyOutcome | null, at: number): boolean {
    if (!outcome || !("observedAtMs" in outcome)) return false;
    if (at - outcome.observedAtMs > FRESH_MS) return false;
    // A reset already past means the reading predates a rollover.
    return outcome.kind !== "weekly" || outcome.resetsAtMs > at;
  }

  // The last good reading, if under FALLBACK_MS old and, for a weekly one,
  // its reset is still ahead.
  function fallback(slot: Slot, at: number): GoodOutcome | null {
    const last = slot.lastGood;
    if (!last || at - last.observedAtMs >= FALLBACK_MS) return null;
    if (last.kind === "weekly" && last.resetsAtMs <= at) return null;
    return last;
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

  async function probeOnce(
    provider: ProviderAccountProvider,
    slot: Slot,
    env: Record<string, string | undefined>,
  ): Promise<OfficeWeeklyOutcome> {
    const generation = slot.generation;
    let probe: OfficeUsageProbe | null = null;
    let cancelTimeout: (() => void) | null = null;
    let result: ProbeResult;
    try {
      // Inside the try: a process that cannot even start is a failed read.
      slot.probe ??= createProbe(provider, env);
      probe = slot.probe;
      result = await Promise.race([
        probe.read(),
        new Promise<ProbeResult>((resolve) => {
          cancelTimeout = setTimer(
            () => resolve({ kind: "failed" }),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      result = { kind: "failed" };
    } finally {
      (cancelTimeout as (() => void) | null)?.();
    }
    // A failure may mean the process died: start a new one next time.
    if (result.kind === "failed" && probe && slot.probe === probe)
      dropProbe(slot);
    const at = now();
    const outcome = settle(result, at);
    const current =
      slots.get(provider) === slot && slot.generation === generation;
    if (current) {
      slot.cached = outcome.kind === "failed" ? null : outcome;
      if (outcome.kind === "weekly" || outcome.kind === "no_limit")
        slot.lastGood = outcome;
      if (slot.probe) armIdleClose(slot);
    }
    if (outcome.kind === "failed" && current)
      return fallback(slot, at) ?? outcome;
    return outcome;
  }

  // The slot key: the office account directory AND the env the reader runs
  // with, so a changed office variable (an API key, a cloud switch) is a
  // different account even in the same directory.
  function targetKey(provider: ProviderAccountProvider): {
    key: string;
    env: Record<string, string | undefined>;
  } | null {
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
  }

  return {
    async read(provider) {
      // An answer counts only if the account it was read for is still the
      // office's when it arrives: an invalidation or an office change during
      // the probe sends the caller round again, never the old answer.
      for (let attempt = 0; attempt < 3; attempt++) {
        const target = targetKey(provider);
        if (!target) return { kind: "failed" };
        const slot = slotFor(provider, target.key);
        const generation = slot.generation;
        if (usable(slot.cached, now())) return slot.cached!;
        let flight = slot.inFlight;
        if (!flight) {
          const started = probeOnce(provider, slot, target.env).finally(() => {
            if (slot.inFlight === started) slot.inFlight = null;
          });
          slot.inFlight = started;
          flight = started;
        }
        const outcome = await flight;
        if (
          slots.get(provider) === slot &&
          slot.generation === generation &&
          targetKey(provider)?.key === target.key
        )
          return outcome;
      }
      return { kind: "failed" };
    },
    invalidate(provider) {
      const slot = slots.get(provider);
      if (!slot) return;
      slot.generation++;
      slot.cached = null;
      slot.lastGood = null;
      slot.inFlight = null;
      dropProbe(slot);
    },
    close() {
      for (const slot of slots.values()) dropProbe(slot);
      slots.clear();
    },
  };
}
