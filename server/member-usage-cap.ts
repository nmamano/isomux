// Member usage cap (internal-docs/usage-caps-design.md, task 6de8f530).
//
// When the owner turns it on, a member-driven turn on the office sign-in may
// start only while the office account's weekly usage is below the elapsed
// fraction of the week (the pace line). Owners are never stopped. The check
// runs at turn start; a running turn completes.
//
// Who is capped (Isomux PM ruling, 2026-10-02): input a human sends directly
// is capped when that human is not an owner; input no human sent directly is
// capped when the receiving agent's manager is a member; a cron run is capped
// when the cronjob's owner is a member. These helpers answer that question;
// `admit` answers whether the office account has room.

import { resolve } from "node:path";
import type {
  AgentBackendType,
  ProviderAccountProvider,
} from "../shared/types.ts";
import type { OfficeUsageStatusWire } from "../shared/contract-shapes.ts";
import type { Translator } from "../shared/i18n/translate.ts";
import { timeUntilFine } from "../shared/i18n/time.ts";
import { buildOfficeEnv } from "./env-loader.ts";
import { loadMemberUsageCap, saveMemberUsageCap } from "./persistence.ts";
import { effectiveProviderDirectory } from "./provider-account-manager.ts";
import {
  createOfficeUsageReader,
  FRESH_MS,
  WEEK_MS,
  type OfficeUsageReader,
} from "./office-usage.ts";
import { getUserById, getUserByName } from "./users.ts";

// The account a session bills: its provider and account directory. Null for
// a backend the cap does not cover (OpenCode).
export type BillingAccount = {
  provider: ProviderAccountProvider;
  dir: string;
} | null;

export type Admission =
  | { kind: "admitted" }
  | { kind: "exempt" }
  | { kind: "refused"; reason: "pace" | "read_failed"; retryAtMs: number };

export class UsageCapError extends Error {
  constructor(
    readonly reason: "pace" | "read_failed",
    readonly retryAtMs: number,
  ) {
    super("usage_cap");
    this.name = "UsageCapError";
  }
}

export function billingAccountFor(
  agentType: AgentBackendType,
  env: Record<string, string | undefined> | undefined,
): BillingAccount {
  if (agentType !== "claude" && agentType !== "codex") return null;
  return {
    provider: agentType,
    dir: effectiveProviderDirectory(agentType, env ?? process.env),
  };
}

// The pace line. Exported for tests.
export function evaluatePace(
  usedPercent: number,
  resetsAtMs: number,
  now: number,
): { allowed: boolean; pacePercent: number; retryAtMs: number } {
  const elapsed = Math.min(1, Math.max(0, 1 - (resetsAtMs - now) / WEEK_MS));
  const pacePercent = elapsed * 100;
  return {
    allowed: usedPercent < pacePercent,
    pacePercent,
    // When the line reaches today's use. Owner use can move it later.
    retryAtMs: Math.min(
      resetsAtMs,
      resetsAtMs - WEEK_MS + (usedPercent / 100) * WEEK_MS,
    ),
  };
}

// Input a human sent directly: capped unless that human is an owner. A name
// that no longer resolves (renamed while queued) fails closed.
export function directInputCapped(username: string | undefined): boolean {
  if (!username) return true;
  return getUserByName(username)?.role !== "owner";
}

// Input no human sent directly, and cron runs: capped when the manager (or
// cronjob owner) is a member. No manager: not capped.
export function managerCapped(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return getUserById(userId)?.role === "member";
}

export function usageCapText(
  translator: Translator,
  err: Pick<UsageCapError, "reason" | "retryAtMs">,
  now: number = Date.now(),
): string {
  if (err.reason === "read_failed")
    return translator.t("systemEntries.usageCap.readFailed");
  const until = timeUntilFine(
    translator.language,
    Math.max(err.retryAtMs, now + 60_000),
    now,
  );
  return translator.t("systemEntries.usageCap.pace", {
    when: until.kind === "formatted" ? until.text : "",
  });
}

export interface MemberUsageCap {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  admit(billing: BillingAccount): Promise<Admission>;
  // The answer `admit` gave for this account in the last FRESH_MS, without
  // waiting for a provider; null when there is none. For callers that cannot
  // await (the queue's early refusal); turn start always calls `admit`.
  peek(billing: BillingAccount): Admission | null;
  status(): Promise<OfficeUsageStatusWire[]>;
  invalidate(provider: ProviderAccountProvider): void;
  close(): void;
}

export interface MemberUsageCapDeps {
  reader: OfficeUsageReader;
  officeDir: (provider: ProviderAccountProvider) => string;
  load?: () => boolean;
  save?: (enabled: boolean) => void;
  now?: () => number;
}

