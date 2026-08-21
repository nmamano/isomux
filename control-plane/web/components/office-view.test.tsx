import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProgressView } from "../lib/services.server";
import { OfficeView, STATE_WORDS } from "./office-view";

const baseView: ProgressView = {
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
