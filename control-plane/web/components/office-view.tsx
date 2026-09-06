"use client";

import { useEffect, useRef, useState } from "react";
import type { ProgressView } from "../lib/services.server";
import { customerPriceLine } from "./plan-copy";
import { PolicyNotice } from "./policy-notice";
import type { SupportedLanguageCode } from "../lib/i18n/languages";
import { webTranslatorFor, type WebTranslator } from "../lib/i18n/rich";
import { keyFrom, type PlainMessageKey } from "../lib/i18n/translate";
import { en } from "../lib/i18n/en";

/** Fast while the office is being built, slow once it is serving. The server
 * side of this is a read of rows already in the database, so the cost of the
 * fast cadence is a query, not a probe of the box. */
const BUILDING_MS = 3_000;
const READY_MS = 30_000;
/** A build that has shown no material progress for this long may use the ready
 * cadence. This is deliberately above the longest 15-minute inactivity window
 * in the build ladder. Deadline attention changes the projection at that
 * window, so work the server still considers live cannot reach this ceiling. */
export const STALLED_AFTER_MS = 20 * 60_000;
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

/** Ours, and the same in every language. */
const SUPPORT_EMAIL = "llc@isomux.com";

/**
 * The control plane's ids, mapped to catalog keys.
 *
 * The PROJECTION already carries an id beside every sentence it words for us -
 * a step's `kind`, a liveness `rung`, an attention `reasonClass` - so this page
 * translates from the id and never has to parse the English. `control-plane/
 * progress.ts` keeps its own English for the CLI and the ops floor, which are
 * English by ruling; an id we have no key for falls back to the sentence the
 * projection sent, so a new step kind reads as English rather than as a key.
 */
export const STATE_KEYS: Record<string, PlainMessageKey> = {
  waiting: "stepState.waiting",
  active: "stepState.active",
  checking: "stepState.checking",
  done: "stepState.done",
  failed: "stepState.failed",
};

/**
 * The catalog key for an id the control plane sent, DERIVED rather than looked
 * up in a table of ids.
 *
 * Derived because it has to be: `control-plane/web-boundary.test.ts` forbids any
 * file under web/ from containing an operation kind, so that a page cannot ask
 * for one by spelling it, and a table mapping every kind to a key would be
 * exactly that spelling - and the scan reads comments too, so this one cannot
 * even give an example. The transform is ruling 15's camelCase rule read
 * backwards: a snake_case or kebab-case id becomes one camelCase segment under
 * the namespace, and the English catalog is what says whether the result is a
 * key we hold.
 *
 * The segment carries a `label` prefix for the same rule: without it, a
 * single-word id would produce a key segment that IS the kind, and the catalogs
 * would name it even though no request here ever could.
 *
 * An id we have no key for falls back to the sentence the projection already
 * worded, so a new step kind reads as English rather than as a key. That is also
 * why `control-plane/progress.ts` keeps its own English: the CLI and the ops
 * floor read it, and both are English by ruling.
 */
function keyForId(
  namespace: "steps" | "liveness" | "attention",
  id: string,
): PlainMessageKey | undefined {
  const pascal = id
    .replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/^\w/, (c) => c.toUpperCase());
  const key = `${namespace}.label${pascal}`;
  return Object.hasOwn(en, key) ? (key as PlainMessageKey) : undefined;
}

/** The word for a step's state. A state is not an operation kind, so unlike the
 * kinds it may be spelled here. */
function stateWord(i18n: WebTranslator, state: string): string {
  const key = keyFrom(STATE_KEYS, state);
  return key ? i18n.t(key) : state;
}

/** The catalog text for `id`, or the English the projection already sent. */
function fromId(
  i18n: WebTranslator,
  namespace: "steps" | "liveness" | "attention",
  id: string,
  delivered: string,
): string {
  const key = keyForId(namespace, id);
  return key ? i18n.t(key) : delivered;
}

