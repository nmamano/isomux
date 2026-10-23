import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressView } from "../lib/services.server";
import { webTranslatorFor } from "../lib/i18n/rich";
import { SUPPORT_EMAIL } from "../lib/support-email";
import {
  anchoredNow,
  formatDuration,
  nextClock,
  OfficeView,
  progressBusy,
  progressPollInterval,
  startProgressPolling,
  stableProgressSignature,
  STALLED_AFTER_MS,
  Steps,
} from "./office-view";

/** The page's default language; expectations read its catalog, not copies. */
const english = webTranslatorFor("en");

const baseView: ProgressView = {
  asOf: 0,
  instanceId: "instance-test",
  officeName: "test-office",
  hostname: "test-office.example.test",
  sshTarget: null,
  plan: "V153",
  tier: {
    label: "Entry",
    specification: "4 vCPU, 8 GB RAM, 100 GB SSD",
    customerPrice: { amount: 8, currency: "EUR", billingPeriod: "month" },
  },
  serviceState: "suspended",
  goal: "live",
  origin: "created",
  steps: [],
  otherOperations: [],
  ready: false,
  ended: false,
  attention: [],
  access: { state: "gone", expiresAt: null, ceilingProven: true },
  handoff: {
    canMint: false,
    invite: { state: "none", operationId: null, mintedAt: null },
    revocation: {
      state: "done",
      customerConfirmed: true,
      confirmedAt: 0,
    },
  },
  liveness: null,
  restart: { state: "none", active: false, lastRequestedAt: null },
  subscription: {
    status: "canceled",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    comped: false,
    endedAt: 0,
    customerCancelled: true,
    cancellationPolicy: "launch",
  },
  lifecycle: null,
};

function renderedWithLifecycle(
  lifecycle: NonNullable<ProgressView["lifecycle"]>,
) {
  return renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={{ ...baseView, lifecycle }}
      instanceId={baseView.instanceId}
    />,
  );
}

const POLICY_HREFS = [
  "https://isomux.com/hosted-terms",
  "https://isomux.com/hosted-privacy",
  "https://isomux.com/hosted-refund",
];

/** Every hosted policy link comes before the payment action `marker`. */
function expectPolicyBefore(html: string, marker: string) {
  const at = html.indexOf(marker);
  expect([marker, at]).not.toEqual([marker, -1]);
  for (const href of POLICY_HREFS) {
    const link = html.indexOf(`href="${href}"`);
    expect([href, link >= 0 && link < at]).toEqual([href, true]);
  }
}

const PAYMENT_SUBMIT = '<button class="btn-primary" type="submit"';

test("durations use one compact format at every scale", () => {
  expect(formatDuration(12_999)).toBe("12s");
  expect(formatDuration(204_000)).toBe("3m 24s");
  expect(formatDuration(3_840_000)).toBe("1h 04m");
  expect(formatDuration(-1)).toBe("0s");
});

test("a running step is a silent timer anchored to control-plane time", () => {
  const html = renderToStaticMarkup(
    <Steps
      i18n={english}
      testid="timed"
      now={13_240}
      steps={[
        {
          kind: "step-under-test" as ProgressView["steps"][number]["kind"],
          label: "Waiting for SSH",
          state: "active",
          detail: null,
          startedAt: 10_000,
          finishedAt: null,
          elapsedMs: null,
        },
      ]}
    />,
  );
  expect(html).toContain('role="timer"');
  expect(html).toContain(
    `aria-label="${english.t("office.runningFor", {
      spoken: english.tn("office.duration.seconds", 3),
    })}"`,
  );
  expect(html).not.toContain("aria-live");
});

test("a finished step reads as took without retaining the timer role", () => {
  const html = renderToStaticMarkup(
    <Steps
      i18n={english}
      testid="timed"
      now={99_000}
      steps={[
        {
          kind: "step-under-test" as ProgressView["steps"][number]["kind"],
          label: "Waiting for SSH",
          state: "done",
          detail: null,
          startedAt: 10_000,
          finishedAt: 13_240,
          elapsedMs: 3_240,
        },
      ]}
    />,
  );
  expect(html).toContain('aria-hidden="true">3s</span>');
  expect(html).not.toContain('role="timer"');
});

