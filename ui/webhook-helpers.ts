// Pure helpers for the Webhooks tab and the run views. See
// internal-docs/webhooks-design.md sections 8 and 9.

import type {
  CronjobListWire,
  CronjobRun,
  SessionContext,
  WebhookRule,
  WebhookWire,
} from "../shared/types.ts";

// Edit, the enabled toggle, Show and Rotate exist only for a viewer the write
// and secret routes accept: a human session of the hook owner or of an office
// owner. A member of the hook's room only reads it. Every viewer of the office
// UI is a human session, so a missing session context is the only other case.
export function canManageWebhook(
  hook: Pick<WebhookWire, "userId">,
  session: SessionContext | null,
): boolean {
  if (session === null) return false;
  return hook.userId === session.userId || session.role === "owner";
}

// The event names to tick in GitHub's "individual events" list, in rule
// order. A "*" rule takes every event.
export function ruleEvents(rules: WebhookRule[]): {
  events: string[];
  everything: boolean;
} {
  const events: string[] = [];
  let everything = false;
  for (const rule of rules) {
    if (rule.event === "*") everything = true;
    else if (rule.event && !events.includes(rule.event))
      events.push(rule.event);
  }
  return { events, everything };
}

// True when the hook URL points at this machine only (design section 9): no
// outside service can reach it.
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

// A secret to set, or a pre-verify rejection on record: the list marks it.
export function webhookNeedsAttention(
  hook: Pick<WebhookWire, "secretState" | "counters">,
): boolean {
  if (hook.secretState === "missing") return true;
  return Object.values(hook.counters).some((c) => (c?.count ?? 0) > 0);
}

// The newest run of a job, of any trigger. lastFireAt moves only on a
// scheduled fire, so an "On demand" job would otherwise never show one.
export function lastRunAt(
  job: Pick<CronjobListWire, "lastFireAt">,
  runs: Pick<CronjobRun, "startedAt">[],
): number | null {
  let newest = job.lastFireAt;
  for (const run of runs) {
    if (newest === null || run.startedAt > newest) newest = run.startedAt;
  }
  return newest;
}
