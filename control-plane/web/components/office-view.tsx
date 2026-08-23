"use client";

import { useEffect, useState } from "react";
import type { ProgressView } from "../lib/services.server";
import { customerPriceLine } from "./plan-copy";
import { PolicyNotice } from "./policy-notice";

/** Fast while the office is being built, slow once it is serving. The server
 * side of this is a read of rows already in the database, so the cost of the
 * fast cadence is a query, not a probe of the box. */
const BUILDING_MS = 3_000;
const READY_MS = 30_000;
/** How often, and for how long, the page asks the provisioner for a link it has
 * requested. The mint is a two-hop SSH round trip, so seconds rather than
 * milliseconds; the ceiling is generous because giving up early would strand a
 * link that was minted successfully. */
const COLLECT_POLL_MS = 2_000;
const COLLECT_TIMEOUT_MS = 120_000;
/**
 * The grace week, for the PROJECTED date shown before service ends.
 *
 * The only piece of the timeline this file computes, and it is a fixed span
 * rather than calendar arithmetic. The retention month is deliberately NOT
 * computed here: it runs from the instant the box is actually powered off, so a
 * second implementation working from the grace end would print a different day
 * whenever the power-off lands after midnight or across a month end. Before the
 * power-off the copy says "one calendar month after that" and names no date;
 * afterwards it renders the machine's own `retentionEnd`.
 */
const GRACE_DAYS = 7;

export const STATE_WORDS: Record<string, string> = {
  waiting: "not started",
  active: "in progress",
  checking: "checking",
  done: "done",
  failed: "failed",
};

export function Steps({
  steps,
  testid,
  now,
}: {
  steps: ProgressView["steps"];
  testid: string;
  now: number | null;
}) {
  return (
    <ol className="card ladder" data-testid={testid}>
      {steps.map((step) => (
        <li key={step.kind} data-testid={`step-${step.kind}`}>
          {step.label} -{" "}
          <span data-state={step.state}>{STATE_WORDS[step.state]}</span>
          {step.startedAt !== null &&
            (step.elapsedMs !== null || now !== null) && (
              <StepDuration step={step} now={now} />
            )}
          {step.detail ? ` (${step.detail})` : ""}
        </li>
      ))}
    </ol>
  );
}