test("a finished duration is present in the server-rendered office", () => {
  const html = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={{
        ...baseView,
        steps: [
          {
            kind: "step-under-test" as ProgressView["steps"][number]["kind"],
            label: "Waiting for SSH",
            state: "done",
            detail: null,
            startedAt: 10_000,
            finishedAt: 13_240,
            elapsedMs: 3_240,
          },
        ],
      }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(html).toContain('aria-hidden="true">3s</span>');
});

test("a slower poll cannot move the anchored control-plane time backwards", () => {
  const first = nextClock(null, 10_000, 1_000);
  const advanced = { ...first, clientNow: 2_000 };
  const slowerPoll = nextClock(advanced, 10_800, 2_000);
  expect(anchoredNow(slowerPoll)).toBe(11_000);
  expect(anchoredNow(slowerPoll)).toBeGreaterThanOrEqual(anchoredNow(advanced));
});

test("the progress signature ignores only the moving server clock", () => {
  const first = stableProgressSignature(baseView);
  expect(stableProgressSignature({ ...baseView, asOf: 99_000 })).toBe(first);
  expect(stableProgressSignature({ ...baseView, ready: true })).not.toBe(first);
  expect(
    stableProgressSignature({
      ...baseView,
      attention: [
        {
          reasonClass: "inactivity_deadline",
          severity: "warning",
          raisedAt: 1,
          acknowledged: false,
          summary: "A step is taking longer than expected.",
        },
      ],
    }),
  ).not.toBe(first);
});

test("only an unchanged building projection past the ceiling slows down", () => {
  expect(
    progressPollInterval({
      busy: true,
      explicitAction: false,
      unchangedMs: STALLED_AFTER_MS - 1,
    }),
  ).toBe(3_000);
  expect(
    progressPollInterval({
      busy: true,
      explicitAction: false,
      unchangedMs: STALLED_AFTER_MS,
    }),
  ).toBe(30_000);
  expect(
    progressPollInterval({
      busy: false,
      explicitAction: false,
      unchangedMs: 0,
    }),
  ).toBe(30_000);
});

test("an explicit customer action stays fast past the progress ceiling", () => {
  expect(
    progressPollInterval({
      busy: true,
      explicitAction: true,
      unchangedMs: STALLED_AFTER_MS * 2,
    }),
  ).toBe(3_000);
});

test("the polling effect recovers after a non-OK progress response", async () => {
  const scheduled: { run: () => Promise<void>; delay: number }[] = [];
  let fetches = 0;
  const observed: ProgressView[] = [];
  const stop = startProgressPolling({
    delay: () => 3_000,
    fetchProgress: async () => {
      fetches++;
      if (fetches === 1) return { ok: false, json: async () => baseView };
      return { ok: true, json: async () => ({ ...baseView, ready: true }) };
    },
    accept: (next) => {
      observed.push(next);
      return 30_000;
    },
    schedule: (run, delay) => {
      scheduled.push({ run, delay });
      return scheduled.length;
    },
    clear: () => {},
  });
  expect(scheduled.map((timer) => timer.delay)).toEqual([3_000]);
  await scheduled.shift()!.run();
  expect(fetches).toBe(1);
  expect(scheduled.map((timer) => timer.delay)).toEqual([3_000]);
  await scheduled.shift()!.run();
  expect(fetches).toBe(2);
  expect(observed[0]?.ready).toBe(true);
  expect(scheduled.map((timer) => timer.delay)).toEqual([30_000]);
  stop();
});

test("suspended office shows policies before reinstatement payment", () => {
  const html = renderedWithLifecycle({
    phase: "suspended",
    graceEnd: 0,
    retentionEnd: Date.UTC(2027, 1, 14),
    poweredOff: true,
    reinstate: { allowed: true, reason: null },
  });
  expectPolicyBefore(html, 'data-testid="reinstate-button"');
});

test("pending reinstatement shows policies before returning to payment", () => {
  const html = renderedWithLifecycle({
    phase: "reinstatement_pending",
    graceEnd: 0,
    retentionEnd: Date.UTC(2027, 1, 14),
    poweredOff: true,
    reinstate: { allowed: true, reason: null },
  });
  expectPolicyBefore(html, 'data-testid="reinstate-button"');
});

test("office without a payment action omits the policy notice", () => {
  const refused = renderedWithLifecycle({
    phase: "suspended",
    graceEnd: 0,
    retentionEnd: Date.UTC(2027, 1, 14),
    poweredOff: true,
    reinstate: {
      allowed: false,
      code: "too_late",
      reason: "Reinstatement is unavailable.",
    },
  });
  const healthy = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={baseView}
      instanceId={baseView.instanceId}
    />,
  );
  expect(refused).not.toContain(POLICY_HREFS[0]);
  expect(healthy).not.toContain(POLICY_HREFS[0]);
});

