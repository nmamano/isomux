import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressView } from "../lib/services.server";
import {
  anchoredNow,
  formatDuration,
  nextClock,
  OfficeView,
  STATE_WORDS,
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