export function formatDuration(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(elapsedMs, 0) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function spokenDuration(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(elapsedMs, 0) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return (
    [
      hours ? `${hours} ${hours === 1 ? "hour" : "hours"}` : "",
      minutes ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "",
      !hours && remainder
        ? `${remainder} ${remainder === 1 ? "second" : "seconds"}`
        : "",
    ]
      .filter(Boolean)
      .join(" ") || "0 seconds"
  );
}

function StepDuration({
  step,
  now,
}: {
  step: ProgressView["steps"][number];
  now: number | null;
}) {
  const elapsed =
    step.elapsedMs === null
      ? Math.max((now ?? step.startedAt ?? 0) - (step.startedAt ?? 0), 0)
      : step.elapsedMs;
  const running = step.elapsedMs === null;
  const compact = formatDuration(elapsed);
  const spoken = spokenDuration(elapsed);
  return running ? (
    <span
      className="step-duration"
      role="timer"
      aria-label={`running for ${spoken}`}
    >
      {compact}
    </span>
  ) : (
    <>
      <span className="step-duration" aria-hidden="true">
        {compact}
      </span>
      <span className="visually-hidden">, took {spoken}</span>
    </>
  );
}

export interface Clock {
  serverAt: number;
  clientAt: number;
  clientNow: number;
}

export function anchoredNow(clock: Clock): number {
  return clock.serverAt + (clock.clientNow - clock.clientAt);
}

// Re-anchoring must never move the displayed time backwards. The anchor lags
// true control-plane time by the latency of the poll that set it, so a poll
// that is slower than the one before would step the timer back.
export function nextClock(
  previous: Clock | null,
  serverAt: number,
  clientAt: number,
): Clock {
  const candidate = { serverAt, clientAt, clientNow: clientAt };
  if (!previous) return candidate;
  const held = { ...previous, clientNow: clientAt };
  return anchoredNow(candidate) < anchoredNow(held) ? held : candidate;
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

/**
 * The invite, held in this component and nowhere else.
 *
 * Not in localStorage, not in a cookie, not in the URL: a reload loses it, and
 * losing it is correct - the provisioner dropped it when we collected it, so
 * the only honest way to see one again is to ask for a new one, which kills the
 * old link anyway.
 */
type InviteState =
  | { phase: "idle" }
  | { phase: "asking" }
  /** The id THIS click opened. Carried rather than read back from the polled
   * view: between the click and the next poll the projection still describes
   * the PREVIOUS mint, and collecting against that id asks the provisioner for
   * a link it already handed over - which is how a resend came back as "no
   * longer available" while the box had minted perfectly well. A real browser
   * run is what found it. */
  | { phase: "waiting"; operationId: string }
  | { phase: "shown"; url: string }
  | { phase: "problem"; message: string };

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

function reasonOf(data: Record<string, unknown>, fallback: string): string {
  return typeof data.reason === "string" && data.reason
    ? data.reason
    : fallback;
}

export function OfficeView({
  initial,
  instanceId,
}: {
  initial: ProgressView;
  instanceId: string;
}) {
  const [view, setView] = useState(initial);
  const [clock, setClock] = useState<Clock | null>(null);
  const [invite, setInvite] = useState<InviteState>({ phase: "idle" });
  const [action, setAction] = useState<string | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoffProblem, setHandoffProblem] = useState<string | null>(null);
  const [signedInConfirmed, setSignedInConfirmed] = useState(false);
  /** Which billing change we have asked Stripe for and not yet seen land.
   * Cleared by the poll, because the WEBHOOK is what makes it true - this side
   * never writes subscription state, so it must not claim it either. */
  const [billing, setBilling] = useState<"cancel" | "uncancel" | null>(null);
  const [billingProblem, setBillingProblem] = useState<string | null>(null);
  const invitePathOffered =
    view.origin === "adopted" || view.handoff.invite.mintedAt !== null;
  const paymentStep: ProgressView["steps"][number] = {
    kind: "waiting-for-payment" as ProgressView["steps"][number]["kind"],
    label: "Waiting for payment",
    state: view.subscription ? "done" : "active",
    detail: null,
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
  };
  const progressSteps = [paymentStep, ...view.steps];

  // FAST WHILE SOMETHING THE CUSTOMER ASKED FOR IS IN FLIGHT, not only while
  // the office is being built. An invite takes a few seconds to mint, and a
  // dashboard that only noticed on its next slow poll would look broken for
  // half a minute after a button press.
  const busy =
    !view.ready ||
    billing !== null ||
    invite.phase === "waiting" ||
    handoffPending ||
    view.restart.active ||
    view.handoff.invite.state === "active" ||
    view.handoff.revocation.state === "active";

  const hasRunningStep = [...view.steps, ...view.otherOperations].some(
    (step) => step.state === "active" || step.state === "checking",
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const clientAt = Date.now();
      setClock((previous) => nextClock(previous, view.asOf, clientAt));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [view.asOf]);

  useEffect(() => {
    if (!hasRunningStep) return;
    const timer = setInterval(() => {
      setClock((current) =>
        current ? { ...current, clientNow: Date.now() } : current,
      );
    }, 1_000);
    return () => clearInterval(timer);
  }, [hasRunningStep]);

  const timerNow = clock ? anchoredNow(clock) : null;

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/progress/${instanceId}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const next = (await res.json()) as ProgressView;
        if (cancelled) return;
        setView(next);
        if (next.handoff.revocation.state !== "none") {
          setHandoffPending(false);
        }
        // Stripe has confirmed when the CACHED flag matches what we asked for.
        // Anything else and the pending sentence stands, which is the truth.
        setBilling((asked) => {
          if (!asked || !next.subscription) return asked;
          const landed =
            asked === "cancel"
              ? next.subscription.cancelAtPeriodEnd
              : !next.subscription.cancelAtPeriodEnd;
          return landed ? null : asked;
        });
      } catch {
        // A failed poll is a poll that did not happen. The next one decides.
      }
    };
    const timer = setInterval(() => void tick(), busy ? BUILDING_MS : READY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [instanceId, busy]);

  // COLLECT THE INVITE THIS CLICK ASKED FOR, and only while we are the ones
  // waiting for it. `phase: "waiting"` is set by the click and by nothing else,
  // so a page that is merely looking at a minted office never consumes a link
  // somebody else asked for.
  //
  // It asks the seam directly rather than waiting for the projection to catch
  // up. `not_ready` is a real answer and costs nothing - the take only happens
  // once the mint has succeeded - so polling it is both simpler and free of the
  // stale-id race the projection route had.
  useEffect(() => {
    if (invite.phase !== "waiting") return;
    const operationId = invite.operationId;
    let cancelled = false;
    void (async () => {
      const deadline = Date.now() + COLLECT_TIMEOUT_MS;
      for (;;) {
        const { data } = await postJson("/api/invite/reveal", {
          instanceId,
          operationId,
        });
        if (cancelled) return;
        if (data.status === "ready" && typeof data.url === "string") {
          setInvite({ phase: "shown", url: data.url });
          return;
        }
        if (data.status !== "not_ready") {
          setInvite({
            phase: "problem",
            message: reasonOf(data, "that invite is no longer available"),
          });
          return;
        }
        if (Date.now() > deadline) {
          setInvite({
            phase: "problem",
            message:
              "preparing your invite is taking longer than expected. Try asking again.",
          });
          return;
        }
        await new Promise((r) => setTimeout(r, COLLECT_POLL_MS));
        if (cancelled) return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invite, instanceId]);

  const askForInvite = async (): Promise<void> => {
    setInvite({ phase: "asking" });
    const { data, status } = await postJson("/api/invite", { instanceId });
    if (status !== 200 || data.ok !== true) {
      setInvite({
        phase: "problem",
        message: reasonOf(data, "we could not ask for an invite just now."),
      });
      return;
    }
    const operationId = data.operationId;
    if (typeof operationId !== "string") {
      setInvite({
        phase: "problem",
        message: "we could not ask for an invite just now.",
      });
      return;
    }
    setInvite({ phase: "waiting", operationId });
  };

  const billingAct = async (
    path: "/api/cancel" | "/api/uncancel",
    label: "cancel" | "uncancel",
  ): Promise<void> => {
    setBillingProblem(null);
    setBilling(label);
    try {
      const { data, status } = await postJson(path, { instanceId });
      if (status === 200 && data.ok === true) return;
      setBilling(null);
      setBillingProblem(
        reasonOf(data, "we could not change your plan just now."),
      );
    } catch {
      setBilling(null);
      setBillingProblem("We could not change your plan just now.");
    }
  };

  const reinstate = async (): Promise<void> => {
    setBillingProblem(null);
    const { data, status } = await postJson("/api/reinstate", { instanceId });
    if (status === 200 && typeof data.checkoutUrl === "string") {
      window.location.assign(data.checkoutUrl);
      return;
    }
    setBillingProblem(
      reasonOf(data, "we could not open reinstatement payment."),
    );
  };

  const act = async (path: string, label: string): Promise<boolean> => {
    setAction(null);
    try {
      const { data, status } = await postJson(path, { instanceId });
      if (status === 200 && data.ok === true) return true;
      setAction(reasonOf(data, `we could not ${label} just now.`));
      return false;
    } catch {
      setAction(`We could not ${label} just now.`);
      return false;
    }
  };

  const requestHandoff = async (): Promise<void> => {
    setHandoffProblem(null);
    setHandoffPending(true);
    try {
      const { data, status } = await postJson("/api/handoff", { instanceId });
      // A successful request stays pending until the progress poll sees the
      // revocation row. A failure must stay beside the control that caused it.
      if (status === 200 && data.ok === true) return;
      setHandoffPending(false);
      setHandoffProblem(
        reasonOf(data, "we could not remove our access just now."),
      );
    } catch {
      setHandoffPending(false);
      setHandoffProblem("We could not remove our access just now.");
    }
  };

  return (
    <main>
      <h1 data-testid="office-hostname">{view.hostname}</h1>
      <section className="card" data-testid="office-tier">
        <strong>{view.tier.label}</strong>
        {view.tier.specification && <p>{view.tier.specification}</p>}
        {customerPriceLine(view.tier.customerPrice) && (
          <p>{customerPriceLine(view.tier.customerPrice)}</p>
        )}
      </section>
      <p className="lead" data-testid="office-status">
        {view.ready ? "Your office is ready." : "Your office is not ready yet."}
      </p>
      {!view.subscription && (
        <section className="card" data-testid="payment-guidance">
          <p>Complete payment to start ordering your server.</p>
          <form className="form" method="post" action="/api/signup">
            <input type="hidden" name="signupIntent" value="continue" />
            <input type="hidden" name="officeName" value={view.officeName} />
            <PolicyNotice />
            <button className="btn-primary" type="submit">
              Continue to payment
            </button>
          </form>
        </section>
      )}
      {view.ready && invitePathOffered && (
        <p>
          <a
            className="btn btn-primary"
            href={`https://${view.hostname}`}
            target="_blank"
            rel="noopener"
          >
            Open your office
          </a>
        </p>
      )}
      {view.attention.length > 0 && (
        <section className="callout callout-danger" data-testid="attention">
          {/* The icon is decorative: the heading beside it already names the
              condition, and the left rule marks the banner out. Between the
              three, nothing here depends on seeing the colour. */}
          <div className="callout-head">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5a1 1 0 0 1 .87.5l6 10.5A1 1 0 0 1 14 14H2a1 1 0 0 1-.87-1.5l6-10.5A1 1 0 0 1 8 1.5Zm0 3.75a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5.25ZM8 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
            </svg>
            <strong>We need to check your setup</strong>
          </div>
          <ul className="rows">
            {view.attention.map((item, index) => (
              <li key={index} data-severity={item.severity}>
                {item.summary}
                {item.acknowledged ? " (we have seen it)" : ""}
              </li>
            ))}
          </ul>
          <p>
            You do not need to do anything. We have been notified. If this
            message is still here after 12 hours, email{" "}
            <a href="mailto:llc@isomux.com">llc@isomux.com</a>.
          </p>
        </section>
      )}

      <h2>Progress</h2>
      <Steps steps={progressSteps} testid="steps" now={timerNow} />

      {view.otherOperations.length > 0 && (
        <>
          <h2>Other work on this office</h2>
          <Steps
            steps={view.otherOperations}
            testid="other-operations"
            now={timerNow}
          />
        </>
      )}

      <h2>Getting in</h2>
      <section className="card" data-testid="handoff">
        {view.sshCommand && (
          <p data-testid="ssh-command">
            Your SSH access: <code>{view.sshCommand}</code>
          </p>
        )}
        {view.access.state !== "not_started" &&
          (view.access.state !== "gone" ||
            view.handoff.revocation.state === "none") && (
            <p className="note" data-testid="access-window">
              {accessSentence(view.access)}
            </p>
          )}

        <ol className="handoff-steps">
          <li>
            <h3>Get your owner invite</h3>
            {view.handoff.invite.state === "none" && !view.ready && (
              <p className="note" data-testid="invite-not-yet">
                Wait until the office is serving.
              </p>
            )}

            {view.handoff.canMint && view.ready && (
              <p className="action">
                <button
                  className={
                    view.handoff.invite.mintedAt ? undefined : "btn-primary"
                  }
                  data-testid="invite-button"
                  onClick={() => void askForInvite()}
                  disabled={
                    invite.phase === "asking" || invite.phase === "waiting"
                  }
                >
                  {view.handoff.invite.mintedAt
                    ? "Send me a new invite"
                    : "Get my owner invite"}
                </button>
                {view.handoff.invite.mintedAt ? (
                  <span data-testid="resend-caveat">
                    A new invite replaces the previous one, which stops working.
                  </span>
                ) : null}
              </p>
            )}

            {!view.handoff.canMint && view.handoff.invite.mintedAt !== null && (
              <p className="note" data-testid="invite-closed">
                Hosted Isomux Provisioning can no longer create invites for this
                office. If you cannot get in, contact support.
              </p>
            )}

            {invite.phase === "asking" && (
              <p className="note">Asking for an invite...</p>
            )}
            {invite.phase === "waiting" &&
              (view.handoff.invite.state === "failed" ? (
                <p
                  className="callout callout-danger"
                  data-testid="invite-problem"
                >
                  We could not prepare an invite. Try asking again.
                </p>
              ) : (
                <p className="note" data-testid="invite-waiting">
                  Preparing your invite. This takes a few seconds.
                </p>
              ))}
            {invite.phase === "problem" && (
              <p
                className="callout callout-danger"
                data-testid="invite-problem"
              >
                {invite.message}
              </p>
            )}
          </li>

          <li>
            <h3>Open your office and sign in</h3>
            {invite.phase === "shown" ? (
              <div className="callout" data-testid="invite-shown">
                <p>
                  <a
                    className="btn btn-primary"
                    data-testid="invite-link"
                    href={invite.url}
                    target="_blank"
                    rel="noopener"
                  >
                    Open your office and sign in
                  </a>
                </p>
                <p className="note">
                  Open this from the browser profile where you&apos;ll use the
                  office (not incognito). It works once and is gone after five
                  minutes; if you miss it, ask for a new one. You can add your
                  other devices later from inside the office.
                </p>
              </div>
            ) : view.handoff.canMint ? (
              <p className="note" data-testid="sign-in-guidance">
                {view.handoff.invite.mintedAt
                  ? "Your link was shown once and is not kept. Ask for a new one above if you still need to sign in."
                  : view.origin === "adopted" && view.ready
                    ? "Open your office above and make sure it works in this browser."
                    : "Your sign-in link will appear here after the invite is ready."}
              </p>
            ) : null}
          </li>

          {/* THE NAG. Shown while we still hold a key and the customer has not
            confirmed. It is the design's answer to a handoff that never ends:
            the ceiling is a backstop, not the normal path. It stops the moment
            they HAVE confirmed - a revocation in flight is not a reason to keep
            asking for one - while minting stays available until the removal is
            proven, because a failed revocation must not also lock them out. */}
          {view.handoff.canMint &&
            view.ready &&
            view.handoff.revocation.state === "none" && (
              <li data-testid="handoff-nag">
                <h3>Confirm office access, then remove our access</h3>
                <div className="callout">
                  <p>
                    Do not continue until your office is open in this browser.
                    After removal, Hosted Isomux Provisioning cannot create
                    another owner invite for you.
                  </p>
                  <label className="handoff-confirm">
                    <input
                      type="checkbox"
                      data-testid="signed-in-confirmation"
                      checked={signedInConfirmed}
                      onChange={(event) =>
                        setSignedInConfirmed(event.target.checked)
                      }
                      disabled={!invitePathOffered || handoffPending}
                    />
                    Click to confirm that your office is open in this browser.
                  </label>
                  {!invitePathOffered && (
                    <p className="note" data-testid="invite-required">
                      Get your owner invite and open your office before you
                      confirm.
                    </p>
                  )}
                  <button
                    className="btn-primary"
                    data-testid="revoke-button"
                    disabled={
                      !invitePathOffered || !signedInConfirmed || handoffPending
                    }
                    onClick={() => void requestHandoff()}
                  >
                    {handoffPending
                      ? "Removing temporary access..."
                      : "Revoke isomux's access"}
                  </button>
                  <p
                    className="note handoff-status"
                    role="status"
                    data-testid="revocation-pending"
                  >
                    {handoffPending
                      ? "Your request was received. We are removing our temporary access now."
                      : ""}
                  </p>
                  {handoffProblem && (
                    <p
                      className="callout callout-danger"
                      data-testid="handoff-problem"
                    >
                      {handoffProblem}
                    </p>
                  )}
                </div>
              </li>
            )}

          {view.handoff.revocation.state !== "none" && (
            <li>
              <h3>Access removal</h3>
              <p>
                <span className="note" data-testid="revocation-state">
                  {revocationSentence(view.handoff.revocation)}
                </span>
              </p>
            </li>
          )}
        </ol>
      </section>

      {view.liveness && (
        <>
          <h2>Is it answering?</h2>
          <p className="card" data-testid="liveness">
            {view.liveness.unreachable
              ? `Your office has not answered its last ${view.liveness.strikes} checks: ${view.liveness.words}. This has been raised with us.`
              : view.liveness.strikes > 0
                ? `The last check did not get through: ${view.liveness.words}.`
                : `Checked just now: ${view.liveness.words}.`}
          </p>
        </>
      )}

      <h2>Restart</h2>
      <div className="card">
        <p className="note" data-testid="restart-caveat">
          Restarting powers the whole server off and on, not just isomux. It
          interrupts every agent that is running and takes a couple of minutes.
        </p>
        <p className="action">
          <button
            data-testid="restart-button"
            onClick={() => void act("/api/restart", "restart your server")}
            disabled={
              !view.subscription ||
              !view.ready ||
              view.restart.active ||
              !!(view.lifecycle && view.lifecycle.phase !== "grace")
            }
          >
            {view.restart.active ? "Restarting..." : "Restart my server"}
          </button>
        </p>
        {action && (
          <p className="callout callout-danger" data-testid="action-problem">
            {action}
          </p>
        )}
      </div>

      <h2>Your plan</h2>
      <div className="card">
        <p data-testid="subscription">{planLine(view)}</p>
        <CancelPanel
          view={view}
          pending={billing}
          onAct={(path, label) => void billingAct(path, label)}
        />
        {view.lifecycle?.reinstate.allowed && (
          <>
            <PolicyNotice />
            <p className="action">
              <button
                data-testid="reinstate-button"
                onClick={() => void reinstate()}
              >
                {view.lifecycle.phase === "reinstatement_pending"
                  ? "Return to payment"
                  : "Reinstate this office"}
              </button>
            </p>
          </>
        )}
        {billingProblem && (
          <p className="callout callout-danger" data-testid="billing-problem">
            {billingProblem}
          </p>
        )}
      </div>
    </main>
  );
}

/**
 * The revocation, in the customer's terms.
 *
 * An ambiguous or failed revocation stays PROMINENT and is never softened: the
 * design says a failed revocation is an attention case, not a shrug, and the
 * customer sees the honest state rather than a euphemism.
 */
function revocationSentence(
  revocation: ProgressView["handoff"]["revocation"],
): string {
  switch (revocation.state) {
    case "done":
      return "Hosted Isomux Provisioning no longer has a key to your server. We confirmed this by trying to reconnect with it and being refused.";
    case "failed":
      return "We could not remove our key, and a person has been asked to finish it. Your server's own expiry still removes it at the latest date shown above.";
    case "checking":
      return "We are removing our key and could not confirm it yet. A person has been asked to check. Your server's own expiry still removes it at the latest date shown above.";
    default:
      return "We are removing our key from your server.";
  }
}

/** Dates as yyyy-mm-dd, the format the rest of this page already uses. */
function day(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/** Exact UTC boundary for a payment whose remaining window can be under a day. */
function instant(value: number): string {
  return new Date(value).toISOString().replace(".000Z", "Z");
}

/**
 * Cancelling, un-cancelling, and what happens on each date.
 *
 * Every sentence here states what we can PROVE or what we will DO, never what
 * the provider will do at an exact instant. Manager ruling R-2026-08-10-3: the
 * retention deadline is ours and it is fixed, the provider's term is its own
 * business, and a provider term that would end sooner raises attention rather
 * than quietly shortening what the customer was told.
 *
 * The pre-end sentence says SCHEDULED. `cancel_at_period_end` means Stripe will
 * end it at the period end, not that it has ended, and the office serves
 * normally until then.
 */
function CancelPanel({
  view,
  pending,
  onAct,
}: {
  view: ProgressView;
  pending: "cancel" | "uncancel" | null;
  onAct: (
    path: "/api/cancel" | "/api/uncancel",
    label: "cancel" | "uncancel",
  ) => void;
}) {
  const sub = view.subscription;
  if (!sub) return null;
  const life = view.lifecycle;

  if (pending === "cancel") {
    return (
      <p className="note" data-testid="cancel-pending">
        We have asked Stripe to cancel your subscription. This page updates when
        Stripe confirms it.
      </p>
    );
  }
  if (pending === "uncancel") {
    return (
      <p className="note" data-testid="uncancel-pending">
        We have asked Stripe to keep your subscription. This page updates when
        Stripe confirms it.
      </p>
    );
  }

  // Service has ended: the timeline is real, and every date in it is proven.
  if (life) {
    if (life.phase === "ended") {
      return <p data-testid="cancel-ended">This office has been deleted.</p>;
    }
    if (life.phase === "reinstatement_pending" && life.retentionEnd !== null) {
      return (
        <>
          <p className="callout" data-testid="reinstate-pending">
            Your office remains powered off while payment is pending. Complete
            payment before {instant(life.retentionEnd)} to reinstate this same
            office.
          </p>
          {!life.reinstate.allowed && (
            <p className="note" data-testid="reinstate-refused">
              {life.reinstate.reason}
            </p>
          )}
        </>
      );
    }
    if (life.phase === "checkout_expiry_due") {
      return (
        <p className="callout" data-testid="reinstate-expired">
          The reinstatement deadline has been reached. This payment can no
          longer reinstate the office.
        </p>
      );
    }
    if (life.phase === "suspended" && life.retentionEnd !== null) {
      // A PROVEN date: the machine measured this calendar month from the
      // instant the box was actually powered off, and this is that same number
      // carried across rather than a second computation of it.
      return (
        <>
          <p className="callout" data-testid="cancel-suspended">
            Your office is powered off. Restart your subscription by{" "}
            {day(life.retentionEnd)} to restore it, or contact support for free
            temporary access to your office so you can get your data out. After{" "}
            {day(life.retentionEnd)}, your office cannot be recovered.
          </p>
          {!life.reinstate.allowed && (
            <p className="note" data-testid="reinstate-refused">
              {life.reinstate.reason}
            </p>
          )}
        </>
      );
    }
    if (life.phase === "deprovision_due") {
      return (
        <p className="callout" data-testid="cancel-retention-ended">
          The retention period for this office has ended. It can no longer be
          recovered.
        </p>
      );
    }
    if (sub.cancellationPolicy === "launch") {
      return (
        <>
          <p className="callout" data-testid="cancel-power-off">
            Your subscription ended on {day(sub.endedAt!)}. Your office is being
            powered off. Restart your subscription by {day(life.retentionEnd!)}{" "}
            to restore it, or contact support for free temporary access to your
            office so you can get your data out. After {day(life.retentionEnd!)}
            , your office cannot be recovered.
          </p>
          <p className="note" data-testid="cancel-restart-refused">
            This office cannot be restarted. Your office dashboard shows the
            options available now.
          </p>
        </>
      );
    }
    return (
      <>
        <p className="callout" data-testid="cancel-grace">
          Your subscription ended on {day(sub.endedAt!)}. Your office keeps
          serving until {day(life.graceEnd!)} so you can take your work out.
          After that your server is powered off.
        </p>
        {life.phase === "grace" ? null : (
          <p className="note" data-testid="cancel-restart-refused">
            This office cannot be restarted here after suspension. Contact
            support if you need help.
          </p>
        )}
      </>
    );
  }

  if (sub.cancelAtPeriodEnd && sub.currentPeriodEnd !== null) {
    if (sub.cancellationPolicy === "launch") {
      return (
        <section data-testid="cancel-scheduled">
          <p>
            Your subscription is scheduled to end on {day(sub.currentPeriodEnd)}
            . Your office runs through the period you paid for and is powered
            off when that period ends.
          </p>
          <p>
            We retain the server data for 14 days. During that time, restart
            your subscription to restore the same office, or contact support for
            free temporary access to your office so you can get your data out.
            After that, your office cannot be recovered.
          </p>
          <p className="action">
            <button
              className="btn-primary"
              data-testid="uncancel-button"
              onClick={() => onAct("/api/uncancel", "uncancel")}
            >
              Keep my office
            </button>
            <span data-testid="uncancel-caveat">
              {" "}
              Keeping your office means your subscription renews on{" "}
              {day(sub.currentPeriodEnd)} and normal billing continues.
            </span>
          </p>
        </section>
      );
    }
    const graceEnd = sub.currentPeriodEnd + GRACE_DAYS * 24 * 60 * 60 * 1000;
    return (
      <section data-testid="cancel-scheduled">
        <p>
          Your subscription is scheduled to end on {day(sub.currentPeriodEnd)}.
          Your office keeps serving until {day(sub.currentPeriodEnd)}, and then
          for a further 7 days until {day(graceEnd)}.
        </p>
        <p>
          After {day(graceEnd)} your server is powered off. Your data stays on
          it for one calendar month, and then the server is permanently deleted.
        </p>
        <p className="action">
          <button
            className="btn-primary"
            data-testid="uncancel-button"
            onClick={() => onAct("/api/uncancel", "uncancel")}
          >
            Keep my office
          </button>
          <span data-testid="uncancel-caveat">
            {" "}
            Keeping your office means your subscription renews on{" "}
            {day(sub.currentPeriodEnd)} and normal billing continues.
          </span>
        </p>
      </section>
    );
  }

  return (
    <section data-testid="cancel-offer">
      <p className="note" data-testid="cancel-caveat">
        Cancelling keeps your office running until the end of the period you
        have paid for.
      </p>
      <p className="action">
        <button
          data-testid="cancel-button"
          onClick={() => onAct("/api/cancel", "cancel")}
        >
          Cancel my office
        </button>
      </p>
    </section>
  );
}

/**
 * The plan line, and what the period-end date MEANS in each state.
 *
 * One label for every state was a lie in two of them: a scheduled cancellation
 * has no next invoice, and a subscription that has already ended has one in the
 * past. The date is the same number throughout - what changes is whether it is
 * a bill or an ending.
 */
function planLine(view: ProgressView) {
  const sub = view.subscription;
  if (!sub) return `${view.tier.label} - waiting for payment to be confirmed`;
  const head = `${view.tier.label} - ${sub.status}${sub.comped ? ", no charge" : ""}`;
  // Ended: the period end is history, so it is not shown at all. The
  // cancellation panel below is where the remaining dates live.
  if (sub.endedAt !== null) return head;
  if (sub.currentPeriodEnd === null) return head;
  return sub.cancelAtPeriodEnd ? (
    <>
      {head},{" "}
      <strong className="period-end">
        period ends {day(sub.currentPeriodEnd)}
      </strong>
    </>
  ) : (
    `${head}, next invoice ${day(sub.currentPeriodEnd)}`
  );
}
