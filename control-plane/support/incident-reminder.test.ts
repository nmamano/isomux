// The reminder before the hour (incident-reminder.ts): the support agent hears
// at 40 minutes after the last update, the engineer is paged at 50, each once
// per gap, and a new update starts a new gap. When the due list cannot be read
// for 10 minutes, one page says so, and it clears on the next good read.

import { describe, expect, test } from "bun:test";
import type { DueIncidentItem } from "../incidents.ts";
import {
  decidePollAlarm,
  decideReminders,
  type ReminderAction,
} from "./incident-reminder.ts";

const T0 = Date.parse("2027-06-10T00:00:00Z");
const MIN = 60_000;

function item(id: string, lastUpdateAt: number): DueIncidentItem {
  return {
    id,
    customerLabel: "Acme",
    n: 1,
    title: "Office down",
    kind: "critical",
    lastUpdateAt,
    dueAt: lastUpdateAt + 60 * MIN,
    lateByMs: 0,
  };
}

function kinds(actions: ReminderAction[]): string[] {
  return actions.map((a) => `${a.kind}:${a.incident.id}`).sort();
}

/** Poll at each minute in turn, carrying what was sent, as the loop does. */
function pollAt(
  minutes: number[],
  due: (now: number) => DueIncidentItem[],
  supportAgent: boolean,
): string[][] {
  let sent: ReadonlySet<string> = new Set();
  return minutes.map((m) => {
    const now = T0 + m * MIN;
    const decision = decideReminders(due(now), now, sent, { supportAgent });
    sent = decision.sent;
    return kinds(decision.actions);
  });
}

describe("decideReminders", () => {
  test("nudge at 40, page at 50, each once per gap", () => {
    const a = item("a", T0);
    expect(pollAt([38, 40, 42, 50, 52, 70], () => [a], true)).toEqual([
      [],
      ["nudge_support:a"],
      [],
      ["page_engineer:a"],
      [],
      [],
    ]);
  });

  test("a new update starts a new gap", () => {
    let last = T0;
    const due = () => [item("a", last)];
    let sent: ReadonlySet<string> = new Set();
    const at = (m: number) => {
      const d = decideReminders(due(), T0 + m * MIN, sent, {
        supportAgent: true,
      });
      sent = d.sent;
      return kinds(d.actions);
    };
    expect(at(41)).toEqual(["nudge_support:a"]);
    expect(at(51)).toEqual(["page_engineer:a"]);
    last = T0 + 55 * MIN;
    expect(at(94)).toEqual([]);
    expect(at(95)).toEqual(["nudge_support:a"]);
    expect(at(105)).toEqual(["page_engineer:a"]);
  });

  test("with no support agent the page is the only reminder", () => {
    const a = item("a", T0);
    expect(pollAt([40, 45, 50, 55], () => [a], false)).toEqual([
      [],
      [],
      ["page_engineer:a"],
      [],
    ]);
  });

  test("issues are reminded separately", () => {
    const a = item("a", T0);
    const b = item("b", T0 + 10 * MIN);
    expect(pollAt([40, 50, 60], () => [a, b], true)).toEqual([
      ["nudge_support:a"],
      ["nudge_support:b", "page_engineer:a"],
      ["page_engineer:b"],
    ]);
  });
});

describe("decidePollAlarm", () => {
  /** Poll at each minute in turn; `failing` says whether that poll failed. */
  function alarmAt(polls: [number, boolean][]): (string | null)[] {
    let failingSince: number | null = null;
    let raised = false;
    return polls.map(([m, failing]) => {
      const now = T0 + m * MIN;
      failingSince = failing ? (failingSince ?? now) : null;
      const decision = decidePollAlarm({ failingSince, raised, now });
      if (decision === "raise") raised = true;
      if (decision === "resolve") raised = false;
      return decision;
    });
  }

  test("ten minutes of failed reads raise one page; the next good read resolves it", () => {
    expect(
      alarmAt([
        [0, false],
        [2, true],
        [10, true],
        [12, true],
        [14, true],
        [16, false],
        [18, false],
      ]),
    ).toEqual([null, null, null, "raise", null, "resolve", null]);
  });

  test("a good read in between starts the ten minutes again", () => {
    expect(
      alarmAt([
        [0, true],
        [8, true],
        [9, false],
        [10, true],
        [18, true],
        [20, true],
      ]),
    ).toEqual([null, null, null, null, null, "raise"]);
  });
});