test("a refused reinstatement reads in the reader's language, or the projection's sentence for an unknown code", () => {
  const delivered = "The sentence the projection sent.";
  // Spelled, not derived, so the expectation is not the derivation under test.
  const spanish = (
    webTranslatorFor("es").t as unknown as (key: string) => string
  )("refusals.reinstatementTooLate");
  expect(spanish).not.toBe("refusals.reinstatementTooLate");
  expect(spanish).not.toBe(delivered);
  const refusedText = (
    phase: "suspended" | "reinstatement_pending",
    code: string,
  ): string | undefined => {
    const html = renderToStaticMarkup(
      <OfficeView
        language="es"
        initial={{
          ...baseView,
          lifecycle: {
            phase,
            graceEnd: 0,
            retentionEnd: Date.UTC(2027, 1, 14),
            poweredOff: true,
            reinstate: {
              allowed: false,
              code: code as "too_late",
              reason: delivered,
            },
          },
        }}
        instanceId={baseView.instanceId}
      />,
    );
    // As a reader sees it: React escapes an apostrophe and a quote.
    return /data-testid="reinstate-refused">([^<]*)</
      .exec(html)?.[1]
      .replaceAll("&#x27;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&");
  };
  // Both places the page shows the refusal.
  for (const phase of ["suspended", "reinstatement_pending"] as const) {
    expect([phase, refusedText(phase, "too_late")]).toEqual([phase, spanish]);
    expect([phase, refusedText(phase, "a_code_from_the_future")]).toEqual([
      phase,
      delivered,
    ]);
  }
});

