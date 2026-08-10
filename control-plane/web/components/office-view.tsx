"use client";

import { useEffect, useState } from "react";
import type { ProgressView } from "../lib/services.server";

/** Fast while the office is being built, slow once it is serving. The server
 * side of this is a read of rows already in the database, so the cost of the
 * fast cadence is a query, not a probe of the box. */
const BUILDING_MS = 3_000;
const READY_MS = 30_000;

const STATE_WORDS: Record<string, string> = {
  waiting: "waiting",
  active: "in progress",
  checking: "checking",
  done: "done",
  failed: "failed",
};

function Steps({
  steps,
  testid,
}: {
  steps: ProgressView["steps"];
  testid: string;
}) {
  return (
    <ol data-testid={testid}>
      {steps.map((step) => (
        <li key={step.kind} data-testid={`step-${step.kind}`}>
          {step.label} -{" "}
          <span data-state={step.state}>{STATE_WORDS[step.state]}</span>
          {step.detail ? ` (${step.detail})` : ""}
        </li>
      ))}
    </ol>
  );
}

/**
 * One sentence per state, and a DATE only when the box itself enforces it.
 *
 * A ceiling that lives only in our database is not something to name at a
 * customer: until first contact has written the expiry option and read it back,
 * the honest sentence is the one without a date.
 */
function accessSentence(access: ProgressView["access"]): string {
  const date = access.expiresAt
    ? new Date(access.expiresAt).toISOString().slice(0, 10)
    : null;
  switch (access.state) {
    case "not_started":
      return "Hosted Isomux Provisioning does not have a key to your server yet.";
    case "gone":
      return "Hosted Isomux Provisioning no longer has a key to your server.";
    case "needs_attention":
      return "Hosted Isomux Provisioning cannot confirm whether it still has a key to your server.";
    default:
      return date && access.ceilingProven
        ? `Hosted Isomux Provisioning holds a temporary key to your server, until ${date} at the latest.`
        : "Hosted Isomux Provisioning holds a temporary key to your server.";
  }
}

export function OfficeView({
  initial,
  instanceId,
}: {
  initial: ProgressView;
  instanceId: string;
}) {
  const [view, setView] = useState(initial);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/progress/${instanceId}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const next = (await res.json()) as ProgressView;
        if (!cancelled) setView(next);
      } catch {
        // A failed poll is a poll that did not happen. The next one decides.
      }
    };
    const timer = setInterval(
      () => void tick(),
      view.ready ? READY_MS : BUILDING_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [instanceId, view.ready]);

  return (
    <main>
      <h1 data-testid="office-hostname">{view.hostname}</h1>
      <p data-testid="office-status">
        {view.ready
          ? "Your office is ready."
          : "Hosted Isomux Provisioning is setting up your office."}
      </p>
      {view.ready && (
        <p>
          <a href={`https://${view.hostname}`}>Open your office</a>
        </p>
      )}
      {view.origin === "adopted" && (
        <p data-testid="office-origin">
          An existing server was adopted for this office, so there is no
          ordering step.
        </p>
      )}

      {view.attention.length > 0 && (
        <section
          data-testid="attention"
          style={{
            border: "1px solid #b00020",
            padding: "0.75rem",
            margin: "1rem 0",
          }}
        >
          <strong>This office needs a person</strong>
          <ul>
            {view.attention.map((item, index) => (
              <li key={index} data-severity={item.severity}>
                {item.summary}
                {item.acknowledged ? " (we have seen it)" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2>Progress</h2>
      <Steps steps={view.steps} testid="steps" />

      {view.otherOperations.length > 0 && (
        <>
          <h2>Other work on this office</h2>
          <Steps steps={view.otherOperations} testid="other-operations" />
        </>
      )}

      <h2>Plan</h2>
      <p data-testid="subscription">
        {view.subscription
          ? `${view.plan} - ${view.subscription.status}` +
            (view.subscription.comped ? ", no charge" : "") +
            (view.subscription.currentPeriodEnd
              ? `, next invoice ${new Date(view.subscription.currentPeriodEnd)
                  .toISOString()
                  .slice(0, 10)}`
              : "")
          : `${view.plan} - waiting for payment to be confirmed`}
      </p>

      <p style={{ color: "#555" }} data-testid="access-window">
        {accessSentence(view.access)}
      </p>
    </main>
  );
}
