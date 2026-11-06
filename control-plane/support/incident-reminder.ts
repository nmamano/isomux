// The reminder before the hour for a critical issue (incidents.ts), run in our
// own office as an office app, not as an agent turn.
//
// Every POLL_EVERY_MS it asks the storefront for the due issues (GET
// /api/ops/incidents?due=1, with the write key). When an issue's last update is
// NUDGE_AFTER_MS old it messages the support agent; at PAGE_AFTER_MS it raises
// an office page to the engineer. Each reminder goes once per gap: a new update
// starts a new gap. It needs the office up; nothing on the storefront pushes.

import type { DueIncidentItem } from "../incidents.ts";

export const POLL_EVERY_MS = 2 * 60_000;
/** Message the support agent when the last update is this old. */
export const NUDGE_AFTER_MS = 40 * 60_000;
/** Page the engineer when the last update is this old. */
export const PAGE_AFTER_MS = 50 * 60_000;

/** When the due list has failed this long in a row, page that the reminder
 * cannot read it: a bad key or a storefront outage must not pass silently. */
export const POLL_FAILURE_PAGE_AFTER_MS = 10 * 60_000;
/** Every call to the storefront and the office ends by then: a hung call
 * would stop the poll loop for good. */
export const FETCH_TIMEOUT_MS = 30_000;

export type ReminderAction =
  | { kind: "nudge_support"; incident: DueIncidentItem }
  | { kind: "page_engineer"; incident: DueIncidentItem };

export interface ReminderDecision {
  actions: ReminderAction[];
  /** The reminders already sent, to pass to the next poll. Entries of issues
   * no longer due are dropped. */
  sent: Set<string>;
}

/** One reminder of one gap. A gap is one issue since one update, so a new
 * update starts a new gap. */
function reminderId(
  incident: DueIncidentItem,
  kind: ReminderAction["kind"],
): string {
  return `${incident.id}@${incident.lastUpdateAt}:${kind}`;
}

/**
 * Which reminders this poll sends. Pure: the clock and what was already sent
 * come in, so a test moves them.
 *
 * `supportAgent` false (no support agent configured yet) sends no nudge; the
 * page is then the only reminder.
 */
export function decideReminders(
  due: readonly DueIncidentItem[],
  now: number,
  sent: ReadonlySet<string>,
  options: { supportAgent: boolean },
): ReminderDecision {
  const actions: ReminderAction[] = [];
  const next = new Set<string>();
  for (const incident of due) {
    const elapsed = now - incident.lastUpdateAt;
    const reminders: [ReminderAction["kind"], number, boolean][] = [
      ["nudge_support", NUDGE_AFTER_MS, options.supportAgent],
      ["page_engineer", PAGE_AFTER_MS, true],
    ];
    for (const [kind, after, wanted] of reminders) {
      const id = reminderId(incident, kind);
      if (sent.has(id)) {
        next.add(id);
      } else if (wanted && elapsed >= after) {
        actions.push({ kind, incident });
        next.add(id);
      }
    }
  }
  return { actions, sent: next };
}

/**
 * Whether to raise or resolve the page that says the due list cannot be read.
 * `failingSince` is the first failed poll of the current run of failures, null
 * after a good poll; `raised` says that page is up. Pure, like
 * decideReminders.
 */
export function decidePollAlarm(state: {
  failingSince: number | null;
  raised: boolean;
  now: number;
}): "raise" | "resolve" | null {
  if (state.failingSince === null) return state.raised ? "resolve" : null;
  if (state.raised) return null;
  return state.now - state.failingSince >= POLL_FAILURE_PAGE_AFTER_MS
    ? "raise"
    : null;
}

// ------------------------------------------------------------ the office app
//
// Run as an office app (control-plane README, "Critical-issue status pages"):
//   INCIDENT_WRITE_KEY        the write key, an app secret
//   ISOMUX_APP_TOKEN          set by the office for every app
//   INCIDENT_API_URL          default https://cloud.isomux.com
//   ISOMUX_OFFICE_URL         default http://127.0.0.1:4000
//   ISOMUX_SUPPORT_AGENT_ID   the support agent; unset sends no nudge
// Every poll and every send has its own catch: a throw in a timer would end
// the process.

const MIN = 60_000;
const POLL_ALARM_KEY = "incident-reminder:poll";

interface ReminderConfig {
  writeKey: string;
  appToken: string;
  apiUrl: string;
  officeUrl: string;
  supportAgentId: string | null;
}

function configFromEnv(env: NodeJS.ProcessEnv): ReminderConfig | null {
  const writeKey = env.INCIDENT_WRITE_KEY ?? "";
  const appToken = env.ISOMUX_APP_TOKEN ?? "";
  if (!writeKey || !appToken) return null;
  return {
    writeKey,
    appToken,
    apiUrl: (env.INCIDENT_API_URL || "https://cloud.isomux.com").replace(
      /\/$/,
      "",
    ),
    officeUrl: (env.ISOMUX_OFFICE_URL || "http://127.0.0.1:4000").replace(
      /\/$/,
      "",
    ),
    supportAgentId: env.ISOMUX_SUPPORT_AGENT_ID || null,
  };
}

