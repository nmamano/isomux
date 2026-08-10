"use client";

import { useEffect, useState } from "react";
import type { ProgressView } from "../lib/services.server";

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
  const [invite, setInvite] = useState<InviteState>({ phase: "idle" });
  const [action, setAction] = useState<string | null>(null);

  // FAST WHILE SOMETHING THE CUSTOMER ASKED FOR IS IN FLIGHT, not only while
  // the office is being built. An invite takes a few seconds to mint, and a
  // dashboard that only noticed on its next slow poll would look broken for
  // half a minute after a button press.
  const busy =
    !view.ready ||
    invite.phase === "waiting" ||
    view.restart.active ||
    view.handoff.invite.state === "active" ||
    view.handoff.revocation.state === "active";

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

  const act = async (path: string, label: string): Promise<void> => {
    setAction(null);
    const { data, status } = await postJson(path, { instanceId });
    if (status !== 200 || data.ok !== true) {
      setAction(reasonOf(data, `we could not ${label} just now.`));
      return;
    }
    setAction(null);
  };

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

      <h2>Getting in</h2>
      <section data-testid="handoff">
        <p style={{ color: "#555" }} data-testid="access-window">
          {accessSentence(view.access)}
        </p>

        {view.handoff.invite.state === "none" && !view.ready && (
          <p data-testid="invite-not-yet">
            Your owner invite can be created once your office is serving.
          </p>
        )}

        {view.handoff.canMint && view.ready && (
          <p>
            <button
              data-testid="invite-button"
              onClick={() => void askForInvite()}
              disabled={invite.phase === "asking" || invite.phase === "waiting"}
            >
              {view.handoff.invite.mintedAt
                ? "Send me a new invite"
                : "Get my owner invite"}
            </button>
            {view.handoff.invite.mintedAt ? (
              <span data-testid="resend-caveat">
                {" "}
                A new invite replaces the previous one, which stops working.
              </span>
            ) : null}
          </p>
        )}

        {!view.handoff.canMint && view.handoff.invite.mintedAt !== null && (
          <p data-testid="invite-closed">
            Hosted Isomux Provisioning can no longer create invites for this
            office. If you cannot get in, contact support.
          </p>
        )}

        {invite.phase === "asking" && <p>Asking for an invite...</p>}
        {invite.phase === "waiting" &&
          (view.handoff.invite.state === "failed" ? (
            <p data-testid="invite-problem">
              We could not prepare an invite. Try asking again.
            </p>
          ) : (
            <p data-testid="invite-waiting">
              Preparing your invite. This takes a few seconds.
            </p>
          ))}
        {invite.phase === "problem" && (
          <p data-testid="invite-problem">{invite.message}</p>
        )}
        {invite.phase === "shown" && (
          <div data-testid="invite-shown">
            <p>
              <a data-testid="invite-link" href={invite.url}>
                Open your office and sign in
              </a>
            </p>
            <p style={{ color: "#555" }}>
              This link works once, within 24 hours, and is shown only here. If
              you lose it, ask for a new one.
            </p>
          </div>
        )}

        {/* THE NAG. Shown while we still hold a key and the customer has not
            confirmed. It is the design's answer to a handoff that never ends:
            the ceiling is a backstop, not the normal path. It stops the moment
            they HAVE confirmed - a revocation in flight is not a reason to keep
            asking for one - while minting stays available until the removal is
            proven, because a failed revocation must not also lock them out. */}
        {view.handoff.canMint &&
          view.ready &&
          view.handoff.revocation.state === "none" && (
            <div data-testid="handoff-nag">
              <p>
                Once you are signed in to your office, remove our access. Until
                you do, Hosted Isomux Provisioning keeps a temporary key to your
                server.
              </p>
              <button
                data-testid="revoke-button"
                onClick={() => void act("/api/handoff", "remove our access")}
              >
                Revoke isomux&apos;s access
              </button>
            </div>
          )}

        {view.handoff.revocation.state !== "none" && (
          <p data-testid="revocation-state">
            {revocationSentence(view.handoff.revocation)}
          </p>
        )}
      </section>

      {view.liveness && (
        <>
          <h2>Is it answering?</h2>
          <p data-testid="liveness">
            {view.liveness.unreachable
              ? `Your office has not answered its last ${view.liveness.strikes} checks: ${view.liveness.words}. This has been raised with us.`
              : view.liveness.strikes > 0
                ? `The last check did not get through: ${view.liveness.words}.`
                : `Checked just now: ${view.liveness.words}.`}
          </p>
        </>
      )}

      <h2>Restart</h2>
      <p style={{ color: "#555" }} data-testid="restart-caveat">
        Restarting powers the whole server off and on, not just isomux. It
        interrupts every agent that is running and takes a couple of minutes.
      </p>
      <p>
        <button
          data-testid="restart-button"
          onClick={() => void act("/api/restart", "restart your server")}
          disabled={view.restart.active}
        >
          {view.restart.active ? "Restarting..." : "Restart my server"}
        </button>
      </p>
      {action && <p data-testid="action-problem">{action}</p>}
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
      return "Hosted Isomux Provisioning has removed its key, and we confirmed it by trying to reconnect with it and being refused.";
    case "failed":
      return "We could not remove our key, and a person has been asked to finish it. Your server's own expiry still removes it at the latest date shown above.";
    case "checking":
      return "We are removing our key and could not confirm it yet. A person has been asked to check. Your server's own expiry still removes it at the latest date shown above.";
    default:
      return "We are removing our key from your server.";
  }
}