/** The server clock moves on every response and is not progress. */
export function stableProgressSignature(view: ProgressView): string {
  const { asOf: _asOf, ...stable } = view;
  return JSON.stringify(stable);
}

export function progressPollInterval(args: {
  busy: boolean;
  explicitAction: boolean;
  unchangedMs: number;
}): number {
  if (!args.busy) return READY_MS;
  if (args.explicitAction) return BUILDING_MS;
  return args.unchangedMs >= STALLED_AFTER_MS ? READY_MS : BUILDING_MS;
}

export async function runProgressPoll(args: {
  delay: number;
  fetchProgress: () => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
  cancelled: () => boolean;
  accept: (next: ProgressView) => number;
  schedule: (delay: number) => void;
}): Promise<void> {
  let delay = args.delay;
  try {
    const response = await args.fetchProgress();
    if (!response.ok) return;
    const next = (await response.json()) as ProgressView;
    if (args.cancelled()) return;
    delay = args.accept(next);
  } catch {
    // A failed poll changes no state. The scheduled next poll decides.
  } finally {
    if (!args.cancelled()) args.schedule(delay);
  }
}

export function startProgressPolling(args: {
  delay: () => number;
  fetchProgress: () => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
  accept: (next: ProgressView) => number;
  schedule: (run: () => Promise<void>, delay: number) => unknown;
  clear: (timer: unknown) => void;
}): () => void {
  let cancelled = false;
  let timer: unknown;
  const tick = async () => {
    await runProgressPoll({
      delay: args.delay(),
      fetchProgress: args.fetchProgress,
      cancelled: () => cancelled,
      accept: args.accept,
      schedule: (delay) => {
        timer = args.schedule(tick, delay);
      },
    });
  };
  timer = args.schedule(tick, args.delay());
  return () => {
    cancelled = true;
    args.clear(timer);
  };
}

