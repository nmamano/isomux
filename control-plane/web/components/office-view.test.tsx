import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressView } from "../lib/services.server";
import {
  anchoredNow,
  formatDuration,
  nextClock,
  OfficeView,
  progressPollInterval,
  startProgressPolling,
  stableProgressSignature,
  STATE_WORDS,
  STALLED_AFTER_MS,
  Steps,
} from "./office-view";

const baseView: ProgressView = {
  asOf: 0,
  instanceId: "instance-test",
  officeName: "test-office",
  hostname: "test-office.example.test",
  sshCommand: null,
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
      initial={{ ...baseView, lifecycle }}
      instanceId={baseView.instanceId}
    />,
  );
}

function expectPolicyBefore(html: string, paymentLabel: string) {
  expect(html).toContain("Before you pay, review the");
  for (const label of ["Terms of Service", "Privacy Policy", "Refund Policy"]) {
    expect(html.indexOf(label)).toBeLessThan(html.indexOf(paymentLabel));
  }
}

test("waiting ladder steps say they have not started", () => {
  expect(STATE_WORDS.waiting).toBe("not started");
  expect(STATE_WORDS.active).toBe("in progress");
});

test("durations use one compact format at every scale", () => {
  expect(formatDuration(12_999)).toBe("12s");
  expect(formatDuration(204_000)).toBe("3m 24s");
  expect(formatDuration(3_840_000)).toBe("1h 04m");
  expect(formatDuration(-1)).toBe("0s");
});

test("a running step is a silent timer anchored to control-plane time", () => {
  const html = renderToStaticMarkup(
    <Steps
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
  expect(html).toContain('aria-label="running for 3 seconds"');
  expect(html).toContain(">3s</span>");
  expect(html).not.toContain("aria-live");
});

test("a finished step reads as took without retaining the timer role", () => {
  const html = renderToStaticMarkup(
    <Steps
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
  expect(html).toContain("took 3 seconds");
  expect(html).not.toContain('role="timer"');
});

test("a finished duration is present in the server-rendered office", () => {
  const html = renderToStaticMarkup(
    <OfficeView
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
  expect(html).toContain("took 3 seconds");
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
  let observed: ProgressView | null = null;
  const stop = startProgressPolling({
    delay: () => 3_000,
    fetchProgress: async () => {
      fetches++;
      if (fetches === 1) return { ok: false, json: async () => baseView };
      return { ok: true, json: async () => ({ ...baseView, ready: true }) };
    },
    accept: (next) => {
      observed = next;
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
  expect(observed?.ready).toBe(true);
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
  expectPolicyBefore(html, "Reinstate this office");
});

test("pending reinstatement shows policies before returning to payment", () => {
  const html = renderedWithLifecycle({
    phase: "reinstatement_pending",
    graceEnd: 0,
    retentionEnd: Date.UTC(2027, 1, 14),
    poweredOff: true,
    reinstate: { allowed: true, reason: null },
  });
  expectPolicyBefore(html, "Return to payment");
});

test("office without a payment action omits the policy notice", () => {
  const refused = renderedWithLifecycle({
    phase: "suspended",
    graceEnd: 0,
    retentionEnd: Date.UTC(2027, 1, 14),
    poweredOff: true,
    reinstate: { allowed: false, reason: "Reinstatement is unavailable." },
  });
  const healthy = renderToStaticMarkup(
    <OfficeView initial={baseView} instanceId={baseView.instanceId} />,
  );
  expect(refused).not.toContain("Before you pay");
  expect(healthy).not.toContain("Before you pay");
});

test("an unpaid reservation owns its payment continuation and guidance", () => {
  const html = renderToStaticMarkup(
    <OfficeView
      initial={{
        ...baseView,
        access: { state: "not_started", expiresAt: null, ceilingProven: false },
        subscription: null,
      }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(html).toContain("Complete payment to start ordering your server.");
  expect(html).toContain('name="signupIntent" value="continue"');
  expect(html).toContain('name="officeName" value="test-office"');
  expectPolicyBefore(html, "Continue to payment");
  expect(html).toContain("Waiting for payment -");
  expect(html).toContain('data-state="active">in progress</span>');
  expect(html).not.toContain("does not have a key to your server yet");
  expect(html).toContain("Wait until the office is serving.");
  expect(html).toContain('data-testid="restart-button" disabled=""');
});

test("payment completes its ladder step and restart waits for provisioning", () => {
  const building = renderToStaticMarkup(
    <OfficeView initial={baseView} instanceId={baseView.instanceId} />,
  );
  expect(building).not.toContain('data-testid="payment-guidance"');
  expect(building).toContain("Waiting for payment -");
  expect(building).toContain('data-state="done">done</span>');
  expect(building).toContain('data-testid="restart-button" disabled=""');

  const ready = renderToStaticMarkup(
    <OfficeView
      initial={{ ...baseView, ready: true }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(ready).toMatch(/data-testid="restart-button"[^>]*>Restart my server/);
  expect(ready).not.toMatch(/data-testid="restart-button"[^>]*disabled/);
});

test("the top office link waits for a minted-or-adopted invite path", () => {
  const created = renderToStaticMarkup(
    <OfficeView
      initial={{ ...baseView, ready: true }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(created).not.toContain(
    '<a class="btn btn-primary" href="https://test-office.example.test"',
  );

  const minted = renderToStaticMarkup(
    <OfficeView
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
      initial={{ ...baseView, ready: true, origin: "adopted" }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(adopted).toContain(
    '<a class="btn btn-primary" href="https://test-office.example.test"',
  );
});

test("refund terms stay visible before and after cancellation is scheduled", () => {
  const refund =
    "You can request a full refund by emailing llc@isomux.com within 7 days of your first payment. If we refund you, we don't retain the server data for 14 days in case you want to restore it later.";
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
    <OfficeView initial={active} instanceId={active.instanceId} />,
  );
  const scheduled = renderToStaticMarkup(
    <OfficeView
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

test("handoff uses the customer-approved access removal label", () => {
  const html = renderToStaticMarkup(
    <OfficeView
      initial={{
        ...baseView,
        ready: true,
        handoff: {
          canMint: true,
          invite: { state: "done", operationId: null, mintedAt: 1 },
          revocation: {
            state: "none",
            customerConfirmed: false,
            confirmedAt: null,
          },
        },
      }}
      instanceId={baseView.instanceId}
    />,
  );
  expect(html).toContain("Remove Hosted Isomux Provisioning access");
  expect(html).not.toContain("Revoke isomux&#x27;s access");
});
