// A webhook as the API returns it, for the Webhooks tab tests.

import type { WebhookDelivery, WebhookWire } from "../../shared/types.ts";

export const HOOK_ID = "wh_0123456789abcdef";

export function hookWire(over: Partial<WebhookWire> = {}): WebhookWire {
  return {
    id: HOOK_ID,
    name: "pr-review",
    scheme: "github-hmac-sha256",
    signatureHeader: null,
    eventHeader: null,
    deliveryHeader: null,
    rules: [{ event: "pull_request", match: { action: "opened" } }],
    target: { kind: "cronjob", cronjobId: "job00001" },
    enabled: true,
    // The self user of ui/test-support/language-fixture.tsx.
    userId: "u1",
    username: "Tester",
    createdBy: "Tester",
    createdAt: 1,
    url: `https://office.example/hooks/${HOOK_ID}`,
    secretState: "set",
    counters: {},
    countersSince: 1,
    lastDelivery: null,
    ...over,
  };
}

export function deliveryRow(
  over: Partial<WebhookDelivery> & Pick<WebhookDelivery, "id">,
): WebhookDelivery {
  return {
    receivedAt: 1_800_000_000_000,
    event: "pull_request",
    deliveryId: "d-1",
    bodyHash: `sha256:${over.id}`,
    bodySize: 10,
    outcome: "no_match",
    attempts: 1,
    duplicates: 0,
    lastSeenAt: 1_800_000_000_000,
    status: 200,
    ruleIndex: null,
    args: null,
    target: null,
    detail: null,
    ...over,
  };
}