export function createMemberUsageCap(deps: MemberUsageCapDeps): MemberUsageCap {
  const now = deps.now ?? Date.now;
  let enabled = deps.load?.() ?? false;

  // The last answer per office account, for `peek`, and a generation per
  // provider so an answer that an invalidation overtook is not recorded.
  const recent = new Map<string, { admission: Admission; at: number }>();
  const generations = new Map<ProviderAccountProvider, number>();

  // Whether the account is the office sign-in, and its key for `recent`.
  function officeAccount(
    billing: BillingAccount,
  ):
    | { kind: "office"; key: string; provider: ProviderAccountProvider }
    | { kind: "other" }
    | { kind: "error" } {
    if (!billing) return { kind: "other" };
    let officeDir: string;
    try {
      officeDir = resolve(deps.officeDir(billing.provider));
    } catch {
      return { kind: "error" };
    }
    if (resolve(billing.dir) !== officeDir) return { kind: "other" };
    return {
      kind: "office",
      key: `${billing.provider}:${officeDir}`,
      provider: billing.provider,
    };
  }

  async function read(provider: ProviderAccountProvider): Promise<Admission> {
    const outcome = await deps.reader.read(provider);
    if (outcome.kind === "no_limit") return { kind: "exempt" };
    if (outcome.kind !== "weekly") return refusedReadFailed(now());
    const pace = evaluatePace(outcome.usedPercent, outcome.resetsAtMs, now());
    return pace.allowed
      ? { kind: "admitted" }
      : { kind: "refused", reason: "pace", retryAtMs: pace.retryAtMs };
  }

  return {
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = next;
      deps.save?.(next);
    },
    async admit(billing) {
      if (!enabled) return { kind: "admitted" };
      const account = officeAccount(billing);
      if (account.kind === "error") return refusedReadFailed(now());
      if (account.kind === "other") return { kind: "exempt" };
      // Only an answer read under the current generation counts: one that an
      // invalidation overtook (even a cached one the reader handed back
      // before the invalidation ran) is read again, and three overtaken reads
      // refuse.
      for (let attempt = 0; attempt < 3; attempt++) {
        const generation = generations.get(account.provider) ?? 0;
        const admission = await read(account.provider);
        if ((generations.get(account.provider) ?? 0) !== generation) continue;
        recent.set(account.key, { admission, at: now() });
        return admission;
      }
      return refusedReadFailed(now());
    },
    peek(billing) {
      if (!enabled) return { kind: "admitted" };
      const account = officeAccount(billing);
      if (account.kind === "error") return refusedReadFailed(now());
      if (account.kind === "other") return { kind: "exempt" };
      const last = recent.get(account.key);
      if (!last || now() - last.at > FRESH_MS) return null;
      return last.admission;
    },
    async status() {
      const providers: ProviderAccountProvider[] = ["claude", "codex"];
      const rows = await Promise.all(
        providers.map(
          async (provider): Promise<OfficeUsageStatusWire | null> => {
            const outcome = await deps.reader.read(provider);
            if (outcome.kind === "signed_out") return null;
            if (outcome.kind === "no_limit")
              return { provider, state: "no_limit" };
            if (outcome.kind === "failed") return { provider, state: "failed" };
            const pace = evaluatePace(
              outcome.usedPercent,
              outcome.resetsAtMs,
              now(),
            );
            return {
              provider,
              state: "weekly",
              usedPercent: outcome.usedPercent,
              pacePercent: pace.pacePercent,
            };
          },
        ),
      );
      return rows.filter((row): row is OfficeUsageStatusWire => row !== null);
    },
    invalidate(provider) {
      generations.set(provider, (generations.get(provider) ?? 0) + 1);
      deps.reader.invalidate(provider);
      for (const key of recent.keys())
        if (key.startsWith(`${provider}:`)) recent.delete(key);
    },
    close() {
      deps.reader.close();
      recent.clear();
    },
  };
}

function refusedReadFailed(at: number): Admission {
  return { kind: "refused", reason: "read_failed", retryAtMs: at + FRESH_MS };
}

function officeDir(provider: ProviderAccountProvider): string {
  return effectiveProviderDirectory(provider, buildOfficeEnv());
}

// The office sign-in for a provider: its account directory and the env a
// reader process uses to read it.
export function officeUsageTarget(provider: ProviderAccountProvider): {
  dir: string;
  env: Record<string, string | undefined>;
} {
  const env = buildOfficeEnv();
  const dir = effectiveProviderDirectory(provider, env);
  return {
    dir,
    env:
      provider === "claude"
        ? { ...env, CLAUDE_CONFIG_DIR: dir }
        : { ...env, CODEX_HOME: dir },
  };
}

let shared: MemberUsageCap | null = null;

// The office's cap. Built on first use so a process that never turns it on
// never reads the office env or starts a reader.
export function memberUsageCap(): MemberUsageCap {
  shared ??= createMemberUsageCap({
    reader: createOfficeUsageReader({ officeTarget: officeUsageTarget }),
    officeDir,
    load: loadMemberUsageCap,
    save: saveMemberUsageCap,
  });
  return shared;
}

// A server boot reads the switch from its own state root.
export function resetMemberUsageCap(): void {
  shared?.close();
  shared = null;
}

// Tests swap the office's cap and must put back exactly what they found.
export function setMemberUsageCapForTests(
  next: MemberUsageCap | null,
): MemberUsageCap | null {
  const previous = shared;
  shared = next;
  return previous;
}
