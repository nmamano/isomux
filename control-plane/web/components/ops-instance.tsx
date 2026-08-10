"use client";

import { useState } from "react";
import type { OpsInstanceView } from "../lib/services.server";

/**
 * One office, for the person who has to fix it.
 *
 * This view carries the operator-facing reason STRINGS, unlike the customer's
 * dashboard, which strips them to a class. That is the whole point of an ops
 * floor: the reason was written for this reader.
 */
export function OpsInstance({ initial }: { initial: OpsInstanceView }) {
  const view = initial;
  const [note, setNote] = useState<string | null>(null);

  const acknowledge = async (): Promise<void> => {
    const res = await fetch("/api/ops/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: view.instanceId }),
      cache: "no-store",
    });
    if (!res.ok) {
      setNote("that acknowledgement was refused.");
      return;
    }
    const data = (await res.json()) as { acknowledged?: number };
    setNote(`acknowledged ${data.acknowledged ?? 0} reason(s)`);
    // RELOAD rather than patch local state. The ack writes a timestamp and an
    // actor this component did not compute, and rendering a guess at them would
    // show the operator a row that does not match what was stored.
    window.location.reload();
  };

  return (
    <main className="wide">
      <h1 data-testid="ops-office">{view.officeName}</h1>
      <p className="mono" data-testid="ops-states">
        service {view.serviceState} - subscription {view.subscriptionState} -
        attention {view.attentionState}
      </p>

      <h2>Attention</h2>
      {view.attention.length === 0 ? (
        <p className="note" data-testid="ops-none">
          Nothing has been raised for this office.
        </p>
      ) : (
        <ul className="card rows" data-testid="ops-reasons">
          {view.attention.map((item) => (
            <li key={item.reasonId} data-severity={item.severity}>
              <strong>{item.severity}</strong> - {item.reasonClass} -{" "}
              {item.reason}
              {item.acknowledgedAt
                ? ` (we have seen it: ${item.acknowledgedBy})`
                : ""}
            </li>
          ))}
        </ul>
      )}
      <p className="action">
        <button data-testid="ops-ack" onClick={() => void acknowledge()}>
          We have seen it
        </button>
        {/* Acknowledging is not clearing, and the button says so rather than
            letting an operator believe the condition is handled. */}
        <span data-testid="ops-ack-caveat">
          {" "}
          This records that a person has seen these reasons. It does not clear
          them; the condition itself does.
        </span>
      </p>
      {note && (
        <p className="note" data-testid="ops-ack-note">
          {note}
        </p>
      )}

      <h2>Operations</h2>
      <ul className="card rows mono" data-testid="ops-operations">
        {view.operations.map((op) => (
          <li key={op.operationId}>
            {op.kind} - {op.status} - attempt {op.attempt}
            {op.inactivityFlagged ? " - inactivity flagged" : ""}
            {op.absoluteFlagged ? " - PAST ITS CEILING" : ""}
          </li>
        ))}
      </ul>

      <h2>Audit</h2>
      <ol className="card rows mono" data-testid="ops-audit">
        {view.audit.map((event) => (
          <li key={event.seq}>
            {new Date(event.ts).toISOString()} - {event.actor} - {event.action}{" "}
            - {event.outcome}
            {event.detail ? ` - ${event.detail}` : ""}
          </li>
        ))}
      </ol>
    </main>
  );
}