async function fetchDue(config: ReminderConfig): Promise<DueIncidentItem[]> {
  const response = await fetch(`${config.apiUrl}/api/ops/incidents?due=1`, {
    headers: { authorization: `Bearer ${config.writeKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the due list answered ${response.status}`);
  return (await response.json()) as DueIncidentItem[];
}

function describe(incident: DueIncidentItem, now: number): string {
  const minutes = Math.floor((now - incident.lastUpdateAt) / MIN);
  return (
    `${incident.customerLabel} issue ${incident.n} (${incident.title}): ` +
    `last update ${minutes} min ago; the next one is due at ` +
    `${new Date(incident.dueAt).toISOString()}.`
  );
}

function pageKey(incident: DueIncidentItem): string {
  return `incident:${incident.id}@${incident.lastUpdateAt}`;
}

async function office(
  config: ReminderConfig,
  path: string,
  body: unknown,
): Promise<void> {
  const response = await fetch(`${config.officeUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.appToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the office answered ${response.status}`);
}

async function send(
  config: ReminderConfig,
  action: ReminderAction,
  now: number,
): Promise<void> {
  const text = describe(action.incident, now);
  if (action.kind === "nudge_support") {
    await office(config, "/api/app/message", {
      text: `Post the hourly update for ${text} Incident id ${action.incident.id}.`,
      targetAgentId: config.supportAgentId,
    });
  } else {
    await office(config, "/api/app/pager", {
      title: `Critical issue update due: ${action.incident.customerLabel} issue ${action.incident.n}`,
      body: text,
      key: pageKey(action.incident),
    });
  }
}

async function run(config: ReminderConfig): Promise<void> {
  let sent: ReadonlySet<string> = new Set();
  const paged = new Set<string>();
  let failingSince: number | null = null;
  let lastFailure = "";
  let alarmRaised = false;
  // The page that says the due list cannot be read. Its message carries the
  // HTTP status or the network error, never the key.
  const pollAlarm = async (now: number) => {
    try {
      const decision = decidePollAlarm({
        failingSince,
        raised: alarmRaised,
        now,
      });
      if (decision === "raise") {
        await office(config, "/api/app/pager", {
          title: "The critical-issue reminder cannot read the due issues",
          body:
            `Since ${new Date(failingSince ?? now).toISOString()}: ${lastFailure}. ` +
            "No update reminder goes out until it can. Check the write key " +
            "(INCIDENT_WRITE_KEY) and the storefront.",
          key: POLL_ALARM_KEY,
        });
        alarmRaised = true;
      } else if (decision === "resolve") {
        await office(config, "/api/app/pager/resolve", { key: POLL_ALARM_KEY });
        alarmRaised = false;
      }
    } catch (err) {
      console.error(
        `incident reminder: alarm failed: ${(err as Error).message}`,
      );
    }
  };
  const poll = async () => {
    const now = Date.now();
    let due: DueIncidentItem[] | null = null;
    try {
      due = await fetchDue(config);
      failingSince = null;
    } catch (err) {
      failingSince ??= now;
      lastFailure = (err as Error).message;
      console.error(`incident reminder: poll failed: ${lastFailure}`);
    }
    await pollAlarm(now);
    if (due === null) return;
    const decision = decideReminders(due, now, sent, {
      supportAgent: config.supportAgentId !== null,
    });
    const kept = new Set(decision.sent);
    for (const action of decision.actions) {
      try {
        await send(config, action, now);
      } catch (err) {
        // Not sent: forget it, so the next poll tries again.
        kept.delete(reminderId(action.incident, action.kind));
        console.error(
          `incident reminder: ${action.kind} failed: ${(err as Error).message}`,
        );
      }
    }
    sent = kept;
    // A page whose gap ended (an update landed, or the issue resolved) is
    // resolved, so the office stops repeating it.
    const live = new Set(due.map(pageKey));
    for (const key of [...paged]) {
      if (live.has(key)) continue;
      try {
        await office(config, "/api/app/pager/resolve", { key });
        paged.delete(key);
      } catch (err) {
        console.error(
          `incident reminder: resolve failed: ${(err as Error).message}`,
        );
      }
    }
    for (const action of decision.actions) {
      if (
        action.kind === "page_engineer" &&
        kept.has(reminderId(action.incident, action.kind))
      ) {
        paged.add(pageKey(action.incident));
      }
    }
  };
  const tick = () => {
    poll()
      .catch((err: unknown) => {
        console.error(`incident reminder: ${(err as Error).message}`);
      })
      .finally(() => setTimeout(tick, POLL_EVERY_MS));
  };
  tick();
}

if (import.meta.main) {
  const config = configFromEnv(process.env);
  if (!config) {
    console.error(
      "incident reminder: INCIDENT_WRITE_KEY and ISOMUX_APP_TOKEN must be set",
    );
    process.exit(1);
  }
  console.log(
    `incident reminder: polling ${config.apiUrl} every ${POLL_EVERY_MS / MIN} min`,
  );
  void run(config);
}