export function Steps({
  i18n,
  steps,
  testid,
  now,
}: {
  i18n: WebTranslator;
  steps: ProgressView["steps"];
  testid: string;
  now: number | null;
}) {
  return (
    <ol className="card ladder" data-testid={testid}>
      {steps.map((step) => (
        <li key={step.kind} data-testid={`step-${step.kind}`}>
          {fromId(i18n, "steps", step.kind, step.label)} -{" "}
          <span data-state={step.state}>{stateWord(i18n, step.state)}</span>
          {step.startedAt !== null &&
            (step.elapsedMs !== null || now !== null) && (
              <StepDuration i18n={i18n} step={step} now={now} />
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

/** The screen-reader form. `formatDuration` above stays as it is: "1h 04m" is
 * the same compact notation in every language this app serves, and it carries no
 * words to translate. This one does, so it takes the translator (ruling 18) and
 * its unit/plural split is `Intl.PluralRules`, which agrees with the English it
 * replaces at every count. */
function spokenDuration(i18n: WebTranslator, elapsedMs: number): string {
  const seconds = Math.floor(Math.max(elapsedMs, 0) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return (
    [
      hours ? i18n.tn("office.duration.hours", hours) : "",
      minutes ? i18n.tn("office.duration.minutes", minutes) : "",
      !hours && remainder ? i18n.tn("office.duration.seconds", remainder) : "",
    ]
      .filter(Boolean)
      .join(" ") || i18n.tn("office.duration.seconds", 0)
  );
}

function StepDuration({
  i18n,
  step,
  now,
}: {
  i18n: WebTranslator;
  step: ProgressView["steps"][number];
  now: number | null;
}) {
  const elapsed =
    step.elapsedMs === null
      ? Math.max((now ?? step.startedAt ?? 0) - (step.startedAt ?? 0), 0)
      : step.elapsedMs;
  const running = step.elapsedMs === null;
  const compact = formatDuration(elapsed);
  const spoken = spokenDuration(i18n, elapsed);
  return running ? (
    <span
      className="step-duration"
      role="timer"
      aria-label={i18n.t("office.runningFor", { spoken })}
    >
      {compact}
    </span>
  ) : (
    <>
      <span className="step-duration" aria-hidden="true">
        {compact}
      </span>
      <span className="visually-hidden">
        {i18n.t("office.took", { spoken })}
      </span>
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
function accessSentence(
  i18n: WebTranslator,
  access: ProgressView["access"],
): string {
  const date = access.expiresAt
    ? new Date(access.expiresAt).toISOString().slice(0, 10)
    : null;
  switch (access.state) {
    case "not_started":
      return i18n.t("office.access.notStarted");
    case "gone":
      return i18n.t("office.access.gone");
    case "needs_attention":
      return i18n.t("office.access.needsAttention");
    default:
      return date && access.ceilingProven
        ? i18n.t("office.access.holdsUntil", { date })
        : i18n.t("office.access.holds");
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
  language,
  initial,
  instanceId,
}: {
  language: SupportedLanguageCode;
  initial: ProgressView;
  instanceId: string;
}) {
  // THE LANGUAGE IS A PROP FROM THE SERVER RENDER, so it is fixed for the life
  // of this component: the switch writes a cookie and reloads rather than
  // re-rendering in place. That is why the message state below may hold a
  // finished sentence - ours or the server's - instead of a key.
  const i18n = webTranslatorFor(language);
  const [view, setView] = useState(initial);
  const [clock, setClock] = useState<Clock | null>(null);
  const progressSignature = useRef(stableProgressSignature(initial));
  const unchangedSince = useRef(Date.now());
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
    // The only step this page invents. Its label is the English fallback for a
    // reader whose language we have no key for; keyForId is the normal path.
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
  const explicitAction =
    billing !== null ||
    invite.phase === "waiting" ||
    handoffPending ||
    view.restart.active;
  const busy =
    !view.ready ||
    explicitAction ||
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
    return startProgressPolling({
      delay: () =>
        progressPollInterval({
          busy,
          explicitAction,
          unchangedMs: Date.now() - unchangedSince.current,
        }),
      fetchProgress: () =>
        fetch(`/api/progress/${instanceId}`, { cache: "no-store" }),
      accept: (next) => {
        const nextSignature = stableProgressSignature(next);
        const observedAt = Date.now();
        if (nextSignature !== progressSignature.current) {
          progressSignature.current = nextSignature;
          unchangedSince.current = observedAt;
        }
        setView(next);
        if (next.handoff.revocation.state !== "none") {
          setHandoffPending(false);
        }
        // Stripe has confirmed when the CACHED flag matches what we asked for.
        // Anything else and the pending sentence stands, which is true.
        setBilling((asked) => {
          if (!asked || !next.subscription) return asked;
          const landed =
            asked === "cancel"
              ? next.subscription.cancelAtPeriodEnd
              : !next.subscription.cancelAtPeriodEnd;
          return landed ? null : asked;
        });
        return progressPollInterval({
          busy:
            !next.ready ||
            explicitAction ||
            next.handoff.invite.state === "active" ||
            next.handoff.revocation.state === "active",
          explicitAction,
          unchangedMs: observedAt - unchangedSince.current,
        });
      },
      schedule: (run, delay) => setTimeout(() => void run(), delay),
      clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
  }, [instanceId, busy, explicitAction]);

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
            message: reasonOf(data, i18n.t("office.invite.gone")),
          });
          return;
        }
        if (Date.now() > deadline) {
          setInvite({
            phase: "problem",
            message: i18n.t("office.invite.slow"),
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
    // `i18n` is one cached object per language (webTranslatorFor), so naming it
    // here costs nothing and keeps the dependency list honest.
  }, [invite, instanceId, i18n]);

  const askForInvite = async (): Promise<void> => {
    setInvite({ phase: "asking" });
    const { data, status } = await postJson("/api/invite", { instanceId });
    if (status !== 200 || data.ok !== true) {
      setInvite({
        phase: "problem",
        message: reasonOf(data, i18n.t("office.invite.askFailed")),
      });
      return;
    }
    const operationId = data.operationId;
    if (typeof operationId !== "string") {
      setInvite({
        phase: "problem",
        message: i18n.t("office.invite.askFailed"),
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
        reasonOf(data, i18n.t("office.cancel.planFailedLower")),
      );
    } catch {
      setBilling(null);
      setBillingProblem(i18n.t("office.cancel.planFailed"));
    }
  };

  const reinstate = async (): Promise<void> => {
    setBillingProblem(null);
    const { data, status } = await postJson("/api/reinstate", { instanceId });
    if (status === 200 && typeof data.checkoutUrl === "string") {
      window.location.assign(data.checkoutUrl);
      return;
    }
    setBillingProblem(reasonOf(data, i18n.t("office.reinstate.failedLower")));
  };

  const act = async (path: string, action: string): Promise<boolean> => {
    setAction(null);
    try {
      const { data, status } = await postJson(path, { instanceId });
      if (status === 200 && data.ok === true) return true;
      setAction(
        reasonOf(data, i18n.t("office.action.failedLower", { action })),
      );
      return false;
    } catch {
      setAction(i18n.t("office.action.failed", { action }));
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
      setHandoffProblem(reasonOf(data, i18n.t("office.handoff.failedLower")));
    } catch {
      setHandoffPending(false);
      setHandoffProblem(i18n.t("office.handoff.failed"));
    }
  };

  return (
    <main lang={language}>
      <h1 data-testid="office-hostname">{view.hostname}</h1>
      <section className="card" data-testid="office-tier">
        {/* The plan name and its specification are the product's own words and
            its hardware figures, not copy (ruling 11). */}
        <strong>{view.tier.label}</strong>
        {view.tier.specification && <p>{view.tier.specification}</p>}
        {customerPriceLine(language, view.tier.customerPrice) && (
          <p>{customerPriceLine(language, view.tier.customerPrice)}</p>
        )}
      </section>
      <p className="lead" data-testid="office-status">
        {view.ready ? i18n.t("office.ready") : i18n.t("office.notReady")}
      </p>
      {!view.subscription && (
        <section className="card" data-testid="payment-guidance">
          <p>{i18n.t("office.completePayment")}</p>
          <form className="form" method="post" action="/api/signup">
            <input type="hidden" name="signupIntent" value="continue" />
            <input type="hidden" name="officeName" value={view.officeName} />
            <PolicyNotice language={language} />
            <button className="btn-primary" type="submit">
              {i18n.t("common.continueToPayment")}
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
            {i18n.t("office.openOffice")}
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
            <strong>{i18n.t("office.attention.heading")}</strong>
          </div>
          <ul className="rows">
            {view.attention.map((item, index) => (
              <li key={index} data-severity={item.severity}>
                {fromId(i18n, "attention", item.reasonClass, item.summary)}
                {item.acknowledged ? i18n.t("office.attention.seen") : ""}
              </li>
            ))}
          </ul>
          <p>
            {i18n.rich("office.attention.note", {
              address: SUPPORT_EMAIL,
              mail: (chunk) => <a href={`mailto:${SUPPORT_EMAIL}`}>{chunk}</a>,
            })}
          </p>
        </section>
      )}

      <h2>{i18n.t("office.progressHeading")}</h2>
      <Steps i18n={i18n} steps={progressSteps} testid="steps" now={timerNow} />

      {view.otherOperations.length > 0 && (
        <>
          <h2>{i18n.t("office.otherWorkHeading")}</h2>
          <Steps
            i18n={i18n}
            steps={view.otherOperations}
            testid="other-operations"
            now={timerNow}
          />
        </>
      )}

      <h2>{i18n.t("office.gettingInHeading")}</h2>
      <section className="card" data-testid="handoff">
        {view.sshCommand && (
          <p data-testid="ssh-command">
            {i18n.rich("office.sshAccess", {
              command: view.sshCommand,
              cmd: (chunk) => <code>{chunk}</code>,
            })}
          </p>
        )}
        {view.access.state !== "not_started" &&
          (view.access.state !== "gone" ||
            view.handoff.revocation.state === "none") && (
            <p className="note" data-testid="access-window">
              {accessSentence(i18n, view.access)}
            </p>
          )}

        <ol className="handoff-steps">
          <li>
            <h3>{i18n.t("office.invite.heading")}</h3>
            {view.handoff.invite.state === "none" && !view.ready && (
              <p className="note" data-testid="invite-not-yet">
                {i18n.t("office.invite.notYet")}
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
                    ? i18n.t("office.invite.resend")
                    : i18n.t("office.invite.get")}
                </button>
                {view.handoff.invite.mintedAt ? (
                  <span data-testid="resend-caveat">
                    {i18n.t("office.invite.resendCaveat")}
                  </span>
                ) : null}
              </p>
            )}

            {!view.handoff.canMint && view.handoff.invite.mintedAt !== null && (
              <p className="note" data-testid="invite-closed">
                {i18n.t("office.invite.closed")}
              </p>
            )}

            {invite.phase === "asking" && (
              <p className="note">{i18n.t("office.invite.asking")}</p>
            )}
            {invite.phase === "waiting" &&
              (view.handoff.invite.state === "failed" ? (
                <p
                  className="callout callout-danger"
                  data-testid="invite-problem"
                >
                  {i18n.t("office.invite.failed")}
                </p>
              ) : (
                <p className="note" data-testid="invite-waiting">
                  {i18n.t("office.invite.waiting")}
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
            <h3>{i18n.t("common.openOfficeAndSignIn")}</h3>
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
                    {i18n.t("common.openOfficeAndSignIn")}
                  </a>
                </p>
                <p className="note">{i18n.t("office.invite.linkNote")}</p>
              </div>
            ) : view.handoff.canMint ? (
              <p className="note" data-testid="sign-in-guidance">
                {view.handoff.invite.mintedAt
                  ? i18n.t("office.signIn.shownOnce")
                  : view.origin === "adopted" && view.ready
                    ? i18n.t("office.signIn.adopted")
                    : i18n.t("office.signIn.pending")}
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
                <h3>{i18n.t("office.handoff.heading")}</h3>
                <div className="callout">
                  <p>{i18n.t("office.handoff.warning")}</p>
                  <label className="handoff-confirm">
                    <input
                      type="checkbox"
                      data-testid="signed-in-confirmation"
                      checked={signedInConfirmed}
                      onChange={(event) =>
                        setSignedInConfirmed(event.target.checked)
                      }
                      disabled={!invitePathOffered || handoffPending}
                    />{" "}
                    {i18n.t("office.handoff.confirm")}
                  </label>
                  {!invitePathOffered && (
                    <p className="note" data-testid="invite-required">
                      {i18n.t("office.handoff.inviteRequired")}
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
                      ? i18n.t("office.handoff.removing")
                      : i18n.t("office.handoff.remove")}
                  </button>
                  <p
                    className="note handoff-status"
                    role="status"
                    data-testid="revocation-pending"
                  >
                    {handoffPending ? i18n.t("office.handoff.pending") : ""}
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
              <h3>{i18n.t("office.revocation.heading")}</h3>
              <p>
                <span className="note" data-testid="revocation-state">
                  {revocationSentence(i18n, view.handoff.revocation)}
                </span>
              </p>
            </li>
          )}
        </ol>
      </section>

      {view.liveness && (
        <>
          <h2>{i18n.t("office.livenessHeading")}</h2>
          <p className="card" data-testid="liveness">
            {livenessSentence(i18n, view.liveness)}
          </p>
        </>
      )}

      <h2>{i18n.t("office.restartHeading")}</h2>
      <div className="card">
        <p className="note" data-testid="restart-caveat">
          {i18n.t("office.restartCaveat")}
        </p>
        <p className="action">
          <button
            data-testid="restart-button"
            onClick={() =>
              void act("/api/restart", i18n.t("office.action.restartServer"))
            }
            disabled={
              !view.subscription ||
              !view.ready ||
              view.restart.active ||
              !!(view.lifecycle && view.lifecycle.phase !== "grace")
            }
          >
            {view.restart.active
              ? i18n.t("office.restarting")
              : i18n.t("office.restart")}
          </button>
        </p>
        {action && (
          <p className="callout callout-danger" data-testid="action-problem">
            {action}
          </p>
        )}
      </div>

      <h2>{i18n.t("office.planHeading")}</h2>
      <div className="card">
        <p data-testid="subscription">{planLine(i18n, view)}</p>
        <CancelPanel
          i18n={i18n}
          view={view}
          pending={billing}
          onAct={(path, label) => void billingAct(path, label)}
        />
        {view.lifecycle?.reinstate.allowed && (
          <>
            <PolicyNotice language={language} />
            <p className="action">
              <button
                data-testid="reinstate-button"
                onClick={() => void reinstate()}
              >
                {view.lifecycle.phase === "reinstatement_pending"
                  ? i18n.t("office.reinstate.return")
                  : i18n.t("office.reinstate.reinstate")}
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
  i18n: WebTranslator,
  revocation: ProgressView["handoff"]["revocation"],
): string {
  switch (revocation.state) {
    case "done":
      return i18n.t("office.revocation.done");
    case "failed":
      return i18n.t("office.revocation.failed");
    case "checking":
      return i18n.t("office.revocation.checking");
    default:
      return i18n.t("office.revocation.removing");
  }
}

/**
 * The probe ladder, in the customer's terms.
 *
 * The RUNG is what is translated, not the sentence the projection wrote: the
 * view carries both, so an unknown rung still reads as the English the control
 * plane classified it with rather than as a key.
 */
function livenessSentence(
  i18n: WebTranslator,
  liveness: NonNullable<ProgressView["liveness"]>,
): string {
  const words = fromId(i18n, "liveness", liveness.rung, liveness.words);
  if (liveness.unreachable) {
    return i18n.t("office.liveness.unreachable", {
      strikes: liveness.strikes,
      words,
    });
  }
  return liveness.strikes > 0
    ? i18n.t("office.liveness.strike", { words })
    : i18n.t("office.liveness.ok", { words });
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
  i18n,
  view,
  pending,
  onAct,
}: {
  i18n: WebTranslator;
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
        {i18n.t("office.cancel.pendingCancel")}
      </p>
    );
  }
  if (pending === "uncancel") {
    return (
      <p className="note" data-testid="uncancel-pending">
        {i18n.t("office.cancel.pendingUncancel")}
      </p>
    );
  }

  // Service has ended: the timeline is real, and every date in it is proven.
  if (life) {
    if (life.phase === "ended") {
      return <p data-testid="cancel-ended">{i18n.t("office.cancel.ended")}</p>;
    }
    if (life.phase === "reinstatement_pending" && life.retentionEnd !== null) {
      return (
        <>
          <p className="callout" data-testid="reinstate-pending">
            {i18n.t("office.cancel.reinstatePending", {
              deadline: instant(life.retentionEnd),
            })}
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
          {i18n.t("office.cancel.reinstateExpired")}
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
            {i18n.t("office.cancel.suspended", {
              date: day(life.retentionEnd),
            })}
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
          {i18n.t("office.cancel.retentionEnded")}
        </p>
      );
    }
    if (sub.cancellationPolicy === "launch") {
      return (
        <>
          <p className="callout" data-testid="cancel-power-off">
            {i18n.t("office.cancel.powerOffLaunch", {
              endedAt: day(sub.endedAt!),
              date: day(life.retentionEnd!),
            })}
          </p>
          <p className="note" data-testid="cancel-restart-refused">
            {i18n.t("office.cancel.restartRefusedLaunch")}
          </p>
        </>
      );
    }
    return (
      <>
        <p className="callout" data-testid="cancel-grace">
          {i18n.t("office.cancel.grace", {
            endedAt: day(sub.endedAt!),
            graceEnd: day(life.graceEnd!),
          })}
        </p>
        {life.phase === "grace" ? null : (
          <p className="note" data-testid="cancel-restart-refused">
            {i18n.t("office.cancel.restartRefused")}
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
            {i18n.t("office.cancel.scheduledLaunch", {
              date: day(sub.currentPeriodEnd),
            })}
          </p>
          <p>{i18n.t("office.cancel.scheduledLaunchRetention")}</p>
          <RefundNotice i18n={i18n} />
          <p className="action">
            <button
              className="btn-primary"
              data-testid="uncancel-button"
              onClick={() => onAct("/api/uncancel", "uncancel")}
            >
              {i18n.t("office.cancel.keep")}
            </button>
            <span data-testid="uncancel-caveat">
              {i18n.t("office.cancel.keepCaveat", {
                date: day(sub.currentPeriodEnd),
              })}
            </span>
          </p>
        </section>
      );
    }
    const graceEnd = sub.currentPeriodEnd + GRACE_DAYS * 24 * 60 * 60 * 1000;
    return (
      <section data-testid="cancel-scheduled">
        <p>
          {i18n.t("office.cancel.scheduled", {
            date: day(sub.currentPeriodEnd),
            graceEnd: day(graceEnd),
          })}
        </p>
        <p>
          {i18n.t("office.cancel.scheduledAfter", {
            graceEnd: day(graceEnd),
          })}
        </p>
        <p className="action">
          <button
            className="btn-primary"
            data-testid="uncancel-button"
            onClick={() => onAct("/api/uncancel", "uncancel")}
          >
            {i18n.t("office.cancel.keep")}
          </button>
          <span data-testid="uncancel-caveat">
            {i18n.t("office.cancel.keepCaveat", {
              date: day(sub.currentPeriodEnd),
            })}
          </span>
        </p>
      </section>
    );
  }

  return (
    <section data-testid="cancel-offer">
      <p className="note" data-testid="cancel-caveat">
        {i18n.t("office.cancel.caveat")}
      </p>
      <RefundNotice i18n={i18n} />
      <p className="action">
        <button
          data-testid="cancel-button"
          onClick={() => onAct("/api/cancel", "cancel")}
        >
          {i18n.t("office.cancel.cancel")}
        </button>
      </p>
    </section>
  );
}

function RefundNotice({ i18n }: { i18n: WebTranslator }) {
  return (
    <p className="note" data-testid="refund-notice">
      {i18n.t("office.refundNotice", { address: SUPPORT_EMAIL })}
    </p>
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
function planLine(i18n: WebTranslator, view: ProgressView) {
  const sub = view.subscription;
  // The tier label is the plan's own name and `sub.status` is Stripe's own
  // status word: both are data, not copy (ruling 11).
  if (!sub) {
    return `${view.tier.label} - ${i18n.t("office.plan.waitingForPayment")}`;
  }
  const head = `${view.tier.label} - ${sub.status}${sub.comped ? i18n.t("office.plan.noCharge") : ""}`;
  // Ended: the period end is history, so it is not shown at all. The
  // cancellation panel below is where the remaining dates live.
  if (sub.endedAt !== null) return head;
  if (sub.currentPeriodEnd === null) return head;
  return sub.cancelAtPeriodEnd ? (
    <>
      {head},{" "}
      <strong className="period-end">
        {i18n.t("office.plan.periodEnds", { date: day(sub.currentPeriodEnd) })}
      </strong>
    </>
  ) : (
    `${head}, ${i18n.t("office.plan.nextInvoice", { date: day(sub.currentPeriodEnd) })}`
  );
}