test("an unpaid reservation owns its payment continuation and guidance", () => {
  const html = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={{
        ...baseView,
        access: { state: "not_started", expiresAt: null, ceilingProven: false },
        subscription: null,
      }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(html).toContain('name="signupIntent" value="continue"');
  expect(html).toContain('name="officeName" value="test-office"');
  expectPolicyBefore(html, PAYMENT_SUBMIT);
  expect(html).toContain(
    `data-state="active">${english.t("stepState.active")}</span>`,
  );
  expect(html).toContain('data-testid="restart-button" disabled=""');
});

test("payment completes its ladder step and restart waits for provisioning", () => {
  const building = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={baseView}
      instanceId={baseView.instanceId}
    />,
  );
  expect(building).not.toContain('data-testid="payment-guidance"');
  expect(building).toContain(
    `data-state="done">${english.t("stepState.done")}</span>`,
  );
  expect(building).toContain('data-testid="restart-button" disabled=""');

  const ready = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={{ ...baseView, ready: true }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(ready).toContain('data-testid="restart-button"');
  expect(ready).not.toMatch(/data-testid="restart-button"[^>]*disabled/);
});

test("the top office link waits for a minted-or-adopted invite path", () => {
  const created = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={{ ...baseView, ready: true }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(created).not.toContain(
    '<a class="btn btn-primary" href="https://test-office.example.test"',
  );

  const minted = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={{
        ...baseView,
        ready: true,
        handoff: {
          ...baseView.handoff,
          invite: {
            ...baseView.handoff.invite,
            mintedAt: 1,
          },
        },
      }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(minted).toContain(
    '<a class="btn btn-primary" href="https://test-office.example.test"',
  );

  const adopted = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={{ ...baseView, ready: true, origin: "adopted" }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(adopted).toContain(
    '<a class="btn btn-primary" href="https://test-office.example.test"',
  );
});

test("refund terms stay visible before and after cancellation is scheduled", () => {
  const refund = english.t("office.refundNotice", { address: SUPPORT_EMAIL });
  const active = {
    ...baseView,
    subscription: {
      ...baseView.subscription!,
      status: "active",
      currentPeriodEnd: Date.UTC(2027, 0, 31),
      endedAt: null,
      customerCancelled: false,
    },
  } satisfies ProgressView;
  const offered = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={active}
      instanceId={active.instanceId}
    />,
  );
  const scheduled = renderToStaticMarkup(
    <OfficeView
      language="en"
      initial={{
        ...active,
        subscription: { ...active.subscription, cancelAtPeriodEnd: true },
      }}
      instanceId={active.instanceId}
    />,
  );
  // renderToStaticMarkup escapes the apostrophe, so the pin must too.
  const refundHtml = refund.replaceAll("'", "&#x27;");
  expect(offered).toContain(`data-testid="refund-notice">${refundHtml}`);
  expect(scheduled).toContain(`data-testid="refund-notice">${refundHtml}`);
});

test("a deleted office reads as ended, with nothing to open, reach or restart", () => {
  const render = (view: ProgressView) =>
    renderToStaticMarkup(
      <OfficeView language="en" initial={view} instanceId={view.instanceId} />,
    );
  const status = (html: string) =>
    /data-testid="office-status">([^<]*)</.exec(html)?.[1];
  // The projection never sends an ended office as ready.
  const lifecycle: NonNullable<ProgressView["lifecycle"]> = {
    phase: "ended",
    graceEnd: null,
    retentionEnd: null,
    poweredOff: false,
    reinstate: {
      allowed: false,
      code: "deletion_started",
      reason: "the office is gone",
    },
  };
  const notReady = render({ ...baseView, serviceState: "live", lifecycle });
  const ended = render({
    ...baseView,
    serviceState: "deprovisioned",
    ended: true,
    lifecycle,
  });

  expect(status(ended)).toBeTruthy();
  expect(status(ended)).not.toBe(status(notReady));
  expect(ended).not.toContain('href="https://test-office.example.test"');
  for (const section of [
    "handoff",
    "restart-button",
    "cancel-ended",
    "payment-guidance",
  ]) {
    expect(ended).not.toContain(`data-testid="${section}"`);
  }
  // Payment guidance is the one block that needs no subscription.
  expect(
    render({ ...baseView, ended: true, subscription: null }),
  ).not.toContain('data-testid="payment-guidance"');
  expect(render({ ...baseView, subscription: null })).toContain(
    'data-testid="payment-guidance"',
  );
  // The status line says it once; the cancellation panel does not repeat it.
  expect(notReady).toContain('data-testid="cancel-ended"');
  expect(notReady).toContain('data-testid="handoff"');
  expect(notReady).toContain('data-testid="restart-button"');
});

test("an ended office does not poll as if it were still being built", () => {
  expect(progressBusy({ ...baseView, ready: false }, false)).toBe(true);
  expect(progressBusy({ ...baseView, ready: false, ended: true }, false)).toBe(
    false,
  );
  expect(progressBusy({ ...baseView, ended: true }, true)).toBe(true);
});

test("the SSH command names the private key with a localized placeholder", () => {
  // Spanish, so a placeholder left in English or hard-coded in the page shows.
  const spanish = webTranslatorFor("es");
  const render = (view: ProgressView) =>
    renderToStaticMarkup(
      <OfficeView language="es" initial={view} instanceId={view.instanceId} />,
    );
  const unescaped = (html: string) =>
    html
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#x27;", "'")
      .replaceAll("&amp;", "&");
  const target = "owner@test-office.example.test";
  const html = render({ ...baseView, sshTarget: target });

  // Everything up to the first </p>: a note nested in this <p> shows up here.
  const commandBlock = /data-testid="ssh-command">(.*?)<\/p>/.exec(html)?.[1];
  expect(commandBlock).toBeDefined();
  const command = /<code>(.*?)<\/code>/.exec(commandBlock!)?.[1];
  expect(unescaped(command ?? "")).toBe(
    `ssh -i <${spanish.t("office.sshKeyPath")}> ${target}`,
  );
  expect(spanish.t("office.sshKeyPath")).not.toBe(
    english.t("office.sshKeyPath"),
  );
  expect(commandBlock).not.toContain("<p");

  const note = /data-testid="ssh-key-note">([^<]*)<\/p>/.exec(html)?.[1];
  expect(unescaped(note ?? "")).toBe(spanish.t("office.sshKeyNote"));
  expect(spanish.t("office.sshKeyNote")).not.toBe(
    english.t("office.sshKeyNote"),
  );

  // No login to show: neither the command nor the note about its key.
  const hidden = render({ ...baseView, sshTarget: null });
  expect(hidden).toContain('data-testid="handoff"');
  expect(hidden).not.toContain('data-testid="ssh-command"');
  expect(hidden).not.toContain('data-testid="ssh-key-note"');
});
